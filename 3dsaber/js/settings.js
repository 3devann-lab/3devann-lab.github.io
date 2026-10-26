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
    safeMode: true,       // drop to light graphics if a map overloads the GPU
    memorySaver: 'auto',  // stream songs + small render buffers: auto (consoles, low-memory devices) / on / off
    blProxy: '',          // BeatLeader API proxy: '' = built-in worker, a URL, or 'off' (see proxy/README.md)
    trailLength: 0.12,    // saber trail length in seconds (0 = off)

    // your look (Customize): other players see these in multiplayer
    saberStyle: 'classic', // classic / beam / katana / pixel / crystal
    saberHilt: 'standard', // standard / long / guard / ring
    saberGlow: 1,          // 0–2
    avatar: null,          // looks.js DEFAULT_AVATAR when unset

    // thumbstick → saber (the stick places the blade's cutting point on the note grid)
    stickDeadzone: 0.1,   // radial, 0..1
    stickRange: 0.94,     // how far you must push for "full tilt"
    stickCurve: 1,        // 1 = linear, >1 = finer near centre
    stickSquare: true,    // diagonals reach the grid corners
    saberReachX: 1.2,     // metres from rest at full tilt (lanes are 0.6 m apart)
    saberReachY: 0.8,
    saberRestHeight: 1.4, // middle note row
    saberRestSpread: 0.3, // rest spots at ±0.3 m: each saber sits on its inner lane
    saberSmoothing: 0.012, // seconds; 0 = raw stick
    saberTilt: 29,        // degrees the blade leans toward the notes
    swapSticks: false,
    invertY: false,
    rumble: 1,

    // modifiers (normal play; picked on the difficulty screen)
    modSpeed: 1,          // song speed 0.5–2
    modNoArrows: false,
    modGhost: false,      // note bodies invisible, arrows only
    modDisappear: false,  // arrows vanish before the note arrives
    modNoBombs: false,
    modNoWalls: false,
    modInstantFail: false,
    modSmallNotes: false,
    modStrict: false,     // cutting against the arrow is a bad cut

    // sound
    audioOffset: 0,       // ms: + if hits sound late (Bluetooth headphones), - if early
    hitSound: 'soft',     // soft (synth) / classic (sample) / off
    missSound: true,

    // look & HUD
    noteSize: 1,
    judgeStyle: 'words',  // words (PERFECT) / numbers (115) / off
    hitParticles: 1,      // spark amount 0–2
    cutHalves: true,      // cut notes split into two halves
    lightBrightness: 1,
    reduceFlashing: false, // no strobes: light changes glide (photosensitivity)
    hudScale: 1,
    hudOpacity: 1,
    hudTimer: true,
    showFps: false,

    // play camera (normal play, and the replay third-person view)
    camFov: 72,
    camHeight: 1.85,      // metres above the floor
    camDistance: 5.6,     // metres behind the sabers
    camTilt: 3,           // degrees looking down

    // replay first-person camera (the player's own head)
    fpFov: 80,
    fpPosSmooth: 0.2,     // 0 = raw head movement, 1 = very smooth
    fpRotSmooth: 0.3,
    fpLevelHorizon: false, // remove head roll (tilt) so the horizon stays level
    fpOffsetBack: 0,      // pull the view back behind the head (metres)
    fpOffsetUp: 0,

    // replay follow camera (chases the player's head from behind)
    followDistance: 1.8,
    followHeight: 0.5,
    followSmooth: 0.6,

    // replays
    replayCamera: 'third',      // first / third / follow / free
    replayHud: true,
    replayCutText: 'total',     // total / split (pre·acc·post) / off
    replayHitSounds: true,
    replayStats: true,          // live per-hand accuracy overlay
    replayBody: 'avatar',       // who stands where the player was in outside views: avatar (yours) / head / off
    replaySkipIntro: true,      // start a moment before the first note
    replayShowMisses: true,     // red marks on the timeline
    replayCutHalves: true,      // cut notes split into halves while watching
    replaySparks: true,         // cut / bomb sparks while watching
    freeCam: null,              // last free-camera position {tx,ty,tz,yaw,pitch,dist}
};

// Every camera / replay option, with its default (for "Reset to defaults")
export const CAMERA_KEYS = ['camFov', 'camHeight', 'camDistance', 'camTilt',
    'fpFov', 'fpPosSmooth', 'fpRotSmooth', 'fpLevelHorizon', 'fpOffsetBack', 'fpOffsetUp',
    'followDistance', 'followHeight', 'followSmooth'];
export const REPLAY_KEYS = ['replayCamera', 'replayHud', 'replayCutText', 'replayHitSounds', 'replayStats',
    'replayBody', 'replaySkipIntro', 'replayShowMisses', 'replayCutHalves', 'replaySparks', 'trailLength', 'freeCam'];
export const defaultSetting = (key) => DEFAULTS[key];
export const ALL_KEYS = Object.keys(DEFAULTS);
// your saber style and avatar (Reset All leaves them alone)
export const LOOK_KEYS = ['saberStyle', 'saberHilt', 'saberGlow', 'avatar'];
export const CONTROL_KEYS = ['stickDeadzone', 'stickRange', 'stickCurve', 'stickSquare', 'saberReachX', 'saberReachY',
    'saberRestHeight', 'saberRestSpread', 'saberSmoothing', 'saberTilt', 'swapSticks', 'invertY', 'rumble'];
export const MOD_KEYS = ['modSpeed', 'modNoArrows', 'modGhost', 'modDisappear', 'modNoBombs', 'modNoWalls',
    'modInstantFail', 'modSmallNotes', 'modStrict'];
export const PLAY_KEYS = ['audioOffset', 'hitSound', 'missSound', 'noteSize', 'judgeStyle', 'hitParticles', 'cutHalves'];
export const VISUAL_KEYS = ['lightBrightness', 'reduceFlashing', 'hudScale', 'hudOpacity', 'hudTimer', 'showFps'];

// ---------- where settings live ----------
// Guests: a browser cookie (only what differs from the defaults, so it stays
// small) with local storage as a backup. Signed in: the account (account.js
// hands over the saved values and a function that writes them back).
const GUEST_KEY = 'saber3d_settings';
const COOKIE_MAX = 3800;

export function readCookie(name) {
    const m = document.cookie.match(new RegExp('(?:^|; )' + name.replace(/[.$?*|{}()[\]\\/+^]/g, '\\$&') + '=([^;]*)'));
    return m ? decodeURIComponent(m[1]) : null;
}
export function writeCookie(name, value, days = 365) {
    const v = encodeURIComponent(value);
    if (v.length > COOKIE_MAX) return false;
    document.cookie = `${name}=${v}; max-age=${days * 86400}; path=/; SameSite=Lax`;
    return true;
}
export function deleteCookie(name) { document.cookie = `${name}=; max-age=0; path=/; SameSite=Lax`; }

class Settings {
    constructor() {
        this.mode = 'guest';
        this._save = null;
        this.loadGuest();
    }
    loadGuest() {
        this.data = { ...DEFAULTS };
        try { Object.assign(this.data, JSON.parse(readCookie(GUEST_KEY) || '{}')); } catch (e) { /* bad cookie */ }
        try { Object.assign(this.data, JSON.parse(localStorage.getItem(GUEST_KEY) || '{}')); } catch (e) { /* fresh start */ }
    }
    // switch to an account's settings; save(values) writes them to the account
    useAccount(saved, save) {
        this.mode = 'account';
        this._save = save;
        this.data = { ...DEFAULTS, ...(saved || {}) };
    }
    useGuest() {
        this.mode = 'guest';
        this._save = null;
        this.loadGuest();
    }
    // only the values that differ from the defaults
    changedValues() {
        const out = {};
        for (const k in this.data) {
            const v = this.data[k];
            if (k in DEFAULTS && JSON.stringify(v) === JSON.stringify(DEFAULTS[k])) continue;
            out[k] = v;
        }
        return out;
    }
    persist() {
        if (this.mode === 'account' && this._save) { this._save(this.changedValues()); return; }
        try { localStorage.setItem(GUEST_KEY, JSON.stringify(this.data)); } catch (e) { /* private mode */ }
        try {
            if (!writeCookie(GUEST_KEY, JSON.stringify(this.changedValues()))) deleteCookie(GUEST_KEY);
        } catch (e) { /* cookies blocked */ }
    }
    get(key) { return this.data[key]; }
    // a number setting, falling back to its default when missing or invalid
    num(key, min = -Infinity, max = Infinity) {
        let v = Number(this.data[key]);
        if (!Number.isFinite(v)) v = Number(DEFAULTS[key]) || 0;
        return Math.min(max, Math.max(min, v));
    }
    reset(keys) {
        for (const k of keys) this.data[k] = DEFAULTS[k];
        this.persist();
    }
    set(key, value) {
        this.data[key] = value;
        this.persist();
    }
}

export const settings = new Settings();

// ---------- high scores ----------
// key: <mapId>_<characteristic>_<difficulty>; value: {score, accuracy, rank, maxCombo}
// Guests keep them in local storage; account.js swaps in a store backed by the account.
const HS_PREFIX = 'saber3d_hs_';
export const guestScores = {
    get(key) { try { return JSON.parse(localStorage.getItem(HS_PREFIX + key)); } catch (e) { return null; } },
    put(key, v) { try { localStorage.setItem(HS_PREFIX + key, JSON.stringify(v)); return true; } catch (e) { return false; } },
    entries() {
        const out = [];
        for (let i = 0; i < localStorage.length; i++) {
            const k = localStorage.key(i);
            if (!k || !k.startsWith(HS_PREFIX)) continue;
            try { out.push([k.slice(HS_PREFIX.length), JSON.parse(localStorage.getItem(k))]); } catch (e) { /* skip */ }
        }
        return out;
    },
};
let scoreStore = guestScores;
export function setScoreStore(store) { scoreStore = store || guestScores; }

export function getHighScore(mapId, characteristic, difficulty) {
    return scoreStore.get(`${mapId}_${characteristic}_${difficulty}`) || null;
}

export function setHighScore(mapId, characteristic, difficulty, result) {
    const prev = getHighScore(mapId, characteristic, difficulty);
    if (prev && prev.score >= result.score) return false;
    return scoreStore.put(`${mapId}_${characteristic}_${difficulty}`, {
        score: result.score,
        accuracy: result.accuracy,
        rank: result.rank,
        maxCombo: result.maxCombo,
    }) !== false;
}

// Best score per map, built in one pass (the song list used to rescan every key once per row)
export function getBestScores() {
    const best = new Map();
    for (const [rest, v] of scoreStore.entries()) {
        // key is <mapId>_<characteristic>_<difficulty>; ids may contain "_"
        const id = rest.split('_').slice(0, -2).join('_');
        const prev = best.get(id);
        if (v && (!prev || v.score > prev.score)) best.set(id, v);
    }
    return best;
}

export function getBestForMap(mapId) {
    return getBestScores().get(mapId) || null;
}
