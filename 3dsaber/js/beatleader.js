// ============ BeatLeader: player search, scores, leaderboards, replays ============
// api.beatleader.xyz only sends CORS headers to beatleader.xyz itself, so a
// page hosted anywhere else can't call it directly. Requests try, in order:
// a remembered working route, your own proxy (Settings → BeatLeader proxy,
// see proxy/README.md), a direct call, then public CORS proxies.
// Replay files come from cdn.replays.beatleader.xyz, which allows any origin.
import { settings } from './settings.js';

const API = 'https://api.beatleader.xyz';
const REPLAY_CDN = 'https://cdn.replays.beatleader.xyz';

const PUBLIC_PROXIES = [
    { id: 'corsproxy', make: (u) => `https://corsproxy.io/?url=${encodeURIComponent(u)}` },
    { id: 'allorigins', make: (u) => `https://api.allorigins.win/raw?url=${encodeURIComponent(u)}` },
    { id: 'codetabs', make: (u) => `https://api.codetabs.com/v1/proxy/?quest=${encodeURIComponent(u)}` },
];

let workingRoute = null;
try { workingRoute = sessionStorage.getItem('saber3d_bl_route'); } catch (e) { /* storage blocked */ }

function customProxyRoute() {
    const p = String(settings.get('blProxy') || '').trim();
    if (!p) return null;
    return {
        id: 'custom',
        // either a generic proxy with a {url} placeholder, or a forwarding worker base URL
        make: (u, path) => (p.includes('{url}')
            ? p.replace('{url}', encodeURIComponent(u))
            : p.replace(/\/+$/, '') + path),
    };
}

async function fetchWithTimeout(url, ms, asJson = true) {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), ms);
    try {
        const res = await fetch(url, { signal: ctl.signal });
        if (!res.ok) {
            const err = new Error(`HTTP ${res.status}`);
            err.status = res.status;
            throw err;
        }
        return asJson ? await res.json() : await res.arrayBuffer();
    } finally {
        clearTimeout(timer);
    }
}

export class BeatLeaderUnreachable extends Error {}

async function blGet(path) {
    const url = API + path;
    const routes = [];
    const custom = customProxyRoute();
    if (custom) routes.push(custom);
    routes.push({ id: 'direct', make: (u) => u });
    routes.push(...PUBLIC_PROXIES);
    if (workingRoute) {
        const i = routes.findIndex(r => r.id === workingRoute);
        if (i > 0) routes.unshift(routes.splice(i, 1)[0]);
    }

    let lastErr = null;
    for (const r of routes) {
        try {
            const data = await fetchWithTimeout(r.make(url, path), r.id === 'direct' ? 8000 : 9000);
            if (workingRoute !== r.id) {
                workingRoute = r.id;
                try { sessionStorage.setItem('saber3d_bl_route', r.id); } catch (e) { /* ignore */ }
            }
            return data;
        } catch (e) {
            // a real API answer (e.g. 404 for an unknown id) is final
            if (e.status === 404 && (r.id === 'direct' || r.id === 'custom')) throw new Error('Not found on BeatLeader');
            lastErr = e.name === 'AbortError' ? new Error('timed out') : e;
        }
    }
    throw new BeatLeaderUnreachable(
        'Couldn\'t reach BeatLeader from this page' + (lastErr ? ` (${lastErr.message})` : '') +
        '. Add your own proxy in Settings → BeatLeader Proxy, or open a .bsor replay file instead.');
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
