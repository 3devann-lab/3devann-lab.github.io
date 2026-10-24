// ============ Beat Saber map parsing: Info.dat + difficulty files ============
// Supports v2.x, v3.x and v4.x beatmaps, Chroma colors, and Noodle Extensions:
// coordinates, per-object NJS/offset, tracks, full animations, custom events
// (AnimateTrack / AssignPathAnimation / AssignTrackParent / AssignPlayerToTrack),
// fake notes/bombs/walls/chains, world + local rotation, angle offsets.
// Pure JS (no DOM) so it can be tested headlessly.

export const CUT_DIR = {
    UP: 0, DOWN: 1, LEFT: 2, RIGHT: 3,
    UP_LEFT: 4, UP_RIGHT: 5, DOWN_LEFT: 6, DOWN_RIGHT: 7, ANY: 8,
};

// Direction the PLAYER swings to cut the note (unit vectors, screen space)
export const DIR_VECTORS = {
    0: [0, 1], 1: [0, -1], 2: [-1, 0], 3: [1, 0],
    4: [-0.707, 0.707], 5: [0.707, 0.707], 6: [-0.707, -0.707], 7: [0.707, -0.707],
    8: [0, 0],
};

const DIFF_ORDER = { Easy: 1, Normal: 3, Hard: 5, Expert: 7, ExpertPlus: 9 };

function num(v, fallback = 0) {
    const n = Number(v);
    return Number.isFinite(n) ? n : fallback;
}

function normColor(c) {
    if (!Array.isArray(c) || c.length < 3) return null;
    return [num(c[0]), num(c[1]), num(c[2])];
}

// Chroma colors may carry alpha (brightness) as a 4th component
function colorAlpha(c) {
    return Array.isArray(c) && c.length >= 4 ? Math.max(0, num(c[3], 1)) : 1;
}

// ---------- Noodle helpers ----------
// `position` is kept apart from `offsetPosition`: on gameplay objects both are
// offsets (v2 `_position`), but on environment pieces / parent tracks / the
// player, `position` is an absolute placement.
const PROP_ALIASES = {
    offsetPosition: ['offsetPosition'],
    position: ['position', '_position'],
    localPosition: ['localPosition', '_localPosition'],
    definitePosition: ['definitePosition', '_definitePosition'],
    rotation: ['rotation', 'offsetWorldRotation', 'worldRotation', '_rotation'],
    localRotation: ['localRotation', '_localRotation'],
    scale: ['scale', '_scale'],
    dissolve: ['dissolve', '_dissolve'],
    dissolveArrow: ['dissolveArrow', '_dissolveArrow'],
    color: ['color', '_color'],
    interactable: ['interactable', '_interactable'],
    time: ['time', '_time'],
    attenuation: ['attenuation', '_attenuation'],
    fogOffset: ['offset', '_offset'],
    startY: ['startY', '_startY'],
    height: ['height', '_height'],
};

function resolvePts(v, defs) {
    if (typeof v === 'string') return defs[v] ?? null;    // named point definition
    return v ?? null;
}

// Normalize an animation object (v2 underscore keys or v3 keys) into canonical
// props. With allowNull, an explicit `null` is kept so AnimateTrack /
// AssignPathAnimation can clear a property (Heck behaviour).
function normAnim(a, defs, allowNull = false) {
    if (!a || typeof a !== 'object') return null;
    const out = {};
    let any = false;
    for (const prop in PROP_ALIASES) {
        for (const alias of PROP_ALIASES[prop]) {
            if (!(alias in a)) continue;
            if (a[alias] === null) {
                if (allowNull) { out[prop] = null; any = true; }
            } else {
                const pts = resolvePts(a[alias], defs);
                if (pts !== null) { out[prop] = pts; any = true; }
            }
            break;
        }
    }
    return any ? out : null;
}

function normTrack(t) {
    if (t == null) return null;
    return Array.isArray(t) ? t.map(String) : [String(t)];
}

// Static world rotation: number (y-axis degrees) or [x,y,z]
function normWorldRot(r) {
    if (r == null) return null;
    if (typeof r === 'number') return r ? [0, r, 0] : null;
    if (Array.isArray(r)) return [num(r[0]), num(r[1]), num(r[2])];
    return null;
}

function normVec3(v) {
    return Array.isArray(v) ? [num(v[0]), num(v[1]), num(v[2])] : null;
}

// Chroma environment enhancements: geometry objects ("custom models").
// ID/regex lookups target base-game objects we don't have, so only
// geometry-based entries are returned (that's what model maps use). Disabling
// entries are inspected to decide whether the map wants the stock scenery gone.
// Which of our stock scenery groups a disabled base-game object corresponds to
const STOCK_GROUPS = {
    floor: /Floor|Mirror|PlayersPlace|Construction|Platform/i,
    strips: /Construction|NeonTube|BottomGlow/i,
    back: /BackColumns|Buildings|Spectrogram|Logo|Frame|BackCube|Clouds/i,
    towers: /RotatingLaser|SideLaser|(^|[^a-z])Laser/i,
    lasers: /Laser/i,
    rings: /Ring/i,
};

function parseEnvironment(cd, v2) {
    const list = (v2 ? cd._environment : cd.environment) || [];
    const mats = (v2 ? cd._materials : cd.materials) || {};
    const out = [];
    const hide = new Set();
    for (const e of list) {
        if (!e || typeof e !== 'object') continue;
        const active = v2 ? e._active : e.active;
        const geo = v2 ? e._geometry : e.geometry;
        if (!geo) {
            const id = String((v2 ? e._id : e.id) ?? '');
            if (active === false) {
                if (/^(Environment|GameCore)$|^\.\*$/.test(id)) for (const g in STOCK_GROUPS) hide.add(g);
                for (const g in STOCK_GROUPS) if (STOCK_GROUPS[g].test(id)) hide.add(g);
            }
            continue;
        }
        if (active === false) continue;
        let m = v2 ? geo._material : geo.material;
        if (typeof m === 'string') m = mats[m];
        m = m || {};
        const color = v2 ? m._color : m.color;
        out.push({
            type: (v2 ? geo._type : geo.type) || 'Cube',
            shader: (v2 ? m._shader : m.shader) || 'Standard',
            color: normColor(color),
            position: normVec3(v2 ? e._position : e.position),
            rotation: normVec3(v2 ? e._rotation : e.rotation),
            localPosition: normVec3(v2 ? e._localPosition : e.localPosition),
            localRotation: normVec3(v2 ? e._localRotation : e.localRotation),
            scale: normVec3(v2 ? e._scale : e.scale),
            track: normTrack(v2 ? e._track : e.track),
        });
    }
    // big model maps bring their own world: hide all stock scenery
    if (out.length >= 24) { for (const g in STOCK_GROUPS) hide.add(g); hide.add('stars'); }
    out.hideGroups = [...hide];
    return out;
}

// Chroma v2 light gradient on an event
function parseGradient(g, clock, beat) {
    if (!g) return null;
    const start = normColor(g._startColor);
    const end = normColor(g._endColor);
    if (!start || !end) return null;
    return {
        start, end,
        duration: Math.max(0.01, clock.toSeconds(beat + num(g._duration)) - clock.toSeconds(beat)),
        easing: g._easing || null,
    };
}

// Chroma ring/laser event extras
function parseEventCustom(cd, v2) {
    if (!cd) return null;
    const pick = (a, b) => (v2 ? cd[a] : cd[b]);
    const custom = {
        rotation: pick('_rotation', 'rotation') ?? null,
        step: pick('_step', 'step') ?? null,
        prop: pick('_prop', 'prop') ?? null,
        speed: pick('_speed', 'speed') ?? (v2 ? cd._preciseSpeed ?? null : null),
        direction: pick('_direction', 'direction') ?? null,
    };
    return (custom.rotation !== null || custom.step !== null || custom.speed !== null ||
            custom.direction !== null || custom.prop !== null) ? custom : null;
}

// Point definitions: v2 [{_name,_points}], v3 {name: points}
function parsePointDefs(cd, v2) {
    const defs = {};
    if (!cd) return defs;
    if (v2 && Array.isArray(cd._pointDefinitions)) {
        for (const d of cd._pointDefinitions) if (d && d._name) defs[d._name] = d._points;
    } else if (Array.isArray(cd.pointDefinitions)) {          // v3.0 – v3.2 array form
        for (const d of cd.pointDefinitions) if (d && d.name) defs[d.name] = d.points;
    } else if (cd.pointDefinitions && typeof cd.pointDefinitions === 'object') {
        Object.assign(defs, cd.pointDefinitions);             // v3.3+ object form
    }
    return defs;
}

// Custom events: AnimateTrack / AssignPathAnimation / AssignTrackParent / AssignPlayerToTrack
function parseCustomEvents(list, clock, defs, v2) {
    const out = [];
    for (const ev of (list || [])) {
        if (!ev) continue;
        const type = v2 ? ev._type : ev.t;
        const beat = v2 ? ev._time : ev.b;
        const d = (v2 ? ev._data : ev.d) || {};
        if (!type || beat === undefined) continue;

        const durBeats = num(v2 ? d._duration : d.duration);
        const time = clock.toSeconds(num(beat));
        const parsed = {
            time,
            duration: Math.max(0, clock.toSeconds(num(beat) + durBeats) - time),
            type,
            easing: (v2 ? d._easing : d.easing) || null,
            repeat: num(v2 ? d._repeat : d.repeat),
            tracks: normTrack(v2 ? d._track : d.track) || [],
            target: (v2 ? d._target : d.target) || null,   // Root/Head/LeftHand/RightHand
            props: {},
            parent: null,
            children: null,
        };

        if (type === 'AssignTrackParent') {
            parsed.parent = String((v2 ? d._parentTrack : d.parentTrack) ?? '');
            parsed.children = (normTrack(v2 ? d._childrenTracks : d.childrenTracks) || []);
        } else if (type === 'AnimateComponent') {
            // Chroma v3: animate fog via BloomFogEnvironment component
            const comp = (v2 ? d._components : d.components) || {};
            const fog = comp.BloomFogEnvironment || comp._BloomFogEnvironment || {};
            const props = {};
            for (const k of ['attenuation', 'offset', 'startY', 'height']) {
                const pts = resolvePts(fog[k], defs);
                if (pts) props[k === 'offset' ? 'fogOffset' : k] = pts;
            }
            parsed.props = props;
        } else {
            const anim = normAnim(d, defs, true);
            if (anim) parsed.props = anim;
        }
        out.push(parsed);
    }
    return out;
}

// Sample a point list at time t (0..1) — thin version used by tests;
// the full sampler (easings/splines/quaternions) lives in noodle.js.
export function samplePoints(points, t, dims) {
    if (!points || !points.length) return null;
    if (typeof points[0] === 'number') return points.slice(0, dims);
    const pts = points;
    if (t <= pts[0][dims]) return pts[0].slice(0, dims);
    for (let i = 0; i < pts.length - 1; i++) {
        const a = pts[i], b = pts[i + 1];
        const ta = a[dims], tb = b[dims];
        if (t >= ta && t <= tb) {
            const f = tb > ta ? (t - ta) / (tb - ta) : 1;
            const out = [];
            for (let d = 0; d < dims; d++) out.push(a[d] + (b[d] - a[d]) * f);
            return out;
        }
    }
    return pts[pts.length - 1].slice(0, dims);
}

// ---------- Info.dat ----------
export function parseInfo(json) {
    const info = typeof json === 'string' ? JSON.parse(json) : json;
    const version = String(info.version || info._version || '2.0.0');
    const major = parseInt(version.split('.')[0], 10);

    if (major >= 4) {
        const diffs = (info.difficultyBeatmaps || []).map(d => ({
            characteristic: d.characteristic || 'Standard',
            difficulty: d.difficulty || 'Normal',
            label: (d.customData && d.customData.difficultyLabel) || d.difficulty,
            filename: d.beatmapDataFilename,
            lightshowFilename: d.lightshowDataFilename || null,
            njs: d.noteJumpMovementSpeed || 10,
            offset: d.noteJumpStartBeatOffset || 0,
            requirements: (d.customData && d.customData.requirements) || [],
        }));
        return {
            version,
            songName: (info.song && info.song.title) || 'Unknown',
            songAuthor: (info.song && info.song.author) || '',
            levelAuthor: (info.difficultyBeatmaps && info.difficultyBeatmaps[0] &&
                info.difficultyBeatmaps[0].beatmapAuthors &&
                (info.difficultyBeatmaps[0].beatmapAuthors.mappers || []).join(', ')) || '',
            bpm: (info.audio && info.audio.bpm) || 120,
            songFilename: (info.audio && info.audio.songFilename) || 'song.ogg',
            audioDataFilename: (info.audio && info.audio.audioDataFilename) || null,
            coverFilename: info.coverImageFilename || null,
            environment: (info.environmentNames && info.environmentNames[0]) || 'DefaultEnvironment',
            difficulties: sortDiffs(diffs),
        };
    }

    // v2
    const sets = info._difficultyBeatmapSets || [];
    const diffs = [];
    for (const set of sets) {
        const char = set._beatmapCharacteristicName || 'Standard';
        for (const d of (set._difficultyBeatmaps || [])) {
            diffs.push({
                characteristic: char,
                difficulty: d._difficulty || 'Normal',
                label: (d._customData && d._customData._difficultyLabel) || d._difficulty,
                filename: d._beatmapFilename,
                lightshowFilename: null,
                njs: d._noteJumpMovementSpeed || 10,
                offset: d._noteJumpStartBeatOffset || 0,
                requirements: (d._customData && d._customData._requirements) || [],
            });
        }
    }
    return {
        version,
        songName: info._songName || 'Unknown',
        songAuthor: info._songAuthorName || '',
        levelAuthor: info._levelAuthorName || '',
        bpm: info._beatsPerMinute || 120,
        songFilename: info._songFilename || 'song.egg',
        audioDataFilename: 'BPMInfo.dat',
        coverFilename: info._coverImageFilename || null,
        environment: info._environmentName || 'DefaultEnvironment',
        difficulties: sortDiffs(diffs),
    };
}

function sortDiffs(diffs) {
    return diffs.sort((a, b) => {
        if (a.characteristic !== b.characteristic) {
            return a.characteristic === 'Standard' ? -1 : b.characteristic === 'Standard' ? 1
                : a.characteristic.localeCompare(b.characteristic);
        }
        return (DIFF_ORDER[a.difficulty] || 0) - (DIFF_ORDER[b.difficulty] || 0);
    });
}

// ---------- BPM regions (v2 BPMInfo.dat / v4 AudioData.dat) ----------
// Returns [{beat, bpm}] for maps whose tempo changes live outside the
// difficulty file. Single-region files carry no extra information.
export function parseBpmRegions(json) {
    if (!json) return [];
    let d;
    try { d = typeof json === 'string' ? JSON.parse(json) : json; } catch (e) { return []; }
    const freq = num(d._songFrequency ?? d.songFrequency, 44100) || 44100;
    const regions = (d._regions || []).map(r => ({
        si: num(r._startSampleIndex), ei: num(r._endSampleIndex),
        sb: num(r._startBeat), eb: num(r._endBeat),
    })).concat((d.bpmData || []).map(r => ({
        si: num(r.si), ei: num(r.ei), sb: num(r.sb), eb: num(r.eb),
    })));
    if (regions.length < 2) return [];
    const out = [];
    for (const r of regions) {
        const secs = (r.ei - r.si) / freq;
        if (secs <= 0 || r.eb <= r.sb) continue;
        out.push({ beat: r.sb, bpm: (r.eb - r.sb) / (secs / 60) });
    }
    return out;
}

// ---------- Beat <-> seconds with BPM changes ----------
export class BeatClock {
    constructor(baseBpm, bpmEvents = []) {
        this.segments = [{ beat: 0, bpm: baseBpm, time: 0 }];
        const sorted = [...bpmEvents].filter(e => e.bpm > 0).sort((a, b) => a.beat - b.beat);
        for (const ev of sorted) {
            if (ev.beat <= 0) { this.segments[0].bpm = ev.bpm; continue; }
            const prev = this.segments[this.segments.length - 1];
            const time = prev.time + (ev.beat - prev.beat) * 60 / prev.bpm;
            this.segments.push({ beat: ev.beat, bpm: ev.bpm, time });
        }
    }
    _seg(beat) {
        const s = this.segments;
        if (s.length === 1 || beat < s[1].beat) return s[0];
        let lo = 0, hi = s.length - 1;           // binary search: maps can have thousands
        while (lo < hi) {
            const mid = (lo + hi + 1) >> 1;
            if (s[mid].beat <= beat) lo = mid; else hi = mid - 1;
        }
        return s[lo];
    }
    toSeconds(beat) {
        const seg = this._seg(beat);
        return seg.time + (beat - seg.beat) * 60 / seg.bpm;
    }
    bpmAt(beat) { return this._seg(beat).bpm; }
    // seconds → beats (the editor maps mouse / audio time back onto the grid)
    toBeats(sec) {
        const s = this.segments;
        let lo = 0, hi = s.length - 1;
        while (lo < hi) {
            const mid = (lo + hi + 1) >> 1;
            if (s[mid].time <= sec) lo = mid; else hi = mid - 1;
        }
        const seg = s[lo];
        return seg.beat + (sec - seg.time) * seg.bpm / 60;
    }
}

// ---------- Difficulty file ----------
// Returns { notes, bombs, walls, events, customEvents, environment, clock }
export function parseDifficulty(json, baseBpm, lightshowJson = null, bpmRegions = null) {
    const map = typeof json === 'string' ? JSON.parse(json) : json;
    const version = String(map.version || map._version || '2.0.0');
    const major = parseInt(version.split('.')[0], 10);
    const regions = Array.isArray(bpmRegions) ? bpmRegions : parseBpmRegions(bpmRegions);

    let data;
    if (major >= 4) data = parseV4(map, baseBpm, lightshowJson, regions);
    else if (major === 3) data = parseV3(map, baseBpm, regions);
    else data = parseV2(map, baseBpm, regions);
    data.version = major;
    return data;
}

// Arrow angle: v3 `a` is a counter-clockwise offset; NE v2 `_cutDirection`
// is an absolute rotation where 0 = down.
function angleFields(dir, offsetDeg, absoluteDeg) {
    if (absoluteDeg != null && Number.isFinite(Number(absoluteDeg))) {
        return { angle: Number(absoluteDeg), angleAbs: true };
    }
    const off = num(offsetDeg);
    return off ? { angle: off, angleAbs: false } : { angle: 0, angleAbs: false };
}

// --- v2 ---
function parseV2(map, baseBpm, regions) {
    const bpmEvents = [];
    for (const ev of (map._events || [])) {
        if (ev._type === 100 && ev._floatValue > 0) bpmEvents.push({ beat: ev._time, bpm: ev._floatValue });
    }
    for (const b of (map._BPMChanges || map._bpmChanges || [])) {
        const bpm = num(b._BPM ?? b._bpm);
        if (bpm > 0) bpmEvents.push({ beat: num(b._time), bpm });
    }
    const clock = new BeatClock(baseBpm, bpmEvents.length ? bpmEvents : regions);
    const mapCd = map._customData || {};
    const defs = parsePointDefs(mapCd, true);

    const notes = [];
    const bombs = [];
    for (const n of (map._notes || [])) {
        if (!n) continue;
        const cd = n._customData || {};
        let x = num(n._lineIndex), y = num(n._lineLayer);
        if (Array.isArray(cd._position)) {          // Noodle: [lineIndex-2, lineLayer]
            x = num(cd._position[0]) + 2;
            y = num(cd._position[1]);
        }
        const time = clock.toSeconds(num(n._time));
        const common = {
            time, x, y,
            lx: num(n._lineIndex), ly: num(n._lineLayer),
            njs: num(cd._noteJumpMovementSpeed) || null,
            spawnOffset: cd._noteJumpStartBeatOffset ?? null,
            decorative: !!cd._fake || cd._interactable === false,
            localRot: normVec3(cd._localRotation),
            worldRot: normWorldRot(cd._rotation),
            track: normTrack(cd._track),
            anim: normAnim(cd._animation, defs),
            noGravity: !!cd._disableNoteGravity,
        };
        if (n._type === 3) {
            bombs.push(common);
        } else if (n._type === 0 || n._type === 1) {
            const dir = n._cutDirection ?? 8;
            notes.push({
                ...common,
                color: n._type,
                dir: dir >= 0 && dir <= 8 ? dir : 8,
                ...angleFields(dir, 0, cd._cutDirection),
                chroma: normColor(cd._color),
            });
        }
    }

    const walls = [];
    for (const o of (map._obstacles || [])) {
        if (!o) continue;
        const cd = o._customData || {};
        let x = num(o._lineIndex), y, h;
        if (o._type === 2) { y = num(o._lineLayer); h = num(o._height, 5) || 5; }
        else if (o._type === 1) { y = 2; h = 3; }   // crouch
        else { y = 0; h = 5; }                       // full height
        let w = num(o._width, 1), l = null;
        if (Array.isArray(cd._position)) { x = num(cd._position[0]) + 2; y = num(cd._position[1]); }
        if (Array.isArray(cd._scale)) {
            w = num(cd._scale[0], w) || w;
            h = num(cd._scale[1], h) || h;
            if (cd._scale[2] != null) l = num(cd._scale[2]);
        }
        const start = num(o._time);
        walls.push({
            time: clock.toSeconds(start),
            duration: Math.max(0, clock.toSeconds(start + num(o._duration)) - clock.toSeconds(start)),
            x, y, w, h, l,
            chroma: normColor(cd._color),
            decorative: !!cd._fake || cd._interactable === false,
            localRot: normVec3(cd._localRotation),
            worldRot: normWorldRot(cd._rotation),
            njs: num(cd._noteJumpMovementSpeed) || null,
            spawnOffset: cd._noteJumpStartBeatOffset ?? null,
            track: normTrack(cd._track),
            anim: normAnim(cd._animation, defs),
        });
    }

    const events = [];
    for (const ev of (map._events || [])) {
        if (!ev || ev._type === 100 || ev._type === 14 || ev._type === 15) continue;
        const cd = ev._customData || {};
        const value = num(ev._value);
        const out = {
            time: clock.toSeconds(num(ev._time)),
            type: ev._type,
            value,
            float: num(ev._floatValue, 1) * colorAlpha(cd._color),
            chroma: normColor(cd._color),
            gradient: parseGradient(cd._lightGradient, clock, num(ev._time)),
            custom: parseEventCustom(ev._customData, true),
            legacyColor: null,
        };
        // Legacy Chroma: values >= 2e9 encode an RGB color for later events
        if (value >= 2000000000) {
            const rgb = value - 2000000000;
            out.legacyColor = [((rgb >> 16) & 255) / 255, ((rgb >> 8) & 255) / 255, (rgb & 255) / 255];
        } else if (value === 1999999999) {
            out.legacyColor = 'reset';
        }
        events.push(out);
    }

    const customEvents = parseCustomEvents(mapCd._customEvents, clock, defs, true);
    const environment = parseEnvironment(mapCd, true);
    return finish({ notes, bombs, walls, events, customEvents, environment, clock });
}

// --- v3 ---
function parseV3(map, baseBpm, regions) {
    const bpmEvents = (map.bpmEvents || []).map(e => ({ beat: num(e.b), bpm: num(e.m) }));
    const clock = new BeatClock(baseBpm, bpmEvents.length ? bpmEvents : regions);
    const mapCd = map.customData || {};
    const defs = parsePointDefs(mapCd, false);

    const v3Common = (o, forceDecorative = false) => {
        const cd = o.customData || {};
        let x = num(o.x), y = num(o.y);
        if (Array.isArray(cd.coordinates)) { x = num(cd.coordinates[0]) + 2; y = num(cd.coordinates[1]); }
        return {
            time: clock.toSeconds(num(o.b)),
            x, y,
            lx: num(o.x), ly: num(o.y),
            njs: num(cd.noteJumpMovementSpeed) || null,
            spawnOffset: cd.noteJumpStartBeatOffset ?? null,
            decorative: forceDecorative || cd.uninteractable === true,
            localRot: normVec3(cd.localRotation),
            worldRot: normWorldRot(cd.worldRotation),
            track: normTrack(cd.track),
            anim: normAnim(cd.animation, defs),
            noGravity: !!cd.disableNoteGravity,
        };
    };

    const notes = [];
    const pushNote = (n, forceDec = false) => {
        if (!n) return;
        const dir = n.d ?? 8;
        notes.push({
            ...v3Common(n, forceDec),
            color: n.c ?? 0,
            dir: dir >= 0 && dir <= 8 ? dir : 8,
            ...angleFields(dir, n.a, null),
            chroma: normColor((n.customData || {}).color),
        });
    };
    for (const n of (map.colorNotes || [])) pushNote(n);
    for (const n of (mapCd.fakeColorNotes || [])) pushNote(n, true);

    // Chains: links as small dot notes. Link times are spread evenly between
    // head and tail; squish only bends the shape (Beat Saber behaviour).
    const pushChain = (c, forceDec = false) => {
        if (!c) return;
        const base = v3Common(c, forceDec);
        const headTime = base.time;
        const tailTime = clock.toSeconds(num(c.tb, c.b));
        const count = Math.max(1, (c.sc || 2) - 1);
        const squish = c.s ?? 1;
        for (let i = 1; i <= count; i++) {
            const f = i / count;
            const sf = f * squish;
            notes.push({
                ...base,
                time: headTime + (tailTime - headTime) * f,
                x: base.x + ((c.tx ?? base.x) - base.x) * sf,
                y: base.y + ((c.ty ?? base.y) - base.y) * sf,
                color: c.c ?? 0,
                dir: 8,
                angle: 0, angleAbs: false,
                chroma: normColor((c.customData || {}).color),
                chainLink: true,
            });
        }
    };
    for (const c of (map.burstSliders || [])) pushChain(c);
    for (const c of (mapCd.fakeBurstSliders || [])) pushChain(c, true);

    const bombs = [];
    for (const b of (map.bombNotes || [])) if (b) bombs.push(v3Common(b));
    for (const b of (mapCd.fakeBombNotes || [])) if (b) bombs.push(v3Common(b, true));

    const walls = [];
    const pushWall = (o, forceDec = false) => {
        if (!o) return;
        const cd = o.customData || {};
        const base = v3Common(o, forceDec);
        let w = num(o.w, 1), h = num(o.h, 1), l = null;
        if (Array.isArray(cd.size)) {
            w = num(cd.size[0], w) || w;
            h = num(cd.size[1], h) || h;
            if (cd.size[2] != null) l = num(cd.size[2]);   // explicit length in grid units
        }
        walls.push({
            ...base,
            duration: Math.max(0, clock.toSeconds(num(o.b) + num(o.d)) - base.time),
            w, h, l,
            chroma: normColor(cd.color),
        });
    };
    for (const o of (map.obstacles || [])) pushWall(o);
    for (const o of (mapCd.fakeObstacles || [])) pushWall(o, true);

    const events = (map.basicBeatmapEvents || []).filter(Boolean).map(ev => {
        const cd = ev.customData || {};
        return {
            time: clock.toSeconds(num(ev.b)),
            type: ev.et,
            value: num(ev.i),
            float: num(ev.f, 1) * colorAlpha(cd.color),
            chroma: normColor(cd.color),
            gradient: null,
            custom: parseEventCustom(ev.customData, false),
            legacyColor: null,
        };
    });

    const customEvents = parseCustomEvents(mapCd.customEvents, clock, defs, false);
    const environment = parseEnvironment(mapCd, false);
    return finish({ notes, bombs, walls, events, customEvents, environment, clock });
}

// --- v4 (split object/metadata arrays; lighting lives in the lightshow file) ---
function parseV4(map, baseBpm, lightshowJson, regions) {
    const clock = new BeatClock(baseBpm, regions);
    const nd = map.colorNotesData || [];
    const bd = map.bombNotesData || [];
    const od = map.obstaclesData || [];
    const cdata = map.chainsData || [];

    const blank = { spawnOffset: null, decorative: false, localRot: null, worldRot: null, track: null, anim: null, njs: null };
    const notes = (map.colorNotes || []).map(n => {
        const d = nd[n.i || 0] || {};
        const dir = d.d ?? 8;
        return {
            ...blank,
            time: clock.toSeconds(num(n.b)),
            x: num(d.x, 1), y: num(d.y), lx: num(d.x, 1), ly: num(d.y),
            color: d.c ?? 0,
            dir: dir >= 0 && dir <= 8 ? dir : 8,
            ...angleFields(dir, d.a, null),
            chroma: null,
        };
    });

    for (const c of (map.chains || [])) {
        const d = cdata[c.ci || 0];
        const head = nd[c.i || 0];
        if (!d || !head) continue;
        const headTime = clock.toSeconds(num(c.hb));
        const tailTime = clock.toSeconds(num(c.tb));
        const count = Math.max(1, (d.c || 2) - 1);
        const squish = d.s ?? 1;
        for (let i = 1; i <= count; i++) {
            const f = i / count, sf = f * squish;
            notes.push({
                ...blank,
                time: headTime + (tailTime - headTime) * f,
                x: num(head.x) + (num(d.tx, head.x) - num(head.x)) * sf,
                y: num(head.y) + (num(d.ty, head.y) - num(head.y)) * sf,
                lx: num(head.x), ly: num(head.y),
                color: head.c ?? 0, dir: 8, angle: 0, angleAbs: false, chroma: null, chainLink: true,
            });
        }
    }

    const bombs = (map.bombNotes || []).map(b => {
        const d = bd[b.i || 0] || {};
        return {
            ...blank,
            time: clock.toSeconds(num(b.b)), x: num(d.x, 1), y: num(d.y), lx: num(d.x, 1), ly: num(d.y),
        };
    });

    const walls = (map.obstacles || []).map(o => {
        const d = od[o.i || 0] || {};
        const start = num(o.b);
        return {
            ...blank,
            time: clock.toSeconds(start),
            duration: Math.max(0, clock.toSeconds(start + num(d.d)) - clock.toSeconds(start)),
            x: num(d.x), y: num(d.y), w: num(d.w, 1) || 1, h: num(d.h, 1) || 1, l: null,
            chroma: null,
        };
    });

    let events = [];
    if (lightshowJson) {
        try {
            const ls = typeof lightshowJson === 'string' ? JSON.parse(lightshowJson) : lightshowJson;
            const evData = ls.basicEventsData || [];
            events = (ls.basicEvents || []).map(ev => {
                const d = ev.i !== undefined && evData.length ? (evData[ev.i] || {}) : ev;
                return {
                    time: clock.toSeconds(num(ev.b)),
                    type: d.t ?? ev.t ?? 0,
                    value: num(d.i ?? ev.i),
                    float: num(d.f ?? ev.f, 1),
                    chroma: null, gradient: null, custom: null, legacyColor: null,
                };
            });
        } catch (e) { /* lightshow optional */ }
    }

    const environment = [];
    environment.hideGroups = [];
    return finish({ notes, bombs, walls, events, customEvents: [], environment, clock });
}

function finish(data) {
    data.notes.sort((a, b) => a.time - b.time);
    data.bombs.sort((a, b) => a.time - b.time);
    data.walls.sort((a, b) => a.time - b.time);
    data.events.sort((a, b) => a.time - b.time);
    data.customEvents.sort((a, b) => a.time - b.time);
    if (!data.environment) data.environment = [];
    if (!data.environment.hideGroups) data.environment.hideGroups = [];
    return data;
}

// Standard half-jump-duration calculation → seconds of look-ahead for a note
export function reactionTime(njs, offsetBeats, bpm) {
    const spb = 60 / bpm;
    let hjd = 4;
    while (njs * spb * hjd > 17.999) hjd /= 2;
    hjd += offsetBeats;
    if (hjd < 0.25) hjd = 0.25;
    return hjd * spb;
}
