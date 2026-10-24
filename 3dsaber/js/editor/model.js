// ============ Map editor: project model, timing, undo, import / export ============
// Everything in the editor is in beats (like the .dat files); seconds only
// appear at the edges (audio, preview, test play) through a BeatClock.
import { BeatClock, parseInfo, parseDifficulty, parseBpmRegions } from '../beatmap.js';

export const CHARACTERISTICS = ['Standard', 'OneSaber', 'NoArrows', 'Lawless', 'Lightshow'];
export const DIFFICULTIES = ['Easy', 'Normal', 'Hard', 'Expert', 'ExpertPlus'];
export const DIFF_LABEL = { Easy: 'Easy', Normal: 'Normal', Hard: 'Hard', Expert: 'Expert', ExpertPlus: 'Expert+' };
const DIFF_RANK = { Easy: 1, Normal: 3, Hard: 5, Expert: 7, ExpertPlus: 9 };
const DEFAULT_NJS = { Easy: 10, Normal: 10, Hard: 12, Expert: 16, ExpertPlus: 18 };

// Basic lighting lanes (v3 basicBeatmapEvents "et")
export const EVENT_LANES = [
    { et: 0, name: 'Back', kind: 'light' },
    { et: 1, name: 'Rings', kind: 'light' },
    { et: 2, name: 'Left', kind: 'light' },
    { et: 3, name: 'Right', kind: 'light' },
    { et: 4, name: 'Center', kind: 'light' },
    { et: 8, name: 'Spin', kind: 'trigger' },
    { et: 9, name: 'Zoom', kind: 'trigger' },
    { et: 12, name: 'L Spd', kind: 'speed' },
    { et: 13, name: 'R Spd', kind: 'speed' },
];
export const LIGHT_COLORS = ['blue', 'red', 'white'];
export const LIGHT_MODES = ['on', 'flash', 'fade', 'transition'];
// value i for a light event: 0 off, 1–4 blue, 5–8 red, 9–12 white (on/flash/fade/transition)
export function lightValue(color, mode) {
    if (mode === 'off') return 0;
    return LIGHT_COLORS.indexOf(color) * 4 + LIGHT_MODES.indexOf(mode) + 1;
}
export function lightParts(i) {
    if (!i || i < 1 || i > 12) return { color: null, mode: 'off' };
    return { color: LIGHT_COLORS[Math.floor((i - 1) / 4)], mode: LIGHT_MODES[(i - 1) % 4] };
}

// cut directions: 0 up, 1 down, 2 left, 3 right, 4 up-left, 5 up-right, 6 down-left, 7 down-right, 8 any
export const DIR_NAMES = ['Up', 'Down', 'Left', 'Right', 'Up-Left', 'Up-Right', 'Down-Left', 'Down-Right', 'Dot'];
const MIRROR_DIR = [0, 1, 3, 2, 5, 4, 7, 6, 8];

export function uid() {
    return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

export function emptyData() {
    return { notes: [], bombs: [], walls: [], arcs: [], chains: [], events: [], bpm: [], bookmarks: [] };
}

export function newDifficulty(characteristic = 'Standard', difficulty = 'Expert', copyFrom = null) {
    return {
        characteristic, difficulty, label: '',
        njs: DEFAULT_NJS[difficulty] || 16, offset: 0,
        data: copyFrom ? structuredClone(copyFrom.data) : emptyData(),
    };
}

export function newProject({ songName = 'Untitled', songSubName = '', songAuthor = '', levelAuthor = '', bpm = 120, songExt = 'ogg', duration = 0 } = {}) {
    return {
        id: 'p' + uid(),
        created: Date.now(),
        updated: Date.now(),
        info: {
            songName, songSubName, songAuthor, levelAuthor,
            bpm: Number(bpm) || 120,
            previewStart: Math.min(12, Math.max(0, duration / 3)), previewDuration: 10,
            environment: 'DefaultEnvironment',
        },
        song: { ext: songExt, duration },
        hasCover: false,
        diffs: [newDifficulty('Standard', 'Expert')],
        editor: { diff: 0, cursor: 0, snap: 4, zoom: 120 },
    };
}

export function diffName(d) {
    return `${d.characteristic === 'Standard' ? '' : d.characteristic + ' '}${d.label || DIFF_LABEL[d.difficulty]}`;
}

export function diffFilename(d) {
    return `${d.difficulty}${d.characteristic}.dat`;
}

export function sortDiffs(diffs) {
    const ci = (c) => { const i = CHARACTERISTICS.indexOf(c); return i < 0 ? 99 : i; };
    return diffs.sort((a, b) => (a.characteristic === b.characteristic
        ? DIFF_RANK[a.difficulty] - DIFF_RANK[b.difficulty]
        : ci(a.characteristic) - ci(b.characteristic) || a.characteristic.localeCompare(b.characteristic)));
}

// ---------- timing ----------
export function clockFor(project, diff) {
    return new BeatClock(project.info.bpm, (diff.data.bpm || []).map(e => ({ beat: e.b, bpm: e.m })));
}

// ---------- undo / redo ----------
// Each step stores a full copy of the difficulty's objects before the change:
// simple and robust, and cheap enough for maps with thousands of objects.
export class History {
    constructor(limit = 200) {
        this.limit = limit;
        this.undoStack = [];
        this.redoStack = [];
    }
    record(diffIndex, data, label) {
        this.undoStack.push({ diffIndex, data: structuredClone(data), label });
        if (this.undoStack.length > this.limit) this.undoStack.shift();
        this.redoStack.length = 0;
    }
    // returns {diffIndex, data, label} to restore, given the current data of that difficulty
    undo(currentData) {
        const step = this.undoStack.pop();
        if (!step) return null;
        this.redoStack.push({ diffIndex: step.diffIndex, data: structuredClone(currentData(step.diffIndex)), label: step.label });
        return step;
    }
    redo(currentData) {
        const step = this.redoStack.pop();
        if (!step) return null;
        this.undoStack.push({ diffIndex: step.diffIndex, data: structuredClone(currentData(step.diffIndex)), label: step.label });
        return step;
    }
    get canUndo() { return this.undoStack.length > 0; }
    get canRedo() { return this.redoStack.length > 0; }
}

// ---------- export (v3.3.0 difficulty, v2.1.0 Info.dat — what Beat Saber and ChroMapper read) ----------
const r4 = (v) => Math.round(v * 10000) / 10000;
const byBeat = (a, b) => a.b - b.b;
function withColor(obj, color) {
    if (Array.isArray(color)) obj.customData = { color: color.map(v => Math.round(v * 1000) / 1000) };
    return obj;
}

export function toV3(diff, project) {
    const D = diff.data;
    const bpmEvents = D.bpm.length
        ? [{ b: 0, m: project.info.bpm }, ...[...D.bpm].sort(byBeat).filter(e => e.b > 0).map(e => ({ b: r4(e.b), m: e.m }))]
        : [];
    const out = {
        version: '3.3.0',
        bpmEvents,
        rotationEvents: [],
        colorNotes: D.notes.map(n => withColor({ b: r4(n.b), x: n.x, y: n.y, a: n.a || 0, c: n.c, d: n.d }, n.color)).sort(byBeat),
        bombNotes: D.bombs.map(o => ({ b: r4(o.b), x: o.x, y: o.y })).sort(byBeat),
        obstacles: D.walls.map(w => withColor({ b: r4(w.b), x: w.x, y: w.y, d: r4(w.d), w: w.w, h: w.h }, w.color)).sort(byBeat),
        sliders: D.arcs.map(a => ({
            c: a.c, b: r4(a.b), x: a.x, y: a.y, d: a.d, mu: a.mu,
            tb: r4(a.tb), tx: a.tx, ty: a.ty, tc: a.tc, tmu: a.tmu, m: a.m || 0,
        })).sort(byBeat),
        burstSliders: D.chains.map(c => ({
            b: r4(c.b), x: c.x, y: c.y, c: c.c, d: c.d,
            tb: r4(c.tb), tx: c.tx, ty: c.ty, sc: c.sc, s: c.s,
        })).sort(byBeat),
        waypoints: [],
        basicBeatmapEvents: D.events.map(e => withColor({ b: r4(e.b), et: e.et, i: e.i, f: e.f ?? 1 }, e.color)).sort(byBeat),
        colorBoostBeatmapEvents: [],
        lightColorEventBoxGroups: [],
        lightRotationEventBoxGroups: [],
        lightTranslationEventBoxGroups: [],
        basicEventTypesWithKeywords: { d: [] },
        useNormalEventsAsCompatibleEvents: true,
        customData: {
            bookmarks: D.bookmarks.map(bm => ({ b: r4(bm.b), n: bm.name || '', c: bm.colorRgb || [1, 0.8, 0.2] })).sort(byBeat),
        },
    };
    return out;
}

export function usesChroma(diff) {
    const D = diff.data;
    return [D.notes, D.walls, D.events].some(list => list.some(o => Array.isArray(o.color)));
}

export function songFilename(project) {
    const ext = (project.song.ext || 'ogg').toLowerCase();
    return ext === 'ogg' || ext === 'egg' ? 'song.egg' : `song.${ext}`;
}

export function toInfoV2(project, coverName) {
    const sets = new Map();
    for (const d of sortDiffs([...project.diffs])) {
        if (!sets.has(d.characteristic)) sets.set(d.characteristic, []);
        const cd = {};
        if (d.label) cd._difficultyLabel = d.label;
        if (usesChroma(d)) cd._suggestions = ['Chroma'];
        sets.get(d.characteristic).push({
            _difficulty: d.difficulty,
            _difficultyRank: DIFF_RANK[d.difficulty],
            _beatmapFilename: diffFilename(d),
            _noteJumpMovementSpeed: d.njs,
            _noteJumpStartBeatOffset: d.offset,
            _beatmapColorSchemeIdx: 0,
            _environmentNameIdx: 0,
            _customData: cd,
        });
    }
    const I = project.info;
    return {
        _version: '2.1.0',
        _songName: I.songName,
        _songSubName: I.songSubName || '',
        _songAuthorName: I.songAuthor || '',
        _levelAuthorName: I.levelAuthor || '',
        _beatsPerMinute: I.bpm,
        _shuffle: 0,
        _shufflePeriod: 0.5,
        _previewStartTime: I.previewStart || 0,
        _previewDuration: I.previewDuration || 10,
        _songFilename: songFilename(project),
        _coverImageFilename: coverName || '',
        _environmentName: I.environment || 'DefaultEnvironment',
        _allDirectionsEnvironmentName: 'GlassDesertEnvironment',
        _songTimeOffset: 0,
        _environmentNames: [],
        _colorSchemes: [],
        _customData: { _editors: { _lastEditedBy: 'SABER3D', SABER3D: { version: '1.0.0' } } },
        _difficultyBeatmapSets: [...sets].map(([name, maps]) => ({ _beatmapCharacteristicName: name, _difficultyBeatmaps: maps })),
    };
}

// ---------- import ----------
const num = (v, f = 0) => (Number.isFinite(Number(v)) ? Number(v) : f);
const colorOf = (cd) => (cd && Array.isArray(cd.color) ? cd.color.slice(0, 4).map(Number) : (cd && Array.isArray(cd._color) ? cd._color.slice(0, 4).map(Number) : undefined));

function hasModdedData(o) {
    const cd = o && (o.customData || o._customData);
    if (!cd) return false;
    return Object.keys(cd).some(k => !/^_?color$/.test(k));
}

export function importV3(json) {
    const D = emptyData();
    let modded = 0;
    for (const n of (json.colorNotes || [])) {
        if (!n) continue;
        if (hasModdedData(n)) modded++;
        D.notes.push({ b: num(n.b), x: num(n.x), y: num(n.y), c: num(n.c) ? 1 : 0, d: clampDir(n.d), a: num(n.a), color: colorOf(n.customData) });
    }
    for (const o of (json.bombNotes || [])) if (o) { if (hasModdedData(o)) modded++; D.bombs.push({ b: num(o.b), x: num(o.x), y: num(o.y) }); }
    for (const o of (json.obstacles || [])) {
        if (!o) continue;
        if (hasModdedData(o)) modded++;
        D.walls.push({ b: num(o.b), x: num(o.x), y: num(o.y), d: num(o.d, 1), w: num(o.w, 1), h: num(o.h, 5), color: colorOf(o.customData) });
    }
    for (const a of (json.sliders || [])) {
        if (!a) continue;
        D.arcs.push({ c: num(a.c) ? 1 : 0, b: num(a.b), x: num(a.x), y: num(a.y), d: clampDir(a.d), mu: num(a.mu, 1),
            tb: num(a.tb), tx: num(a.tx), ty: num(a.ty), tc: clampDir(a.tc), tmu: num(a.tmu, 1), m: num(a.m) });
    }
    for (const c of (json.burstSliders || [])) {
        if (!c) continue;
        D.chains.push({ b: num(c.b), x: num(c.x), y: num(c.y), c: num(c.c) ? 1 : 0, d: clampDir(c.d),
            tb: num(c.tb), tx: num(c.tx), ty: num(c.ty), sc: Math.max(2, num(c.sc, 5)), s: num(c.s, 1) });
    }
    for (const e of (json.basicBeatmapEvents || [])) {
        if (!e) continue;
        D.events.push({ b: num(e.b), et: num(e.et), i: num(e.i), f: num(e.f, 1), color: colorOf(e.customData) });
    }
    for (const e of (json.bpmEvents || [])) if (e && num(e.b) > 0 && num(e.m) > 0) D.bpm.push({ b: num(e.b), m: num(e.m) });
    const cd = json.customData || {};
    for (const bm of (cd.bookmarks || cd._bookmarks || [])) {
        D.bookmarks.push({ b: num(bm.b ?? bm._time), name: String(bm.n ?? bm._name ?? '') });
    }
    const firstBpm = (json.bpmEvents || []).find(e => e && num(e.b) <= 0 && num(e.m) > 0);
    return { data: D, modded: modded + (cd.customEvents || []).length + (cd.environment || []).length, baseBpm: firstBpm ? num(firstBpm.m) : null };
}

export function importV2(json) {
    const D = emptyData();
    let modded = 0;
    for (const n of (json._notes || [])) {
        if (!n) continue;
        if (hasModdedData(n)) modded++;
        const o = { b: num(n._time), x: num(n._lineIndex), y: num(n._lineLayer) };
        if (n._type === 3) D.bombs.push(o);
        else if (n._type === 0 || n._type === 1) D.notes.push({ ...o, c: n._type, d: clampDir(n._cutDirection), a: 0, color: colorOf(n._customData) });
    }
    for (const w of (json._obstacles || [])) {
        if (!w) continue;
        if (hasModdedData(w)) modded++;
        let y = 0, h = 5;
        if (w._type === 1) { y = 2; h = 3; }
        else if (w._type === 2) { y = num(w._lineLayer); h = num(w._height, 5); }
        D.walls.push({ b: num(w._time), x: num(w._lineIndex), y, d: num(w._duration, 1), w: num(w._width, 1), h, color: colorOf(w._customData) });
    }
    for (const e of (json._events || [])) {
        if (!e) continue;
        if (e._type === 100) { if (num(e._floatValue) > 0 && num(e._time) > 0) D.bpm.push({ b: num(e._time), m: num(e._floatValue) }); continue; }
        D.events.push({ b: num(e._time), et: num(e._type), i: num(e._value), f: num(e._floatValue, 1), color: colorOf(e._customData) });
    }
    const cd = json._customData || {};
    for (const c of (cd._BPMChanges || cd._bpmChanges || [])) if (num(c._time) > 0 && num(c._BPM ?? c._bpm) > 0) D.bpm.push({ b: num(c._time), m: num(c._BPM ?? c._bpm) });
    for (const bm of (cd._bookmarks || [])) D.bookmarks.push({ b: num(bm._time), name: String(bm._name || '') });
    return { data: D, modded: modded + (cd._customEvents || []).length + (cd._environment || []).length, baseBpm: null };
}

// v4 (and anything else) through the game's parser, converting seconds back to beats
function importParsed(raw, bpm, lightshow, regions) {
    const map = parseDifficulty(raw, bpm, lightshow, regions);
    const clock = map.clock;
    const D = emptyData();
    const beat = (s) => Math.round(clock.toBeats(s) * 1000) / 1000;
    for (const n of map.notes) {
        if (n.chainLink || n.decorative) continue;
        D.notes.push({ b: beat(n.time), x: n.lx, y: n.ly, c: n.color, d: clampDir(n.dir), a: n.angleAbs ? 0 : (n.angle || 0) });
    }
    for (const o of map.bombs) if (!o.decorative) D.bombs.push({ b: beat(o.time), x: o.lx, y: o.ly });
    for (const w of map.walls) {
        if (w.decorative) continue;
        D.walls.push({ b: beat(w.time), x: w.lx, y: w.ly, d: Math.max(0.01, beat(w.time + w.duration) - beat(w.time)), w: w.w, h: w.h });
    }
    for (const e of map.events) if (!e.legacyColor) D.events.push({ b: beat(e.time), et: e.type, i: e.value, f: Number.isFinite(e.float) ? e.float : 1 });
    return { data: D, modded: (map.customEvents || []).length, baseBpm: null };
}

function clampDir(d) {
    const v = Math.round(num(d, 8));
    return v >= 0 && v <= 8 ? v : 8;
}

/**
 * Build a project from a map (a library record or an unpacked zip):
 * {infoRaw, diffFiles: {filename: text}, songBuf, coverBlob}
 */
export function projectFromMap(rec) {
    const info = parseInfo(rec.infoRaw);
    const regions = rec.diffFiles.__bpm ? parseBpmRegions(rec.diffFiles.__bpm) : [];
    const project = newProject({
        songName: info.songName, songAuthor: info.songAuthor, levelAuthor: info.levelAuthor, bpm: info.bpm,
        songExt: (info.songFilename || 'song.egg').split('.').pop(),
    });
    // tempo changes kept outside the difficulty files (v2 BPMInfo.dat / v4 AudioData.dat)
    // become the difficulty's own BPM changes, so beats keep their exact times
    const first = regions.find(r => r.beat <= 0);
    if (first) project.info.bpm = first.bpm;
    const regionBpm = regions.filter(r => r.beat > 0).map(r => ({ b: r.beat, m: r.bpm }));
    project.diffs = [];
    let modded = 0;
    for (const d of info.difficulties) {
        const text = rec.diffFiles[d.filename];
        if (!text) continue;
        let json;
        try { json = JSON.parse(text); } catch (e) { continue; }
        const major = parseInt(String(json.version || json._version || '2').split('.')[0], 10);
        let res;
        if (major === 3) res = importV3(json);
        else if (major >= 4) res = importParsed(json, info.bpm, d.lightshowFilename ? rec.diffFiles[d.lightshowFilename] : null, regions);
        else res = importV2(json);
        modded += res.modded;
        if (res.baseBpm && Math.abs(res.baseBpm - project.info.bpm) > 0.001 && !project.diffs.length) project.info.bpm = res.baseBpm;
        if (major !== 3 && !res.data.bpm.length && regionBpm.length) res.data.bpm = regionBpm.map(e => ({ ...e }));
        const diff = newDifficulty(d.characteristic || 'Standard', DIFFICULTIES.includes(d.difficulty) ? d.difficulty : 'Expert');
        diff.label = d.label && d.label !== d.difficulty ? d.label : '';
        diff.njs = d.njs;
        diff.offset = d.offset;
        diff.data = res.data;
        if (!project.diffs.some(x => x.characteristic === diff.characteristic && x.difficulty === diff.difficulty)) project.diffs.push(diff);
    }
    if (!project.diffs.length) project.diffs.push(newDifficulty());
    sortDiffs(project.diffs);
    return { project, modded };
}

// ---------- stats + map checks ----------
export function stats(project, diff, songDuration) {
    const D = diff.data;
    const clock = clockFor(project, diff);
    const notes = D.notes.length + D.chains.length;
    const len = songDuration || (D.notes.length ? clock.toSeconds(Math.max(...D.notes.map(n => n.b))) : 0);
    const jd = jumpDistance(diff.njs, diff.offset, project.info.bpm);
    return {
        notes, red: D.notes.filter(n => n.c === 0).length, blue: D.notes.filter(n => n.c === 1).length,
        bombs: D.bombs.length, walls: D.walls.length, events: D.events.length, arcs: D.arcs.length, chains: D.chains.length,
        nps: len > 0 ? notes / len : 0,
        jd, rt: jd / (2 * Math.max(1, diff.njs)),
    };
}

// Beat Saber's half-jump duration (beats) and jump distance (m)
export function jumpDistance(njs, offset, bpm) {
    const beat = 60 / bpm;
    let hjd = 4;
    while (njs * beat * hjd > 17.999) hjd /= 2;
    hjd = Math.max(0.25, hjd + (offset || 0));
    return njs * beat * hjd * 2;
}

// Problems worth fixing, each {b, msg, kind}
export function checkMap(project, diff, songDuration) {
    const D = diff.data, out = [];
    const clock = clockFor(project, diff);
    const end = songDuration ? clock.toBeats(songDuration) : Infinity;
    const cell = new Map();
    const key = (o) => `${Math.round(o.b * 1000)}|${o.x}|${o.y}`;
    for (const n of [...D.notes, ...D.bombs]) {
        const k = key(n);
        if (cell.has(k)) out.push({ b: n.b, kind: 'stack', msg: 'Two objects in the same spot' });
        else cell.set(k, n);
        if (n.b < 0 || n.b > end) out.push({ b: n.b, kind: 'range', msg: 'Outside the song' });
    }
    for (const w of D.walls) {
        const ms = (clock.toSeconds(w.b + w.d) - clock.toSeconds(w.b)) * 1000;
        if (ms < 15) out.push({ b: w.b, kind: 'wall', msg: `Wall only ${Math.max(0, Math.round(ms))} ms long (invisible in game)` });
        if (w.w <= 0 || w.h <= 0) out.push({ b: w.b, kind: 'wall', msg: 'Wall with no width or height' });
        for (const n of D.notes) {
            if (n.b < w.b || n.b > w.b + w.d) continue;
            if (n.x >= w.x && n.x < w.x + w.w && n.y >= w.y && n.y < w.y + w.h) out.push({ b: n.b, kind: 'wall', msg: 'Note inside a wall' });
        }
    }
    // same colour, same moment, pointing different ways (an impossible double)
    const byTime = new Map();
    for (const n of D.notes) {
        const k = Math.round(n.b * 1000) + '|' + n.c;
        if (!byTime.has(k)) byTime.set(k, []);
        byTime.get(k).push(n);
    }
    for (const group of byTime.values()) {
        const dirs = new Set(group.filter(n => n.d !== 8).map(n => n.d));
        if (dirs.size > 1) out.push({ b: group[0].b, kind: 'swing', msg: `${group[0].c ? 'Blue' : 'Red'} notes at the same time point different ways` });
    }
    return out.sort(byBeat);
}

// ---------- transforms ----------
export function mirrorObjects(sel) {
    for (const o of sel.notes || []) { o.x = 3 - o.x; o.c = 1 - o.c; o.d = MIRROR_DIR[o.d]; o.a = -(o.a || 0); }
    for (const o of sel.bombs || []) o.x = 3 - o.x;
    for (const o of sel.walls || []) o.x = 4 - o.x - o.w;
    for (const o of sel.arcs || []) { o.x = 3 - o.x; o.tx = 3 - o.tx; o.c = 1 - o.c; o.d = MIRROR_DIR[o.d]; o.tc = MIRROR_DIR[o.tc]; }
    for (const o of sel.chains || []) { o.x = 3 - o.x; o.tx = 3 - o.tx; o.c = 1 - o.c; o.d = MIRROR_DIR[o.d]; }
    for (const e of sel.events || []) {
        if (e.et === 2) e.et = 3; else if (e.et === 3) e.et = 2;
        else if (e.et === 12) e.et = 13; else if (e.et === 13) e.et = 12;
        if (e.i >= 1 && e.i <= 4) e.i += 4; else if (e.i >= 5 && e.i <= 8) e.i -= 4;
    }
}

// Alternating light events from `from` to `to` every `step` beats
export function strobe({ et, from, to, step, values }) {
    const out = [];
    let k = 0;
    for (let b = from; b <= to + 1e-6; b += step, k++) out.push({ b: Math.round(b * 10000) / 10000, et, i: values[k % values.length], f: 1 });
    return out;
}

// A starter light show that follows the notes
export function autoLights(diff) {
    const out = [];
    const notes = [...diff.data.notes].sort(byBeat);
    let lastBeat = -1;
    for (const n of notes) {
        const et = n.c === 0 ? 2 : 3;
        out.push({ b: n.b, et, i: n.c === 0 ? 6 : 2, f: 1 });                 // flash the laser on that side
        if (Math.floor(n.b) !== Math.floor(lastBeat)) {
            const beat = Math.floor(n.b);
            out.push({ b: beat, et: 4, i: beat % 2 ? 3 : 7, f: 1 });         // center pulses on the beat
            if (beat % 4 === 0) out.push({ b: beat, et: 0, i: beat % 8 ? 5 : 1, f: 1 });
            if (beat % 8 === 0) out.push({ b: beat, et: 8, i: 0, f: 1 });     // ring spin each 2 bars
            if (beat % 16 === 0) out.push({ b: beat, et: 12, i: 3, f: 1 }, { b: beat, et: 13, i: 3, f: 1 });
        }
        lastBeat = n.b;
    }
    // drop exact duplicates (several notes on one beat)
    const seen = new Set();
    return out.filter(e => { const k = `${e.b}|${e.et}|${e.i}`; if (seen.has(k)) return false; seen.add(k); return true; });
}

// ---------- package ----------
// The map as the game stores it: {infoRaw, diffFiles, info} (song and cover are added by the caller)
export function buildMapFiles(project, coverName = 'cover.jpg') {
    const infoJson = toInfoV2(project, coverName);
    const infoRaw = JSON.stringify(infoJson, null, 2);
    const diffFiles = {};
    for (const d of project.diffs) diffFiles[diffFilename(d)] = JSON.stringify(toV3(d, project));
    return { infoRaw, info: parseInfo(infoRaw), diffFiles };
}
