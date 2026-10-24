// ============ Persistent settings + high scores ============

const DEFAULTS = {
    musicVolume: 0.75,
    sfxVolume: 0.9,
    leftColor: '#ff2d55',
    rightColor: '#2d7dff',
    noteSpeed: 1.0,       // note speed multiplier
    noFail: false,
    bloom: true,
    bloomStrength: 0.5,   // glow intensity
    aimAssist: 0.6,       // 0 = off, 1 = strong magnetism
    wallDistortion: true, // real-time energy-field shader on walls
    cursorSpeed: 1.0,
    quality: 'auto',      // auto (dynamic resolution) / high / medium / low
    blProxy: '',          // optional CORS proxy for the BeatLeader API (see proxy/README.md)
};

class Settings {
    constructor() {
        this.data = { ...DEFAULTS };
        try {
            const saved = JSON.parse(localStorage.getItem('saber3d_settings') || '{}');
            Object.assign(this.data, saved);
        } catch (e) { /* fresh start */ }
    }
    get(key) { return this.data[key]; }
    set(key, value) {
        this.data[key] = value;
        try { localStorage.setItem('saber3d_settings', JSON.stringify(this.data)); } catch (e) { /* private mode */ }
    }
}

export const settings = new Settings();

export function getHighScore(mapId, characteristic, difficulty) {
    try {
        return JSON.parse(localStorage.getItem(`saber3d_hs_${mapId}_${characteristic}_${difficulty}`));
    } catch (e) { return null; }
}

export function setHighScore(mapId, characteristic, difficulty, result) {
    const prev = getHighScore(mapId, characteristic, difficulty);
    if (prev && prev.score >= result.score) return false;
    try {
        localStorage.setItem(`saber3d_hs_${mapId}_${characteristic}_${difficulty}`, JSON.stringify({
            score: result.score,
            accuracy: result.accuracy,
            rank: result.rank,
            maxCombo: result.maxCombo,
        }));
    } catch (e) { return false; }
    return true;
}

// Best score per map, built in one pass over localStorage (the song list used
// to rescan every key once per row)
export function getBestScores() {
    const best = new Map();
    for (let i = 0; i < localStorage.length; i++) {
        const k = localStorage.key(i);
        if (!k || !k.startsWith('saber3d_hs_')) continue;
        try {
            const v = JSON.parse(localStorage.getItem(k));
            const rest = k.slice('saber3d_hs_'.length);
            // key is <mapId>_<characteristic>_<difficulty>; ids may contain "_"
            const parts = rest.split('_');
            const id = parts.slice(0, -2).join('_');
            const prev = best.get(id);
            if (v && (!prev || v.score > prev.score)) best.set(id, v);
        } catch (e) { /* skip */ }
    }
    return best;
}

export function getBestForMap(mapId) {
    return getBestScores().get(mapId) || null;
}
