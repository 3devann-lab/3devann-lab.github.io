// ============ Multiplayer screens: lobby browser, lobby, level picker, match results ============
import { account } from './account.js';
import { showAuth } from './authui.js';
import {
    mp, MP_MODS, MP_SPEEDS, defaultMods, modsSummary, levelFromRecord, levelFromSearch, levelFromBuiltin,
    shareable, findLocalLevel, downloadLevel, diffLabel, MAX_PLAYERS,
} from './multiplayer.js';
import { authMessage } from './firebase.js';
import { Match } from './match.js';
import { getSavedMaps, searchMaps, downloadMap, getMapByHash } from '../beatsaver.js';
import { BUILTIN_SONG } from '../builtin.js';
import { cursor, gamepad } from '../input.js';
import { drawPortrait } from '../looks.js';
import { showCustomize } from '../customize.js';
import { toast, esc } from '../ui.js';

const $ = (id) => document.getElementById(id);
const DIFF_ORDER = ['Easy', 'Normal', 'Hard', 'Expert', 'ExpertPlus'];

// covers come from other players' lobby data: only show BeatSaver's own images
export function safeCover(url) {
    return /^https:\/\/([a-z0-9-]+\.)*beatsaver\.com\//i.test(String(url || '')) ? String(url) : '';
}
function cover(level) {
    const url = level && safeCover(level.coverURL);
    return url ? `<img class="song-cover" src="${esc(url)}" alt="" loading="lazy">` : '<div class="song-cover builtin-cover"></div>';
}

export class LobbyUI {
    constructor(menu) {
        this.menu = menu;
        this.screen = null;           // browser | lobby | results
        this.match = null;
        this.dl = null;               // the level being fetched for this lobby {key, progress}
        this.haveKey = null;          // the selected level is on this device
        mp.on((what) => this.onEvent(what));
    }

    get L() { return mp.lobby; }

    // ---------- entry ----------
    show() {
        if (account.state === 'off' || !account.configured) {
            this.gate('Multiplayer isn\'t set up on this copy of the game yet.',
                account.loadError ? 'Firebase couldn\'t be reached — check your connection and reload.' : 'The site owner can turn it on by following FIREBASE_SETUP.md (it\'s free).');
            return;
        }
        if (!account.signedIn) {
            this.gate('Multiplayer needs an account.', 'Guests can play everything else. Sign in or create a free account to play with other people.', true);
            return;
        }
        mp.startPresence();
        if (mp.lobbyId) this.showLobby(); else this.showBrowser();
    }

    gate(title, sub, withAuth = false) {
        const menu = this.menu;
        menu.setScreen(`
        <div class="screen">
            <div class="modal" style="width:min(460px,92vw);text-align:center">
                <h2>${esc(title)}</h2>
                <div class="sub">${esc(sub)}</div>
                <div class="menu-buttons" style="width:100%">
                    ${withAuth ? '<button class="btn primary" id="mg-signin">Sign In</button><button class="btn" id="mg-signup">Create Account</button>' : ''}
                    <button class="btn" id="btn-back">← Back</button>
                </div>
            </div>
        </div>`);
        menu.enterMenuMode(() => menu.showHome());
        $('btn-back').onclick = () => menu.showHome();
        if (withAuth) {
            $('mg-signin').onclick = () => showAuth(menu, 'signin', { done: () => this.show() });
            $('mg-signup').onclick = () => showAuth(menu, 'signup', { done: () => this.show() });
        }
    }

    // ---------- lobby browser + who's online ----------
    showBrowser() {
        const menu = this.menu;
        menu.setScreen(`
        <div class="screen panel-screen">
            <div class="panel mp-panel">
                <div class="panel-header">
                    <div class="panel-title">MULTIPLAYER</div>
                    <form class="mp-head-actions" id="mp-join-form">
                        <input class="search-box mp-code" id="mp-code" placeholder="Lobby code" maxlength="8" autocomplete="off">
                        <button class="btn small" type="submit">Join</button>
                        <button class="btn small primary" type="button" id="mp-create">+ Create Lobby</button>
                        <button class="btn small" type="button" id="btn-back">← Back</button>
                    </form>
                </div>
                <div class="panel-body mp-browser">
                    <div class="mp-col"><div class="mp-col-title">Lobbies</div><div id="mp-lobbies"><div class="loading-spinner"></div></div></div>
                    <div class="mp-col side"><div class="mp-col-title">Online now <span id="mp-online-n"></span></div><div id="mp-online"><div class="loading-spinner"></div></div></div>
                </div>
            </div>
        </div>`);
        this.screen = 'browser';
        menu.enterMenuMode(() => menu.showHome());
        $('btn-back').onclick = () => menu.showHome();
        $('mp-create').onclick = () => this.createDialog();
        $('mp-join-form').onsubmit = (e) => { e.preventDefault(); this.join($('mp-code').value); };
        const unL = mp.watchLobbies((list, err) => this.renderLobbies(list, err));
        const unO = mp.watchOnline((list) => this.renderOnline(list));
        menu._cleanup = () => { unL(); unO(); if (this.screen === 'browser') this.screen = null; };
    }

    renderLobbies(list, err) {
        const box = $('mp-lobbies');
        if (!box) return;
        if (err) { box.innerHTML = `<div class="browse-msg">${esc(authMessage(err))}</div>`; return; }
        if (!list.length) {
            box.innerHTML = '<div class="browse-msg">No open lobbies right now.<br>Make one and send your friends the code!</div>';
            return;
        }
        box.innerHTML = list.map(l => `
            <div class="mp-lobby-row">
                <div class="mp-lobby-info">
                    <div class="song-name">${esc(l.name)}</div>
                    <div class="song-artist">Host: ${esc(l.hostName || '?')} · <b>${l.players || 1}</b> / ${l.maxPlayers || MAX_PLAYERS} players
                        · <span class="mp-status ${l.status === 'playing' ? 'playing' : ''}">${l.status === 'playing' ? 'Playing' : 'Open'}</span></div>
                    ${l.level ? `<div class="song-mapper">♪ ${esc(l.level)}</div>` : ''}
                </div>
                <button class="btn small primary" data-join="${esc(l.id)}" ${(l.players || 1) >= (l.maxPlayers || MAX_PLAYERS) ? 'disabled' : ''}>Join</button>
            </div>`).join('');
        box.querySelectorAll('[data-join]').forEach(b => { b.onclick = () => this.join(b.dataset.join); });
    }

    renderOnline(list) {
        const box = $('mp-online');
        if (!box) return;
        $('mp-online-n').textContent = `(${list.length})`;
        const what = (p) => p.state === 'playing' ? `Playing in “${p.lobbyName || p.lobby}”` : p.lobby ? `In lobby “${p.lobbyName || p.lobby}”` : 'In the menus';
        box.innerHTML = list.map(p => `
            <div class="mp-player ${p.uid === mp.uid ? 'me' : ''}">
                <span class="account-dot">${esc(String(p.name || '?')[0].toUpperCase())}</span>
                <div class="mp-player-info"><b>${esc(p.name || 'Player')}${p.uid === mp.uid ? ' <small>(you)</small>' : ''}</b><small>${esc(what(p))}</small></div>
                ${p.lobby && p.uid !== mp.uid && p.lobby !== mp.lobbyId ? `<button class="btn small" data-join="${esc(p.lobby)}">Join</button>` : ''}
            </div>`).join('') || '<div class="browse-msg">Nobody else is online.</div>';
        box.querySelectorAll('[data-join]').forEach(b => { b.onclick = () => this.join(b.dataset.join); });
    }

    async join(code) {
        try {
            await mp.joinLobby(code);
            this.showLobby();
        } catch (err) {
            console.error(err);
            toast(authMessage(err), 'error');
        }
    }

    createDialog() {
        const bd = this.modal(`<h2>Create a lobby</h2>
            <form class="ed-form" id="cl-form">
                <label class="ed-field"><span>Lobby name</span><input class="search-box" id="cl-name" maxlength="40" value="${esc(account.user.name)}'s lobby"></label>
                <label class="ed-field"><span>Players</span><select class="search-box" id="cl-max">${Array.from({ length: MAX_PLAYERS - 1 }, (_, i) => i + 2).map(n => `<option ${n === 8 ? 'selected' : ''}>${n}</option>`).join('')}</select></label>
                <label class="mp-check"><input type="checkbox" id="cl-private"> Private — only people with the code can join</label>
                <div class="menu-buttons" style="width:100%"><button class="btn primary" type="submit" id="cl-go">Create</button><button class="btn small modal-close" type="button">Cancel</button></div>
            </form>`);
        bd.querySelector('#cl-form').onsubmit = async (e) => {
            e.preventDefault();
            const go = bd.querySelector('#cl-go');
            go.disabled = true;
            try {
                await mp.createLobby({ name: bd.querySelector('#cl-name').value.trim() || `${account.user.name}'s lobby`, maxPlayers: Number(bd.querySelector('#cl-max').value), isPrivate: bd.querySelector('#cl-private').checked });
                bd.remove();
                this.showLobby();
            } catch (err) {
                console.error(err);
                toast(authMessage(err), 'error');
                go.disabled = false;
            }
        };
    }

    modal(html, cls = '') {
        const bd = document.createElement('div');
        bd.className = 'modal-backdrop mp-modal';
        bd.innerHTML = `<div class="modal ${cls}" style="width:min(560px,94vw)">${html}</div>`;
        document.body.appendChild(bd);
        const prev = cursor.onBack;
        const close = () => { bd.remove(); cursor.onBack = prev; };
        bd.addEventListener('click', (e) => { if (e.target === bd || e.target.closest('.modal-close')) close(); });
        cursor.onBack = close;
        bd.close = close;
        return bd;
    }

    // ---------- the lobby ----------
    showLobby() {
        const menu = this.menu;
        if (!mp.lobbyId) { this.showBrowser(); return; }
        menu.setScreen(`
        <div class="screen panel-screen">
            <div class="panel mp-panel mp-lobby">
                <div class="panel-header">
                    <div class="panel-title" id="lb-name"></div>
                    <div class="mp-code-chip" title="Friends join with this code">CODE <b id="lb-code"></b></div>
                    <span class="ed-grow"></span>
                    <button class="btn small" id="lb-custom" title="Your avatar and sabers — everyone here sees them">Customize</button>
                    <button class="btn small danger" id="lb-leave">Leave Lobby</button>
                </div>
                <div class="panel-body mp-lobby-body">
                    <div class="mp-col players"><div class="mp-col-title">Players <span id="lb-count"></span></div><div id="lb-players"></div></div>
                    <div class="mp-col level"><div id="lb-level"></div><div id="lb-controls"></div></div>
                    <div class="mp-col side">
                        <div class="mp-col-title">Suggestions</div><div id="lb-suggest" class="mp-suggest"></div>
                        <div class="mp-col-title">Chat</div><div id="lb-chat" class="mp-chat"></div>
                        <form id="lb-chat-form" class="mp-chat-form"><input class="search-box" id="lb-chat-in" maxlength="200" placeholder="Say something…" autocomplete="off"><button class="btn small">Send</button></form>
                    </div>
                </div>
            </div>
        </div>`);
        this.screen = 'lobby';          // after setScreen: it runs the old screen's cleanup, which may be this one's
        menu.enterMenuMode(() => this.leave());
        $('lb-leave').onclick = () => this.leave();
        $('lb-custom').onclick = () => showCustomize(menu, { back: () => this.showLobby() });
        mp.setPad();
        $('lb-chat-form').onsubmit = (e) => {
            e.preventDefault();
            const inp = $('lb-chat-in');
            mp.sendChat(inp.value).catch(err => toast(authMessage(err), 'error'));
            inp.value = '';
        };
        menu._cleanup = () => { if (this.screen === 'lobby') this.screen = null; };
        this.renderAll();
        this.ensureLevel();
    }

    async leave() {
        try { await mp.leaveLobby(); } catch (err) { console.error(err); }
        this.haveKey = null;
        this.showBrowser();
    }

    renderAll() {
        if (this.screen !== 'lobby' || !this.L) return;
        const info = this.L.info || this.L.infoCache || {};
        $('lb-name').textContent = info.name || 'Lobby';
        $('lb-code').textContent = mp.lobbyId;
        this.renderPlayers();
        this.renderLevel();
        this.renderSuggest();
        this.renderChat();
    }

    onEvent(what) {
        if (what === 'offline') { if (mp.lobbyId) toast('Connection lost — reconnecting…', 'error'); return; }
        if (what === 'online') { if (mp.lobbyId) toast('Reconnected', 'success'); return; }
        if (what === 'sel') this.ensureLevel();
        if (what === 'game') { this.onGame(); return; }
        // (anyone whose song is already over keeps their results)
        if (this.match && !this.match.finished && (what === 'gameUpdate' || what === 'members' || what === 'info') && this.matchAborted()) { this.abortToLobby(); return; }
        if (what === 'removed' || what === 'lost') {
            toast(what === 'lost' ? 'Lost the connection to the lobby' : 'You were removed from the lobby', 'error');
            if (this.screen === 'lobby') this.showBrowser();
            return;
        }
        if (this.screen !== 'lobby' || !this.L) return;
        if (what === 'members') { this.renderPlayers(); this.renderControls(); }
        else if (what === 'info') { this.renderAll(); }
        else if (what === 'sel') { this.renderLevel(); this.renderPlayers(); }
        else if (what === 'suggest') this.renderSuggest();
        else if (what === 'chat') this.renderChat();
    }

    renderPlayers() {
        const box = $('lb-players');
        if (!box) return;
        const L = this.L, info = L.info || {};
        const list = Object.entries(L.members || {}).sort((a, b) => (a[1].joined || 0) - (b[1].joined || 0));
        $('lb-count').textContent = `(${list.length} / ${info.maxPlayers || MAX_PLAYERS})`;
        const levelState = (m) => !L.sel ? '' : m.has === 'yes' ? '<span class="mp-has yes" title="Has the level">✓ level</span>'
            : m.has === 'downloading' ? `<span class="mp-has dl">⬇ ${Math.round((m.progress || 0) * 100)}%</span>`
            : m.has === 'missing' ? '<span class="mp-has no">✗ can\'t get level</span>' : '<span class="mp-has">…</span>';
        const pad = (m) => (m.pad === true ? '<span class="mp-pad" title="Controller connected">🎮</span>' : '<span class="mp-has no">no controller</span>');
        box.innerHTML = list.map(([uid, m]) => `
            <div class="mp-player ${uid === mp.uid ? 'me' : ''}">
                <span class="mp-portrait"><canvas width="72" height="72" data-portrait="${esc(uid)}"></canvas>${info.host === uid ? '<i class="mp-crown" title="Host">♛</i>' : ''}</span>
                <div class="mp-player-info"><b>${esc(m.name || 'Player')}${uid === mp.uid ? ' <small>(you)</small>' : ''}</b>
                    <small>${info.host === uid ? 'Host' : m.ready ? '<span class="mp-ready">Ready</span>' : 'Not ready'} ${pad(m)} ${levelState(m)}</small></div>
                ${mp.isHost && uid !== mp.uid ? `<div class="mp-player-btns"><button class="sort-btn" data-host="${uid}" title="Make host">♛</button><button class="sort-btn" data-kick="${uid}" title="Remove from lobby">✕</button></div>` : ''}
            </div>`).join('');
        box.querySelectorAll('[data-portrait]').forEach(c => { const m = L.members[c.dataset.portrait]; drawPortrait(c, m && m.look && m.look.avatar); });
        box.querySelectorAll('[data-host]').forEach(b => { b.onclick = () => mp.makeHost(b.dataset.host).catch(e => toast(authMessage(e), 'error')); });
        box.querySelectorAll('[data-kick]').forEach(b => {
            b.onclick = () => {
                if (b.dataset.armed !== '1') { b.dataset.armed = '1'; b.textContent = 'Sure?'; return; }
                mp.kick(b.dataset.kick).catch(e => toast(authMessage(e), 'error'));
            };
        });
    }

    renderLevel() {
        const box = $('lb-level');
        if (!box) return;
        const sel = this.L.sel;
        if (!sel || !sel.level) {
            box.innerHTML = `<div class="mp-level empty"><div class="mp-level-wait">${mp.isHost ? 'Pick a level to play' : 'Waiting for the host to pick a level…'}</div></div>`;
        } else {
            const lv = sel.level;
            const me = (this.L.members || {})[mp.uid] || {};
            const mine = me.has === 'yes' ? '<span class="mp-has yes">✓ Ready to play</span>'
                : me.has === 'downloading' ? `<span class="mp-has dl">Downloading the level… ${Math.round((me.progress || 0) * 100)}%</span>`
                : me.has === 'missing' ? '<span class="mp-has no">Couldn\'t download this level</span>' : '';
            const mods = modsSummary(sel.mods);
            box.innerHTML = `
                <div class="mp-level">
                    ${cover(lv)}
                    <div class="mp-level-info">
                        <div class="song-name">${esc(lv.songName)}</div>
                        <div class="song-artist">${esc(lv.songAuthor || '')}</div>
                        <div class="song-mapper">${lv.mapper ? 'mapped by ' + esc(lv.mapper) : ''}</div>
                        <div class="mp-level-tags"><span class="diff-tag diff-${esc(sel.difficulty)}">${esc(diffLabel(sel.difficulty))}</span>
                            ${sel.characteristic && sel.characteristic !== 'Standard' ? `<span class="badge">${esc(sel.characteristic)}</span>` : ''}
                            ${mods.map(m => `<span class="badge mod">${esc(m)}</span>`).join('')}</div>
                        <div class="mp-level-mine">${mine}</div>
                    </div>
                </div>`;
        }
        this.renderControls();
    }

    renderControls() {
        const box = $('lb-controls');
        if (!box) return;
        const L = this.L, sel = L.sel, info = L.info || {};
        const playing = info.status === 'playing';
        if (mp.isHost) {
            const members = Object.entries(L.members || {});
            const waiting = sel ? members.filter(([u, m]) => u !== mp.uid && m.has !== 'yes').map(([, m]) => m.name) : [];
            const notReady = members.filter(([u, m]) => u !== mp.uid && !m.ready).map(([, m]) => m.name);
            const diffs = sel && sel.level && sel.level.diffs ? sel.level.diffs : [];
            const chars = [...new Set(diffs.map(d => d.characteristic))];
            const mods = (sel && sel.mods) || L.pendingMods || defaultMods();
            const iHave = sel && (L.members[mp.uid] || {}).has === 'yes';
            const noPad = mp.noController().map(p => (p.uid === mp.uid ? 'you' : p.name));
            box.innerHTML = `
                <div class="mp-controls">
                    <button class="btn small" id="lc-pick">${sel ? 'Change Level' : 'Choose Level'}</button>
                    ${diffs.length ? `<select class="search-box mp-diff" id="lc-diff">${chars.map(c => diffs.filter(d => d.characteristic === c)
                        .sort((a, b) => DIFF_ORDER.indexOf(a.difficulty) - DIFF_ORDER.indexOf(b.difficulty))
                        .map(d => `<option value="${esc(c)}|${esc(d.difficulty)}" ${c === sel.characteristic && d.difficulty === sel.difficulty ? 'selected' : ''}>${chars.length > 1 ? esc(c) + ' · ' : ''}${esc(d.label || diffLabel(d.difficulty))}</option>`).join('')).join('')}</select>` : ''}
                </div>
                <div class="mp-mods-title">Modifiers <small>everyone plays with these</small></div>
                ${this.modsHtml(mods)}
                <div class="mp-start">
                    <button class="btn primary" id="lc-start" ${!sel || !iHave || playing || noPad.length ? 'disabled' : ''}>${playing ? 'Match in progress' : 'Start Match'}</button>
                    <div class="mp-start-note ${noPad.length ? 'warn' : ''}">${noPad.length ? `🎮 Waiting for a controller: <b>${esc(noPad.join(', '))}</b>. They can connect one or leave${noPad.length === 1 && noPad[0] === 'you' ? '' : ', or you can remove them (✕)'}.`
                        : !sel ? 'Choose a level first.' : !iHave ? 'Getting the level…'
                        : waiting.length ? `Still getting the level: ${esc(waiting.join(', '))} (they'll sit this one out if you start now)`
                        : notReady.length ? `Not ready yet: ${esc(notReady.join(', '))}` : members.length > 1 ? 'Everyone is ready ✓' : 'You\'re the only one here — share the code!'}</div>
                </div>`;
            $('lc-pick').onclick = () => this.openPicker('select');
            const dsel = $('lc-diff');
            if (dsel) dsel.onchange = () => { const [c, d] = dsel.value.split('|'); mp.setDifficulty(c, d).catch(e => toast(authMessage(e), 'error')); };
            this.bindMods(box, mods, (m) => mp.setMods(m).then(() => { if (!L.sel) this.renderControls(); }).catch(e => toast(authMessage(e), 'error')));
            $('lc-start').onclick = () => mp.startMatch().catch(e => toast(authMessage(e), 'error'));
        } else {
            const me = (L.members || {})[mp.uid] || {};
            box.innerHTML = `
                <div class="mp-controls">
                    <button class="btn ${me.ready ? 'primary' : ''}" id="lc-ready">${me.ready ? '✓ Ready' : 'Ready?'}</button>
                    <button class="btn small" id="lc-sug-level">Suggest a Level</button>
                    <button class="btn small" id="lc-sug-mods">Suggest Modifiers</button>
                </div>
                <div class="mp-start-note ${gamepad.connected ? '' : 'warn'}">${!gamepad.connected ? '🎮 Connect a controller — the host can\'t start the match until you do.'
                    : playing ? 'A match is being played — you\'ll be in the next one.' : 'The host picks the level and starts the match. Suggestions show up for the host to use.'}</div>`;
            $('lc-ready').onclick = () => mp.setReady(!me.ready).then(() => this.renderControls()).catch(e => toast(authMessage(e), 'error'));
            $('lc-sug-level').onclick = () => this.openPicker('suggest');
            $('lc-sug-mods').onclick = () => this.suggestModsDialog();
        }
    }

    modsHtml(mods) {
        const sp = Number(mods.speed) || 1;
        return `<div class="mods-chips mp-mods">${MP_MODS.map(([k, l]) => `<button class="mod-chip ${mods[k] ? 'active' : ''}" data-mpmod="${k}">${esc(l)}</button>`).join('')}</div>
            <div class="mods-line"><span>Song speed</span><div class="seg">${MP_SPEEDS.map(v => `<button class="sort-btn ${Math.abs(v - sp) < 0.001 ? 'active' : ''}" data-mpspeed="${v}">${v}x</button>`).join('')}</div></div>`;
    }

    bindMods(box, mods, apply) {
        box.querySelectorAll('[data-mpmod]').forEach(b => {
            b.onclick = () => {
                const m = { ...mods };
                const k = b.dataset.mpmod;
                m[k] = !m[k];
                if (k === 'noFail' && m[k]) m.instantFail = false;
                if (k === 'instantFail' && m[k]) m.noFail = false;
                if (k === 'noArrows' && m[k]) m.strict = false;
                if (k === 'strict' && m[k]) m.noArrows = false;
                for (const key of Object.keys(m)) if (m[key] === false) delete m[key];
                apply(m);
            };
        });
        box.querySelectorAll('[data-mpspeed]').forEach(b => { b.onclick = () => apply({ ...mods, speed: Number(b.dataset.mpspeed) }); });
    }

    renderSuggest() {
        const box = $('lb-suggest');
        if (!box) return;
        const list = Object.entries(this.L.suggest || {}).sort((a, b) => (a[1].at || 0) - (b[1].at || 0));
        if (!list.length) {
            box.innerHTML = `<div class="mp-empty">${mp.isHost ? 'Nothing yet. Other players\' level and modifier ideas show up here.' : 'Suggest a level or modifiers — the host can use them with one click.'}</div>`;
            return;
        }
        box.innerHTML = list.map(([sid, s]) => {
            const mods = s.mods ? modsSummary(s.mods) : [];
            const what = s.level
                ? `<b>${esc(s.level.songName)}</b> · ${esc(diffLabel(s.difficulty))}${mods.length ? ` · ${esc(mods.join(', '))}` : ''}`
                : `modifiers: <b>${esc(mods.length ? mods.join(', ') : 'none')}</b>`;
            return `<div class="mp-sug">
                <div class="mp-sug-text"><small>${esc(s.name || 'Player')} suggests</small>${what}</div>
                <div class="mp-sug-btns">${mp.isHost ? `<button class="btn small primary" data-use="${sid}">Use</button>` : ''}
                ${mp.isHost || s.by === mp.uid ? `<button class="sort-btn" data-dismiss="${sid}" title="Remove">✕</button>` : ''}</div>
            </div>`;
        }).join('');
        box.querySelectorAll('[data-use]').forEach(b => {
            b.onclick = async () => {
                b.disabled = true;
                const s = this.L.suggest[b.dataset.use];
                try {
                    // get the suggested level first, so the host can play it too
                    if (s && s.level && s.level.source === 'beatsaver' && !(await findLocalLevel(s.level))) {
                        b.textContent = 'Downloading…';
                        const rec = await downloadLevel(s.level, (p) => { b.textContent = Math.round(p * 100) + '%'; });
                        s.level = { ...levelFromRecord(rec), hash: s.level.hash };
                    }
                    await mp.applySuggestion(b.dataset.use);
                    toast('Suggestion applied', 'success');
                } catch (err) { toast('Couldn\'t use it: ' + authMessage(err), 'error'); b.disabled = false; b.textContent = 'Use'; }
            };
        });
        box.querySelectorAll('[data-dismiss]').forEach(b => { b.onclick = () => mp.dismissSuggestion(b.dataset.dismiss).catch(e => toast(authMessage(e), 'error')); });
    }

    renderChat() {
        const box = $('lb-chat');
        if (!box) return;
        const near = box.scrollHeight - box.scrollTop - box.clientHeight < 40;
        box.innerHTML = (this.L.chat || []).map(m => `<div class="mp-msg ${m.by === mp.uid ? 'me' : ''}"><b>${esc(m.name || 'Player')}</b> ${esc(m.text)}</div>`).join('')
            || '<div class="mp-empty">Say hi 👋</div>';
        if (near || !this._chatSeen) box.scrollTop = box.scrollHeight;
        this._chatSeen = true;
    }

    // ---------- choosing / suggesting a level ----------
    openPicker(purpose) {
        const host = purpose === 'select';
        let tab = 'lib', query = '';
        const bd = this.modal(`<h2>${host ? 'Choose a level' : 'Suggest a level'}</h2>
            <div class="seg mp-pick-tabs"><button class="sort-btn active" data-pt="lib">Your Levels</button><button class="sort-btn" data-pt="search">Find on BeatSaver</button></div>
            <div id="pk-body" class="mp-pick-body"></div>
            <button class="btn small modal-close">Cancel</button>`, 'mp-picker');
        const body = bd.querySelector('#pk-body');
        const pickDiff = (level, record = null) => this.diffStep(bd, level, async (characteristic, difficulty) => {
            try {
                if (host) {
                    let lv = level;
                    if (level.source === 'beatsaver' && !record && !(await findLocalLevel(level))) {
                        body.innerHTML = '<div class="browse-msg">Downloading the level…<div class="dl-progress"><div class="dl-progress-fill" id="pk-fill"></div></div></div>';
                        const meta = await getMapByHash(level.hash);
                        const rec = await downloadMap(meta, (p) => { const f = bd.querySelector('#pk-fill'); if (f) f.style.width = (p * 100) + '%'; });
                        lv = levelFromRecord(rec);
                    }
                    await mp.select(lv, characteristic, difficulty);
                    toast(`Level set: ${lv.songName} · ${diffLabel(difficulty)}`, 'success');
                } else {
                    await mp.suggest({ level, characteristic, difficulty });
                    toast('Suggestion sent to the host', 'success');
                }
                bd.close();
            } catch (err) {
                console.error(err);
                toast(authMessage(err), 'error');
                render();
            }
        });
        const render = async () => {
            bd.querySelectorAll('[data-pt]').forEach(b => b.classList.toggle('active', b.dataset.pt === tab));
            if (tab === 'lib') {
                body.innerHTML = '<div class="loading-spinner"></div>';
                const saved = (await getSavedMaps().catch(() => [])).filter(shareable);
                if (!body.isConnected || tab !== 'lib') return;
                const items = [{ level: levelFromBuiltin(BUILTIN_SONG), record: null }, ...saved.map(r => ({ level: levelFromRecord(r), record: r }))];
                body.innerHTML = items.map((it, i) => `<button class="song-row mp-pick-row" data-i="${i}">${cover(it.level)}
                    <div class="song-meta"><div class="song-name">${esc(it.level.songName)}</div><div class="song-artist">${esc(it.level.songAuthor || '')}</div>
                    <div class="song-mapper">${esc(it.level.mapper || '')}</div></div></button>`).join('')
                    + (saved.length ? '' : '<div class="browse-msg">Your downloaded BeatSaver maps show up here. Your own editor maps can\'t be shared yet.</div>');
                body.querySelectorAll('[data-i]').forEach(b => { b.onclick = () => { const it = items[Number(b.dataset.i)]; pickDiff(it.level, it.record); }; });
            } else {
                body.innerHTML = `<form class="mp-search" id="pk-form"><input class="search-box" id="pk-q" placeholder="Search BeatSaver… (song, artist, mapper)" value="${esc(query)}"><button class="btn small">Search</button></form><div id="pk-res"><div class="loading-spinner"></div></div>`;
                const run = async () => {
                    const res = bd.querySelector('#pk-res');
                    res.innerHTML = '<div class="loading-spinner"></div>';
                    try {
                        const maps = await searchMaps({ query, sort: query ? 'Relevance' : 'Rating' });
                        if (!res.isConnected) return;
                        res.innerHTML = maps.map((m, i) => `<button class="song-row mp-pick-row" data-m="${i}"><img class="song-cover" src="${esc(m.coverURL || '')}" alt="" loading="lazy">
                            <div class="song-meta"><div class="song-name">${esc(m.songName)}</div><div class="song-artist">${esc(m.songAuthor)}</div>
                            <div class="song-mapper">${esc(m.mapper)} · ▲ ${m.upvotes}</div></div></button>`).join('') || '<div class="browse-msg">No maps found.</div>';
                        res.querySelectorAll('[data-m]').forEach(b => { b.onclick = () => pickDiff(levelFromSearch(maps[Number(b.dataset.m)])); });
                    } catch (err) {
                        res.innerHTML = `<div class="browse-msg">Couldn't reach BeatSaver.<br><small>${esc(err.message)}</small></div>`;
                    }
                };
                bd.querySelector('#pk-form').onsubmit = (e) => { e.preventDefault(); query = bd.querySelector('#pk-q').value.trim(); run(); };
                run();
                setTimeout(() => { const q = bd.querySelector('#pk-q'); if (q) q.focus(); }, 30);
            }
        };
        bd.querySelectorAll('[data-pt]').forEach(b => { b.onclick = () => { tab = b.dataset.pt; render(); }; });
        render();
    }

    diffStep(bd, level, done) {
        const body = bd.querySelector('#pk-body');
        const diffs = (level.diffs || []).filter(d => d.characteristic !== 'Lightshow');
        const chars = [...new Set(diffs.map(d => d.characteristic))];
        let ch = chars.includes('Standard') ? 'Standard' : chars[0];
        const render = () => {
            body.innerHTML = `<div class="mp-level small">${cover(level)}<div class="mp-level-info"><div class="song-name">${esc(level.songName)}</div>
                <div class="song-artist">${esc(level.songAuthor || '')}</div></div></div>
                ${chars.length > 1 ? `<div class="char-tabs">${chars.map(c => `<button class="sort-btn ${c === ch ? 'active' : ''}" data-ch="${esc(c)}">${esc(c)}</button>`).join('')}</div>` : ''}
                <div class="diff-list">${diffs.filter(d => d.characteristic === ch).sort((a, b) => DIFF_ORDER.indexOf(a.difficulty) - DIFF_ORDER.indexOf(b.difficulty))
                    .map(d => `<button class="diff-btn diff-${esc(d.difficulty)}" data-d="${esc(d.difficulty)}"><span>${esc(d.label || diffLabel(d.difficulty))}</span></button>`).join('')
                    || '<div class="browse-msg">This map has no playable difficulties.</div>'}</div>`;
            body.querySelectorAll('[data-ch]').forEach(b => { b.onclick = () => { ch = b.dataset.ch; render(); }; });
            body.querySelectorAll('[data-d]').forEach(b => { b.onclick = () => { body.innerHTML = '<div class="loading-spinner"></div>'; done(ch, b.dataset.d); }; });
        };
        render();
    }

    suggestModsDialog() {
        let mods = { ...((this.L.sel && this.L.sel.mods) || defaultMods()) };
        const bd = this.modal(`<h2>Suggest modifiers</h2><div class="sub">The host sees your suggestion and can use it with one click.</div>
            <div id="sm-body"></div>
            <div class="menu-buttons" style="width:100%"><button class="btn primary" id="sm-go">Suggest</button><button class="btn small modal-close">Cancel</button></div>`);
        const render = () => {
            const box = bd.querySelector('#sm-body');
            box.innerHTML = this.modsHtml(mods);
            this.bindMods(box, mods, (m) => { mods = m; render(); });
        };
        render();
        bd.querySelector('#sm-go').onclick = () => {
            mp.suggest({ mods }).then(() => { toast('Suggestion sent to the host', 'success'); bd.close(); }).catch(e => toast(authMessage(e), 'error'));
        };
    }

    // ---------- the selected level, on this device ----------
    // everybody gets the host's pick automatically (BeatSaver maps download)
    async ensureLevel() {
        const L = this.L;
        const sel = L && L.sel;
        if (!sel || !sel.level) { this.haveKey = null; return; }
        const lv = sel.level;
        const key = `${lv.source}:${lv.hash || lv.id}`;
        if (this.haveKey === key || (this.dl && this.dl.key === key)) return;
        const me = (L.members || {})[mp.uid];
        const local = await findLocalLevel(lv);
        if (!mp.lobby || !mp.lobby.sel || mp.lobby.sel.level !== lv && `${mp.lobby.sel.level.source}:${mp.lobby.sel.level.hash || mp.lobby.sel.level.id}` !== key) return;
        if (local) {
            this.haveKey = key;
            if (!me || me.has !== 'yes') mp.setHas('yes', 1).catch(() => {});
            return;
        }
        this.haveKey = null;
        if (lv.source !== 'beatsaver' || !lv.hash) { mp.setHas('missing').catch(() => {}); return; }
        this.dl = { key, progress: 0 };
        mp.setHas('downloading', 0).catch(() => {});
        let last = 0;
        try {
            await downloadLevel(lv, (p) => {
                const now = performance.now();
                if (now - last > 400) { last = now; mp.setHas('downloading', p).catch(() => {}); }
            });
            this.dl = null;
            const cur = mp.lobby && mp.lobby.sel && mp.lobby.sel.level;
            if (cur && `${cur.source}:${cur.hash || cur.id}` === key) {
                this.haveKey = key;
                await mp.setHas('yes', 1);
                toast(`Downloaded “${lv.songName}” for the match`, 'success');
            } else this.ensureLevel();
        } catch (err) {
            console.error('level download', err);
            this.dl = null;
            mp.setHas('missing').catch(() => {});
            toast('Couldn\'t download the level: ' + err.message, 'error');
        }
        if (this.screen === 'lobby') { this.renderLevel(); this.renderPlayers(); }
    }

    // ---------- the match ----------
    async onGame() {
        const g = mp.lobby && mp.lobby.game;
        if (!g || !g.level) return;
        const menu = this.menu;
        if (menu.gameplay || this.match) return;
        if (!(g.players || []).includes(mp.uid)) {
            if (this.screen === 'lobby') toast('A match is being played — you\'ll join the next one');
            return;
        }
        if (mp.serverNow() - g.startAt > 30000) return;       // an old round
        const local = await findLocalLevel(g.level);
        if (!local) { toast('You don\'t have this level yet — you\'ll join the next match', 'error'); return; }
        let builtinSong = null, record = null, diff;
        if (local.builtin) {
            builtinSong = BUILTIN_SONG;
            diff = BUILTIN_SONG.difficulties.find(d => d.difficulty === g.difficulty) || BUILTIN_SONG.difficulties[1];
        } else {
            record = local.record;
            diff = record.info.difficulties.find(d => d.characteristic === g.characteristic && d.difficulty === g.difficulty);
        }
        if (!diff) { toast('This level doesn\'t have that difficulty on your copy', 'error'); return; }
        const match = new Match(menu, g);
        this.match = match;
        menu.match = match;
        mp.setState('playing');
        document.querySelectorAll('.mp-modal').forEach(m => m.remove());
        await menu.startLevel(builtinSong, record, diff, null, { match, mods: g.mods || {} });
        if (!menu.gameplay) this.endMatch();          // couldn't start (no controller, bad file…)
    }

    // pressing pause in a match doesn't stop the song (everyone plays together)
    showMatchMenu() {
        const menu = this.menu;
        if (document.querySelector('.mp-match-menu')) { this.closeMatchMenu(); return; }
        const el = document.createElement('div');
        el.className = 'modal-backdrop mp-match-menu';
        el.innerHTML = `<div class="modal" style="width:min(380px,90vw);text-align:center">
            <div class="result-title">MULTIPLAYER</div>
            <div class="sub">${mp.isHost ? 'The song keeps going. You\'re the host: if you leave, the match ends and everyone goes back to the lobby.' : 'The song keeps going — everyone is playing together.'}</div>
            <div class="menu-buttons" style="width:100%"><button class="btn primary" id="mm-keep">Keep Playing</button>
            <button class="btn danger" id="mm-leave">Leave Match</button></div></div>`;
        document.body.appendChild(el);
        menu.enterMenuMode(() => this.closeMatchMenu());
        el.querySelector('#mm-keep').onclick = () => this.closeMatchMenu();
        el.querySelector('#mm-leave').onclick = () => {
            el.remove();
            const wasHost = mp.isHost && !!this.match;
            if (this.match) this.match.leave();
            menu.abortGameplay();
            this.endMatch();
            // the host leaving ends the match for everyone (after we're out of it ourselves)
            if (wasHost) mp.abortMatch().catch(() => {});
            this.showLobby();
        };
    }

    // the host left mid-match (or called it off): everyone goes back to the lobby
    matchAborted() {
        const m = this.match, L = mp.lobby;
        if (!m || !L || !mp.lobbyId) return false;
        if (L.game && L.game.round === m.round && L.game.aborted) return true;
        const host = m.game.host;
        if (!host) return false;
        // someone else runs the lobby now (the match's host left, or dropped off and was replaced)
        if (L.info && L.info.host && L.info.host !== host) return true;
        return host !== mp.uid && !!L.members && !L.members[host];
    }

    abortToLobby() {
        const menu = this.menu;
        document.querySelectorAll('.mp-match-menu').forEach(m => m.remove());
        if (this.match) this.match.stop();
        if (menu.gameplay) menu.abortGameplay();
        const wasHost = this.match && this.match.game.host === mp.uid;
        this.endMatch();
        if (mp.isHost) mp.endMatch().catch(() => {});
        toast(wasHost ? 'You lost the connection, so the match ended — everyone is back in the lobby' : 'The host left the match — everyone is back in the lobby', 'error');
        if (mp.lobbyId) this.showLobby(); else this.showBrowser();
    }

    closeMatchMenu() {
        document.querySelectorAll('.mp-match-menu').forEach(m => m.remove());
        cursor.disable();
        const hb = $('hint-bar');
        if (hb) hb.classList.add('hidden');
    }

    endMatch() {
        if (this.match) this.match.stop();
        this.match = null;
        this.menu.match = null;
        if (mp.lobbyId) mp.setState('lobby');
    }

    // my song is over: the standings (they keep updating while others finish)
    showResults(match, results, isNewBest) {
        const menu = this.menu;
        this.closeMatchMenu();
        menu.setScreen(`
        <div class="screen panel-screen">
            <div class="panel mp-panel mp-results">
                <div class="panel-header"><div class="panel-title">MATCH RESULTS</div>
                    <div class="mp-res-level">${esc(match.game.level.songName)} · ${esc(diffLabel(match.game.difficulty))}</div></div>
                <div class="panel-body">
                    <div class="mp-res-me">
                        ${results.failed ? '<div class="result-title failed">FAILED</div>' : `<div class="result-rank">${esc(results.rank)}</div>`}
                        <div class="result-grid">
                            <div class="result-stat"><div class="val ${isNewBest ? 'new-hs' : ''}">${results.score.toLocaleString()}</div><div class="lbl">${isNewBest ? 'New Best!' : 'Your Score'}</div></div>
                            <div class="result-stat"><div class="val">${(results.accuracy * 100).toFixed(1)}%</div><div class="lbl">Accuracy</div></div>
                            <div class="result-stat"><div class="val">${results.maxCombo}</div><div class="lbl">Max Combo</div></div>
                            <div class="result-stat"><div class="val" id="mp-place">—</div><div class="lbl">Place</div></div>
                        </div>
                    </div>
                    <div class="mp-col-title">Standings</div>
                    <div id="mp-rank" class="mp-rank"></div>
                    <div class="menu-buttons" style="width:100%"><button class="btn primary" id="mp-back">Back to Lobby</button></div>
                </div>
            </div>
        </div>`);
        this.screen = 'results';
        menu.enterMenuMode(() => this.backToLobby());
        $('mp-back').onclick = () => this.backToLobby();
        const render = (rows) => {
            const box = $('mp-rank');
            if (!box) return;
            const place = rows.findIndex(r => r.me) + 1;
            $('mp-place').textContent = place ? `${place} / ${rows.length}` : '—';
            box.innerHTML = rows.map((r, i) => `
                <div class="mp-rank-row ${r.me ? 'me' : ''}">
                    <span class="mp-pos">${i + 1}</span>
                    <span class="mp-name">${esc(r.name)}</span>
                    <span class="mp-score">${r.score.toLocaleString()}</span>
                    <span class="mp-acc">${(r.acc * 100).toFixed(1)}%</span>
                    <span class="mp-state">${r.left ? 'left' : r.failed ? 'failed' : r.done ? (r.fullCombo ? 'FC · ' : '') + esc(r.rank || '') : `playing… ${Math.round(r.progress * 100)}%`}</span>
                </div>`).join('');
        };
        match.onLiveChange = render;
        render(match.ranking());
        menu._cleanup = () => { if (this.screen === 'results') this.screen = null; };
    }

    backToLobby() {
        const wasHost = mp.isHost;
        this.endMatch();
        if (wasHost) mp.endMatch().catch(() => {});
        if (mp.lobbyId) this.showLobby(); else this.showBrowser();
    }
}
