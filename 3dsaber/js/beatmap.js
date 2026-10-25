// ============ Beat Saber map parsing: Info.dat + difficulty files ============
// Supports v2.x, v3.x and v4.x beatmaps, 360/90 degree rotation events, and the
// mapping mods:
// - Noodle Extensions: coordinates, per-object NJS/offset, tracks, full
//   animations, custom events (AnimateTrack / AssignPathAnimation /
//   AssignTrackParent / AssignPlayerToTrack), fake objects, world + local
//   rotation, links, flips, bad-cut switches
// - Chroma: object and light colours, light IDs, gradients, transitions,
//   environment geometry with lights and animated materials, fog
// - Mapping Extensions: extra and precise lanes/layers, any-angle notes, precise
//   wall width/height/start height, precise rotation events
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

// ---------- Mapping Extensions ----------
// Lanes/layers of ±1000 and beyond are "precise": 1/1000ths of a lane, with
// 1000 and -1000 both meaning lane 0. Plain values outside 0–3 / 0–2 are extra
// lanes and need nothing special.
function meLane(v) {
    v = num(v);
    if (v >= 1000) return v / 1000 - 1;
    if (v <= -1000) return v / 1000 + 1;
    return v;
}
function meLayer(v) {
    v = num(v);
    return v >= 1000 || v <= -1000 ? v / 1000 - 1 : v;
}
// wall heights (layers): precise ±1000 like lanes, but -1000 is height 1
function meHeight(v, fallback) {
    v = num(v, fallback);
    if (v >= 1000) return v / 1000 - 1;
    if (v <= -1000) return v / 1000 + 2;
    return v;
}
// cut direction 1000–1360: an arrow at any angle (degrees clockwise from a
// down cut); 2000–2360: a dot note turned to an angle
function meCut(d) {
    d = num(d, 8);
    if (d >= 1000 && d <= 1360) return { dir: 1, angle: 1000 - d, angleAbs: true, me: true };
    if (d >= 2000 && d <= 2360) return { dir: 8, angle: 2000 - d, angleAbs: true, me: true };
    return null;
}
const isMeValue = (v) => typeof v === 'number' && (v >= 1000 || v <= -1000);

// v2 wall _type 1000–4000: precise height; 4001–4005000: height + start height
// (ME's own formulas, including its slightly-high placement)
function meWallType(type) {
    if (!(type >= 1000 && type <= 4005000)) return null;
    let height, start = 0;
    if (type >= 4001) { const v = type - 4001; height = Math.floor(v / 1000); start = v % 1000; }
    else height = type - 1000;
    return { h: height / 1000 * 5, y: Math.trunc(start / 750 * 5 * 1000 + 1334) / 1000 - 1 };
}

// Noodle coordinates / size entries may be null or missing: keep the vanilla value
function coord(arr, i, fallback) {
    const v = Array.isArray(arr) ? arr[i] : undefined;
    if (v == null) return fallback;
    const n = Number(v);
    return Number.isFinite(n) ? n : fallback;
}

// Chroma lightID: a number or a list of them
function lightIds(v) {
    if (v == null) return null;
    const out = (Array.isArray(v) ? v : [v]).map(Number).filter(Number.isFinite);
    return out.length ? out : null;
}

// 360/90 degree maps: rotation event values 0–7, or ME's precise 1000–1720
const ROT_VALUES = [-60, -45, -30, -15, 15, 30, 45, 60];
function rotationDegrees(value) {
    const v = Math.round(num(value));
    if (v >= 1000 && v <= 1720) return v - 1360;
    return ROT_VALUES[v] ?? 0;
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
// AnimateComponent: component name -> {field -> canonical prop}
const COMPONENT_PROPS = {
    BloomFogEnvironment: { attenuation: 'attenuation', offset: 'fogOffset', startY: 'startY', height: 'height' },
    TubeBloomPrePassLight: { colorAlphaMultiplier: 'colorAlphaMultiplier', bloomFogIntensityMultiplier: 'bloomFogIntensityMultiplier' },
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

// Chroma environment enhancements.
// - geometry objects ("custom models"), including ones that are lights
//   (light shaders / ILightWithId) and ones whose material animates on a track
// - directional lights picked by ID (they light the geometry; events drive them)
// - fog set on the environment (BloomFogEnvironment)
// Other ID lookups target base-game objects we don't have: disabling ones
// decide whether the map wants our stock scenery gone.
// Which of our stock scenery groups a disabled base-game object corresponds to
const STOCK_GROUPS = {
    floor: /Floor|Mirror|PlayersPlace|Construction|Platform/i,
    strips: /Construction|NeonTube|BottomGlow/i,
    back: /BackColumns|Buildings|Spectrogram|Logo|Frame|BackCube|Clouds/i,
    towers: /RotatingLaser|SideLaser|(^|[^a-z])Laser/i,
    lasers: /Laser/i,
    rings: /Ring/i,
};
const LIGHT_SHADERS = /^(OpaqueLight|TransparentLight)$/i;

function parseMaterial(m, v2) {
    if (!m || typeof m !== 'object') return null;
    const kw = v2 ? m._shaderKeywords : m.shaderKeywords;
    return {
        color: normColor(v2 ? m._color : m.color),
        alpha: Array.isArray(v2 ? m._color : m.color) ? colorAlpha(v2 ? m._color : m.color) : 1,
        shader: String((v2 ? m._shader : m.shader) || 'Standard'),
        track: (v2 ? m._track : m.track) != null ? String(v2 ? m._track : m.track) : null,
        // an empty keyword list used to make Standard full-bright; Chroma turns it into "Glowing"
        glowing: Array.isArray(kw) && kw.length === 0,
    };
}

function parseEnvironment(cd, v2) {
    const list = (v2 ? cd._environment : cd.environment) || [];
    const rawMats = (v2 ? cd._materials : cd.materials) || {};
    const materials = {};
    for (const name in rawMats) { const m = parseMaterial(rawMats[name], v2); if (m) materials[name] = m; }
    const out = [];
    const lights = [];
    const hide = new Set();
    let fog = null, fogTrack = null;
    for (const e of list) {
        if (!e || typeof e !== 'object') continue;
        const active = v2 ? e._active : e.active;
        const geo = v2 ? e._geometry : e.geometry;
        const comps = (v2 ? e._components : e.components) || {};
        const lw = comps.ILightWithId || comps._ILightWithId || null;
        // v2 Chroma put the light ID straight on the entry
        let lightID = lw && lw.lightID != null ? num(lw.lightID, NaN) : num(e._lightID ?? e.lightID, NaN);
        const lightType = lw && lw.type != null ? num(lw.type, NaN) : NaN;
        const tube = comps.TubeBloomPrePassLight || null;
        const track = normTrack(v2 ? e._track : e.track);
        if (!geo) {
            const id = String((v2 ? e._id : e.id) ?? '');
            if (active === false) {
                if (/^(Environment|GameCore)$|^\.\*$/.test(id)) for (const g in STOCK_GROUPS) hide.add(g);
                for (const g in STOCK_GROUPS) if (STOCK_GROUPS[g].test(id)) hide.add(g);
                continue;
            }
            const fc = comps.BloomFogEnvironment;
            if (fc) {
                fog = { ...(fog || {}) };
                for (const k of ['attenuation', 'offset', 'startY', 'height']) if (fc[k] != null) fog[k === 'offset' ? 'fogOffset' : k] = num(fc[k]);
                if (track) fogTrack = track[0];
            }
            // the environment's directional lights: they light everything, and
            // lighting events (usually by ID) set their colour
            if (/DirectionalLight/i.test(id) && lights.length < 4) {
                lights.push({
                    rotation: normVec3(v2 ? e._rotation : e.rotation),
                    localRotation: normVec3(v2 ? e._localRotation : e.localRotation),
                    track,
                    light: { type: Number.isFinite(lightType) ? lightType : null, id: Number.isFinite(lightID) ? lightID : null },
                });
            }
            continue;
        }
        if (active === false) continue;
        let mname = v2 ? geo._material : geo.material;
        let m = typeof mname === 'string' ? materials[mname] : parseMaterial(mname, v2);
        if (typeof mname !== 'string') mname = null;
        m = m || { color: null, alpha: 1, shader: 'Standard', track: null, glowing: false };
        const isLight = LIGHT_SHADERS.test(m.shader) || !!lw;
        out.push({
            type: (v2 ? geo._type : geo.type) || 'Cube',
            shader: m.shader,
            color: m.color ? [...m.color, m.alpha] : null,
            material: mname,                          // shared by name (animated by the material's track)
            glowing: m.glowing,
            position: normVec3(v2 ? e._position : e.position),
            rotation: normVec3(v2 ? e._rotation : e.rotation),
            localPosition: normVec3(v2 ? e._localPosition : e.localPosition),
            localRotation: normVec3(v2 ? e._localRotation : e.localRotation),
            scale: normVec3(v2 ? e._scale : e.scale),
            track,
            // a light: lighting events of its type (and ID, when they name one) drive it
            light: isLight ? { type: Number.isFinite(lightType) ? lightType : 0, id: Number.isFinite(lightID) ? lightID : null } : null,
            bloom: tube && tube.colorAlphaMultiplier != null ? num(tube.colorAlphaMultiplier, 1) : 1,
        });
    }
    // big model maps bring their own world: hide all stock scenery
    if (out.length >= 24) { for (const g in STOCK_GROUPS) hide.add(g); hide.add('stars'); }
    out.hideGroups = [...hide];
    out.materials = materials;
    out.lights = lights;
    out.fog = fog;
    out.fogTrack = fogTrack;
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
        lockRotation: !!(v2 ? cd._lockPosition : cd.lockRotation),
        nameFilter: pick('_nameFilter', 'nameFilter') ?? null,
    };
    return (custom.rotation !== null || custom.step !== null || custom.speed !== null ||
            custom.direction !== null || custom.prop !== null || custom.lockRotation || custom.nameFilter !== null) ? custom : null;
}

// Chroma lighting-event extras shared by v2 and v3
function lightExtras(cd, v2) {
    if (!cd) return { lightIDs: null, easing: null, hsv: false };
    return {
        lightIDs: lightIds(v2 ? cd._lightID : cd.lightID),
        easing: (v2 ? cd._easing : cd.easing) || null,
        hsv: /hsv/i.test(String((v2 ? cd._lerpType : cd.lerpType) || '')),
    };
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
            parsed.worldPositionStays = !!(v2 ? d._worldPositionStays : d.worldPositionStays);
        } else if (type === 'AnimateComponent') {
            // Chroma: animate the fog (BloomFogEnvironment) or light glow
            // (TubeBloomPrePassLight). Components sit right in the event data
            // (older maps nest them under "components").
            const nested = (v2 ? d._components : d.components) || {};
            const props = {};
            for (const cname in COMPONENT_PROPS) {
                const comp = d[cname] || d['_' + cname] || nested[cname] || nested['_' + cname];
                if (!comp || typeof comp !== 'object') continue;
                for (const field in COMPONENT_PROPS[cname]) {
                    const pts = resolvePts(comp[field] ?? comp['_' + field], defs);
                    if (pts != null) props[COMPONENT_PROPS[cname][field]] = pts;
                }
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

// Noodle note switches (v3 names; v2 the same with a leading underscore)
function noteFlags(cd, v2) {
    const g = (k) => (v2 ? cd['_' + k] : cd[k]);
    const flip = g('flip');
    return {
        link: g('link') != null ? String(g('link')) : null,
        flip: Array.isArray(flip) ? [num(flip[0]), num(flip[1])] : null,
        noBadDirection: !!g('disableBadCutDirection'),
        noBadSpeed: !!g('disableBadCutSpeed'),
        noBadSaber: !!g('disableBadCutSaberType'),
        // Chroma: no debris when cut
        noDebris: !!(cd.disableDebris || cd._disableDebris),
    };
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
    let me = false;
    for (const n of (map._notes || [])) {
        if (!n) continue;
        const cd = n._customData || {};
        let x = meLane(n._lineIndex), y = meLayer(n._lineLayer);
        if (isMeValue(n._lineIndex) || isMeValue(n._lineLayer)) me = true;
        if (Array.isArray(cd._position)) {          // Noodle: [lineIndex-2, lineLayer]
            x = coord(cd._position, 0, x - 2) + 2;
            y = coord(cd._position, 1, y);
        }
        const time = clock.toSeconds(num(n._time));
        const common = {
            time, beat: num(n._time), x, y,
            lx: num(n._lineIndex), ly: num(n._lineLayer),
            njs: num(cd._noteJumpMovementSpeed) || null,
            spawnOffset: cd._noteJumpStartBeatOffset ?? null,
            decorative: !!cd._fake || cd._interactable === false,
            localRot: normVec3(cd._localRotation),
            worldRot: normWorldRot(cd._rotation),
            track: normTrack(cd._track),
            anim: normAnim(cd._animation, defs),
            noGravity: !!cd._disableNoteGravity,
            chroma: normColor(cd._color),
            ...noteFlags(cd, true),
        };
        if (n._type === 3) {
            bombs.push(common);
        } else if (n._type === 0 || n._type === 1) {
            const dir = n._cutDirection ?? 8;
            const mc = meCut(dir);
            if (mc) me = true;
            notes.push({
                ...common,
                color: n._type,
                ...(mc || { dir: dir >= 0 && dir <= 8 ? dir : 8, ...angleFields(dir, 0, cd._cutDirection) }),
            });
        }
    }

    const walls = [];
    for (const o of (map._obstacles || [])) {
        if (!o) continue;
        const cd = o._customData || {};
        let x = meLane(o._lineIndex), y, h;
        const type = num(o._type);
        const mw = meWallType(type);
        if (mw) { y = mw.y; h = mw.h; me = true; }
        else if (type === 2) { y = meLayer(o._lineLayer); h = meHeight(o._height, 5); }
        else if (type === 1) { y = 2; h = 3; }       // crouch
        else { y = 0; h = 5; }                       // full height
        let w = meLane(num(o._width, 1)), l = null;
        if (isMeValue(o._lineIndex) || isMeValue(o._width)) me = true;
        if (Array.isArray(cd._position)) { x = coord(cd._position, 0, x - 2) + 2; y = coord(cd._position, 1, y); }
        if (Array.isArray(cd._scale)) {
            w = coord(cd._scale, 0, w) || w;
            h = coord(cd._scale, 1, h) || h;
            if (cd._scale[2] != null) l = num(cd._scale[2]);
        }
        const start = num(o._time);
        walls.push({
            time: clock.toSeconds(start), beat: start,
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
    const rotations = [];
    for (const ev of (map._events || [])) {
        if (!ev || ev._type === 100) continue;
        const cd = ev._customData || {};
        if (ev._type === 14 || ev._type === 15) {     // 360/90: early / late lane rotation
            const deg = cd._rotation != null ? num(cd._rotation) : rotationDegrees(ev._value);
            if (num(ev._value) >= 1000) me = true;
            rotations.push({ time: clock.toSeconds(num(ev._time)), early: ev._type === 14, deg });
            continue;
        }
        const value = num(ev._value);
        const out = {
            time: clock.toSeconds(num(ev._time)),
            type: ev._type,
            value,
            float: num(ev._floatValue, 1) * colorAlpha(cd._color),
            chroma: normColor(cd._color),
            gradient: parseGradient(cd._lightGradient, clock, num(ev._time)),
            custom: parseEventCustom(ev._customData, true),
            ...lightExtras(cd, true),
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
    return finish({ notes, bombs, walls, events, customEvents, environment, clock, rotations, me });
}

// --- v3 ---
function parseV3(map, baseBpm, regions) {
    const bpmEvents = (map.bpmEvents || []).map(e => ({ beat: num(e.b), bpm: num(e.m) }));
    const clock = new BeatClock(baseBpm, bpmEvents.length ? bpmEvents : regions);
    const mapCd = map.customData || {};
    const defs = parsePointDefs(mapCd, false);

    let me = false;
    const v3Common = (o, forceDecorative = false) => {
        const cd = o.customData || {};
        let x = meLane(o.x), y = meLayer(o.y);
        if (isMeValue(o.x) || isMeValue(o.y)) me = true;
        if (Array.isArray(cd.coordinates)) { x = coord(cd.coordinates, 0, x - 2) + 2; y = coord(cd.coordinates, 1, y); }
        return {
            time: clock.toSeconds(num(o.b)), beat: num(o.b),
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
            chroma: normColor(cd.color),
            ...noteFlags(cd, false),
        };
    };

    const notes = [];
    const pushNote = (n, forceDec = false) => {
        if (!n) return;
        const dir = n.d ?? 8;
        const mc = meCut(dir);
        if (mc) me = true;
        notes.push({
            ...v3Common(n, forceDec),
            color: n.c ?? 0,
            ...(mc || { dir: dir >= 0 && dir <= 8 ? dir : 8, ...angleFields(dir, n.a, null) }),
        });
    };
    for (const n of (map.colorNotes || [])) pushNote(n);
    for (const n of (mapCd.fakeColorNotes || [])) pushNote(n, true);

    // Chains: links as small dot notes. Link times are spread evenly between
    // head and tail; squish only bends the shape (Beat Saber behaviour).
    const pushChain = (c, forceDec = false) => {
        if (!c) return;
        const base = v3Common(c, forceDec);
        const cd = c.customData || {};
        const headTime = base.time;
        const tailTime = clock.toSeconds(num(c.tb, c.b));
        // a chain has at most a few dozen links; a garbage count must not hang the browser
        const count = Math.max(1, Math.min(64, Math.round(num(c.sc, 2)) - 1));
        const squish = num(c.s, 1);
        let tx = c.tx != null ? meLane(c.tx) : base.x, ty = c.ty != null ? meLayer(c.ty) : base.y;
        if (Array.isArray(cd.tailCoordinates)) { tx = coord(cd.tailCoordinates, 0, tx - 2) + 2; ty = coord(cd.tailCoordinates, 1, ty); }
        for (let i = 1; i <= count; i++) {
            const f = i / count;
            const sf = f * squish;
            notes.push({
                ...base,
                time: headTime + (tailTime - headTime) * f,
                x: base.x + (tx - base.x) * sf,
                y: base.y + (ty - base.y) * sf,
                color: c.c ?? 0,
                dir: 8,
                angle: 0, angleAbs: false,
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
        let w = meLane(num(o.w, 1)), h = meHeight(o.h, 1), l = null;
        if (isMeValue(o.w) || isMeValue(o.h)) me = true;
        if (Array.isArray(cd.size)) {
            w = coord(cd.size, 0, w) || w;
            h = coord(cd.size, 1, h) || h;
            if (cd.size[2] != null) l = num(cd.size[2]);   // explicit length in grid units
        }
        walls.push({
            ...base,
            duration: Math.max(0, clock.toSeconds(num(o.b) + num(o.d)) - base.time),
            w, h, l,
        });
    };
    for (const o of (map.obstacles || [])) pushWall(o);
    for (const o of (mapCd.fakeObstacles || [])) pushWall(o, true);

    const rotations = (map.rotationEvents || []).filter(Boolean).map(r => ({
        time: clock.toSeconds(num(r.b)), early: num(r.e) === 0, deg: num(r.r),
    }));
    const events = [];
    for (const ev of (map.basicBeatmapEvents || [])) {
        if (!ev) continue;
        const cd = ev.customData || {};
        if (ev.et === 14 || ev.et === 15) {           // older v3 maps keep rotations here
            if (num(ev.i) >= 1000) me = true;
            rotations.push({ time: clock.toSeconds(num(ev.b)), early: ev.et === 14, deg: cd.rotation != null ? num(cd.rotation) : rotationDegrees(ev.i) });
            continue;
        }
        events.push({
            time: clock.toSeconds(num(ev.b)),
            type: ev.et,
            value: num(ev.i),
            float: num(ev.f, 1) * colorAlpha(cd.color),
            chroma: normColor(cd.color),
            gradient: null,
            custom: parseEventCustom(ev.customData, false),
            ...lightExtras(cd, false),
            legacyColor: null,
        });
    }

    const customEvents = parseCustomEvents(mapCd.customEvents, clock, defs, false);
    const environment = parseEnvironment(mapCd, false);
    return finish({ notes, bombs, walls, events, customEvents, environment, clock, rotations, me });
}

// --- v4 (split object/metadata arrays; lighting lives in the lightshow file) ---
function parseV4(map, baseBpm, lightshowJson, regions) {
    const clock = new BeatClock(baseBpm, regions);
    const nd = map.colorNotesData || [];
    const bd = map.bombNotesData || [];
    const od = map.obstaclesData || [];
    const cdata = map.chainsData || [];

    const blank = { spawnOffset: null, decorative: false, localRot: null, worldRot: null, track: null, anim: null, njs: null, chroma: null };
    let me = false;
    // v4 objects carry their 360/90 rotation (degrees) themselves
    const rot = (o) => (num(o.r) ? [0, num(o.r), 0] : null);
    const notes = (map.colorNotes || []).map(n => {
        const d = nd[n.i || 0] || {};
        const dir = d.d ?? 8;
        const mc = meCut(dir);
        if (mc || isMeValue(d.x) || isMeValue(d.y)) me = true;
        return {
            ...blank,
            time: clock.toSeconds(num(n.b)), beat: num(n.b), worldRot: rot(n),
            x: meLane(num(d.x, 1)), y: meLayer(d.y), lx: num(d.x, 1), ly: num(d.y),
            color: d.c ?? 0,
            ...(mc || { dir: dir >= 0 && dir <= 8 ? dir : 8, ...angleFields(dir, d.a, null) }),
        };
    });

    for (const c of (map.chains || [])) {
        const d = cdata[c.ci || 0];
        const head = nd[c.i || 0];
        if (!d || !head) continue;
        const headTime = clock.toSeconds(num(c.hb));
        const tailTime = clock.toSeconds(num(c.tb));
        const count = Math.max(1, Math.min(64, Math.round(num(d.c, 2)) - 1));
        const squish = num(d.s, 1);
        const hx = meLane(head.x), hy = meLayer(head.y);
        const tx = d.tx != null ? meLane(d.tx) : hx, ty = d.ty != null ? meLayer(d.ty) : hy;
        for (let i = 1; i <= count; i++) {
            const f = i / count, sf = f * squish;
            notes.push({
                ...blank,
                time: headTime + (tailTime - headTime) * f, worldRot: rot(c),
                x: hx + (tx - hx) * sf,
                y: hy + (ty - hy) * sf,
                lx: num(head.x), ly: num(head.y),
                color: head.c ?? 0, dir: 8, angle: 0, angleAbs: false, chainLink: true,
            });
        }
    }

    const bombs = (map.bombNotes || []).map(b => {
        const d = bd[b.i || 0] || {};
        return {
            ...blank,
            time: clock.toSeconds(num(b.b)), beat: num(b.b), worldRot: rot(b),
            x: meLane(num(d.x, 1)), y: meLayer(d.y), lx: num(d.x, 1), ly: num(d.y),
        };
    });

    const walls = (map.obstacles || []).map(o => {
        const d = od[o.i || 0] || {};
        const start = num(o.b);
        if (isMeValue(d.x) || isMeValue(d.w) || isMeValue(d.h)) me = true;
        return {
            ...blank,
            time: clock.toSeconds(start), beat: start, worldRot: rot(o),
            duration: Math.max(0, clock.toSeconds(start + num(d.d)) - clock.toSeconds(start)),
            x: meLane(d.x), y: meLayer(d.y), w: meLane(num(d.w, 1)) || 1, h: meHeight(d.h, 1) || 1, l: null,
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
                    chroma: null, gradient: null, custom: null, legacyColor: null, lightIDs: null, easing: null, hsv: false,
                };
            });
        } catch (e) { /* lightshow optional */ }
    }

    const environment = [];
    environment.hideGroups = [];
    // the player turns with the objects' own rotations
    const rotations = [];
    for (const o of [...notes, ...bombs, ...walls]) if (o.worldRot) rotations.push({ time: o.time, early: true, deg: 0, abs: o.worldRot[1] });
    return finish({ notes, bombs, walls, events, customEvents: [], environment, clock, rotations, me });
}

// 360/90 degree maps: each object spawns at the lane rotation in effect at its
// time (early rotations count for objects on the same beat, late ones don't).
// Noodle's own world rotation wins over it.
function applyRotations(data) {
    const evs = (data.rotations || []).filter(r => Number.isFinite(r.time)).sort((a, b) => a.time - b.time);
    data.rotations = [];
    if (!evs.length) return;
    if (evs.some(r => r.abs != null)) {          // v4: absolute per object
        for (const r of evs) data.rotations.push({ time: r.time, yaw: r.abs });
        return;
    }
    const times = [], cum = [];
    let total = 0;
    for (const r of evs) { total += r.deg; times.push(r.time); cum.push(total); data.rotations.push({ time: r.time, yaw: total, early: r.early }); }
    const EPS = 1e-6;
    const yawAt = (t) => {
        let lo = 0, hi = evs.length;            // first event at or after t - EPS
        while (lo < hi) { const mid = (lo + hi) >> 1; if (times[mid] < t - EPS) lo = mid + 1; else hi = mid; }
        let y = lo > 0 ? cum[lo - 1] : 0;
        for (let i = lo; i < evs.length && evs[i].time <= t + EPS; i++) if (evs[i].early) y += evs[i].deg;
        return y;
    };
    for (const list of [data.notes, data.bombs, data.walls]) {
        for (const o of list) {
            if (o.worldRot) continue;
            const y = yawAt(o.time);
            if (y) o.worldRot = [0, y, 0];
        }
    }
}

// v3 transition events (value 4/8/12) fade from the event before them: link
// each event to the transition that follows it on the same lights
function linkTransitions(events) {
    const last = new Map();
    for (const ev of events) {
        if (ev.type > 4 && ev.type !== 6 && ev.type !== 7 && ev.type !== 10 && ev.type !== 11) continue;
        const key = ev.type + '|' + (ev.lightIDs ? ev.lightIDs.join(',') : '*');
        const v = Math.round(ev.value);
        const prev = last.get(key);
        if (prev && (v === 4 || v === 8 || v === 12)) prev.transitionTo = ev;
        last.set(key, ev);
    }
}

function finish(data) {
    data.notes.sort((a, b) => a.time - b.time);
    data.bombs.sort((a, b) => a.time - b.time);
    data.walls.sort((a, b) => a.time - b.time);
    data.events.sort((a, b) => a.time - b.time);
    data.customEvents.sort((a, b) => a.time - b.time);
    if (!data.environment) data.environment = [];
    if (!data.environment.hideGroups) data.environment.hideGroups = [];
    applyRotations(data);
    linkTransitions(data.events);
    // Noodle choreography: object timing must match the map exactly
    data.noodle = data.customEvents.length > 0 ||
        [data.notes, data.bombs, data.walls].some(list => list.some(o => o.anim || o.track || o.njs || o.spawnOffset != null));
    data.me = !!data.me;
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
