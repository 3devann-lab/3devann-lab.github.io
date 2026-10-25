// ============ Accounts: sign up / sign in / guest, and where your stuff is saved ============
// Guests: settings in a browser cookie, high scores and maps in this browser.
// Signed in: settings, high scores, your list of downloaded maps and your
// editor maps are saved to your account (Firebase Realtime Database), so they
// follow you to any computer.
import { loadFirebase, isConfigured, encodeKey, decodeKey, withTimeout, authMessage } from './firebase.js';
import { settings, setScoreStore, guestScores, readCookie, writeCookie, deleteCookie } from '../settings.js';
import { libraryHooks } from '../beatsaver.js';

export { authMessage };

const GUEST_COOKIE = 'saber3d_guest';
const cacheKey = (uid) => `saber3d_acct_${uid}`;
const NAME_MAX = 24;

export function cleanName(name) {
    return String(name || '').replace(/\s+/g, ' ').trim().slice(0, NAME_MAX);
}

class Account {
    constructor() {
        this.state = 'loading';     // off (not set up) | signedout | guest | user
        this.user = null;           // { uid, email, name }
        this.fb = null;
        this.library = {};          // maps you downloaded: key -> {id, hash, songName, ...}
        this.projectIndex = {};     // editor maps in the account: pid -> {name, updated, ...}
        this.listeners = new Set();
        this._saveT = null;
        this._projT = new Map();
    }

    get configured() { return isConfigured(); }
    get signedIn() { return this.state === 'user' && !!this.user; }
    get uid() { return this.user ? this.user.uid : null; }

    on(fn) { this.listeners.add(fn); return () => this.listeners.delete(fn); }
    emit() { for (const fn of [...this.listeners]) { try { fn(this); } catch (e) { console.error(e); } } }

    // once at startup: restores a saved sign-in, or remembers you chose guest
    async init() {
        if (!isConfigured()) { this.state = 'off'; return this.state; }
        try {
            this.fb = await withTimeout(loadFirebase(), 8000, 'Loading Firebase');
        } catch (err) {
            console.error('Firebase failed to load', err);
            this.loadError = err;
            this.state = 'off';
            return this.state;
        }
        const { auth, A } = this.fb;
        const first = await new Promise((res) => { const un = A.onAuthStateChanged(auth, (u) => { un(); res(u); }); });
        if (first) {
            try { await this.attachUser(first); } catch (err) { console.error(err); this.state = readCookie(GUEST_COOKIE) ? 'guest' : 'signedout'; }
        } else this.state = readCookie(GUEST_COOKIE) ? 'guest' : 'signedout';
        // signed out somewhere else (another tab, password changed)
        A.onAuthStateChanged(auth, (u) => {
            if (!u && this.state === 'user') { this.detachUser(); this.state = 'signedout'; this.emit(); }
        });
        return this.state;
    }

    // ---------- signing in and out ----------
    async signUp(name, email, password) {
        name = cleanName(name);
        if (!name) throw Object.assign(new Error('Pick a player name.'), { code: 'name' });
        const { auth, A } = this.fb;
        const cred = await A.createUserWithEmailAndPassword(auth, String(email).trim(), password);
        await A.updateProfile(cred.user, { displayName: name });
        await this.attachUser(cred.user, { isNew: true, name });
    }

    async signIn(email, password) {
        const { auth, A } = this.fb;
        const cred = await A.signInWithEmailAndPassword(auth, String(email).trim(), password);
        await this.attachUser(cred.user);
    }

    async signOut() {
        const { auth, A } = this.fb;
        if (this.onBeforeSignOut) { try { await this.onBeforeSignOut(); } catch (e) { console.error(e); } }
        this.flush();
        this.detachUser();
        await A.signOut(auth);
        deleteCookie(GUEST_COOKIE);
        this.state = 'signedout';
        this.emit();
    }

    continueAsGuest() {
        writeCookie(GUEST_COOKIE, '1', 365);
        this.state = 'guest';
        this.emit();
    }

    // back to the sign-in screen without losing the guest choice for good
    forgetGuest() { deleteCookie(GUEST_COOKIE); if (this.state === 'guest') { this.state = 'signedout'; this.emit(); } }

    async resetPassword(email) {
        const { auth, A } = this.fb;
        await A.sendPasswordResetEmail(auth, String(email).trim());
    }

    async changePassword(current, next) {
        const { auth, A } = this.fb;
        const u = auth.currentUser;
        if (!u) throw new Error('You are not signed in.');
        await A.reauthenticateWithCredential(u, A.EmailAuthProvider.credential(u.email, current));
        await A.updatePassword(u, next);
    }

    async changeName(name) {
        name = cleanName(name);
        if (!name) throw new Error('Pick a player name.');
        const { auth, A, db, D } = this.fb;
        await A.updateProfile(auth.currentUser, { displayName: name });
        await D.update(D.ref(db, 'profiles/' + this.uid), { name });
        this.user.name = name;
        this.emit();
    }

    // ---------- your data ----------
    async attachUser(fbUser, { isNew = false, name = null } = {}) {
        const { db, D } = this.fb;
        const uid = fbUser.uid;
        this.user = { uid, email: fbUser.email || '', name: cleanName(name || fbUser.displayName || (fbUser.email || 'player').split('@')[0]) || 'Player' };
        const node = (k) => D.ref(db, `users/${uid}/${k}`);

        let remote = null;
        try {
            const snaps = await withTimeout(Promise.all(['settings', 'scores', 'library', 'projectIndex'].map(k => D.get(node(k)))), 12000, 'Loading your account');
            remote = { settings: snaps[0].val(), scores: snaps[1].val(), library: snaps[2].val(), projectIndex: snaps[3].val() };
        } catch (err) {
            console.warn('Account data unavailable, using the copy saved on this device', err);
        }
        const cache = this.readCache(uid);

        // settings: the account's own, or — first time — what you had as a guest
        let saved = null;
        if (remote && remote.settings) { try { saved = JSON.parse(remote.settings); } catch (e) { saved = null; } }
        if (!saved && !remote && cache) saved = cache.settings;
        const seedSettings = !saved && remote;
        if (!saved) saved = settings.changedValues();
        settings.useAccount(saved, (values) => this.saveSettings(values));

        // high scores: a new account starts with the scores you set as a guest
        const scores = new Map();
        const src = remote ? remote.scores : cache && cache.scores;
        if (src) for (const [k, v] of Object.entries(src)) if (v && typeof v === 'object') scores.set(decodeKey(k), v);
        if (isNew) {
            for (const [k, v] of guestScores.entries()) {
                const prev = scores.get(k);
                if (v && (!prev || v.score > prev.score)) { scores.set(k, v); D.set(D.ref(db, `users/${uid}/scores/${encodeKey(k)}`), v).catch(e => console.error(e)); }
            }
        }
        this.scores = scores;
        setScoreStore({
            get: (k) => scores.get(k) || null,
            put: (k, v) => {
                scores.set(k, v);
                this.writeCache();
                D.set(D.ref(db, `users/${uid}/scores/${encodeKey(k)}`), v).catch(e => console.error('score save failed', e));
                return true;
            },
            entries: () => [...scores.entries()],
        });

        this.library = (remote && remote.library) || {};
        this.projectIndex = (remote && remote.projectIndex) || {};
        libraryHooks.onSaved = (rec) => this.addToLibrary(rec);
        libraryHooks.onDeleted = (id) => this.removeFromLibrary(id);

        // your public name (other players see it in multiplayer)
        D.update(D.ref(db, 'profiles/' + uid), { name: this.user.name }).catch(e => console.error(e));
        if (isNew) D.update(D.ref(db, 'profiles/' + uid), { created: D.serverTimestamp() }).catch(() => {});

        this.state = 'user';
        if (seedSettings) this.saveSettings(settings.changedValues());
        this.writeCache();
        this.emit();
    }

    detachUser() {
        clearTimeout(this._saveT);
        for (const t of this._projT.values()) clearTimeout(t.timer);
        this._projT.clear();
        libraryHooks.onSaved = libraryHooks.onDeleted = null;
        setScoreStore(guestScores);
        settings.useGuest();
        this.user = null;
        this.scores = null;
        this.library = {};
        this.projectIndex = {};
    }

    saveSettings(values) {
        if (!this.signedIn) return;
        this._pendingSettings = values;
        this.writeCache();
        clearTimeout(this._saveT);
        this._saveT = setTimeout(() => this.flush(), 800);
    }

    // write anything still waiting (before signing out / leaving)
    flush() {
        clearTimeout(this._saveT);
        if (!this.signedIn || !this._pendingSettings) return;
        const { db, D } = this.fb;
        const json = JSON.stringify(this._pendingSettings);
        this._pendingSettings = null;
        D.set(D.ref(db, `users/${this.uid}/settings`), json).catch(e => console.error('settings save failed', e));
    }

    // a copy on this device so a flaky connection never loses your settings
    readCache(uid) {
        try { return JSON.parse(localStorage.getItem(cacheKey(uid)) || 'null'); } catch (e) { return null; }
    }
    writeCache() {
        if (!this.user) return;
        try {
            const scores = {};
            if (this.scores) for (const [k, v] of this.scores) scores[k] = v;
            localStorage.setItem(cacheKey(this.uid), JSON.stringify({ settings: settings.changedValues(), scores }));
        } catch (e) { /* storage full or blocked */ }
    }

    // fetch the latest list (another device may have changed it)
    async refresh(kind) {
        if (!this.signedIn || !['library', 'projectIndex'].includes(kind)) return;
        const { db, D } = this.fb;
        try {
            const snap = await withTimeout(D.get(D.ref(db, `users/${this.uid}/${kind}`)), 5000, 'Refreshing');
            if (this.signedIn) this[kind] = snap.val() || {};
        } catch (err) { console.warn('Couldn\'t refresh ' + kind, err); }
    }

    // ---------- downloaded maps ----------
    addToLibrary(rec) {
        if (!this.signedIn || !rec || !rec.meta || !rec.meta.hash || String(rec.id).startsWith('edit-')) return;
        const m = rec.meta;
        const entry = {
            id: rec.id, hash: String(m.hash).toLowerCase(),
            songName: (rec.info && rec.info.songName) || m.songName || m.name || '',
            songAuthor: (rec.info && rec.info.songAuthor) || m.songAuthor || '',
            mapper: m.mapper || (rec.info && rec.info.levelAuthor) || '',
            coverURL: m.coverURL || '',
            savedAt: Date.now(),
        };
        const key = encodeKey(rec.id);
        this.library[key] = entry;
        const { db, D } = this.fb;
        D.set(D.ref(db, `users/${this.uid}/library/${key}`), entry).catch(e => console.error(e));
    }

    removeFromLibrary(id) {
        if (!this.signedIn) return;
        const key = encodeKey(id);
        if (!this.library[key]) return;
        delete this.library[key];
        const { db, D } = this.fb;
        D.remove(D.ref(db, `users/${this.uid}/library/${key}`)).catch(e => console.error(e));
    }

    // maps in your account that aren't downloaded on this device
    missingMaps(savedIds) {
        return Object.values(this.library || {}).filter(e => e && e.hash && !savedIds.has(e.id));
    }

    // ---------- editor maps ----------
    // (the song file stays on the device it was added on — it can be large)
    saveProject(p) {
        if (!this.signedIn || !p) return;
        if (p.owner && p.owner !== this.uid) return;
        p.owner = this.uid;
        const prev = this._projT.get(p.id);
        if (prev) clearTimeout(prev.timer);
        const timer = setTimeout(() => this.writeProject(p.id), 2500);
        this._projT.set(p.id, { timer, p });
    }

    async writeProject(id) {
        const job = this._projT.get(id);
        this._projT.delete(id);
        if (!job || !this.signedIn) return;
        const p = job.p;
        const { db, D } = this.fb;
        const index = {
            name: p.info.songName || 'Untitled', artist: p.info.songAuthor || '', mapper: p.info.levelAuthor || '',
            updated: p.updated || Date.now(), notes: p.diffs.reduce((a, d) => a + d.data.notes.length, 0),
            diffs: p.diffs.length, ext: (p.song && p.song.ext) || '',
        };
        this.projectIndex[id] = index;
        try {
            await D.update(D.ref(db, `users/${this.uid}`), {
                [`projects/${id}`]: { json: JSON.stringify(p), updated: index.updated },
                [`projectIndex/${id}`]: index,
            });
        } catch (err) { console.error('map save to account failed', err); }
    }

    async flushProjects() {
        await Promise.all([...this._projT.keys()].map(id => { clearTimeout(this._projT.get(id).timer); return this.writeProject(id); }));
    }

    async loadProject(id) {
        const { db, D } = this.fb;
        const snap = await D.get(D.ref(db, `users/${this.uid}/projects/${id}`));
        const v = snap.val();
        return v && v.json ? JSON.parse(v.json) : null;
    }

    async deleteProject(id) {
        if (!this.signedIn) return;
        const job = this._projT.get(id);
        if (job) { clearTimeout(job.timer); this._projT.delete(id); }
        delete this.projectIndex[id];
        const { db, D } = this.fb;
        await D.update(D.ref(db, `users/${this.uid}`), { [`projects/${id}`]: null, [`projectIndex/${id}`]: null }).catch(e => console.error(e));
    }
}

export const account = new Account();
