// ============ MOSU storage: settings, scores (localStorage), custom levels (IndexedDB) ============

const DEFAULTS = {
    musicVolume: 0.8,
    sfxVolume: 0.7,
    scrollSpeed: 1.0,       // multiplies how fast notes approach
    offsetMs: 0,            // audio/input calibration
    noFail: false,
    leniency: 'normal',     // normal | relaxed
    effects: 'high',        // high | low
    unlockAll: false,
};

function readJSON(key, fallback) {
    try { const v = JSON.parse(localStorage.getItem(key)); return v ?? fallback; } catch (e) { return fallback; }
}
function writeJSON(key, v) {
    try { localStorage.setItem(key, JSON.stringify(v)); } catch (e) { /* storage full / private mode */ }
}

export const settings = {
    data: { ...DEFAULTS, ...readJSON('mosu_settings', {}) },
    get(k) { return this.data[k]; },
    set(k, v) { this.data[k] = v; writeJSON('mosu_settings', this.data); },
};

const scores = readJSON('mosu_scores', {});
export function getBest(levelId) { return scores[levelId] || null; }
export function saveResult(levelId, r) {
    const prev = scores[levelId];
    const isBest = !prev || r.score > prev.score;
    scores[levelId] = {
        score: Math.max(r.score, prev ? prev.score : 0),
        accuracy: Math.max(r.accuracy, prev ? prev.accuracy : 0),
        grade: isBest ? r.grade : prev.grade,
        maxCombo: Math.max(r.maxCombo, prev ? prev.maxCombo : 0),
        cleared: (prev && prev.cleared) || !r.failed,
        fc: (prev && prev.fc) || (!r.failed && r.misses === 0),
        plays: (prev ? prev.plays || 0 : 0) + 1,
    };
    writeJSON('mosu_scores', scores);
    return isBest;
}

// ---------- custom levels ----------
let dbp = null;
function db() {
    if (dbp) return dbp;
    dbp = new Promise((resolve, reject) => {
        const r = indexedDB.open('mosu', 1);
        r.onupgradeneeded = () => r.result.createObjectStore('levels', { keyPath: 'id' });
        r.onsuccess = () => resolve(r.result);
        r.onerror = () => { dbp = null; reject(r.error); };
    });
    return dbp;
}
function tx(mode, fn) {
    return db().then(d => new Promise((resolve, reject) => {
        const t = d.transaction('levels', mode);
        const req = fn(t.objectStore('levels'));
        t.oncomplete = () => resolve(req && req.result);
        t.onerror = () => reject(t.error);
    }));
}

// record: {id, meta:{title, artist, bpm, approach, offset}, notes, audio: ArrayBuffer, audioName, savedAt}
export const customLevels = {
    list: () => tx('readonly', s => s.getAll()).then(r => (r || []).sort((a, b) => b.savedAt - a.savedAt)),
    get: (id) => tx('readonly', s => s.get(id)),
    put: (rec) => tx('readwrite', s => s.put({ ...rec, savedAt: Date.now() })),
    remove: (id) => tx('readwrite', s => s.delete(id)),
};
