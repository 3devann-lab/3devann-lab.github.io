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
    blProxy: '',          // BeatLeader API proxy: '' = built-in worker, a URL, or 'off' (see proxy/README.md)
    trailLength: 0.12,    // saber trail length in seconds (0 = off)

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
    replayHead: true,           // show the player's head in outside views
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
    'replayHead', 'replaySkipIntro', 'replayShowMisses', 'replayCutHalves', 'replaySparks', 'trailLength', 'freeCam'];
export const defaultSetting = (key) => DEFAULTS[key];
export const ALL_KEYS = Object.keys(DEFAULTS);
export const CONTROL_KEYS = ['stickDeadzone', 'stickRange', 'stickCurve', 'stickSquare', 'saberReachX', 'saberReachY',
    'saberRestHeight', 'saberRestSpread', 'saberSmoothing', 'saberTilt', 'swapSticks', 'invertY', 'rumble'];
export const MOD_KEYS = ['modSpeed', 'modNoArrows', 'modGhost', 'modDisappear', 'modNoBombs', 'modNoWalls',
    'modInstantFail', 'modSmallNotes', 'modStrict'];
export const PLAY_KEYS = ['audioOffset', 'hitSound', 'missSound', 'noteSize', 'judgeStyle', 'hitParticles', 'cutHalves'];
export const VISUAL_KEYS = ['lightBrightness', 'reduceFlashing', 'hudScale', 'hudOpacity', 'hudTimer', 'showFps'];

class Settings {
    constructor() {
        this.data = { ...DEFAULTS };
        try {
            const saved = JSON.parse(localStorage.getItem('saber3d_settings') || '{}');
            Object.assign(this.data, saved);
        } catch (e) { /* fresh start */ }
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
        try { localStorage.setItem('saber3d_settings', JSON.stringify(this.data)); } catch (e) { /* private mode */ }
    }
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
