// ============ Map editor: the 3D editing view ============
// The map laid out on a track in front of you, drawn by the game engine
// (lights and environment included). Time runs away from you: the glowing
// 4×3 frame is the cursor, where new notes go; what's coming sits on the
// track ahead; light lanes run down the right side, the song's waveform and
// beat numbers down the left. Everything is redrawn from the map data each
// frame it changes, and only what is in view.
import * as THREE from 'three';
import { DIR_VECTORS } from '../beatmap.js';
import { HIT_Z } from '../game.js';
import { EVENT_LANES, lightParts } from './model.js';
import { settings } from '../settings.js';

// Beat Saber's grid (same numbers as the game, so the editor track lines up
// with where notes really arrive)
const COL = 0.6;
const LAYER_BASE = 0.85;
const LAYER_STEP = 0.55;
const WALL_STEP = 0.6;
const NOTE = 0.48;
const colX = (c) => (c - 1.5) * COL;
const layerY = (l) => LAYER_BASE + l * LAYER_STEP;

const GRID_X = 2 * COL;                              // the note track spans ±1.2 m
const GRID_Y0 = LAYER_BASE - LAYER_STEP / 2;
const GRID_Y1 = LAYER_BASE + 2.5 * LAYER_STEP;
const EV_W = 0.34;
const EV_X0 = 1.75;
const EV_X1 = EV_X0 + EVENT_LANES.length * EV_W;
const WAVE_X0 = -2.85;
const WAVE_X1 = -1.85;
const LABEL_X = -1.52;
const FLOOR_Y = 0.008;
const LINE_Y = 0.014;
const FAR = 160;                                     // metres of static track
const VIEW_DIST = 78;                                // metres of objects drawn ahead
const DEG = Math.PI / 180;
const AXIS_Z = new THREE.Vector3(0, 0, 1);
const AXIS_Y = new THREE.Vector3(0, 1, 0);
const ONE = new THREE.Vector3(1, 1, 1);
const LANE_INDEX = Object.fromEntries(EVENT_LANES.map((l, i) => [l.et, i]));
const LANE_LABEL = { 0: 'BACK', 1: 'RINGS', 2: 'LEFT', 3: 'RIGHT', 4: 'CENTER', 8: 'SPIN', 9: 'ZOOM', 12: 'L SPD', 13: 'R SPD' };
const LIGHT_RGB = { blue: [0.24, 0.55, 1], red: [1, 0.24, 0.37], white: [0.95, 0.96, 1] };
const OFF_RGB = [0.22, 0.24, 0.32];
const SEL_RGB = [1, 0.84, 0.42];
const HOVER_RGB = [1, 1, 1];

export const CAM_PRESETS = {
    edit:   { tx: 0.7, ty: 1.0, tz: HIT_Z - 3.6, yaw: 0, pitch: 0.47, dist: 8.2 },
    top:    { tx: 0.75, ty: 0, tz: HIT_Z - 9, yaw: 0, pitch: 1.12, dist: 14 },
    side:   { tx: 0.4, ty: 1.1, tz: HIT_Z - 5, yaw: -1.12, pitch: 0.3, dist: 9.5 },
    player: { tx: 0, ty: 1.3, tz: HIT_Z - 6, yaw: 0, pitch: 0.045, dist: 8.2 },
};

export function kindOf(o) {
    if ('et' in o) return 'events';
    if ('sc' in o) return 'chains';
    if ('mu' in o) return 'arcs';
    if ('c' in o) return 'notes';
    if ('w' in o) return 'walls';
    return 'bombs';
}

// 8-way cut direction from a drag on screen (dragging down = a down cut)
export function dirFromDrag(dx, dy) {
    const a = Math.atan2(-dy, dx);          // standard angle, up positive
    const k = ((Math.round(a / (Math.PI / 4)) % 8) + 8) % 8;   // 0 right, 1 up-right, 2 up ...
    return [3, 5, 0, 4, 2, 6, 1, 7][k];
}

// the note's roll: arrow direction plus the v3 angle offset (counter-clockwise)
function noteRoll(d, a) {
    const v = DIR_VECTORS[d] || [0, 0];
    return (d === 8 ? 0 : Math.atan2(-v[0], v[1])) + (a || 0) * DEG;
}

function lowerBound(arr, b) {
    let lo = 0, hi = arr.length;
    while (lo < hi) { const m = (lo + hi) >> 1; if (arr[m].b < b) lo = m + 1; else hi = m; }
    return lo;
}

function validCam(c) {
    return c && ['tx', 'ty', 'tz', 'yaw', 'pitch', 'dist'].every(k => Number.isFinite(c[k])) ? c : null;
}

// ---------- textures ----------
// a framed square: notes read as solid boxes without scene lighting
function makeNoteTexture() {
    const c = document.createElement('canvas');
    c.width = c.height = 64;
    const g = c.getContext('2d');
    g.fillStyle = '#7d7d86';
    g.fillRect(0, 0, 64, 64);
    const grd = g.createLinearGradient(0, 4, 0, 60);
    grd.addColorStop(0, '#ffffff');
    grd.addColorStop(1, '#d4d4dc');
    g.fillStyle = grd;
    g.beginPath();
    g.roundRect(5, 5, 54, 54, 7);
    g.fill();
    const t = new THREE.CanvasTexture(c);
    t.colorSpace = THREE.SRGBColorSpace;
    return t;
}

function makeTextTexture(text, opts = {}) {
    const { size = 44, color = '#ffffff', weight = 700, w = 256, h = 64, align = 'center' } = opts;
    const c = document.createElement('canvas');
    c.width = w; c.height = h;
    const g = c.getContext('2d');
    g.font = `${weight} ${size}px Rajdhani, "Segoe UI", sans-serif`;
    let s = size;
    while (s > 12 && g.measureText(text).width > w - 10) { s -= 2; g.font = `${weight} ${s}px Rajdhani, "Segoe UI", sans-serif`; }
    g.textAlign = align;
    g.textBaseline = 'middle';
    g.shadowColor = 'rgba(0,0,0,0.9)';
    g.shadowBlur = 8;
    g.fillStyle = color;
    g.fillText(text, align === 'left' ? 6 : align === 'right' ? w - 6 : w / 2, h / 2 + 2);
    const t = new THREE.CanvasTexture(c);
    t.colorSpace = THREE.SRGBColorSpace;
    t.anisotropy = 4;
    return t;
}

// soft shading baked per face (front brightest), so boxes look solid unlit
function shadeBox(geo) {
    const n = geo.attributes.normal, col = new Float32Array(n.count * 3);
    for (let i = 0; i < n.count; i++) {
        const v = 0.52 + 0.48 * Math.max(0, n.getX(i) * 0.3 + n.getY(i) * 0.55 + n.getZ(i) * 0.78);
        col[i * 3] = col[i * 3 + 1] = col[i * 3 + 2] = v;
    }
    geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
    return geo;
}

const WALL_VERT = /* glsl */`
varying vec3 vLocal;
varying vec3 vScale;
varying vec3 vColor;
varying float vFog;
uniform float uFog;
void main() {
    mat4 m = modelMatrix * instanceMatrix;
    vec4 wp = m * vec4(position, 1.0);
    vLocal = position;
    vScale = vec3(length(m[0].xyz), length(m[1].xyz), length(m[2].xyz));
    vColor = instanceColor;
    vec4 mv = viewMatrix * wp;
    float d = uFog * length(mv.xyz);
    vFog = exp(-d * d);
    gl_Position = projectionMatrix * mv;
}`;
const WALL_FRAG = /* glsl */`
varying vec3 vLocal;
varying vec3 vScale;
varying vec3 vColor;
varying float vFog;
void main() {
    vec3 d = (0.5 - abs(vLocal)) * vScale;
    float lo = min(d.x, min(d.y, d.z)), hi = max(d.x, max(d.y, d.z));
    float mid = d.x + d.y + d.z - lo - hi;
    float e = 1.0 - smoothstep(0.012, 0.03, mid);
    gl_FragColor = vec4(vColor, (0.2 + e * 0.7) * vFog);
}`;

// ---------- instanced batches (grow on demand) ----------
const _m = new THREE.Matrix4(), _q = new THREE.Quaternion(), _p = new THREE.Vector3(), _s = new THREE.Vector3();

class Batch {
    constructor(parent, geometry, material, cap = 64) {
        this.parent = parent;
        this.geometry = geometry;
        this.material = material;
        this.mesh = null;
        this.cap = 0;
        this.n = 0;
        this.alloc(cap);
    }
    alloc(cap) {
        const old = this.mesh;
        const mesh = new THREE.InstancedMesh(this.geometry, this.material, cap);
        mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
        mesh.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(cap * 3), 3).setUsage(THREE.DynamicDrawUsage);
        mesh.frustumCulled = false;
        mesh.count = 0;
        if (old) {
            mesh.instanceMatrix.array.set(old.instanceMatrix.array);
            mesh.instanceColor.array.set(old.instanceColor.array);
            mesh.renderOrder = old.renderOrder;
            old.removeFromParent();
            old.dispose();
        }
        this.parent.add(mesh);
        this.mesh = mesh;
        this.cap = cap;
    }
    begin() { this.n = 0; }
    // position, roll about z (or y), per-axis scale, colour [r,g,b]
    push(x, y, z, roll, sx, sy, sz, rgb, yaw = 0) {
        if (this.n >= this.cap) this.alloc(this.cap * 2);
        _p.set(x, y, z);
        if (yaw) _q.setFromAxisAngle(AXIS_Y, yaw); else _q.setFromAxisAngle(AXIS_Z, roll);
        _s.set(sx, sy, sz);
        _m.compose(_p, _q, _s);
        const i = this.n++;
        this.mesh.instanceMatrix.array.set(_m.elements, i * 16);
        const c = this.mesh.instanceColor.array;
        c[i * 3] = rgb[0]; c[i * 3 + 1] = rgb[1]; c[i * 3 + 2] = rgb[2];
    }
    end() {
        const m = this.mesh;
        m.count = this.n;
        m.instanceMatrix.needsUpdate = true;
        m.instanceColor.needsUpdate = true;
    }
    dispose() { this.mesh.removeFromParent(); this.mesh.dispose(); }
}

export class View3D {
    /**
     * @param ed Editor (state + edit operations)
     * @param el the viewport element (pointer input; the engine draws behind it)
     */
    constructor(ed, el) {
        this.ed = ed;
        this.el = el;
        this.engine = ed.engine;
        this.root = new THREE.Group();
        this.root.name = 'editor';
        this.engine.scene.add(this.root);
        this.cam = new THREE.PerspectiveCamera(58, 1, 0.05, 400);
        this.orbit = { ...(validCam(settings.get('editorCam')) || CAM_PRESETS.edit) };
        this.mode = 'edit';
        this.viewBeat = ed.cursorBeat;
        this.dirty = true;          // map data changed: re-sort
        this.changed = true;        // something on screen changed
        this.pointer = null;
        this.hover = null;
        this.drag = null;
        this.instant = false;
        this._wheel = 0;
        this.texCache = new Map();
        this.raycaster = new THREE.Raycaster();
        this.engine.renderer.localClippingEnabled = true;
        this.build();
        this.bind();
        this.applyCamera(false);
        this.engine.useCamera(this.cam);
    }

    get spacing() { return this.ed.spacing; }
    zOf(b) { return HIT_Z - (b - this.viewBeat) * this.spacing; }
    snap(b) { const s = this.ed.snap; return Math.round(b * s) / s; }
    invalidate() { this.dirty = true; this.changed = true; }
    refresh() { this.changed = true; }

    // ---------- scene ----------
    build() {
        const R = this.root, A = this.engine.assets;
        const noteTex = makeNoteTexture();
        this.noteTex = noteTex;
        const clip = this.clip = new THREE.Plane(new THREE.Vector3(0, 0, -1), HIT_Z + 0.26);
        this.mats = {
            note: new THREE.MeshBasicMaterial({ map: noteTex, vertexColors: true }),
            arrow: new THREE.MeshBasicMaterial({ map: this.engine.arrowTex, transparent: true, depthWrite: false }),
            dot: new THREE.MeshBasicMaterial({ map: this.engine.dotTex, transparent: true, depthWrite: false }),
            outline: new THREE.MeshBasicMaterial({ side: THREE.BackSide, transparent: true, opacity: 0.95, depthWrite: false }),
            flat: new THREE.MeshBasicMaterial({ vertexColors: true }),
            bar: new THREE.MeshBasicMaterial({ transparent: true, opacity: 0.85, depthWrite: false, side: THREE.DoubleSide }),
            wall: new THREE.ShaderMaterial({
                uniforms: { uFog: { value: 0.02 } },
                vertexShader: WALL_VERT, fragmentShader: WALL_FRAG,
                transparent: true, depthWrite: false, side: THREE.DoubleSide,
            }),
            arc: [0, 1].map(() => new THREE.MeshBasicMaterial({ transparent: true, opacity: 0.8, clippingPlanes: [clip] })),
            arcSel: new THREE.MeshBasicMaterial({ color: new THREE.Color(...SEL_RGB), transparent: true, opacity: 0.95, clippingPlanes: [clip] }),
            ghost: new THREE.MeshBasicMaterial({ map: noteTex, vertexColors: true, transparent: true, opacity: 0.5, depthWrite: false }),
            ghostFace: new THREE.MeshBasicMaterial({ map: this.engine.arrowTex, transparent: true, opacity: 0.8, depthWrite: false }),
            ghostBomb: new THREE.MeshBasicMaterial({ color: 0xff4040, transparent: true, opacity: 0.45, depthWrite: false, wireframe: true }),
        };
        this.geos = {
            note: shadeBox(new THREE.BoxGeometry(NOTE, NOTE, NOTE)),
            face: new THREE.PlaneGeometry(NOTE * 0.86, NOTE * 0.86),
            cube: new THREE.BoxGeometry(1, 1, 1),
            shaded: shadeBox(new THREE.BoxGeometry(1, 1, 1)),
            bar: new THREE.PlaneGeometry(1, 1).rotateX(-Math.PI / 2),
        };
        const G = this.geos, M = this.mats;
        this.B = {
            notes: new Batch(R, G.note, M.note, 256),
            arrows: new Batch(R, G.face, M.arrow, 256),
            dots: new Batch(R, G.face, M.dot, 64),
            bombs: new Batch(R, A.bomb, A.bombMat, 64),
            links: new Batch(R, G.shaded, M.flat, 64),
            events: new Batch(R, G.shaded, M.flat, 256),
            walls: new Batch(R, G.cube, M.wall, 64),
            outline: new Batch(R, G.cube, M.outline, 32),
            bars: new Batch(R, G.bar, M.bar, 64),
        };
        this.B.arrows.mesh.renderOrder = this.B.dots.mesh.renderOrder = 2;
        this.B.walls.mesh.renderOrder = 3;
        this.B.outline.mesh.renderOrder = 4;

        // static track: floors, lane lines, the cursor frame
        const floor = (x0, x1, color, opacity) => {
            const m = new THREE.Mesh(new THREE.PlaneGeometry(x1 - x0, FAR).rotateX(-Math.PI / 2),
                new THREE.MeshBasicMaterial({ color, transparent: true, opacity, depthWrite: false }));
            m.position.set((x0 + x1) / 2, FLOOR_Y, HIT_Z + 0.6 - FAR / 2);
            m.renderOrder = -2;
            R.add(m);
            return m;
        };
        floor(-GRID_X, GRID_X, 0x0a0a18, 0.9);
        floor(EV_X0, EV_X1, 0x0b0f1e, 0.9);
        floor(WAVE_X0, WAVE_X1, 0x0a0a14, 0.9);

        const seg = [], segCol = [];
        const line = (x0, y0, z0, x1, y1, z1, c) => { seg.push(x0, y0, z0, x1, y1, z1); segCol.push(...c, ...c); };
        const zNear = HIT_Z + 0.6, zFar = HIT_Z + 0.6 - FAR;
        for (let i = 0; i <= 4; i++) line(colX(i - 0.5), LINE_Y, zNear, colX(i - 0.5), LINE_Y, zFar, i % 4 === 0 ? [0.42, 0.42, 0.75] : [0.2, 0.2, 0.38]);
        for (let i = 0; i <= EVENT_LANES.length; i++) {
            const x = EV_X0 + i * EV_W;
            line(x, LINE_Y, zNear, x, LINE_Y, zFar, i === 0 || i === EVENT_LANES.length ? [0.35, 0.4, 0.7] : i === 5 || i === 7 ? [0.28, 0.3, 0.5] : [0.15, 0.17, 0.3]);
        }
        line(WAVE_X0, LINE_Y, zNear, WAVE_X0, LINE_Y, zFar, [0.2, 0.2, 0.35]);
        line(WAVE_X1, LINE_Y, zNear, WAVE_X1, LINE_Y, zFar, [0.2, 0.2, 0.35]);
        // posts from the floor up to the cursor frame
        line(-GRID_X, LINE_Y, HIT_Z, -GRID_X, GRID_Y0, HIT_Z, [0.5, 0.45, 0.9]);
        line(GRID_X, LINE_Y, HIT_Z, GRID_X, GRID_Y0, HIT_Z, [0.5, 0.45, 0.9]);
        const lg = new THREE.BufferGeometry();
        lg.setAttribute('position', new THREE.Float32BufferAttribute(seg, 3));
        lg.setAttribute('color', new THREE.Float32BufferAttribute(segCol, 3));
        this.staticLines = new THREE.LineSegments(lg, new THREE.LineBasicMaterial({ vertexColors: true, transparent: true, opacity: 0.9 }));
        R.add(this.staticLines);

        // the cursor frame: 4 lanes × 3 rows where notes are placed
        const frame = new THREE.Group();
        const outer = new THREE.MeshBasicMaterial({ color: 0xd9ceff }), inner = new THREE.MeshBasicMaterial({ color: 0x8a78ff, transparent: true, opacity: 0.8 });
        for (let i = 0; i <= 4; i++) {
            const edge = i % 4 === 0, t = edge ? 0.03 : 0.014;
            const m = new THREE.Mesh(new THREE.BoxGeometry(t, GRID_Y1 - GRID_Y0 + (edge ? t : 0), t), edge ? outer : inner);
            m.position.set(colX(i - 0.5), (GRID_Y0 + GRID_Y1) / 2, HIT_Z);
            frame.add(m);
        }
        for (let j = 0; j <= 3; j++) {
            const edge = j % 3 === 0, t = edge ? 0.03 : 0.014;
            const m = new THREE.Mesh(new THREE.BoxGeometry(GRID_X * 2, t, t), edge ? outer : inner);
            m.position.set(0, GRID_Y0 + j * LAYER_STEP, HIT_Z);
            frame.add(m);
        }
        R.add(frame);
        const glass = new THREE.Mesh(new THREE.PlaneGeometry(GRID_X * 2, GRID_Y1 - GRID_Y0),
            new THREE.MeshBasicMaterial({ color: 0x6a5cff, transparent: true, opacity: 0.08, depthWrite: false, side: THREE.DoubleSide }));
        glass.position.set(0, (GRID_Y0 + GRID_Y1) / 2, HIT_Z - 0.002);
        R.add(glass);
        // the "now" line across the whole floor
        const now = new THREE.Mesh(new THREE.PlaneGeometry(EV_X1 - WAVE_X0, 0.045).rotateX(-Math.PI / 2),
            new THREE.MeshBasicMaterial({ color: 0xb9a6ff, transparent: true, opacity: 0.95, depthWrite: false }));
        now.position.set((WAVE_X0 + EV_X1) / 2, LINE_Y + 0.002, HIT_Z);
        R.add(now);

        // the cell under the mouse
        this.hoverCell = new THREE.Mesh(new THREE.PlaneGeometry(COL - 0.04, LAYER_STEP - 0.04),
            new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.13, depthWrite: false, side: THREE.DoubleSide }));
        this.hoverCell.visible = false;
        R.add(this.hoverCell);

        // placement previews
        this.ghost = new THREE.Group();
        this.ghostNote = new THREE.Mesh(G.note, M.ghost);
        this.ghostFace = new THREE.Mesh(G.face, M.ghostFace);
        this.ghostFace.position.z = NOTE / 2 + 0.012;
        this.ghostNote.add(this.ghostFace);
        this.ghostBomb = new THREE.Mesh(A.bomb, M.ghostBomb);
        this.ghostWall = new THREE.Mesh(G.cube, new THREE.MeshBasicMaterial({ color: 0xff2d55, transparent: true, opacity: 0.28, depthWrite: false }));
        this.ghostEvent = new THREE.Mesh(G.shaded, new THREE.MeshBasicMaterial({ vertexColors: true, transparent: true, opacity: 0.55, depthWrite: false }));
        for (const g of [this.ghostNote, this.ghostBomb, this.ghostWall, this.ghostEvent]) { g.visible = false; g.renderOrder = 5; this.ghost.add(g); }
        R.add(this.ghost);

        // beat lines (rebuilt for the visible stretch)
        this.lineCap = 6000;
        const dg = new THREE.BufferGeometry();
        dg.setAttribute('position', new THREE.BufferAttribute(new Float32Array(this.lineCap * 3), 3).setUsage(THREE.DynamicDrawUsage));
        dg.setAttribute('color', new THREE.BufferAttribute(new Float32Array(this.lineCap * 3), 3).setUsage(THREE.DynamicDrawUsage));
        this.beatLines = new THREE.LineSegments(dg, new THREE.LineBasicMaterial({ vertexColors: true, transparent: true, opacity: 0.85, depthWrite: false }));
        this.beatLines.frustumCulled = false;
        R.add(this.beatLines);

        // waveform strip (rebuilt for the visible stretch)
        this.waveRows = 1400;
        const wg = new THREE.BufferGeometry();
        wg.setAttribute('position', new THREE.BufferAttribute(new Float32Array(this.waveRows * 2 * 3), 3).setUsage(THREE.DynamicDrawUsage));
        const idx = [];
        for (let i = 0; i < this.waveRows - 1; i++) { const a = i * 2; idx.push(a, a + 1, a + 2, a + 1, a + 3, a + 2); }
        wg.setIndex(idx);
        this.wave = new THREE.Mesh(wg, new THREE.MeshBasicMaterial({ color: 0x7c5cff, transparent: true, opacity: 0.8, depthWrite: false, side: THREE.DoubleSide }));
        this.wave.frustumCulled = false;
        R.add(this.wave);

        // arcs: tubes in track space (the group scrolls), clipped at the cursor
        this.arcGroup = new THREE.Group();
        R.add(this.arcGroup);
        this.arcMeshes = [];

        // text
        this.labels = [];
        this.markerLabels = [];
        const laneLabels = new THREE.Group();
        EVENT_LANES.forEach((l, i) => {
            const s = this.sprite(LANE_LABEL[l.et] || l.name.toUpperCase(), { size: 48, color: l.kind === 'light' ? '#dfe3ff' : '#b9adff' }, 0.6);
            s.position.set(EV_X0 + (i + 0.5) * EV_W, 0.55 + (i % 2) * 0.16, HIT_Z - 0.1);
            laneLabels.add(s);
        });
        R.add(laneLabels);
    }

    tex(key, text, opts) {
        let t = this.texCache.get(key);
        if (!t) {
            if (this.texCache.size > 600) { for (const v of this.texCache.values()) v.dispose(); this.texCache.clear(); }
            t = makeTextTexture(text, opts);
            this.texCache.set(key, t);
        }
        return t;
    }

    sprite(text, opts, width) {
        const t = this.tex(JSON.stringify([text, opts]), text, opts);
        const s = new THREE.Sprite(new THREE.SpriteMaterial({ map: t, transparent: true, depthWrite: false }));
        s.scale.set(width, width / 4, 1);
        s.renderOrder = 6;
        return s;
    }

    // a pooled label: [index] → sprite
    poolLabel(pool, i) {
        let s = pool[i];
        if (!s) {
            s = new THREE.Sprite(new THREE.SpriteMaterial({ transparent: true, depthWrite: false }));
            s.renderOrder = 6;
            this.root.add(s);
            pool[i] = s;
        }
        s.visible = true;
        return s;
    }

    setLabel(s, key, text, opts, width) {
        const t = this.tex(key, text, opts);
        if (s.material.map !== t) { s.material.map = t; s.material.needsUpdate = true; }
        s.scale.set(width, width * (t.image.height / t.image.width), 1);
    }

    // ---------- camera ----------
    applyCamera(save = true) {
        const o = this.orbit;
        o.pitch = THREE.MathUtils.clamp(o.pitch, -0.3, 1.52);
        o.dist = THREE.MathUtils.clamp(o.dist, 1.2, 70);
        const cp = Math.cos(o.pitch);
        this.cam.position.set(o.tx + Math.sin(o.yaw) * cp * o.dist, o.ty + Math.sin(o.pitch) * o.dist, o.tz + Math.cos(o.yaw) * cp * o.dist);
        this.cam.lookAt(o.tx, o.ty, o.tz);
        this.cam.updateMatrixWorld();
        this.changed = true;
        if (save) {
            clearTimeout(this._camSave);
            this._camSave = setTimeout(() => settings.set('editorCam', { ...this.orbit }), 400);
        }
    }

    preset(name) {
        if (!CAM_PRESETS[name]) return;
        Object.assign(this.orbit, CAM_PRESETS[name]);
        this.applyCamera();
    }

    orbitBy(dx, dy) {
        this.orbit.yaw -= dx * 0.005;
        this.orbit.pitch += dy * 0.004;
        this.applyCamera();
    }

    panBy(dx, dy) {
        const k = this.orbit.dist * 0.0017;
        const right = _p.setFromMatrixColumn(this.cam.matrixWorld, 0);
        this.orbit.tx -= right.x * dx * k; this.orbit.ty -= right.y * dx * k; this.orbit.tz -= right.z * dx * k;
        const up = _s.setFromMatrixColumn(this.cam.matrixWorld, 1);
        this.orbit.tx += up.x * dy * k; this.orbit.ty += up.y * dy * k; this.orbit.tz += up.z * dy * k;
        this.applyCamera();
    }

    dolly(steps) {
        this.orbit.dist *= Math.pow(1.12, steps);
        this.applyCamera();
    }

    // edit = the 3D editor; game = the map exactly as the game shows it
    setMode(mode) {
        this.mode = mode === 'game' ? 'game' : 'edit';
        this.root.visible = this.mode === 'edit';
        this.engine.useCamera(this.mode === 'edit' ? this.cam : null);
        if (this.ed.gp) this.ed.gp.hideObjects = this.mode === 'edit';
        this.hover = null;
        this.changed = true;
    }

    layout() {
        const r = this.el.getBoundingClientRect();
        this.engine.setViewBox(this.el.offsetParent ? r : null);
        this.changed = true;
    }

    // screen position of a point on the track (tests use these)
    screenOf(x, y, z) {
        _v.set(x, y, z).project(this.cam);
        return { x: (_v.x + 1) / 2 * innerWidth, y: (1 - _v.y) / 2 * innerHeight };
    }
    cellScreen(lane, layer) { return this.screenOf(colX(lane), layerY(layer), HIT_Z); }
    floorScreen(beat, lane) { return this.screenOf(colX(lane), FLOOR_Y, this.zOf(beat)); }
    eventScreen(et, beat) { return this.screenOf(EV_X0 + (LANE_INDEX[et] + 0.5) * EV_W, FLOOR_Y, this.zOf(beat)); }
    rulerScreen(beat) { return this.screenOf((WAVE_X0 + WAVE_X1) / 2, FLOOR_Y, this.zOf(beat)); }
    noteScreen(o) { return this.screenOf(colX(o.x), layerY(o.y), this.zOf(o.b)); }

    // ---------- picking ----------
    setRay(px, py) {
        this.raycaster.setFromCamera(_ndc.set((px / innerWidth) * 2 - 1, -(py / innerHeight) * 2 + 1), this.cam);
        return this.raycaster.ray;
    }

    // the cell of the cursor frame a ray goes through
    rayCell(r) {
        const p = r.intersectPlane(STRIKE_PLANE, _hit);
        if (!p || Math.abs(p.x) > GRID_X || p.y < GRID_Y0 || p.y > GRID_Y1) return null;
        return {
            lane: Math.min(3, Math.floor((p.x + GRID_X) / COL)),
            layer: Math.min(2, Math.floor((p.y - GRID_Y0) / LAYER_STEP)),
            dist: p.distanceTo(r.origin),
        };
    }

    // where a ray meets the floor (or a level plane at height y), and which part of the track that is
    floorHit(r, y = FLOOR_Y) {
        _plane.set(AXIS_Y, -y);
        const p = r.intersectPlane(_plane, _hit);
        if (!p) return null;
        const rel = (HIT_Z - p.z) / this.spacing;          // beats ahead of the cursor
        if (rel < -4 || rel > VIEW_DIST / this.spacing + 4) return null;
        let region = null;
        if (Math.abs(p.x) <= GRID_X + 0.04) region = 'track';
        else if (p.x >= EV_X0 && p.x <= EV_X1) region = 'events';
        else if (p.x >= WAVE_X0 - 0.4 && p.x < -GRID_X) region = 'ruler';
        const li = Math.min(EVENT_LANES.length - 1, Math.max(0, Math.floor((p.x - EV_X0) / EV_W)));
        return {
            x: p.x, z: p.z, rel, beat: this.viewBeat + rel, region,
            lane: Math.max(0, Math.min(3, Math.floor((p.x + GRID_X) / COL))),
            et: EVENT_LANES[li].et,
        };
    }

    // fractional lane / row where a ray crosses the time plane at z
    planePoint(r, z) {
        _plane.set(AXIS_Z, -z);
        const p = r.intersectPlane(_plane, _hit);
        if (!p) return null;
        return { lf: (p.x + GRID_X) / COL - 0.5, yf: (p.y - LAYER_BASE) / LAYER_STEP };
    }

    // the window of beats that is drawn
    window() {
        return [this.viewBeat - 0.02, this.viewBeat + VIEW_DIST / this.spacing];
    }

    // every drawn object with its box, for picking and box selection
    forEachVisible(fn) {
        const S = this.S;
        if (!S) return;
        const [b0, b1] = this.window();
        for (const kind of ['notes', 'bombs']) {
            const arr = S[kind];
            const h = kind === 'notes' ? 0.26 : 0.24;
            for (let i = lowerBound(arr, b0); i < arr.length && arr[i].b <= b1; i++) {
                const o = arr[i];
                fn(o, kind, colX(o.x), layerY(o.y), this.zOf(o.b), h, h, h);
            }
        }
        for (const c of S.chains) {
            if (c.tb < b0 || c.b > b1) continue;
            for (let i = 1; i < c.sc; i++) {
                const f = i / (c.sc - 1), b = c.b + (c.tb - c.b) * f;
                if (b < b0 || b > b1) continue;
                const g = Math.min(1, f * c.s);
                fn(c, 'chains', colX(c.x + (c.tx - c.x) * g), layerY(c.y + (c.ty - c.y) * g), this.zOf(b), 0.18, 0.1, 0.16);
            }
        }
        for (const a of S.arcs) {
            if (a.b >= b0 && a.b <= b1) fn(a, 'arcs', colX(a.x), layerY(a.y), this.zOf(a.b), 0.12, 0.12, 0.12);
            if (a.tb >= b0 && a.tb <= b1) fn(a, 'arcs', colX(a.tx), layerY(a.ty), this.zOf(a.tb), 0.14, 0.14, 0.14);
        }
        for (const w of S.walls) {
            const end = w.b + w.d;
            if (end < this.viewBeat || w.b > b1) continue;
            const g = this.wallGeom(w);
            fn(w, 'walls', g.x, g.y, g.z, g.sx / 2, g.sy / 2, g.sz / 2);
        }
        const ev = S.events;
        for (let i = lowerBound(ev, b0); i < ev.length && ev[i].b <= b1; i++) {
            const e = ev[i], li = LANE_INDEX[e.et];
            if (li == null) continue;
            fn(e, 'events', EV_X0 + (li + 0.5) * EV_W, 0.08, this.zOf(e.b), EV_W * 0.45, 0.12, 0.16);
        }
    }

    rayObject(r, only = null) {
        let best = null;
        this.forEachVisible((o, kind, x, y, z, hx, hy, hz) => {
            if (only && kind !== only) return;
            _box.min.set(x - hx, y - hy, z - hz);
            _box.max.set(x + hx, y + hy, z + hz);
            const p = r.intersectBox(_box, _hit);
            if (!p) return;
            const d = p.distanceTo(r.origin);
            if (!best || d < best.dist - 1e-3) best = { o, kind, dist: d };
        });
        return best;
    }

    // a note / bomb in a cell of the cursor frame
    objectInCell(lane, layer) {
        const S = this.S, b = this.ed.cursorBeat;
        if (!S) return null;
        for (const kind of ['notes', 'bombs']) {
            const arr = S[kind];
            for (let i = lowerBound(arr, b - 1e-3); i < arr.length && arr[i].b <= b + 1e-3; i++) {
                if (arr[i].x === lane && arr[i].y === layer) return arr[i];
            }
        }
        return null;
    }

    // what's under a screen point, for what the click will do:
    // 'erase' (and double-click) = the nearest object, even through the frame;
    // the Wall tool draws on the floor (only walls get in the way);
    // otherwise the cursor frame wins over things behind it
    pick(px, py, purpose = 'use') {
        const r = this.setRay(px, py);
        const tool = this.ed.tool;
        if (purpose === 'erase') {
            const obj = this.rayObject(r);
            if (obj) return { type: 'obj', ...obj };
            const c = this.rayCell(r), o = c && this.objectInCell(c.lane, c.layer);
            return o ? { type: 'obj', o, kind: kindOf(o) } : null;
        }
        if (tool === 'wall') {
            const w = this.rayObject(r, 'walls');
            if (w) return { type: 'obj', ...w };
            const f = this.floorHit(r);
            return f && f.region ? { type: f.region, ...f } : null;
        }
        const cell = this.rayCell(r);
        if (cell) {
            const o = this.objectInCell(cell.lane, cell.layer);
            if (o) return { type: 'obj', o, kind: kindOf(o) };
            if (tool !== 'select') return { type: 'cell', ...cell };
        }
        const obj = this.rayObject(r);
        if (obj) return { type: 'obj', ...obj };
        const f = this.floorHit(r);
        if (f && f.region) return { type: f.region, ...f };
        return cell ? { type: 'cell', ...cell } : null;
    }

    // ---------- input ----------
    bind() {
        const el = this.el;
        el.addEventListener('contextmenu', (e) => e.preventDefault());
        el.addEventListener('pointerdown', (e) => this.onDown(e));
        el.addEventListener('pointermove', (e) => this.onMove(e));
        el.addEventListener('pointerup', (e) => this.onUp(e));
        el.addEventListener('pointercancel', () => this.cancelDrag());
        el.addEventListener('pointerleave', () => { if (!this.drag) { this.pointer = null; this.changed = true; } });
        el.addEventListener('wheel', (e) => this.onWheel(e), { passive: false });
        el.addEventListener('dblclick', (e) => {
            if (this.mode !== 'edit') return;
            const h = this.pick(e.clientX, e.clientY, 'erase');
            if (h && h.type === 'obj') this.ed.setCursor(h.o.b);
        });
    }

    onDown(e) {
        const p = { x: e.clientX, y: e.clientY };
        this.pointer = p;
        try { this.el.setPointerCapture(e.pointerId); } catch (err) { /* synthetic events */ }
        this.ed.focusView();
        const ed = this.ed;
        if (e.button === 1 || (e.button === 2 && e.shiftKey)) { this.drag = { kind: 'pan', last: p }; return; }
        if (this.mode !== 'edit') return;
        if (e.button === 2) {
            const h = this.pick(p.x, p.y, 'erase');
            if (h && h.type === 'obj') {
                this.drag = { kind: 'erase', erased: new Set([h.o]) };
                ed.erase([h.o], true);
            } else this.drag = { kind: 'orbit', last: p, start: p };
            return;
        }
        if (e.button !== 0) return;
        const h = this.pick(p.x, p.y);
        if (e.altKey && !(h && h.type === 'obj')) { this.drag = { kind: 'orbit', last: p, start: p }; return; }
        if (e.shiftKey && !(h && h.type === 'obj')) { this.drag = { kind: 'box', start: p, now: p, add: true }; return; }
        if (!h) { this.drag = { kind: 'box', start: p, now: p, add: false, click: 'clear' }; return; }
        const tool = ed.tool;
        if (h.type === 'obj') {
            if (e.ctrlKey || e.metaKey) { ed.toggleSelect(h.o); return; }
            if (!ed.sel.has(h.o)) ed.select([h.o], e.shiftKey);
            this.drag = this.startMove(h, p, e.altKey);
        } else if (h.type === 'cell') {
            if (tool === 'select') this.drag = { kind: 'box', start: p, now: p, add: false, click: 'clear' };
            else this.drag = { kind: 'aim', start: p, now: p, lane: h.lane, layer: h.layer, beat: this.snap(ed.cursorBeat) };
        } else if (h.type === 'track') {
            if (tool === 'wall') this.drag = { kind: 'wall', start: p, b0: Math.max(0, this.snap(h.beat)), lane0: h.lane, f0: h, f1: null };
            else this.drag = { kind: 'box', start: p, now: p, add: false, click: 'jump', beat: this.snap(h.beat) };
        } else if (h.type === 'events') {
            ed.placeEvent(h.et, Math.max(0, this.snap(h.beat)));
        } else if (h.type === 'ruler') {
            this.drag = { kind: 'scrub', start: p, rel0: h.rel, beat0: this.viewBeat, moved: false };
        }
        this.changed = true;
    }

    onMove(e) {
        const p = { x: e.clientX, y: e.clientY };
        const last = this.pointer;
        this.pointer = p;
        const d = this.drag;
        this.changed = true;
        if (!d) return;
        const dx = last ? p.x - last.x : 0, dy = last ? p.y - last.y : 0;
        switch (d.kind) {
            case 'orbit': this.orbitBy(dx, dy); this.el.classList.add('orbiting'); break;
            case 'pan': this.panBy(dx, dy); this.el.classList.add('orbiting'); break;
            case 'erase': {
                const h = this.pick(p.x, p.y, 'erase');
                if (h && h.type === 'obj' && !d.erased.has(h.o)) { d.erased.add(h.o); this.ed.erase([h.o], false); }
                break;
            }
            case 'aim': d.now = p; break;
            case 'wall': {
                if (Math.hypot(p.x - d.start.x, p.y - d.start.y) > 5) d.moved = true;
                const f = this.floorHit(this.setRay(p.x, p.y));
                if (f) d.f1 = f;
                break;
            }
            case 'box': d.now = p; this.drawBox(d); break;
            case 'scrub': {
                if (Math.hypot(p.x - d.start.x, p.y - d.start.y) > 4) d.moved = true;
                if (!d.moved) break;
                const f = this.floorHit(this.setRay(p.x, p.y));
                if (f) { this.instant = true; this.ed.setCursor(d.beat0 + d.rel0 - f.rel); }
                break;
            }
            case 'move': this.dragMove(d, p); break;
        }
    }

    onUp(e) {
        const d = this.drag;
        this.drag = null;
        this.el.classList.remove('orbiting');
        this.clearBox();
        if (!d) return;
        const ed = this.ed;
        const p = { x: e.clientX, y: e.clientY };
        switch (d.kind) {
            case 'erase': if (d.erased.size) ed.commitErase(); break;
            case 'aim': {
                const dx = p.x - d.start.x, dy = p.y - d.start.y;
                ed.placeNote(d.lane, d.layer, d.beat, Math.hypot(dx, dy) > 12 ? dirFromDrag(dx, dy) : null);
                break;
            }
            case 'wall': { const w = this.wallFromDrag(d); ed.placeWall(w.x, w.w, w.b, w.d); break; }
            case 'box': {
                const moved = Math.abs(p.x - d.start.x) > 4 || Math.abs(p.y - d.start.y) > 4;
                if (moved) ed.select(this.inRect(d.start, p), d.add);
                else if (d.click === 'jump') ed.setCursor(Math.max(0, d.beat));
                else if (!d.add) ed.select([]);
                break;
            }
            case 'scrub':
                this.instant = false;
                ed.setCursor(Math.max(0, this.snap(d.moved ? ed.cursorBeat : d.beat0 + d.rel0)));
                break;
            case 'move':
                if (d.recorded) ed.afterChange(`Moved ${d.orig.size}`);
                break;
        }
        this.changed = true;
    }

    cancelDrag() {
        const d = this.drag;
        this.drag = null;
        this.clearBox();
        this.el.classList.remove('orbiting');
        if (d && d.kind === 'erase' && d.erased.size) this.ed.commitErase();
        if (d && d.kind === 'move' && d.recorded) this.ed.afterChange('Moved');
        this.instant = false;
    }

    onWheel(e) {
        e.preventDefault();
        const dy = e.deltaY || e.deltaX;
        let steps;
        if (Math.abs(dy) >= 50) { steps = Math.sign(dy) * Math.max(1, Math.min(4, Math.round(Math.abs(dy) / 100))); this._wheel = 0; }
        else {                                  // trackpads: small deltas add up
            this._wheel += dy;
            steps = Math.trunc(this._wheel / 40);
            if (!steps) return;
            this._wheel -= steps * 40;
        }
        if ((this.drag && (this.drag.kind === 'orbit' || this.drag.kind === 'pan')) || (e.buttons & 2)) { this.dolly(steps); return; }
        if (e.ctrlKey || e.metaKey) this.ed.setSpacing(this.ed.spacing * Math.pow(1.15, -steps));
        else if (e.altKey && this.ed.sel.size) this.ed.moveSelection(-steps / this.ed.snap, 0);
        else this.ed.stepCursor(-steps * (e.shiftKey ? 4 : 1));
    }

    startMove(h, p, alt) {
        const items = [...this.ed.sel];
        const orig = new Map(items.map(o => [o, { b: o.b, x: o.x, y: o.y, tb: o.tb, tx: o.tx, ty: o.ty }]));
        const timeMode = alt || h.kind === 'walls' || h.kind === 'events';
        const r = this.setRay(p.x, p.y);
        const d = { kind: 'move', start: p, orig, timeMode, primary: h.o, recorded: false, dBeat: 0, dLane: 0, dLayer: 0 };
        // slide on a level plane at the height you grabbed it, so it follows the mouse
        d.grabY = h.dist != null ? Math.max(FLOOR_Y, Math.min(4, r.origin.y + r.direction.y * h.dist)) : FLOOR_Y;
        if (timeMode) d.f0 = this.floorHit(r, d.grabY);
        else { d.planeZ = this.zOf(h.o.b); d.c0 = this.planePoint(r, d.planeZ); }
        return d;
    }

    // drag the selection: notes move across lanes / rows in their own moment,
    // walls and lights (or anything with Alt) slide in time along the floor
    dragMove(d, p) {
        if (!d.recorded && Math.hypot(p.x - d.start.x, p.y - d.start.y) < 5) return;
        const r = this.setRay(p.x, p.y);
        let dBeat = 0, dLane = 0, dLayer = 0;
        if (d.timeMode) {
            const f = this.floorHit(r, d.grabY);
            if (!f || !d.f0) return;
            const s = this.ed.snap;
            dBeat = Math.round((f.rel - d.f0.rel) * s) / s;
            if (kindOf(d.primary) === 'walls') dLane = Math.round((f.x - d.f0.x) / COL);
        } else {
            d.planeZ = HIT_Z - (d.orig.get(d.primary).b - this.viewBeat) * this.spacing;
            const c = this.planePoint(r, d.planeZ);
            if (!c || !d.c0) return;
            dLane = Math.round(c.lf - d.c0.lf);
            dLayer = Math.round(c.yf - d.c0.yf);
        }
        if (dBeat === d.dBeat && dLane === d.dLane && dLayer === d.dLayer) return;
        d.dBeat = dBeat; d.dLane = dLane; d.dLayer = dLayer;
        if (!d.recorded) { this.ed.recordUndo('Move'); d.recorded = true; }
        const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
        const r4 = (v) => Math.round(v * 10000) / 10000;
        for (const [o, s] of d.orig) {
            const k = kindOf(o);
            o.b = Math.max(0, r4(s.b + dBeat));
            if ('tb' in o) o.tb = Math.max(0, r4(s.tb + dBeat));
            if (k === 'events') continue;
            if (k === 'walls') { o.x = clamp(s.x + dLane, 0, 4 - Math.max(1, o.w)); continue; }
            o.x = clamp(s.x + dLane, 0, 3);
            o.y = clamp(s.y + dLayer, 0, 2);
            if ('tx' in o) { o.tx = clamp(s.tx + dLane, 0, 3); o.ty = clamp(s.ty + dLayer, 0, 2); }
        }
        this.invalidate();
    }

    wallFromDrag(d) {
        const s = this.ed.snap;
        let dBeat = 0, dLane = 0;
        if (d.f0 && d.f1) {
            dBeat = Math.round((d.f1.rel - d.f0.rel) * s) / s;
            dLane = Math.round((d.f1.x - d.f0.x) / COL);
        }
        const l1 = Math.max(0, Math.min(3, d.lane0 + dLane));
        let b = d.b0, len = dBeat;
        if (len < 0) { b = Math.max(0, d.b0 + len); len = d.b0 - b; }
        if (len < 1 / s) len = d.moved ? 1 / s : 1;           // a plain click makes a one-beat wall
        return { x: Math.min(d.lane0, l1), w: Math.abs(l1 - d.lane0) + 1, b, d: len };
    }

    // objects whose centre lands inside a screen rectangle
    inRect(a, b) {
        const x0 = Math.min(a.x, b.x), x1 = Math.max(a.x, b.x), y0 = Math.min(a.y, b.y), y1 = Math.max(a.y, b.y);
        const hits = new Set();
        this.forEachVisible((o, kind, x, y, z) => {
            _v.set(x, y, z).project(this.cam);
            if (_v.z < -1 || _v.z > 1) return;
            const sx = (_v.x + 1) / 2 * innerWidth, sy = (1 - _v.y) / 2 * innerHeight;
            if (sx >= x0 && sx <= x1 && sy >= y0 && sy <= y1) hits.add(o);
        });
        return [...hits];
    }

    drawBox(d) {
        let box = this._boxEl;
        if (!box) {
            box = this._boxEl = document.createElement('div');
            box.className = 'ed-boxsel';
            document.body.appendChild(box);
        }
        const x0 = Math.min(d.start.x, d.now.x), y0 = Math.min(d.start.y, d.now.y);
        Object.assign(box.style, { left: x0 + 'px', top: y0 + 'px', width: Math.abs(d.now.x - d.start.x) + 'px', height: Math.abs(d.now.y - d.start.y) + 'px', display: 'block' });
    }
    clearBox() { if (this._boxEl) this._boxEl.style.display = 'none'; }

    // ---------- per frame ----------
    render(dt) {
        const target = this.ed.cursorBeat;
        if (this.ed.playing || this.instant || Math.abs(target - this.viewBeat) > 24) this.viewBeat = target;
        else {
            this.viewBeat += (target - this.viewBeat) * (1 - Math.exp(-dt / 0.045));
            if (Math.abs(target - this.viewBeat) < 1e-4) this.viewBeat = target;
        }
        if (this.viewBeat !== this._lastBeat) { this._lastBeat = this.viewBeat; this.changed = true; }
        if (this.mode !== 'edit') return;
        if (this.dirty) this.resort();
        if (!this.changed) return;
        this.changed = false;
        this.updateHover();
        this.sync();
    }

    resort() {
        const D = this.ed.data;
        const by = (a) => a.slice().sort((x, y) => x.b - y.b);
        this.S = { notes: by(D.notes), bombs: by(D.bombs), events: by(D.events), chains: D.chains, arcs: D.arcs, walls: D.walls };
        this.lightLanes = {};
        for (const e of this.S.events) (this.lightLanes[e.et] || (this.lightLanes[e.et] = [])).push(e);
        this.buildArcs();
        this.dirty = false;
        this.changed = true;
    }

    updateHover() {
        const p = this.pointer;
        const busy = this.drag && !['aim', 'wall'].includes(this.drag.kind);
        const h = p && !busy ? this.pick(p.x, p.y) : null;
        this.hover = h;
        // status line: what a click does here
        const key = h ? `${h.type}:${h.type === 'obj' ? kindOf(h.o) : h.lane ?? h.et ?? ''}:${h.layer ?? ''}:${this.ed.tool}` : '';
        if (key === this._hoverKey) return;
        this._hoverKey = key;
        if (!h || this.drag) return;
        const t = this.ed.tool;
        const msg = {
            cell: t === 'select' ? 'Drag to select' : 'Click to place · drag to aim it · right-click a note to delete it',
            track: t === 'wall' ? 'Drag along the track to draw a wall (a click makes a one-beat wall)' : 'Click to move the cursor here · drag to select',
            events: 'Click to place a light event (pick the colour on the left)',
            ruler: 'Click to jump here · drag to scroll the song',
            obj: 'Click to select · drag to move · right-click to delete · double-click to jump to it',
        }[h.type];
        if (msg) this.ed.status(msg);
    }

    noteRgb(o) {
        if (o.color) return [Math.max(0, Math.min(1, o.color[0])), Math.max(0, Math.min(1, o.color[1])), Math.max(0, Math.min(1, o.color[2]))];
        return o.c ? this.blue : this.red;
    }

    wallGeom(w) {
        const start = Math.max(w.b, this.viewBeat);
        const end = Math.min(w.b + w.d, this.viewBeat + VIEW_DIST / this.spacing + 2);
        const zs = this.zOf(start), ze = this.zOf(end);
        const len = Math.max(0.02, zs - ze);
        const width = Math.max(0.05, Math.abs(w.w || 1)) * COL;
        const height = Math.max(0.05, Math.abs(w.h || 1)) * WALL_STEP;
        return {
            x: colX(w.x) - COL / 2 + (w.w || 1) * COL / 2, y: 0.1 + w.y * WALL_STEP + height / 2, z: zs - len / 2,
            sx: Math.max(0.05, width - 0.03), sy: height, sz: len,
        };
    }

    sync() {
        const ed = this.ed, S = this.S, B = this.B, sel = ed.sel;
        if (!S) return;
        this.red = new THREE.Color(settings.get('leftColor') || '#ff2d55').toArray();
        this.blue = new THREE.Color(settings.get('rightColor') || '#2d7dff').toArray();
        const hov = this.hover && this.hover.type === 'obj' && !this.drag ? this.hover.o : null;
        const [b0, b1] = this.window();
        for (const k in B) B[k].begin();
        const outline = (o, x, y, z, sx, sy, sz, roll = 0) => {
            if (sel.has(o)) B.outline.push(x, y, z, roll, sx, sy, sz, SEL_RGB);
            else if (o === hov) B.outline.push(x, y, z, roll, sx, sy, sz, HOVER_RGB);
        };

        // notes
        const N = S.notes;
        for (let i = lowerBound(N, b0); i < N.length && N[i].b <= b1; i++) {
            const n = N[i];
            const x = colX(n.x), y = layerY(n.y), z = this.zOf(n.b), roll = noteRoll(n.d, n.a);
            B.notes.push(x, y, z, roll, 1, 1, 1, this.noteRgb(n));
            (n.d === 8 ? B.dots : B.arrows).push(x, y, z + NOTE / 2 + 0.012, n.d === 8 ? 0 : roll, 1, 1, 1, HOVER_RGB);
            outline(n, x, y, z, NOTE * 1.2, NOTE * 1.2, NOTE * 1.2, roll);
        }
        for (let i = lowerBound(S.bombs, b0); i < S.bombs.length && S.bombs[i].b <= b1; i++) {
            const o = S.bombs[i], x = colX(o.x), y = layerY(o.y), z = this.zOf(o.b);
            B.bombs.push(x, y, z, o.b * 2.3, 1, 1, 1, HOVER_RGB);
            outline(o, x, y, z, 0.52, 0.52, 0.52);
        }
        // chains: the links after the head note
        for (const c of S.chains) {
            if (c.tb < b0 || c.b > b1) continue;
            const rgb = c.c ? this.blue : this.red, roll = noteRoll(c.d, 0);
            for (let i = 1; i < c.sc; i++) {
                const f = i / (c.sc - 1), b = c.b + (c.tb - c.b) * f;
                if (b < b0 || b > b1) continue;
                const g = Math.min(1, f * c.s);
                const x = colX(c.x + (c.tx - c.x) * g), y = layerY(c.y + (c.ty - c.y) * g), z = this.zOf(b);
                B.links.push(x, y, z, roll, 0.36, 0.13, 0.3, rgb);
                outline(c, x, y, z, 0.44, 0.2, 0.36, roll);
            }
        }
        // walls (cut off at the cursor)
        for (const w of S.walls) {
            if (w.b + w.d < this.viewBeat || w.b > b1) continue;
            const g = this.wallGeom(w);
            let rgb = w.color ? [w.color[0], w.color[1], w.color[2]].map(v => Math.max(0, Math.min(1, v))) : [1, 0.18, 0.33];
            if (sel.has(w)) rgb = SEL_RGB;
            else if (w === hov) rgb = rgb.map(v => Math.min(1, v * 0.6 + 0.4));
            B.walls.push(g.x, g.y, g.z, 0, g.sx, g.sy, g.sz, rgb);
        }
        // light events
        const E = S.events;
        for (let i = lowerBound(E, b0); i < E.length && E[i].b <= b1; i++) {
            const e = E[i], li = LANE_INDEX[e.et];
            if (li == null) continue;
            const lane = EVENT_LANES[li];
            const x = EV_X0 + (li + 0.5) * EV_W, z = this.zOf(e.b);
            let rgb, sy = 0.1, yaw = 0, sx = EV_W * 0.8, sz = 0.18;
            if (lane.kind === 'light') {
                const lp = lightParts(e.i);
                rgb = e.color && e.i ? e.color.slice(0, 3).map(v => Math.max(0, Math.min(1, v))) : lp.color ? LIGHT_RGB[lp.color] : OFF_RGB;
                const f = Math.max(0.3, Math.min(1.4, 0.35 + 0.65 * (e.f ?? 1)));
                if (lp.mode === 'flash') { rgb = rgb.map(v => Math.min(1, v * 0.7 + 0.3)); sy = 0.22; }
                else if (lp.mode === 'fade') { rgb = rgb.map(v => v * 0.55); sz = 0.4; }
                else if (lp.mode === 'transition') { yaw = Math.PI / 4; sx = sz = EV_W * 0.55; }
                if (lp.mode !== 'off') rgb = rgb.map(v => Math.min(1, v * f));
            } else if (lane.kind === 'speed') { rgb = [0.18, 0.83, 0.75]; sy = 0.05 + Math.min(20, e.i || 0) * 0.02; }
            else rgb = [0.65, 0.55, 0.98];
            B.events.push(x, sy / 2 + LINE_Y, z, 0, sx, sy, sz, rgb, yaw);
            outline(e, x, sy / 2 + LINE_Y, z, sx + 0.06, sy + 0.06, sz + 0.06);
        }
        // light state at the cursor: each light lane glows the way it is right now
        for (const lane of EVENT_LANES) {
            if (lane.kind !== 'light') continue;
            const list = this.lightLanes[lane.et];
            let rgb = [0.03, 0.03, 0.06];
            if (list) {
                const j = lowerBound(list, ed.cursorBeat + 1e-4) - 1;
                const e = j >= 0 ? list[j] : null;
                const lp = e ? lightParts(e.i) : null;
                if (lp && lp.color && lp.mode !== 'fade') rgb = e.color ? e.color.slice(0, 3) : LIGHT_RGB[lp.color];
            }
            B.bars.push(EV_X0 + (LANE_INDEX[lane.et] + 0.5) * EV_W, LINE_Y + 0.003, HIT_Z + 0.2, 0, EV_W - 0.04, 1, 0.34, rgb);
        }

        this.syncTrack(b0, b1);
        this.syncGhost();
        for (const k in B) B[k].end();

        // arcs scroll with the track
        this.arcGroup.position.z = HIT_Z + this.viewBeat * this.spacing;
        for (const { a, mesh } of this.arcMeshes) mesh.material = sel.has(a) || a === hov ? this.mats.arcSel : this.mats.arc[a.c ? 1 : 0];
        this.mats.arc[0].color.setRGB(...this.red);
        this.mats.arc[1].color.setRGB(...this.blue);
        if (this.engine.scene.fog) this.mats.wall.uniforms.uFog.value = this.engine.scene.fog.density || 0;
    }

    // beat lines, measure bars, markers, labels, waveform
    syncTrack(b0, b1) {
        const ed = this.ed, B = this.B;
        const pos = this.beatLines.geometry.attributes.position, col = this.beatLines.geometry.attributes.color;
        const P = pos.array, C = col.array;
        let n = 0;
        const seg = (x0, x1, z, c) => {
            if (n + 2 > this.lineCap) return;
            P.set([x0, LINE_Y, z, x1, LINE_Y, z], n * 3);
            C.set([...c, ...c], n * 3);
            n += 2;
        };
        const sub = 1 / ed.snap;
        const from = Math.max(0, Math.ceil(this.viewBeat - 0.01));
        const subTo = this.viewBeat + Math.min(24, 120 / ed.snap);
        const beatStep = this.spacing >= 0.9 ? 1 : this.spacing >= 0.45 ? 2 : 4;
        for (let b = from; b <= b1; b += 1) {
            const z = this.zOf(b);
            const measure = b % 4 === 0;
            if (measure) {
                B.bars.push(0, LINE_Y + 0.001, z, 0, GRID_X * 2, 1, 0.035, [0.55, 0.55, 0.95]);
                B.bars.push((EV_X0 + EV_X1) / 2, LINE_Y + 0.001, z, 0, EV_X1 - EV_X0, 1, 0.03, [0.4, 0.45, 0.85]);
            }
            seg(WAVE_X0, GRID_X, z, measure ? [0.5, 0.5, 0.85] : [0.3, 0.3, 0.55]);
            seg(EV_X0, EV_X1, z, measure ? [0.42, 0.45, 0.8] : [0.22, 0.24, 0.42]);
            if (b < subTo && this.spacing / ed.snap > 0.07) {
                for (let k = 1; k < ed.snap; k++) seg(-GRID_X, GRID_X, this.zOf(b + k * sub), k * 2 === ed.snap ? [0.26, 0.22, 0.5] : [0.15, 0.13, 0.32]);
            }
        }
        pos.needsUpdate = col.needsUpdate = true;
        this.beatLines.geometry.setDrawRange(0, n);

        // beat numbers
        let li = 0;
        for (let b = Math.ceil(Math.max(0, this.viewBeat - 0.01) / beatStep) * beatStep; b <= b1 && li < 120; b += beatStep) {
            const measure = b % 4 === 0;
            const s = this.poolLabel(this.labels, li++);
            this.setLabel(s, (measure ? 'M' : 'b') + b, String(b), { size: measure ? 54 : 44, color: measure ? '#e6e9ff' : '#9aa0cc', w: 128, h: 64 }, measure ? 0.62 : 0.46);
            s.position.set(LABEL_X, 0.16, this.zOf(b));
        }
        for (let i = li; i < this.labels.length; i++) this.labels[i].visible = false;

        // bookmarks + BPM changes: bars across the track with a name
        let mi = 0;
        for (const bm of ed.data.bookmarks) {
            if (bm.b < b0 - 1 || bm.b > b1) continue;
            const z = this.zOf(bm.b);
            B.bars.push((WAVE_X0 + EV_X1) / 2, LINE_Y + 0.004, z, 0, EV_X1 - WAVE_X0, 1, 0.05, [0.24, 1, 0.63]);
            const s = this.poolLabel(this.markerLabels, mi++);
            const name = '⚑ ' + (bm.name || 'Bookmark').slice(0, 24);
            this.setLabel(s, 'bm' + name, name, { size: 40, color: '#3dffa0', w: 384, h: 64, align: 'right' }, 1.5);
            s.center.set(1, 0.5);
            s.position.set(WAVE_X0 - 0.08, 0.14, z);
        }
        for (const e of ed.data.bpm) {
            if (e.b < b0 - 1 || e.b > b1) continue;
            const z = this.zOf(e.b);
            B.bars.push((WAVE_X0 + EV_X1) / 2, LINE_Y + 0.004, z, 0, EV_X1 - WAVE_X0, 1, 0.05, [1, 0.69, 0.18]);
            const s = this.poolLabel(this.markerLabels, mi++);
            const text = `♩ ${e.m} BPM`;
            this.setLabel(s, 'bpm' + text, text, { size: 40, color: '#ffb02d', w: 256, h: 64, align: 'left' }, 1.0);
            s.center.set(0, 0.5);
            s.position.set(EV_X1 + 0.08, 0.14, z);
        }
        for (let i = mi; i < this.markerLabels.length; i++) this.markerLabels[i].visible = false;

        this.syncWave(b1);
    }

    syncWave(b1) {
        const w = this.ed.wave, geo = this.wave.geometry;
        if (!w) { geo.setDrawRange(0, 0); return; }
        const clock = this.ed.clock;
        const start = Math.max(0, this.viewBeat - 2);
        const rows = Math.min(this.waveRows, Math.max(2, Math.ceil((b1 - start) * 16)));
        const step = (b1 - start) / (rows - 1);
        const P = geo.attributes.position.array;
        const mid = (WAVE_X0 + WAVE_X1) / 2, half = (WAVE_X1 - WAVE_X0) / 2 - 0.05;
        let t0 = clock.toSeconds(start);
        for (let r = 0; r < rows; r++) {
            const b = start + r * step;
            const t1 = clock.toSeconds(b + step);
            let i0 = Math.max(0, Math.floor(t0 * w.rate)), i1 = Math.min(w.peaks.length - 1, Math.ceil(t1 * w.rate));
            let m = 0;
            for (let i = i0; i <= i1; i++) if (w.peaks[i] > m) m = w.peaks[i];
            t0 = t1;
            const hw = 0.015 + m * half, z = this.zOf(b);
            P.set([mid - hw, LINE_Y, z, mid + hw, LINE_Y, z], r * 6);
        }
        geo.attributes.position.needsUpdate = true;
        geo.setDrawRange(0, (rows - 1) * 6);
    }

    // what a click would add, shown before you click
    syncGhost() {
        const ed = this.ed, d = this.drag, h = this.hover;
        this.ghostNote.visible = this.ghostBomb.visible = this.ghostWall.visible = this.ghostEvent.visible = false;
        this.hoverCell.visible = false;
        const tool = ed.tool;
        const cell = d && d.kind === 'aim' ? d : (!d && h && h.type === 'cell' && tool !== 'select' ? h : null);
        if (cell) {
            const x = colX(cell.lane), y = layerY(cell.layer);
            this.hoverCell.position.set(x, y, HIT_Z + 0.003);
            this.hoverCell.material.color.setRGB(...(tool === 'blue' ? this.blue : tool === 'red' ? this.red : [1, 1, 1]));
            this.hoverCell.visible = true;
            if (tool === 'red' || tool === 'blue') {
                let dir = ed.dir;
                if (d && d.kind === 'aim') {
                    const dx = d.now.x - d.start.x, dy = d.now.y - d.start.y;
                    if (Math.hypot(dx, dy) > 12) dir = dirFromDrag(dx, dy);
                }
                this.ghostNote.position.set(x, y, HIT_Z);
                this.ghostNote.rotation.set(0, 0, noteRoll(dir, dir === 8 ? 0 : ed.angle));
                this.ghostNote.material.color.setRGB(...(tool === 'blue' ? this.blue : this.red));
                const faceTex = dir === 8 ? this.engine.dotTex : this.engine.arrowTex;
                if (this.mats.ghostFace.map !== faceTex) { this.mats.ghostFace.map = faceTex; this.mats.ghostFace.needsUpdate = true; }
                this.ghostNote.visible = true;
            } else if (tool === 'bomb') {
                this.ghostBomb.position.set(x, y, HIT_Z);
                this.ghostBomb.visible = true;
            }
        }
        // walls: while dragging, or a one-lane preview under the mouse
        let wall = null;
        if (d && d.kind === 'wall') wall = this.wallFromDrag(d);
        else if (!d && tool === 'wall' && h && h.type === 'track') wall = { x: h.lane, w: 1, b: Math.max(0, this.snap(h.beat)), d: 1 };
        if (wall) {
            const [y, hgt] = ed.wallType === 'crouch' ? [2, 3] : [0, 5];
            const g = this.wallGeom({ ...wall, y, h: hgt });
            this.ghostWall.position.set(g.x, g.y, g.z);
            this.ghostWall.scale.set(g.sx, g.sy, g.sz);
            this.ghostWall.visible = true;
        }
        // a light event under the mouse in the light lanes
        if (!d && h && h.type === 'events') {
            const li = LANE_INDEX[h.et];
            const b = Math.max(0, this.snap(h.beat));
            const lane = EVENT_LANES[li];
            const v = ed.eventValue(h.et);
            const lp = lightParts(v);
            const rgb = lane.kind !== 'light' ? [0.65, 0.55, 0.98] : lp.color ? (ed.customColor || LIGHT_RGB[lp.color]) : OFF_RGB;
            this.ghostEvent.position.set(EV_X0 + (li + 0.5) * EV_W, 0.06, this.zOf(b));
            this.ghostEvent.scale.set(EV_W * 0.8, 0.1, 0.18);
            this.ghostEvent.material.color.setRGB(...rgb);
            this.ghostEvent.visible = true;
        }
        // the beat under the mouse on the track
        if (!d && h && (h.type === 'track' || h.type === 'ruler')) {
            const b = Math.max(0, this.snap(h.beat));
            this.B.bars.push(0, LINE_Y + 0.005, this.zOf(b), 0, GRID_X * 2 + (h.type === 'ruler' ? GRID_X : 0), 1, 0.06, [1, 1, 1]);
        }
    }

    buildArcs() {
        for (const { mesh } of this.arcMeshes) { mesh.geometry.dispose(); mesh.removeFromParent(); }
        this.arcMeshes = [];
        const sp = this.spacing;
        for (const a of this.ed.data.arcs) {
            const h = new THREE.Vector3(colX(a.x), layerY(a.y), -a.b * sp);
            const t = new THREE.Vector3(colX(a.tx), layerY(a.ty), -a.tb * sp);
            const len = Math.abs(t.z - h.z);
            const hv = DIR_VECTORS[a.d] || [0, 0], tv = DIR_VECTORS[a.tc] || [0, 0];
            const p1 = h.clone().add(new THREE.Vector3(hv[0] * a.mu * 0.9, hv[1] * a.mu * 0.9, -len / 3));
            const p2 = t.clone().add(new THREE.Vector3(-tv[0] * a.tmu * 0.9, -tv[1] * a.tmu * 0.9, len / 3));
            const geo = new THREE.TubeGeometry(new THREE.CubicBezierCurve3(h, p1, p2, t), 40, 0.035, 6, false);
            const mesh = new THREE.Mesh(geo, this.mats.arc[a.c ? 1 : 0]);
            mesh.frustumCulled = false;
            this.arcGroup.add(mesh);
            this.arcMeshes.push({ a, mesh });
        }
    }

    dispose() {
        clearTimeout(this._camSave);
        settings.set('editorCam', { ...this.orbit });
        this.engine.useCamera(null);
        if (this._boxEl) this._boxEl.remove();
        for (const k in this.B) this.B[k].dispose();
        const sharedGeo = new Set([...Object.values(this.geos), this.engine.assets.bomb]);
        const sharedMat = new Set([...Object.values(this.mats).flat(), this.engine.assets.bombMat]);
        this.root.traverse((o) => {
            if (o.geometry && !o.isSprite && !sharedGeo.has(o.geometry)) o.geometry.dispose();
            if (o.material && !sharedMat.has(o.material)) o.material.dispose();
        });
        this.root.removeFromParent();
        for (const g of Object.values(this.geos)) g.dispose();
        for (const m of Object.values(this.mats)) (Array.isArray(m) ? m : [m]).forEach(x => x.dispose());
        for (const t of this.texCache.values()) t.dispose();
        this.texCache.clear();
        this.noteTex.dispose();
    }
}

const _ndc = new THREE.Vector2();
const _hit = new THREE.Vector3();
const _v = new THREE.Vector3();
const _box = new THREE.Box3();
const _plane = new THREE.Plane();
const STRIKE_PLANE = new THREE.Plane(new THREE.Vector3(0, 0, 1), -HIT_Z);
const FLOOR_PLANE = new THREE.Plane(new THREE.Vector3(0, 1, 0), -FLOOR_Y);
