// ============ Noodle Extensions / Heck animation engine ============
// Point definitions with easings + Catmull-Rom splines, quaternion rotation
// interpolation, track animations (AnimateTrack, AssignPathAnimation,
// AssignTrackParent, AssignPlayerToTrack), and per-object combination that
// follows Heck's rules (positions add, rotations multiply, the rest multiply).
import * as THREE from 'three';

export const UNIT = 0.6;            // Noodle grid unit in meters
const DEG = Math.PI / 180;

// ---------- Easings ----------
function bounceOut(x) {
    const n1 = 7.5625, d1 = 2.75;
    if (x < 1 / d1) return n1 * x * x;
    if (x < 2 / d1) return n1 * (x -= 1.5 / d1) * x + 0.75;
    if (x < 2.5 / d1) return n1 * (x -= 2.25 / d1) * x + 0.9375;
    return n1 * (x -= 2.625 / d1) * x + 0.984375;
}
const C1 = 1.70158, C2 = C1 * 1.525, C3 = C1 + 1;
const C4 = (2 * Math.PI) / 3, C5 = (2 * Math.PI) / 4.5;

export const EASINGS = {
    easeLinear: x => x,
    easeStep: x => (x >= 1 ? 1 : 0),
    easeInQuad: x => x * x,
    easeOutQuad: x => 1 - (1 - x) * (1 - x),
    easeInOutQuad: x => (x < 0.5 ? 2 * x * x : 1 - Math.pow(-2 * x + 2, 2) / 2),
    easeInCubic: x => x ** 3,
    easeOutCubic: x => 1 - Math.pow(1 - x, 3),
    easeInOutCubic: x => (x < 0.5 ? 4 * x ** 3 : 1 - Math.pow(-2 * x + 2, 3) / 2),
    easeInQuart: x => x ** 4,
    easeOutQuart: x => 1 - Math.pow(1 - x, 4),
    easeInOutQuart: x => (x < 0.5 ? 8 * x ** 4 : 1 - Math.pow(-2 * x + 2, 4) / 2),
    easeInQuint: x => x ** 5,
    easeOutQuint: x => 1 - Math.pow(1 - x, 5),
    easeInOutQuint: x => (x < 0.5 ? 16 * x ** 5 : 1 - Math.pow(-2 * x + 2, 5) / 2),
    easeInSine: x => 1 - Math.cos((x * Math.PI) / 2),
    easeOutSine: x => Math.sin((x * Math.PI) / 2),
    easeInOutSine: x => -(Math.cos(Math.PI * x) - 1) / 2,
    easeInExpo: x => (x === 0 ? 0 : Math.pow(2, 10 * x - 10)),
    easeOutExpo: x => (x === 1 ? 1 : 1 - Math.pow(2, -10 * x)),
    easeInOutExpo: x => (x === 0 ? 0 : x === 1 ? 1 : x < 0.5 ? Math.pow(2, 20 * x - 10) / 2 : (2 - Math.pow(2, -20 * x + 10)) / 2),
    easeInCirc: x => 1 - Math.sqrt(Math.max(0, 1 - x * x)),
    easeOutCirc: x => Math.sqrt(Math.max(0, 1 - Math.pow(x - 1, 2))),
    easeInOutCirc: x => (x < 0.5 ? (1 - Math.sqrt(Math.max(0, 1 - Math.pow(2 * x, 2)))) / 2 : (Math.sqrt(Math.max(0, 1 - Math.pow(-2 * x + 2, 2))) + 1) / 2),
    easeInBack: x => C3 * x ** 3 - C1 * x * x,
    easeOutBack: x => 1 + C3 * Math.pow(x - 1, 3) + C1 * Math.pow(x - 1, 2),
    easeInOutBack: x => (x < 0.5
        ? (Math.pow(2 * x, 2) * ((C2 + 1) * 2 * x - C2)) / 2
        : (Math.pow(2 * x - 2, 2) * ((C2 + 1) * (x * 2 - 2) + C2) + 2) / 2),
    easeInElastic: x => (x === 0 ? 0 : x === 1 ? 1 : -Math.pow(2, 10 * x - 10) * Math.sin((x * 10 - 10.75) * C4)),
    easeOutElastic: x => (x === 0 ? 0 : x === 1 ? 1 : Math.pow(2, -10 * x) * Math.sin((x * 10 - 0.75) * C4) + 1),
    easeInOutElastic: x => (x === 0 ? 0 : x === 1 ? 1 : x < 0.5
        ? -(Math.pow(2, 20 * x - 10) * Math.sin((20 * x - 11.125) * C5)) / 2
        : (Math.pow(2, -20 * x + 10) * Math.sin((20 * x - 11.125) * C5)) / 2 + 1),
    easeInBounce: x => 1 - bounceOut(1 - x),
    easeOutBounce: bounceOut,
    easeInOutBounce: x => (x < 0.5 ? (1 - bounceOut(1 - 2 * x)) / 2 : (1 + bounceOut(2 * x - 1)) / 2),
};

function ease(name, x) {
    const fn = name && EASINGS[name];
    return fn ? fn(x) : x;
}

// Maps use stray strings/nulls in point data (e.g. Heck "base" properties we
// don't model). Treat anything non-numeric as 0 so nothing turns into NaN.
function n0(v) {
    return typeof v === 'number' && Number.isFinite(v) ? v : 0;
}

export const PROP_DIMS = {
    offsetPosition: 3, position: 3, localPosition: 3, definitePosition: 3,
    rotation: 3, localRotation: 3,
    scale: 3, dissolve: 1, dissolveArrow: 1, color: 4, interactable: 1, time: 1,
    attenuation: 1, fogOffset: 1, startY: 1, height: 1,
};
const ROT_PROPS = { rotation: true, localRotation: true };

// ---------- Point sampler ----------
const isKeyframed = (points) => Array.isArray(points) && points.length > 0 && Array.isArray(points[0]);
const timeOf = (p, dims) => n0(p[dims]);

// Index of the last keyframe whose time <= t (binary search — some wall-art
// maps have thousands of points)
function findSegment(pts, t, dims) {
    let lo = 0, hi = pts.length - 1;
    while (lo < hi) {
        const mid = (lo + hi + 1) >> 1;
        if (timeOf(pts[mid], dims) <= t) lo = mid; else hi = mid - 1;
    }
    return lo;
}

function segmentFlags(b, dims) {
    let easing = null, spline = false, hsv = false;
    for (let k = dims + 1; k < b.length; k++) {
        const f = b[k];
        if (typeof f !== 'string') continue;
        if (f.startsWith('ease')) easing = f;
        else if (f === 'splineCatmullRom') spline = true;
        else if (f === 'lerpHSV') hsv = true;
    }
    return { easing, spline, hsv };
}

const _hsvA = {}, _hsvB = {}, _colA = new THREE.Color(), _colB = new THREE.Color();

// points: number | [v...] (static) | [[v..., time, ...flags], ...]
// Writes into `out` (an array) and returns it, or null when there is nothing.
export function samplePts(points, t, dims, out = []) {
    if (points == null) return null;
    if (typeof points === 'number') { out[0] = n0(points); out.length = 1; return out; }
    if (!Array.isArray(points) || !points.length) return null;
    if (!isKeyframed(points)) {
        for (let d = 0; d < dims; d++) out[d] = n0(points[d]);
        out.length = dims;
        return out;
    }

    const pts = points;
    const first = pts[0], last = pts[pts.length - 1];
    let i;
    if (t <= timeOf(first, dims)) { i = -1; }
    else if (t >= timeOf(last, dims)) { i = pts.length - 1; }
    else { i = findSegment(pts, t, dims); }

    if (i < 0 || i >= pts.length - 1) {
        const p = i < 0 ? first : last;
        for (let d = 0; d < dims; d++) out[d] = n0(p[d]);
        out.length = dims;
        return out;
    }

    const a = pts[i], b = pts[i + 1];
    const ta = timeOf(a, dims), tb = timeOf(b, dims);
    let f = tb > ta ? (t - ta) / (tb - ta) : 1;
    const flags = segmentFlags(b, dims);      // flags live on the segment's end point
    f = ease(flags.easing, f);

    if (flags.spline && dims >= 3) {
        const p0 = pts[Math.max(0, i - 1)], p3 = pts[Math.min(pts.length - 1, i + 2)];
        for (let d = 0; d < dims; d++) {
            const v0 = n0(p0[d]), v1 = n0(a[d]), v2 = n0(b[d]), v3 = n0(p3[d]);
            out[d] = 0.5 * ((2 * v1) + (-v0 + v2) * f +
                (2 * v0 - 5 * v1 + 4 * v2 - v3) * f * f +
                (-v0 + 3 * v1 - 3 * v2 + v3) * f * f * f);
        }
    } else if (flags.hsv && dims === 4) {
        _colA.setRGB(n0(a[0]), n0(a[1]), n0(a[2])).getHSL(_hsvA);
        _colB.setRGB(n0(b[0]), n0(b[1]), n0(b[2])).getHSL(_hsvB);
        let dh = _hsvB.h - _hsvA.h;
        if (dh > 0.5) dh -= 1; else if (dh < -0.5) dh += 1;
        _colA.setHSL((_hsvA.h + dh * f + 1) % 1, _hsvA.s + (_hsvB.s - _hsvA.s) * f, _hsvA.l + (_hsvB.l - _hsvA.l) * f);
        out[0] = _colA.r; out[1] = _colA.g; out[2] = _colA.b;
        out[3] = n0(a[3] ?? 1) + (n0(b[3] ?? 1) - n0(a[3] ?? 1)) * f;
    } else {
        for (let d = 0; d < dims; d++) {
            const va = n0(a[d]);
            out[d] = va + (n0(b[d]) - va) * f;
        }
    }
    out.length = dims;
    return out;
}

// ---------- Rotations ----------
// Unity is left-handed (+z forward); we mirror z, so rotations about x and y
// flip sign. Unity euler order ZXY (extrinsic) == YXZ intrinsic.
const _euler = new THREE.Euler();
export function unityQuat(rx, ry, rz, out = new THREE.Quaternion()) {
    _euler.set(-n0(rx) * DEG, -n0(ry) * DEG, n0(rz) * DEG, 'YXZ');
    return out.setFromEuler(_euler);
}

export function setUnityRotation(target, rx, ry, rz) {
    target.rotation.order = 'YXZ';
    target.rotation.set(-n0(rx) * DEG, -n0(ry) * DEG, n0(rz) * DEG);
}

const _qa = new THREE.Quaternion(), _qb = new THREE.Quaternion();
// Heck interpolates rotation keyframes with quaternion slerp (so [0,0,0] →
// [0,360,0] is *no* rotation, exactly like in game).
export function sampleRot(points, t, out = new THREE.Quaternion()) {
    if (points == null || !Array.isArray(points) || !points.length) return null;
    if (!isKeyframed(points)) return unityQuat(points[0], points[1], points[2], out);
    const pts = points;
    const first = pts[0], last = pts[pts.length - 1];
    if (t <= timeOf(first, 3)) return unityQuat(first[0], first[1], first[2], out);
    if (t >= timeOf(last, 3)) return unityQuat(last[0], last[1], last[2], out);
    const i = findSegment(pts, t, 3);
    if (i >= pts.length - 1) return unityQuat(last[0], last[1], last[2], out);
    const a = pts[i], b = pts[i + 1];
    const ta = timeOf(a, 3), tb = timeOf(b, 3);
    let f = tb > ta ? (t - ta) / (tb - ta) : 1;
    f = ease(segmentFlags(b, 3).easing, f);
    unityQuat(a[0], a[1], a[2], _qa);
    unityQuat(b[0], b[1], b[2], _qb);
    return out.slerpQuaternions(_qa, _qb, f);
}

// ---------- Track system ----------
const KIND = { OBJECT: 'object', ENV: 'env', PLAYER: 'player', PARENT: 'parent' };

class Track {
    constructor(name, root) {
        this.name = name;
        this.values = {};      // AnimateTrack values (arrays; quaternions for rotations)
        this.paths = {};       // AssignPathAnimation point lists
        this.pathFrom = {};    // prop -> {points, start, dur, easing} while blending to a new path
        this.kind = KIND.OBJECT;
        this.group = new THREE.Group();
        this.group.name = 'track:' + name;
        root.add(this.group);
    }
}

const _tmpA = [], _tmpB = [], _tmpQ = new THREE.Quaternion(), _tmpQ2 = new THREE.Quaternion();

// Reusable result of TrackSystem.combine()
export function makeFx() {
    return {
        pos: [0, 0, 0], hasPos: false,
        def: [0, 0, 0], hasDef: false,
        rot: new THREE.Quaternion(), hasRot: false,
        lrot: new THREE.Quaternion(), hasLrot: false,
        scale: [1, 1, 1], hasScale: false,
        dissolve: 1, hasDissolve: false,
        dissolveArrow: 1, hasDissolveArrow: false,
        color: [1, 1, 1, 1], hasColor: false,
        interactable: 1, hasInteractable: false,
        time: 0, hasTime: false,
    };
}

export class TrackSystem {
    /**
     * @param parent THREE.Object3D the noodle root is attached to (its origin = Beat Saber's player origin)
     * @param customEvents parsed [{time, duration, type, tracks, target, easing, props, parent, children}]
     * @param rigs {Root, Head, LeftHand, RightHand} THREE.Groups (or a single Group = Root)
     * @param opts {v2: bool}
     */
    constructor(parent, customEvents = [], rigs = null, opts = {}) {
        this.parent = parent;
        this.root = new THREE.Group();
        this.root.name = 'noodle-tracks';
        parent.add(this.root);
        this.tracks = new Map();
        this.events = [...customEvents].sort((a, b) => a.time - b.time);
        this.evIdx = 0;
        this.active = new Map();        // "track|prop" -> running AnimateTrack
        this.rigs = (rigs && rigs.isObject3D) ? { Root: rigs } : (rigs || {});
        this.rigBase = {};
        for (const k in this.rigs) {
            const r = this.rigs[k];
            if (r) this.rigBase[k] = { pos: r.position.clone(), quat: r.quaternion.clone() };
        }
        this.playerTargets = {};        // Root/Head/LeftHand/RightHand -> track name
        this.fogTrackName = null;
        this.v2 = !!opts.v2;
        this.now = 0;
    }

    // meters per unit for absolute positions (env / parent / player tracks)
    get absUnit() { return this.v2 ? UNIT : 1; }

    track(name) {
        if (!this.tracks.has(name)) this.tracks.set(name, new Track(name, this.root));
        return this.tracks.get(name);
    }

    // Parent container for an object with these track names (first track wins)
    containerFor(trackNames) {
        if (!trackNames || !trackNames.length) return null;
        return this.track(trackNames[0]).group;
    }

    markEnv(name) {
        const tr = this.track(name);
        if (tr.kind === KIND.OBJECT) tr.kind = KIND.ENV;
        return tr;
    }

    _setValue(tr, prop, points, t) {
        if (ROT_PROPS[prop]) {
            const q = tr.values[prop] instanceof THREE.Quaternion ? tr.values[prop] : new THREE.Quaternion();
            if (sampleRot(points, t, q)) tr.values[prop] = q;
        } else {
            const arr = Array.isArray(tr.values[prop]) ? tr.values[prop] : [];
            if (samplePts(points, t, PROP_DIMS[prop] || 1, arr)) tr.values[prop] = arr;
        }
    }

    _start(ev) {
        if (ev.type === 'AnimateTrack' || ev.type === 'AnimateComponent') {
            for (const name of ev.tracks) {
                const tr = this.track(name);
                for (const prop in ev.props) {
                    const key = name + '|' + prop;
                    const pts = ev.props[prop];
                    if (pts === null) {                    // explicit null clears the property
                        delete tr.values[prop];
                        this.active.delete(key);
                    } else if (ev.duration <= 0.001) {
                        this._setValue(tr, prop, pts, 1);
                        this.active.delete(key);
                    } else {
                        // a newer animation on the same property replaces the running one
                        this.active.set(key, { ev, tr, prop, pts });
                        this._setValue(tr, prop, pts, 0);
                    }
                }
            }
        } else if (ev.type === 'AssignPathAnimation') {
            for (const name of ev.tracks) {
                const tr = this.track(name);
                for (const prop in ev.props) {
                    const pts = ev.props[prop];
                    if (pts === null) { delete tr.paths[prop]; delete tr.pathFrom[prop]; continue; }
                    if (ev.duration > 0.001 && tr.paths[prop]) {
                        tr.pathFrom[prop] = { points: tr.paths[prop], start: ev.time, dur: ev.duration, easing: ev.easing };
                    } else {
                        delete tr.pathFrom[prop];
                    }
                    tr.paths[prop] = pts;
                }
            }
        } else if (ev.type === 'AssignTrackParent') {
            const parent = this.track(ev.parent);
            if (parent.kind === KIND.OBJECT) parent.kind = KIND.PARENT;
            for (const child of (ev.children || [])) {
                const c = this.track(child);
                if (c === parent) continue;
                // never create a cycle (it would recurse forever in updateMatrixWorld)
                let p = parent.group, cyclic = false;
                while (p) { if (p === c.group) { cyclic = true; break; } p = p.parent; }
                if (!cyclic) parent.group.add(c.group);
            }
        } else if (ev.type === 'AssignPlayerToTrack') {
            const name = ev.tracks[0] || null;
            if (name) {
                const target = ev.target || 'Root';
                this.playerTargets[target] = name;
                this.track(name).kind = KIND.PLAYER;
            }
        } else if (ev.type === 'AssignFogTrack') {
            this.fogTrackName = ev.tracks[0] || null;
        }
    }

    update(t) {
        this.now = t;
        while (this.evIdx < this.events.length && this.events[this.evIdx].time <= t) {
            this._start(this.events[this.evIdx++]);
        }

        for (const [key, a] of this.active) {
            let p = (t - a.ev.time) / a.ev.duration;
            const loops = 1 + (a.ev.repeat || 0);
            const done = p >= loops;
            p = done ? 1 : (p <= 0 ? 0 : p - Math.floor(p));     // repeat wraps each loop
            if (!done && p === 0 && t > a.ev.time) p = 1;          // exact loop boundary
            this._setValue(a.tr, a.prop, a.pts, ease(a.ev.easing, p));
            if (done) this.active.delete(key);
        }

        // Track groups. Per Heck, gameplay-object track properties apply to each
        // object individually; offsetPosition and offsetWorldRotation are the
        // ones equivalent to a group transform. Parent tracks are real
        // transforms (position/rotation/localRotation/scale).
        for (const tr of this.tracks.values()) {
            const v = tr.values, g = tr.group;
            if (tr.kind === KIND.OBJECT) {
                const op = v.offsetPosition, p2 = this.v2 ? v.position : null;
                g.position.set(
                    ((op ? op[0] : 0) + (p2 ? p2[0] : 0)) * UNIT,
                    ((op ? op[1] : 0) + (p2 ? p2[1] : 0)) * UNIT,
                    -((op ? op[2] : 0) + (p2 ? p2[2] : 0)) * UNIT);
                if (v.rotation) g.quaternion.copy(v.rotation); else g.quaternion.identity();
            } else if (tr.kind === KIND.PARENT) {
                const s = this.absUnit;
                const p = v.localPosition || v.position;
                const op = v.offsetPosition;
                g.position.set(
                    (p ? p[0] * s : 0) + (op ? op[0] * UNIT : 0),
                    (p ? p[1] * s : 0) + (op ? op[1] * UNIT : 0),
                    -((p ? p[2] * s : 0) + (op ? op[2] * UNIT : 0)));
                g.quaternion.identity();
                if (v.rotation) g.quaternion.copy(v.rotation);
                if (v.localRotation) g.quaternion.multiply(v.localRotation);
                if (v.scale) g.scale.set(v.scale[0], v.scale[1], v.scale[2]); else g.scale.set(1, 1, 1);
            }
            // ENV tracks: pieces are positioned individually by the game
        }

        // player / head / saber movement (AssignPlayerToTrack targets)
        for (const target in this.playerTargets) {
            const rig = this.rigs[target];
            if (!rig) continue;
            const base = this.rigBase[target];
            const v = this.track(this.playerTargets[target]).values;
            const s = this.absUnit;
            const p = v.localPosition || v.position;
            const op = v.offsetPosition;
            rig.position.copy(base.pos);
            if (p) rig.position.add(_v3.set(p[0] * s, p[1] * s, -p[2] * s));
            if (op) rig.position.add(_v3.set(op[0] * UNIT, op[1] * UNIT, -op[2] * UNIT));
            rig.quaternion.copy(base.quat);
            if (v.rotation) rig.quaternion.multiply(v.rotation);
            if (v.localRotation) rig.quaternion.multiply(v.localRotation);
        }
    }

    // latest fog values (Chroma AssignFogTrack / AnimateComponent)
    fogValues() {
        if (this.fogTrackName) {
            const v = this.track(this.fogTrackName).values;
            if (v.attenuation !== undefined || v.startY !== undefined || v.height !== undefined) return v;
        }
        for (const tr of this.tracks.values()) {
            if (tr.values.attenuation !== undefined) return tr.values;
        }
        return null;
    }

    // sample a track's path, blending from the previous path while an
    // AssignPathAnimation with a duration is in progress
    _samplePath(tr, prop, lifeP, out, isRot) {
        const pts = tr.paths[prop];
        if (!pts) return null;
        const from = tr.pathFrom[prop];
        if (from && this.now < from.start + from.dur) {
            const f = ease(from.easing, Math.max(0, (this.now - from.start) / from.dur));
            if (isRot) {
                const qa = sampleRot(from.points, lifeP, _tmpQ2) ? _tmpQ2.clone() : new THREE.Quaternion();
                const qb = sampleRot(pts, lifeP, out) || out.identity();
                return out.slerpQuaternions(qa, qb, f);
            }
            const dims = PROP_DIMS[prop] || 1;
            const a = samplePts(from.points, lifeP, dims, _tmpB);
            const b = samplePts(pts, lifeP, dims, out);
            if (a && b) for (let d = 0; d < dims; d++) b[d] = a[d] + (b[d] - a[d]) * f;
            return b;
        }
        if (from) delete tr.pathFrom[prop];
        return isRot ? sampleRot(pts, lifeP, out) : samplePts(pts, lifeP, PROP_DIMS[prop] || 1, out);
    }

    /**
     * Combine an object's own animation with its tracks' path animations and
     * static values, at lifetime progress lifeP (0 spawn, 0.5 hit, 1 gone).
     * The first track is the object's container, so its offsetPosition and
     * world rotation are already applied by the group transform.
     * Writes into `fx` (see makeFx) and returns it, or null if nothing applies.
     */
    combine(objAnim, trackNames, lifeP, fx) {
        fx.hasPos = fx.hasDef = fx.hasRot = fx.hasLrot = fx.hasScale = false;
        fx.hasDissolve = fx.hasDissolveArrow = fx.hasColor = fx.hasInteractable = fx.hasTime = false;
        let any = false;
        const tracks = [];
        if (trackNames) for (const name of trackNames) { const tr = this.tracks.get(name); if (tr) tracks.push(tr); }

        // `time` first: it remaps the lifetime used for everything else
        let tv = null;
        if (objAnim && objAnim.time) tv = samplePts(objAnim.time, lifeP, 1, _tmpA);
        for (const tr of tracks) {
            const p = tr.paths.time ? this._samplePath(tr, 'time', lifeP, _tmpA, false) : null;
            if (p) tv = p;
            if (tr.values.time) tv = tr.values.time;
        }
        if (tv) { fx.time = tv[0]; fx.hasTime = true; any = true; lifeP = Math.max(0, Math.min(1, tv[0])); }

        const addVec = (target, flag, v) => {
            if (!v) return;
            if (!fx[flag]) { target[0] = v[0]; target[1] = v[1]; target[2] = v[2]; fx[flag] = true; }
            else { target[0] += v[0]; target[1] += v[1]; target[2] += v[2]; }
            any = true;
        };
        const mulVec = (target, flag, v, dims) => {
            if (!v) return;
            if (!fx[flag]) { for (let d = 0; d < dims; d++) target[d] = v[d] ?? 1; fx[flag] = true; }
            else for (let d = 0; d < dims; d++) target[d] *= v[d] ?? 1;
            any = true;
        };
        const mulScalar = (key, flag, v) => {
            if (!v) return;
            fx[key] = fx[flag] ? fx[key] * v[0] : v[0];
            fx[flag] = true; any = true;
        };
        const mulQuat = (target, flag, q) => {
            if (!q) return;
            if (!fx[flag]) { target.copy(q); fx[flag] = true; } else target.multiply(q);
            any = true;
        };

        // positions (object anim `position` is the v2 spelling of offsetPosition)
        if (objAnim) {
            addVec(fx.pos, 'hasPos', objAnim.offsetPosition && samplePts(objAnim.offsetPosition, lifeP, 3, _tmpA));
            addVec(fx.pos, 'hasPos', objAnim.position && samplePts(objAnim.position, lifeP, 3, _tmpA));
            addVec(fx.def, 'hasDef', objAnim.definitePosition && samplePts(objAnim.definitePosition, lifeP, 3, _tmpA));
            mulQuat(fx.rot, 'hasRot', objAnim.rotation && sampleRot(objAnim.rotation, lifeP, _tmpQ));
            mulQuat(fx.lrot, 'hasLrot', objAnim.localRotation && sampleRot(objAnim.localRotation, lifeP, _tmpQ));
            mulVec(fx.scale, 'hasScale', objAnim.scale && samplePts(objAnim.scale, lifeP, 3, _tmpA), 3);
            mulScalar('dissolve', 'hasDissolve', objAnim.dissolve && samplePts(objAnim.dissolve, lifeP, 1, _tmpA));
            mulScalar('dissolveArrow', 'hasDissolveArrow', objAnim.dissolveArrow && samplePts(objAnim.dissolveArrow, lifeP, 1, _tmpA));
            mulVec(fx.color, 'hasColor', objAnim.color && samplePts(objAnim.color, lifeP, 4, _tmpA), 4);
            mulScalar('interactable', 'hasInteractable', objAnim.interactable && samplePts(objAnim.interactable, lifeP, 1, _tmpA));
        }

        for (let i = 0; i < tracks.length; i++) {
            const tr = tracks[i];
            const P = tr.paths, V = tr.values;
            if (P.offsetPosition) addVec(fx.pos, 'hasPos', this._samplePath(tr, 'offsetPosition', lifeP, _tmpA, false));
            if (P.position) addVec(fx.pos, 'hasPos', this._samplePath(tr, 'position', lifeP, _tmpA, false));
            if (P.definitePosition) addVec(fx.def, 'hasDef', this._samplePath(tr, 'definitePosition', lifeP, _tmpA, false));
            if (P.rotation) mulQuat(fx.rot, 'hasRot', this._samplePath(tr, 'rotation', lifeP, _tmpQ, true));
            if (P.localRotation) mulQuat(fx.lrot, 'hasLrot', this._samplePath(tr, 'localRotation', lifeP, _tmpQ, true));
            if (P.scale) mulVec(fx.scale, 'hasScale', this._samplePath(tr, 'scale', lifeP, _tmpA, false), 3);
            if (P.dissolve) mulScalar('dissolve', 'hasDissolve', this._samplePath(tr, 'dissolve', lifeP, _tmpA, false));
            if (P.dissolveArrow) mulScalar('dissolveArrow', 'hasDissolveArrow', this._samplePath(tr, 'dissolveArrow', lifeP, _tmpA, false));
            if (P.color) mulVec(fx.color, 'hasColor', this._samplePath(tr, 'color', lifeP, _tmpA, false), 4);
            if (P.interactable) mulScalar('interactable', 'hasInteractable', this._samplePath(tr, 'interactable', lifeP, _tmpA, false));

            // static track values (the container track's offset/rotation are its group transform)
            if (i > 0) {
                addVec(fx.pos, 'hasPos', V.offsetPosition);
                if (this.v2) addVec(fx.pos, 'hasPos', V.position);
                mulQuat(fx.rot, 'hasRot', V.rotation);
            }
            mulQuat(fx.lrot, 'hasLrot', V.localRotation);
            mulVec(fx.scale, 'hasScale', V.scale, 3);
            mulScalar('dissolve', 'hasDissolve', V.dissolve);
            mulScalar('dissolveArrow', 'hasDissolveArrow', V.dissolveArrow);
            mulVec(fx.color, 'hasColor', V.color, 4);
            mulScalar('interactable', 'hasInteractable', V.interactable);
        }
        return any ? fx : null;
    }

    destroy() {
        this.parent.remove(this.root);
        for (const target in this.rigs) {
            const rig = this.rigs[target], base = this.rigBase[target];
            if (!rig || !base) continue;
            rig.position.copy(base.pos);
            rig.quaternion.copy(base.quat);
        }
        this.tracks.clear();
        this.active.clear();
        this.playerTargets = {};
    }
}

const _v3 = new THREE.Vector3();
