// ============ Multiplayer: who's online, lobbies and matches (Firebase Realtime Database) ============
// Database layout (rules: firebase/database.rules.json):
//   presence/{uid}            who's online and what they're doing
//   lobbyInfo/{code}          lobby name, host, status (the lobby list)
//   lobbyMembers/{code}/{uid} players in the lobby: ready, have the level / downloading
//   lobbySel/{code}           the level, difficulty and modifiers the host picked
//   lobbySuggest/{code}/{id}  levels / modifiers other players suggest
//   lobbyChat/{code}/{id}     chat
//   lobbyGame/{code}          the running match (round, start time on the server clock)
//   lobbyLive/{code}/{uid}    live score while playing, final score after
//   lobbyPoses/{code}/{uid}   saber positions, so you can see the others play
import { account } from './account.js';
import { findSavedByHash, getSavedMap, getMapByHash, downloadMap } from '../beatsaver.js';
import { gamepad } from '../input.js';
import { settings } from '../settings.js';
import { myLook } from '../looks.js';

const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
export const MAX_PLAYERS = 10;

export const MP_MODS = [
    ['noFail', 'No Fail'], ['instantFail', 'One Life'], ['noArrows', 'No Arrows'], ['ghost', 'Ghost Notes'],
    ['disappear', 'Disappearing Arrows'], ['noBombs', 'No Bombs'], ['noWalls', 'No Walls'],
    ['smallNotes', 'Small Notes'], ['strict', 'Strict Angles'],
];
export const MP_SPEEDS = [0.75, 1, 1.25, 1.5];

export function defaultMods() { return { speed: 1, noFail: true }; }

export function modsSummary(mods) {
    const m = mods || {};
    const out = MP_MODS.filter(([k]) => m[k]).map(([, l]) => l);
    if (m.speed && Math.abs(m.speed - 1) > 0.001) out.unshift(m.speed + 'x speed');
    return out;
}

function randomCode(n = 5) {
    const a = new Uint32Array(n);
    crypto.getRandomValues(a);
    return [...a].map(v => CODE_CHARS[v % CODE_CHARS.length]).join('');
}

// ---------- levels ----------
// a level other players can get: the built-in track, or a BeatSaver map (by version hash)
export function levelFromRecord(rec) {
    const m = rec.meta || {};
    return {
        source: 'beatsaver', id: rec.id, hash: String(m.hash || '').toLowerCase(),
        songName: rec.info.songName || m.songName || '', songAuthor: rec.info.songAuthor || m.songAuthor || '',
        mapper: rec.info.levelAuthor || m.mapper || '', coverURL: m.coverURL || '', duration: Number(m.duration) || 0,
        diffs: rec.info.difficulties.map(d => ({ characteristic: d.characteristic, difficulty: d.difficulty, label: d.label || '' })),
    };
}
export function levelFromSearch(m) {
    return {
        source: 'beatsaver', id: m.id, hash: String(m.hash || '').toLowerCase(),
        songName: m.songName, songAuthor: m.songAuthor, mapper: m.mapper, coverURL: m.coverURL || '', duration: m.duration || 0,
        diffs: (m.diffs || []).map(d => ({ characteristic: d.characteristic, difficulty: d.difficulty, label: '' })),
    };
}
export function levelFromBuiltin(song) {
    return {
        source: 'builtin', id: song.id, hash: '', songName: song.songName, songAuthor: song.songAuthor, mapper: song.mapper,
        coverURL: '', duration: 0, diffs: song.difficulties.map(d => ({ characteristic: d.characteristic, difficulty: d.difficulty, label: d.label })),
    };
}
export function shareable(rec) {
    return !!(rec && rec.meta && /^[0-9a-f]{40}$/i.test(String(rec.meta.hash || '')) && !String(rec.id).startsWith('edit-'));
}

// the downloaded copy of a level, if this device has it
export async function findLocalLevel(level) {
    if (!level) return null;
    if (level.source === 'builtin') return { builtin: true };
    if (level.hash) { const r = await findSavedByHash(level.hash).catch(() => null); if (r) return { record: r }; }
    if (level.id) {
        const r = await getSavedMap(level.id).catch(() => null);
        if (r && (!level.hash || String(r.meta && r.meta.hash || '').toLowerCase() === level.hash)) return { record: r };
    }
    return null;
}

// download exactly the version the host picked
export async function downloadLevel(level, onProgress) {
    const meta = await getMapByHash(level.hash);
    if (!meta) throw new Error('That map isn\'t on BeatSaver any more');
    return downloadMap(meta, onProgress);
}

export class Multiplayer {
    constructor() {
        this.lobbyId = null;
        this.lobby = null;           // { info, members, sel, suggest, game, chat }
        this.state = 'online';
        this.offset = 0;             // server clock − local clock (ms)
        this.listeners = new Set();
        this.subs = [];
        this.presenceOn = false;
        this._hostDisc = false;
    }

    get fb() { return account.fb; }
    get uid() { return account.uid; }
    get name() { return account.user ? account.user.name : 'Player'; }
    get isHost() { return !!(this.lobby && this.lobby.info && this.lobby.info.host === this.uid); }
    serverNow() { return Date.now() + this.offset; }
    ref(path) { return path ? this.fb.D.ref(this.fb.db, path) : this.fb.D.ref(this.fb.db); }

    on(fn) { this.listeners.add(fn); return () => this.listeners.delete(fn); }
    emit(what) { for (const fn of [...this.listeners]) { try { fn(what, this); } catch (e) { console.error(e); } } }

    // ---------- presence ----------
    startPresence() {
        if (this.presenceOn || !account.signedIn) return;
        const D = this.fb.D;
        this.presenceOn = true;
        this._presenceSubs = [
            D.onValue(this.ref('.info/serverTimeOffset'), (s) => { this.offset = Number(s.val()) || 0; }),
            D.onValue(this.ref('.info/connected'), (s) => {
                const up = s.val() === true;
                if (!up) {
                    // the server cleans up after us while we're away; we put it back on reconnect
                    if (this.connected) { this.connected = false; console.warn('Multiplayer: connection lost, reconnecting…'); this.emit('offline'); }
                    return;
                }
                const wasDown = this.connected === false;
                this.connected = true;
                this._reconnectedAt = Date.now();
                if (wasDown) this.emit('online');
                if (!account.signedIn) return;
                const me = this.ref('presence/' + this.uid);
                D.onDisconnect(me).remove().then(() => D.set(me, this.presenceData())).catch(e => console.error(e));
                if (this.lobbyId) this.reattach().catch(e => console.error(e));
            }),
        ];
    }

    presenceData() {
        return {
            name: this.name, state: this.state, lobby: this.lobbyId || '',
            lobbyName: (this.lobby && this.lobby.info && this.lobby.info.name) || '',
            at: this.fb.D.serverTimestamp(),
        };
    }

    setState(state) {
        this.state = state;
        if (this.presenceOn && account.signedIn) this.fb.D.set(this.ref('presence/' + this.uid), this.presenceData()).catch(() => {});
    }

    async stopPresence() {
        if (!this.presenceOn) return;
        this.presenceOn = false;
        for (const u of this._presenceSubs || []) u();
        this._presenceSubs = null;
        if (this.lobbyId) await this.leaveLobby().catch(e => console.error(e));
        if (account.signedIn) await this.fb.D.remove(this.ref('presence/' + this.uid)).catch(() => {});
    }

    // everyone online: [{uid, name, state, lobby, lobbyName}]
    watchOnline(cb) {
        return this.fb.D.onValue(this.ref('presence'), (s) => {
            const v = s.val() || {};
            cb(Object.entries(v).map(([uid, p]) => ({ uid, ...p })).sort((a, b) => (a.uid === this.uid ? -1 : b.uid === this.uid ? 1 : String(a.name).localeCompare(String(b.name)))));
        }, (err) => { console.error(err); cb([], err); });
    }

    // public lobbies: [{id, name, hostName, players, maxPlayers, status, level}]
    watchLobbies(cb) {
        return this.fb.D.onValue(this.ref('lobbyInfo'), (s) => {
            const v = s.val() || {};
            cb(Object.entries(v).map(([id, l]) => ({ id, ...l })).filter(l => !l.private).sort((a, b) => (b.created || 0) - (a.created || 0)));
        }, (err) => { console.error(err); cb([], err); });
    }

    // ---------- lobbies ----------
    async createLobby({ name, maxPlayers = 8, isPrivate = false }) {
        const D = this.fb.D;
        if (this.lobbyId) await this.leaveLobby();
        for (let attempt = 0; attempt < 8; attempt++) {
            const id = randomCode();
            const info = {
                name: String(name || `${this.name}'s lobby`).slice(0, 40), host: this.uid, hostName: this.name,
                created: this.serverNow(), status: 'open', maxPlayers: Math.max(2, Math.min(MAX_PLAYERS, maxPlayers | 0)),
                private: !!isPrivate, players: 1, level: '',
            };
            let ok = false;
            try {
                const res = await D.runTransaction(this.ref('lobbyInfo/' + id), (cur) => (cur === null ? info : undefined), { applyLocally: false });
                ok = res.committed;
            } catch (err) {
                if (!/permission/i.test(String(err && err.message))) throw err;   // an old lobby still has this code
            }
            if (!ok) continue;
            await this.clearLobbyData(id);
            await this.enter(id);
            return id;
        }
        throw new Error('Couldn\'t make a lobby — try again');
    }

    // wipe what an older lobby with the same code may have left behind
    clearLobbyData(id, withInfo = false) {
        const u = {};
        for (const k of ['lobbySel', 'lobbyGame', 'lobbySuggest', 'lobbyChat', 'lobbyLive', 'lobbyPoses', 'lobbyMembers']) u[`${k}/${id}`] = null;
        if (withInfo) u[`lobbyInfo/${id}`] = null;
        return this.fb.D.update(this.ref(''), u);
    }

    async joinLobby(code) {
        const id = String(code || '').trim().toUpperCase();
        if (!/^[A-Z0-9]{4,8}$/.test(id)) throw new Error('That isn\'t a lobby code');
        if (this.lobbyId === id) return id;
        if (this.lobbyId) await this.leaveLobby();
        await this.enter(id);
        return id;
    }

    async enter(id) {
        const D = this.fb.D;
        const info = (await D.get(this.ref('lobbyInfo/' + id))).val();
        if (!info) throw new Error('No lobby with that code (it may have closed)');
        const members = (await D.get(this.ref('lobbyMembers/' + id))).val() || {};
        if (!members[this.uid] && Object.keys(members).length >= (info.maxPlayers || MAX_PLAYERS)) throw new Error('That lobby is full');
        this.lobbyId = id;
        this.lobby = { info, members, sel: null, suggest: {}, game: null, chat: [] };
        this._joined = members[this.uid] ? members[this.uid].joined : this.serverNow();
        await this.reattach();
        this.subscribe(id);
        this.setState('lobby');
        this.emit('enter');
    }

    // (re)write my place in the lobby, and what to clean up if my connection drops
    async reattach() {
        const D = this.fb.D, id = this.lobbyId;
        if (!id) return;
        const me = this.ref(`lobbyMembers/${id}/${this.uid}`);
        const cur = this.lobby && this.lobby.members && this.lobby.members[this.uid];
        const data = {
            name: this.name, joined: this._joined, ready: !!(cur && cur.ready),
            has: (cur && cur.has) || 'none', progress: (cur && cur.progress) || 0,
            pad: gamepad.connected,            // nobody starts a match without a controller
            look: myLook(settings),            // your avatar + sabers, for the others
        };
        for (let attempt = 0; ; attempt++) {
            try { await D.set(me, data); break; } catch (err) {
                if (!/permission/i.test(String(err && err.message)) || attempt >= 3 || this.lobbyId !== id) {
                    if (this.lobbyId === id && attempt >= 3) this.dropLobby('lost');
                    throw err;
                }
                // the lobby closed while we were away: bring it back if nobody else is left,
                // otherwise wait for whoever took over to reopen it
                const base = this.lobby && (this.lobby.info || this.lobby.infoCache);
                if (base) {
                    await D.runTransaction(this.ref('lobbyInfo/' + id), (c) => (c === null ? { ...base, host: this.uid, hostName: this.name, players: 1, status: 'open' } : undefined),
                        { applyLocally: false }).catch(() => {});
                }
                await new Promise(r => setTimeout(r, 1500));
            }
        }
        await D.onDisconnect(me).remove();
        await D.onDisconnect(this.ref(`lobbyLive/${id}/${this.uid}`)).remove();
        await D.onDisconnect(this.ref(`lobbyPoses/${id}/${this.uid}`)).remove();
        this._hostDisc = false;
        this.syncHostDuties();
    }

    subscribe(id) {
        const D = this.fb.D;
        this.unsubscribe();
        const L = this.lobby;
        const on = (path, fn) => this.subs.push(D.onValue(this.ref(path), fn, (err) => console.error(path, err)));
        on(`lobbyInfo/${id}`, (s) => {
            L.info = s.val();
            if (L.info) L.infoCache = L.info;
            this.checkHost();
            this.syncHostDuties();
            this.emit('info');
        });
        on(`lobbyMembers/${id}`, (s) => {
            L.members = s.val() || {};
            if (!L.members[this.uid] && this.lobbyId === id && this._wasMember) {
                // gone from the list: a dropped connection (we rejoin) or the host removed us
                if (this.connected === false || Date.now() - (this._reconnectedAt || 0) < 6000) {
                    if (this.connected !== false) this.reattach().catch(e => console.error(e));
                    return;
                }
                this._wasMember = false;
                this.dropLobby('removed');
                return;
            }
            if (L.members[this.uid]) this._wasMember = true;
            this.checkHost();
            if (this.isHost) {
                const n = Object.keys(L.members).length;
                if (L.info && L.info.players !== n) D.update(this.ref(`lobbyInfo/${id}`), { players: n }).catch(() => {});
            }
            this.emit('members');
        });
        on(`lobbySel/${id}`, (s) => { L.sel = s.val(); if (L.sel) L.selCache = L.sel; this.emit('sel'); });
        on(`lobbySuggest/${id}`, (s) => { L.suggest = s.val() || {}; this.emit('suggest'); });
        let firstGame = true;
        on(`lobbyGame/${id}`, (s) => {
            const prev = L.game;
            L.game = s.val();
            const fresh = L.game && (!prev || prev.round !== L.game.round);
            // a match that was already over before you joined isn't yours to start
            if (fresh && firstGame && L.game.startAt < this.serverNow() - 2000) { firstGame = false; return; }
            firstGame = false;
            if (fresh) this.emit('game');
            else if (L.game) this.emit('gameUpdate');
        });
        this.subs.push(D.onValue(D.query(this.ref(`lobbyChat/${id}`), D.limitToLast(60)), (s) => {
            const v = s.val() || {};
            L.chat = Object.entries(v).map(([cid, m]) => ({ cid, ...m })).sort((a, b) => (a.at || 0) - (b.at || 0));
            this.emit('chat');
        }));
    }

    unsubscribe() {
        for (const u of this.subs) { try { u(); } catch (e) { /* gone */ } }
        this.subs = [];
    }

    // the host's connection should close the lobby listing if it drops (the
    // others then pick a new host); only the host keeps that set up
    syncHostDuties() {
        if (!this.lobbyId || !this.lobby) return;
        const D = this.fb.D, ref = this.ref('lobbyInfo/' + this.lobbyId);
        if (this.isHost && !this._hostDisc) { this._hostDisc = true; D.onDisconnect(ref).remove().catch(() => {}); }
        else if (!this.isHost && this._hostDisc) { this._hostDisc = false; D.onDisconnect(ref).cancel().catch(() => {}); }
    }

    // the host left without handing over: the player here longest takes over
    checkHost() {
        const L = this.lobby;
        if (!L || !L.members || !L.members[this.uid]) return;
        const hostHere = L.info && L.info.host && L.members[L.info.host];
        if (hostHere) return;
        const order = Object.entries(L.members).sort((a, b) => (a[1].joined || 0) - (b[1].joined || 0) || a[0].localeCompare(b[0]));
        if (order[0][0] !== this.uid || this._taking) return;
        this._taking = true;
        const D = this.fb.D, members = L.members, base = L.info || L.infoCache || { name: `${this.name}'s lobby`, maxPlayers: 8, status: 'open', created: this.serverNow() };
        D.runTransaction(this.ref('lobbyInfo/' + this.lobbyId), (cur) => {
            if (cur && cur.host && members[cur.host]) return undefined;
            return { ...(cur || base), host: this.uid, hostName: this.name, players: Object.keys(members).length, status: 'open' };
        }, { applyLocally: false }).then(() => {
            // the selection may have gone with the old host's connection
            if (!L.sel && L.selCache) D.set(this.ref('lobbySel/' + this.lobbyId), L.selCache).catch(() => {});
        }).catch(e => console.error('host takeover', e)).finally(() => { this._taking = false; });
    }

    async leaveLobby() {
        const id = this.lobbyId;
        if (!id) return;
        const D = this.fb.D, L = this.lobby;
        this.unsubscribe();
        this.lobbyId = null;
        this._wasMember = false;
        try {
            const others = Object.entries((L && L.members) || {}).filter(([u]) => u !== this.uid);
            if (L && L.info && L.info.host === this.uid) {
                if (others.length) {
                    // hand the lobby to whoever has been here longest
                    others.sort((a, b) => (a[1].joined || 0) - (b[1].joined || 0));
                    await D.update(this.ref('lobbyInfo/' + id), { host: others[0][0], hostName: others[0][1].name || 'Player' });
                } else {
                    await this.clearLobbyData(id, true);       // last one out closes the lobby
                }
            }
            await D.onDisconnect(this.ref('lobbyInfo/' + id)).cancel().catch(() => {});
            await D.update(this.ref(''), {
                [`lobbyMembers/${id}/${this.uid}`]: null, [`lobbyLive/${id}/${this.uid}`]: null, [`lobbyPoses/${id}/${this.uid}`]: null,
            }).catch(() => {});
            for (const p of ['lobbyMembers', 'lobbyLive', 'lobbyPoses']) D.onDisconnect(this.ref(`${p}/${id}/${this.uid}`)).cancel().catch(() => {});
        } finally {
            this._hostDisc = false;
            this.lobby = null;
            this.setState('online');
            this.emit('leave');
        }
    }

    dropLobby(reason) {
        this.unsubscribe();
        const D = this.fb.D, id = this.lobbyId;
        if (id) for (const p of ['lobbyMembers', 'lobbyLive', 'lobbyPoses']) D.onDisconnect(this.ref(`${p}/${id}/${this.uid}`)).cancel().catch(() => {});
        this.lobbyId = null;
        this.lobby = null;
        this.setState('online');
        this.emit(reason || 'leave');
    }

    // ---------- in the lobby ----------
    updateMe(fields) {
        if (!this.lobbyId) return Promise.resolve();
        const L = this.lobby;
        if (L && L.members && L.members[this.uid]) Object.assign(L.members[this.uid], fields);
        return this.fb.D.update(this.ref(`lobbyMembers/${this.lobbyId}/${this.uid}`), fields);
    }

    setReady(ready) { return this.updateMe({ ready: !!ready }); }
    setPad() { return this.lobbyId ? this.updateMe({ pad: gamepad.connected }).catch(() => {}) : Promise.resolve(); }
    refreshLook() { return this.lobbyId ? this.updateMe({ look: myLook(settings) }).catch(() => {}) : Promise.resolve(); }

    // players who can't play yet because no controller is connected
    noController() {
        return Object.entries((this.lobby && this.lobby.members) || {}).filter(([, m]) => m.pad !== true).map(([uid, m]) => ({ uid, name: m.name || 'Player' }));
    }
    setHas(has, progress = 0) { return this.updateMe({ has, progress: Math.round(progress * 100) / 100 }); }

    // host: what to play
    async select(level, characteristic, difficulty, mods) {
        const sel = {
            level, characteristic, difficulty,
            mods: mods || (this.lobby.sel && this.lobby.sel.mods) || defaultMods(),
            by: this.uid, at: this.serverNow(),
        };
        this.lobby.selCache = sel;
        await this.fb.D.set(this.ref('lobbySel/' + this.lobbyId), sel);
        await this.fb.D.update(this.ref('lobbyInfo/' + this.lobbyId), { level: `${level.songName} · ${diffLabel(difficulty)}` }).catch(() => {});
    }

    async setDifficulty(characteristic, difficulty) {
        const s = this.lobby.sel;
        if (!s) return;
        await this.select(s.level, characteristic, difficulty, s.mods);
    }

    async setMods(mods) {
        const s = this.lobby.sel;
        if (!s) { this.lobby.pendingMods = mods; return; }
        this.lobby.selCache = { ...s, mods };
        await this.fb.D.update(this.ref('lobbySel/' + this.lobbyId), { mods });
    }

    // anyone: suggest a level (+ difficulty) and/or modifiers to the host
    suggest({ level = null, characteristic = null, difficulty = null, mods = null }) {
        const s = { by: this.uid, name: this.name, at: this.serverNow(), kind: level ? 'level' : 'mods' };
        if (level) Object.assign(s, { level, characteristic, difficulty });
        if (mods) s.mods = mods;
        return this.fb.D.push(this.ref('lobbySuggest/' + this.lobbyId), s);
    }

    async applySuggestion(sid) {
        const s = this.lobby.suggest[sid];
        if (!s) return;
        const cur = this.lobby.sel;
        if (s.level) await this.select(s.level, s.characteristic, s.difficulty, s.mods || (cur && cur.mods));
        else if (s.mods) await this.setMods(s.mods);
        await this.dismissSuggestion(sid);
    }

    dismissSuggestion(sid) { return this.fb.D.remove(this.ref(`lobbySuggest/${this.lobbyId}/${sid}`)); }

    sendChat(text) {
        text = String(text || '').trim().slice(0, 200);
        if (!text) return Promise.resolve();
        return this.fb.D.push(this.ref('lobbyChat/' + this.lobbyId), { by: this.uid, name: this.name, text, at: this.serverNow() });
    }

    kick(uid) { return this.fb.D.remove(this.ref(`lobbyMembers/${this.lobbyId}/${uid}`)); }

    makeHost(uid) {
        const m = this.lobby.members[uid];
        if (!m) return Promise.resolve();
        return this.fb.D.update(this.ref('lobbyInfo/' + this.lobbyId), { host: uid, hostName: m.name || 'Player' });
    }

    // host: everyone starts together a few seconds from now (server clock)
    async startMatch(leadMs = 5000) {
        const L = this.lobby, D = this.fb.D;
        if (!L.sel) throw new Error('Pick a level first');
        const missing = this.noController();
        if (missing.length) throw new Error(`Waiting for a controller: ${missing.map(m => m.name).join(', ')}`);
        const round = ((L.game && L.game.round) || 0) + 1;
        await D.remove(this.ref('lobbyLive/' + this.lobbyId)).catch(() => {});
        await D.set(this.ref('lobbyGame/' + this.lobbyId), {
            round, startAt: this.serverNow() + leadMs,
            level: L.sel.level, characteristic: L.sel.characteristic, difficulty: L.sel.difficulty, mods: L.sel.mods || defaultMods(),
            players: Object.keys(L.members || {}), host: this.uid,
        });
        await D.update(this.ref('lobbyInfo/' + this.lobbyId), { status: 'playing' });
    }

    // host left the match: everyone goes back to the lobby
    async abortMatch() {
        if (!this.isHost || !this.lobbyId || !this.lobby.game) return;
        await this.fb.D.update(this.ref('lobbyGame/' + this.lobbyId), { aborted: true }).catch(() => {});
        await this.endMatch().catch(() => {});
    }

    // host: back to picking levels
    endMatch() {
        if (!this.isHost || !this.lobbyId) return Promise.resolve();
        return this.fb.D.update(this.ref('lobbyInfo/' + this.lobbyId), { status: 'open' });
    }

    // ---------- during a match ----------
    pushLive(data) {
        if (!this.lobbyId) return Promise.resolve();
        return this.fb.D.set(this.ref(`lobbyLive/${this.lobbyId}/${this.uid}`), { ...data, name: this.name, at: this.serverNow() });
    }

    pushPose(pose) {
        if (!this.lobbyId) return;
        this.fb.D.set(this.ref(`lobbyPoses/${this.lobbyId}/${this.uid}`), pose).catch(() => {});
    }

    watchLive(cb) {
        return this.fb.D.onValue(this.ref('lobbyLive/' + this.lobbyId), (s) => cb(s.val() || {}), (e) => console.error(e));
    }

    watchPoses(cb) {
        return this.fb.D.onValue(this.ref('lobbyPoses/' + this.lobbyId), (s) => cb(s.val() || {}), (e) => console.error(e));
    }
}

export function diffLabel(d) {
    return d === 'ExpertPlus' ? 'Expert+' : d || '';
}

export const mp = new Multiplayer();
