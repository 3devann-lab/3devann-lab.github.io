// ============ BeatLeader: player search, scores, leaderboards, replays ============
// BeatLeader's API (api.beatleader.xyz / .com) only answers browsers on its own
// sites and on localhost dev ports. Anywhere else (like evanblokender.org)
// requests have to go through a relay: your own proxy if you set one up
// (Settings → BeatLeader Proxy, see proxy/README.md), otherwise free public
// CORS relays, raced in parallel. Replay files (cdn.replays.beatleader.*) and
// the live-scores WebSocket allow any origin, so watching never needs a relay.
import { settings } from './settings.js';

const API = 'https://api.beatleader.xyz';
const REPLAY_CDN = 'https://cdn.replays.beatleader.xyz';
const LIVE_SOCKET = 'wss://sockets.api.beatleader.xyz/scores';

const enc = encodeURIComponent;
// kind 'json': the body is BeatLeader's JSON; 'wrapped': {contents: "<json text>", status: {http_code}}
const PUBLIC_RELAYS = [
    { id: 'allorigins', label: 'allorigins', kind: 'wrapped', make: (u) => `https://api.allorigins.win/get?url=${enc(u)}` },
    { id: 'allorigins-raw', label: 'allorigins (raw)', kind: 'json', make: (u) => `https://api.allorigins.win/raw?url=${enc(u)}` },
    { id: 'codetabs', label: 'codetabs', kind: 'json', make: (u) => `https://api.codetabs.com/v1/proxy/?quest=${enc(u)}` },
    { id: 'cors-eu', label: 'cors.eu.org', kind: 'json', make: (u) => `https://cors.eu.org/${u}` },
];
const DIRECT = { id: 'direct', label: 'direct', kind: 'json', make: (u) => u };

// people paste "my-proxy.workers.dev" without the scheme
export function normalizeProxyUrl(raw) {
    let p = String(raw || '').trim();
    if (!p) return '';
    if (!/^https?:\/\//i.test(p)) p = 'https://' + p;
    return p;
}

function customRoute() {
    const p = normalizeProxyUrl(settings.get('blProxy'));
    if (!p) return null;
    return {
        id: 'custom', label: 'your proxy', kind: 'json',
        // a generic relay with a {url} placeholder, or a forwarding worker's base URL
        make: (u, path) => (p.includes('{url}') ? p.replace('{url}', enc(u)) : p.replace(/\/+$/, '') + path),
    };
}

function httpError(status) {
    const e = new Error(status === 404 ? 'not found' : status === 429 ? 'rate limited' : `HTTP ${status}`);
    e.status = status;
    return e;
}

async function fetchJson(url, kind, ms, signal) {
    const ctl = new AbortController();
    const abort = () => ctl.abort();
    if (signal) {
        if (signal.aborted) abort();
        else signal.addEventListener('abort', abort, { once: true });
    }
    const timer = setTimeout(abort, ms);
    try {
        const res = await fetch(url, { signal: ctl.signal });
        if (!res.ok) throw httpError(res.status);
        let data = await res.json();                 // relay error pages (HTML) throw here
        if (kind === 'wrapped') {
            const code = data && data.status && data.status.http_code;
            if (code && code >= 400) throw httpError(code);
            if (!data || typeof data.contents !== 'string' || !data.contents) throw new Error('empty relay response');
            data = JSON.parse(data.contents);
        }
        if (!data || typeof data !== 'object') throw new Error('unexpected response');
        return data;
    } catch (e) {
        if (e.name === 'AbortError') throw new Error(signal && signal.aborted ? 'cancelled' : 'timed out');
        if (e instanceof SyntaxError) throw new Error('relay returned an error page');
        if (e instanceof TypeError && !e.status) throw new Error('blocked by the browser (CORS) or offline');
        throw e;
    } finally {
        clearTimeout(timer);
        if (signal) signal.removeEventListener('abort', abort);
    }
}

export class BeatLeaderUnreachable extends Error {}

// Remember which route worked (for a day) so later requests go straight there
let preferred = null;
try {
    const saved = JSON.parse(localStorage.getItem('saber3d_bl_route') || 'null');
    if (saved && Date.now() - saved.t < 86400000) preferred = saved.id;
} catch (e) { /* storage blocked */ }
function remember(id) {
    if (preferred === id) return;
    preferred = id;
    try { localStorage.setItem('saber3d_bl_route', JSON.stringify({ id, t: Date.now() })); } catch (e) { /* ignore */ }
}

const memo = new Map();           // path -> {t, data}; lists don't change by the second
const MEMO_MS = 3 * 60 * 1000;

async function blGet(path) {
    const hit = memo.get(path);
    if (hit && Date.now() - hit.t < MEMO_MS) return hit.data;
    const data = await fetchViaRoutes(path);
    memo.set(path, { t: Date.now(), data });
    if (memo.size > 100) memo.delete(memo.keys().next().value);
    return data;
}

async function fetchViaRoutes(path) {
    const url = API + path;
    const errors = [];
    let notFound = false;
    const attempt = async (r, ms, signal) => {
        try {
            const data = await fetchJson(r.make(url, path), r.kind, ms, signal);
            remember(r.id);
            return data;
        } catch (e) {
            if (e.status === 404) notFound = true;
            if (e.message !== 'cancelled') errors.push(`${r.label}: ${e.message}`);
            throw e;
        }
    };

    const custom = customRoute();
    const ordered = custom ? [custom, DIRECT] : [DIRECT];
    const all = [...ordered, ...PUBLIC_RELAYS];
    const pref = all.find(r => r.id === preferred) || null;

    // 1. whatever worked last time
    if (pref) {
        try { return await attempt(pref, PUBLIC_RELAYS.includes(pref) ? 15000 : 10000); }
        catch (e) { if (notFound) throw new Error('Not found on BeatLeader'); }
    }
    // 2. your proxy, then a direct call (works on BeatLeader's own sites and localhost dev ports)
    for (const r of ordered) {
        if (r === pref) continue;
        try { return await attempt(r, r === custom ? 12000 : 6000); }
        catch (e) { if (notFound) throw new Error('Not found on BeatLeader'); }
    }
    // 3. public relays, raced — first good answer wins, the rest are cancelled
    const relays = PUBLIC_RELAYS.filter(r => r !== pref);
    const ctl = new AbortController();
    try {
        const data = await Promise.any(relays.map(r => attempt(r, 15000, ctl.signal)));
        ctl.abort();
        return data;
    } catch (e) {
        if (notFound) throw new Error('Not found on BeatLeader');
    }
    const err = new BeatLeaderUnreachable(customRoute()
        ? 'Couldn\'t reach BeatLeader through your proxy. Open Settings and press Test next to BeatLeader Proxy to see what\'s wrong.'
        : 'Player and level search can\'t load on this site yet. BeatLeader only lets its own website read player and level data, '
          + 'and the free public relays aren\'t answering. Set up your own free proxy (about 2 minutes, see Settings → BeatLeader Proxy) '
          + 'and search will work every time.');
    err.details = errors;
    throw err;
}

// Settings → "Test": check just your proxy
export async function testProxy() {
    const r = customRoute();
    if (!r) return { ok: false, error: 'No proxy URL set' };
    const t = performance.now();
    try {
        const d = await fetchJson(r.make(API + '/players?search=a&count=1', '/players?search=a&count=1'), 'json', 12000);
        if (!Array.isArray(d.data)) throw new Error('that URL answered, but not with BeatLeader data');
        return { ok: true, ms: Math.round(performance.now() - t) };
    } catch (e) {
        return { ok: false, error: e.message };
    }
}

// ---------- normalizers ----------
function normPlayer(p) {
    return {
        id: String(p.id),
        name: p.name || 'Unknown',
        avatar: p.avatar || '',
        country: p.country || '',
        rank: p.rank || 0,
        pp: p.pp || 0,
    };
}

function normSong(song) {
    song = song || {};
    return {
        hash: String(song.hash || '').toLowerCase(),
        name: song.name || 'Unknown song',
        subName: song.subName || '',
        author: song.author || '',
        mapper: song.mapper || '',
        cover: song.coverImage || song.fullCoverImage || '',
        bpm: song.bpm || 0,
        duration: song.duration || 0,
        downloadUrl: song.downloadUrl || '',
    };
}

function normDiff(d) {
    d = d || {};
    return {
        name: d.difficultyName || 'Expert',
        mode: d.modeName || 'Standard',
        stars: d.stars || 0,
        njs: d.njs || 0,
        value: d.value || 0,
    };
}

function normScore(s, lb, player) {
    lb = lb || s.leaderboard || {};
    const song = normSong(lb.song);
    const diff = normDiff(lb.difficulty);
    const pl = player || (s.player ? normPlayer(s.player) : null);
    return {
        id: s.id,
        playerId: String(s.playerId || (pl && pl.id) || ''),
        playerName: pl ? pl.name : '',
        playerAvatar: pl ? pl.avatar : '',
        accuracy: s.accuracy || 0,
        score: s.modifiedScore || s.baseScore || 0,
        pp: s.pp || 0,
        rank: s.rank || 0,
        fullCombo: !!s.fullCombo,
        misses: (s.missedNotes || 0) + (s.badCuts || 0),
        modifiers: s.modifiers || '',
        timeset: Number(s.timeset) || 0,
        replay: s.replay || null,
        song, diff,
    };
}

// ---------- public API ----------
export async function searchPlayers(query, page = 1) {
    const q = encodeURIComponent(query.trim());
    const d = await blGet(`/players?search=${q}&page=${page}&count=24&sortBy=pp&order=desc`);
    return {
        total: d.metadata ? d.metadata.total : 0,
        players: (d.data || []).map(normPlayer),
    };
}

export async function getPlayerScores(player, { search = '', sortBy = 'date', page = 1 } = {}) {
    const q = search.trim() ? `&search=${encodeURIComponent(search.trim())}` : '';
    const d = await blGet(`/player/${encodeURIComponent(player.id)}/scores?sortBy=${sortBy}&order=desc&page=${page}&count=20${q}`);
    return {
        total: d.metadata ? d.metadata.total : 0,
        scores: (d.data || []).map(s => normScore(s, null, player)),
    };
}

// Leaderboards matching a search, grouped by song (one card per map version)
export async function searchLevels(query, page = 1) {
    const q = encodeURIComponent(query.trim());
    const d = await blGet(`/leaderboards?search=${q}&page=${page}&count=40&sortBy=playcount&order=desc`);
    const bySong = new Map();
    for (const lb of (d.data || [])) {
        const song = normSong(lb.song);
        const key = song.hash || lb.id;
        if (!bySong.has(key)) bySong.set(key, { song, diffs: [] });
        bySong.get(key).diffs.push({ id: lb.id, plays: lb.plays || 0, ...normDiff(lb.difficulty) });
    }
    const order = { Easy: 1, Normal: 2, Hard: 3, Expert: 4, ExpertPlus: 5 };
    for (const g of bySong.values()) {
        g.diffs.sort((a, b) => (a.mode === b.mode ? 0 : a.mode === 'Standard' ? -1 : 1) || (order[a.name] || 0) - (order[b.name] || 0));
    }
    return { total: d.metadata ? d.metadata.total : 0, levels: [...bySong.values()] };
}

export async function getLeaderboard(id, page = 1) {
    const d = await blGet(`/leaderboard/${encodeURIComponent(id)}?page=${page}&count=20`);
    const lb = { song: d.song, difficulty: d.difficulty };
    return {
        song: normSong(d.song),
        diff: normDiff(d.difficulty),
        total: d.plays || 0,
        scores: (d.scores || []).map(s => normScore(s, lb)),
    };
}

// Replay URL for a score: use the API's value, else build the CDN name
export async function getReplayUrl(score) {
    if (score.replay) return score.replay;
    if (score.song && score.song.hash && score.playerId) {
        return `${REPLAY_CDN}/${score.id}-${score.playerId}-${score.diff.name}-${score.diff.mode}-${score.song.hash.toUpperCase()}.bsor`;
    }
    const d = await blGet(`/score/${encodeURIComponent(score.id)}`);
    if (!d.replay) throw new Error('This score has no replay');
    return d.replay;
}

export async function getScoreById(id) {
    const d = await blGet(`/score/${encodeURIComponent(id)}`);
    return normScore(d, d.leaderboard, d.player ? normPlayer(d.player) : null);
}

export async function fetchReplay(url, onProgress = () => {}) {
    // the replay CDN allows any origin; stream for a progress bar
    const res = await fetch(url);
    if (!res.ok) {
        const err = new Error(res.status === 404 ? 'Replay file not found' : `Replay download failed (${res.status})`);
        err.status = res.status;
        throw err;
    }
    const total = Number(res.headers.get('content-length')) || 0;
    if (!res.body || !total) return await res.arrayBuffer();
    const reader = res.body.getReader();
    const buf = new Uint8Array(total);
    let got = 0;
    for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        if (got + value.length > buf.length) {        // server lied about size
            const chunks = [buf.slice(0, got), value];
            for (;;) { const r = await reader.read(); if (r.done) break; chunks.push(r.value); }
            return await new Blob(chunks).arrayBuffer();
        }
        buf.set(value, got);
        got += value.length;
        onProgress(got / total);
    }
    return buf.buffer.slice(0, got);
}

// Accepts a .bsor URL, a replay.beatleader.xyz link, a beatleader.xyz score
// link, or a bare score id.
export function parseReplayLink(text) {
    const s = String(text || '').trim();
    if (!s) return null;
    if (/^\d+$/.test(s)) return { scoreId: s };
    let u;
    try { u = new URL(s); } catch (e) { return null; }
    if (/\.bsor($|\?)/i.test(u.pathname + u.search)) return { url: u.href };
    const link = u.searchParams.get('link');
    if (link && /\.bsor/i.test(link)) return { url: link };
    const sid = u.searchParams.get('scoreId');
    if (sid && /^\d+$/.test(sid)) return { scoreId: sid };
    const m = u.pathname.match(/score\/(\d+)/i);
    if (m) return { scoreId: m[1] };
    return null;
}

export function countryFlag(code) {
    if (!code || code.length !== 2) return '';
    const A = 0x1f1e6;
    return String.fromCodePoint(A + code.toUpperCase().charCodeAt(0) - 65, A + code.toUpperCase().charCodeAt(1) - 65);
}

// ---------- live scores (no relay needed) ----------
// BeatLeader pushes every new score over a WebSocket, and WebSockets aren't
// subject to CORS, so this works on any site. One shared connection, kept
// open briefly after the last listener leaves so tab switches are smooth.
class LiveScores {
    constructor() {
        this.scores = [];            // newest first
        this.listeners = new Set();
        this.state = 'idle';         // idle | connecting | live | reconnecting
        this.ws = null;
        this.retry = 0;
    }

    subscribe(fn) {
        this.listeners.add(fn);
        clearTimeout(this.closeTimer);
        this.connect();
        fn({ type: 'state', state: this.state });
        return () => {
            this.listeners.delete(fn);
            if (!this.listeners.size) {
                this.closeTimer = setTimeout(() => {
                    if (this.listeners.size || !this.ws) return;
                    const ws = this.ws;
                    this.ws = null;
                    ws.onclose = null;
                    ws.close();
                    this.setState('idle');
                }, 30000);
            }
        };
    }

    emit(ev) { for (const fn of this.listeners) fn(ev); }
    setState(state) { this.state = state; this.emit({ type: 'state', state }); }

    connect() {
        if (this.ws) return;
        this.setState(this.retry ? 'reconnecting' : 'connecting');
        let ws;
        try { ws = new WebSocket(LIVE_SOCKET); } catch (e) { this.scheduleRetry(); return; }
        this.ws = ws;
        ws.onopen = () => { this.retry = 0; this.setState('live'); };
        ws.onmessage = (m) => {
            let d;
            try { d = JSON.parse(m.data); } catch (e) { return; }
            if (!d || !d.replay || !d.leaderboard) return;
            const s = normScore(d, d.leaderboard, d.player ? normPlayer(d.player) : null);
            s.live = true;
            this.scores.unshift(s);
            if (this.scores.length > 80) this.scores.length = 80;
            this.emit({ type: 'score', score: s });
        };
        ws.onclose = () => {
            if (this.ws !== ws) return;
            this.ws = null;
            if (this.listeners.size) this.scheduleRetry();
            else this.setState('idle');
        };
        ws.onerror = () => { /* onclose follows */ };
    }

    scheduleRetry() {
        this.retry++;
        this.setState('reconnecting');
        const wait = [1000, 2000, 5000, 10000, 20000][Math.min(4, this.retry - 1)];
        clearTimeout(this.retryTimer);
        this.retryTimer = setTimeout(() => { if (this.listeners.size) this.connect(); }, wait);
    }
}

export const liveScores = new LiveScores();

// does a score match a free-text filter (player name or song/artist/mapper)?
export function scoreMatches(s, q) {
    q = String(q || '').trim().toLowerCase();
    if (!q) return true;
    return [s.playerName, s.song.name, s.song.author, s.song.mapper].some(v => String(v || '').toLowerCase().includes(q));
}
