// ============ SABER//3D engine + gameplay ============
import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { DIR_VECTORS, reactionTime } from './beatmap.js';
import { TrackSystem, UNIT, setUnityRotation, unityQuat, makeFx } from './noodle.js';
import { NOTE_EVENT, FRAME_STRIDE, splitNoteId, cutScore, maxCutScore } from './bsor.js';
import { audio } from './audio.js';
import { gamepad } from './input.js';
import { settings } from './settings.js';

// ---------- World constants ----------
// Notes arrive on the beat at HIT_Z. Everything Beat Saber places relative to
// the player (notes, walls, Noodle tracks, world rotations, the player rig)
// lives under a root at that point, so rotations pivot where they should.
const HIT_Z = -1.6;
// Chroma environment pieces are anchored at the camera instead, so scenery a
// map puts around/behind the player never ends up between camera and sabers.
const ENV_Z_ORIGIN = 4.0;
const ENV_LOCAL_Z = ENV_Z_ORIGIN - HIT_Z;
const COL_STEP = UNIT;          // 0.6 m — same as Noodle units, so wall art lines up
const LAYER_BASE = 0.85;        // Beat Saber's note heights: 0.85 / 1.40 / 1.95
const LAYER_STEP = 0.55;
const WALL_STEP = UNIT;
const SPAWN_LEAD_Y = 0.35;
const SABER_Z = 0.25;           // saber plane in front of the hit point (normal play)
const CAM_HOME = new THREE.Vector3(0, 1.85, 4.0);
const CAM_LOOK = new THREE.Vector3(0, 1.15, -8);
const BLADE_LEN = 1.05;
const DEG = Math.PI / 180;
const AXIS_Z = new THREE.Vector3(0, 0, 1);

const colX = (c) => (c - 1.5) * COL_STEP;
const layerY = (l) => LAYER_BASE + l * LAYER_STEP;
const clamp = THREE.MathUtils.clamp;

function idealScore(n) {
    // max cut = 115; multiplier ramp: 2 hits @x1, 4 @x2, 8 @x4, rest @x8
    let s = 0;
    const steps = [[2, 1], [4, 2], [8, 4]];
    for (const [count, mult] of steps) {
        const take = Math.min(n, count);
        s += take * 115 * mult;
        n -= take;
        if (n <= 0) return s;
    }
    return s + n * 115 * 8;
}

// Beat Saber's multiplier for the k-th note of a perfect run (1-based)
function idealMult(k) {
    return k <= 1 ? 1 : k <= 5 ? 2 : k <= 13 ? 4 : 8;
}

// Bring a Chroma color into a safe range while keeping its hue: values > 1
// are common in maps (they meant "brighter"); returns the extra brightness.
function tameColor(out, c, maxBoost = 1.6) {
    const r = Math.max(0, c[0] || 0), g = Math.max(0, c[1] || 0), b = Math.max(0, c[2] || 0);
    const m = Math.max(r, g, b);
    if (m > 1) { out.setRGB(r / m, g / m, b / m); return Math.min(maxBoost, m); }
    out.setRGB(r, g, b);
    return 1;
}

// ---------- Textures ----------
function makeArrowTexture() {
    const c = document.createElement('canvas');
    c.width = c.height = 128;
    const ctx = c.getContext('2d');
    ctx.clearRect(0, 0, 128, 128);
    ctx.fillStyle = '#ffffff';
    ctx.shadowColor = '#ffffff';
    ctx.shadowBlur = 12;
    ctx.beginPath();                    // chevron pointing UP
    ctx.moveTo(64, 22);
    ctx.lineTo(108, 74);
    ctx.lineTo(86, 92);
    ctx.lineTo(64, 62);
    ctx.lineTo(42, 92);
    ctx.lineTo(20, 74);
    ctx.closePath();
    ctx.fill();
    const t = new THREE.CanvasTexture(c);
    t.anisotropy = 4;
    return t;
}

// soft round sprite for spark particles
function makeSparkTexture() {
    const c = document.createElement('canvas');
    c.width = c.height = 32;
    const ctx = c.getContext('2d');
    const g = ctx.createRadialGradient(16, 16, 0, 16, 16, 16);
    g.addColorStop(0, 'rgba(255,255,255,1)');
    g.addColorStop(0.35, 'rgba(255,255,255,0.75)');
    g.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, 32, 32);
    return new THREE.CanvasTexture(c);
}

function makeDotTexture() {
    const c = document.createElement('canvas');
    c.width = c.height = 128;
    const ctx = c.getContext('2d');
    ctx.fillStyle = '#ffffff';
    ctx.shadowColor = '#ffffff';
    ctx.shadowBlur = 14;
    ctx.beginPath();
    ctx.arc(64, 64, 26, 0, Math.PI * 2);
    ctx.fill();
    const t = new THREE.CanvasTexture(c);
    t.anisotropy = 4;
    return t;
}

// ---------- Wall distortion shader (real-time energy-field look) ----------
const WALL_VERT = /* glsl */`
varying vec3 vWorldPos;
varying vec3 vNormal;
void main() {
    vec4 wp = modelMatrix * vec4(position, 1.0);
    vWorldPos = wp.xyz;
    vNormal = normalize(mat3(modelMatrix) * normal);
    gl_Position = projectionMatrix * viewMatrix * wp;
}`;

const WALL_FRAG = /* glsl */`
uniform vec3 uColor;
uniform float uOpacity;
uniform float uTime;
uniform sampler2D uScene;
uniform vec2 uResolution;
varying vec3 vWorldPos;
varying vec3 vNormal;

float hash(vec3 p) {
    p = fract(p * 0.3183099 + vec3(0.1, 0.2, 0.3));
    p *= 17.0;
    return fract(p.x * p.y * p.z * (p.x + p.y + p.z));
}
float noise(vec3 x) {
    vec3 i = floor(x); vec3 f = fract(x);
    f = f * f * (3.0 - 2.0 * f);
    return mix(mix(mix(hash(i), hash(i + vec3(1,0,0)), f.x),
                   mix(hash(i + vec3(0,1,0)), hash(i + vec3(1,1,0)), f.x), f.y),
               mix(mix(hash(i + vec3(0,0,1)), hash(i + vec3(1,0,1)), f.x),
                   mix(hash(i + vec3(0,1,1)), hash(i + vec3(1,1,1)), f.x), f.y), f.z);
}

void main() {
    vec3 viewDir = normalize(cameraPosition - vWorldPos);
    float fres = pow(1.0 - abs(dot(viewDir, normalize(vNormal))), 2.0);
    // two layers of drifting noise drive the warp
    float n1 = noise(vWorldPos * 1.6 + vec3(0.0, uTime * 0.5, uTime * 1.2));
    float n2 = noise(vWorldPos * 3.8 - vec3(uTime * 0.9, 0.0, uTime * 0.6));
    // screen-space refraction: sample and warp whatever is BEHIND the wall
    vec2 suv = gl_FragCoord.xy / uResolution;
    vec2 warp = vec2(n1 - 0.5, n2 - 0.5) * (0.05 + fres * 0.035);
    vec3 refr = texture2D(uScene, clamp(suv + warp, vec2(0.002), vec2(0.998))).rgb;
    float swirl = 0.5 + 0.5 * sin(6.28318 * (n1 + n2 * 0.5) + uTime * 0.7);
    vec3 col = refr * (0.82 + swirl * 0.12) + uColor * (0.10 + fres * 0.5 + swirl * 0.08);
    float alpha = uOpacity * clamp(0.88 + fres * 0.12, 0.0, 1.0);
    gl_FragColor = vec4(col, alpha);
}`;

// Bloom's bright-pass with a guard: one NaN/Inf pixel (an over-bright Chroma
// light overflowing half-float) used to smear across the whole blur chain and
// leave the screen solid white until that light changed. Clamp it here.
const SAFE_HIGHPASS_FRAG = /* glsl */`
uniform sampler2D tDiffuse;
uniform vec3 defaultColor;
uniform float defaultOpacity;
uniform float luminosityThreshold;
uniform float smoothWidth;
varying vec2 vUv;
void main() {
    vec4 texel = texture2D(tDiffuse, vUv);
    vec3 c = texel.rgb;
    if (any(isnan(c)) || any(isinf(c))) c = vec3(0.0);
    c = clamp(c, vec3(0.0), vec3(6.0));
    float v = dot(c, vec3(0.299, 0.587, 0.114));
    vec4 outputColor = vec4(defaultColor.rgb, defaultOpacity);
    float alpha = smoothstep(luminosityThreshold, luminosityThreshold + smoothWidth, v);
    gl_FragColor = mix(outputColor, vec4(c, texel.a), alpha);
}`;

// ---------- Light group (responds to beatmap lighting events) ----------
const BASE_BLUE = new THREE.Color(0x2d7dff);
const BASE_RED = new THREE.Color(0xff2d55);
const BASE_WHITE = new THREE.Color(0xffffff);

class LightGroup {
    constructor(materials, baseIntensity = 2.2) {
        this.materials = materials;        // emissive materials to drive
        this.color = new THREE.Color(0x2d7dff);
        this.level = 0;                    // current brightness 0..~2.3
        this.target = 0;                   // level to decay toward
        this.decay = 0;                    // per-second decay for flash/fade
        this.base = baseIntensity;
        this.grad = null;
        this.legacy = null;                // legacy Chroma RGB override
        this._col = new THREE.Color();
        this._lastI = -1;
    }

    trigger(value, float = 1, chromaColor = null, gradient = null) {
        let boost = 1;
        if (gradient) {                        // Chroma light gradient
            this.grad = {
                start: new THREE.Color(), end: new THREE.Color(),
                dur: Math.max(0.01, gradient.duration || 0.01), age: 0,
            };
            tameColor(this.grad.start, gradient.start);
            tameColor(this.grad.end, gradient.end);
            chromaColor = gradient.start;
        } else {
            this.grad = null;
        }
        let mode = 'off';
        const col = this._col;
        const v = Math.round(Number(value) || 0);
        if (v <= 0) { mode = 'off'; }
        else if (v <= 4) { col.copy(BASE_BLUE); mode = ['on', 'flash', 'fade', 'on'][(v - 1) % 4]; }
        else if (v <= 8) { col.copy(BASE_RED); mode = ['on', 'flash', 'fade', 'on'][(v - 5) % 4]; }
        else if (v <= 12) { col.copy(BASE_WHITE); mode = ['on', 'flash', 'fade', 'on'][(v - 9) % 4]; }
        else return;                           // not a light value (legacy color events etc.)
        if (chromaColor) boost = tameColor(col, chromaColor);
        else if (this.legacy) col.copy(this.legacy);

        const f = clamp(Number.isFinite(float) ? float : 1, 0, 1.6) * boost;
        switch (mode) {
            case 'off':   this.level = 0; this.target = 0; this.decay = 0; break;
            case 'on':    this.color.copy(col); this.level = f; this.target = f; this.decay = 0; break;
            case 'flash': this.color.copy(col); this.level = f * 1.45; this.target = f; this.decay = 5; break;
            case 'fade':  this.color.copy(col); this.level = f * 1.25; this.target = 0; this.decay = 2.4; break;
        }
    }

    reset(level, color) {
        this.grad = null; this.legacy = null;
        this.color.copy(color); this.level = level; this.target = level; this.decay = 0;
    }

    update(dt) {
        if (this.decay > 0 && this.level !== this.target) {
            this.level += (this.target - this.level) * Math.min(1, this.decay * dt * 3);
            if (Math.abs(this.level - this.target) < 0.01) this.level = this.target;
        }
        if (this.grad) {                       // gradient sweep
            this.grad.age += dt;
            const f = Math.min(1, this.grad.age / this.grad.dur);
            this.color.lerpColors(this.grad.start, this.grad.end, f);
            if (f >= 1) this.grad = null;
        }
        const intensity = Math.min(4, this.level * this.base);
        for (const m of this.materials) {
            m.emissive.copy(this.color);
            m.emissiveIntensity = intensity;
        }
    }
}

// ---------- Pooled effects (one draw call for all sparks) ----------
class ParticlePool {
    constructor(scene, max = 1500, sprite = null) {
        this.max = max;
        this.pos = new Float32Array(max * 3);
        this.col = new Float32Array(max * 3);
        this.vel = new Float32Array(max * 3);
        this.base = new Float32Array(max * 3);
        this.age = new Float32Array(max);
        this.life = new Float32Array(max);
        this.cursor = 0;
        this.alive = 0;
        for (let i = 0; i < max; i++) this.pos[i * 3 + 1] = -1000;
        const geo = new THREE.BufferGeometry();
        geo.setAttribute('position', new THREE.BufferAttribute(this.pos, 3).setUsage(THREE.DynamicDrawUsage));
        geo.setAttribute('color', new THREE.BufferAttribute(this.col, 3).setUsage(THREE.DynamicDrawUsage));
        this.points = new THREE.Points(geo, new THREE.PointsMaterial({
            size: 0.06, vertexColors: true, transparent: true, map: sprite,
            blending: THREE.AdditiveBlending, depthWrite: false,
        }));
        this.points.frustumCulled = false;
        scene.add(this.points);
    }
    burst(p, color, count = 18) {
        for (let k = 0; k < count; k++) {
            const i = this.cursor; this.cursor = (this.cursor + 1) % this.max;
            const o = i * 3;
            this.pos[o] = p.x; this.pos[o + 1] = p.y; this.pos[o + 2] = p.z;
            this.vel[o] = (Math.random() - 0.5) * 5;
            this.vel[o + 1] = (Math.random() - 0.2) * 5;
            this.vel[o + 2] = (Math.random() - 0.3) * 5;
            this.base[o] = color.r; this.base[o + 1] = color.g; this.base[o + 2] = color.b;
            this.age[i] = 0; this.life[i] = 0.45 + Math.random() * 0.2;
        }
        this.alive = this.max;
    }
    update(dt) {
        if (!this.alive) return;
        let alive = 0;
        for (let i = 0; i < this.max; i++) {
            if (this.life[i] <= 0) continue;
            const o = i * 3;
            this.age[i] += dt;
            const f = 1 - this.age[i] / this.life[i];
            if (f <= 0) {
                this.life[i] = 0; this.pos[o + 1] = -1000;
                this.col[o] = this.col[o + 1] = this.col[o + 2] = 0;
                continue;
            }
            alive++;
            this.vel[o + 1] -= 7 * dt;
            this.pos[o] += this.vel[o] * dt; this.pos[o + 1] += this.vel[o + 1] * dt; this.pos[o + 2] += this.vel[o + 2] * dt;
            this.col[o] = this.base[o] * f; this.col[o + 1] = this.base[o + 1] * f; this.col[o + 2] = this.base[o + 2] * f;
        }
        this.alive = alive;
        this.points.geometry.attributes.position.needsUpdate = true;
        this.points.geometry.attributes.color.needsUpdate = true;
    }
    clear() {
        this.life.fill(0);
        for (let i = 0; i < this.max; i++) { this.pos[i * 3 + 1] = -1000; }
        this.col.fill(0);
        this.alive = 1;          // push one cleared upload
        this.update(0);
    }
}

class SlicePool {
    constructor(scene, count = 32) {
        this.geo = new THREE.BoxGeometry(0.46, 0.2, 0.46);
        this.items = [];
        for (let i = 0; i < count; i++) {
            const mat = new THREE.MeshStandardMaterial({ transparent: true, opacity: 1, roughness: 0.35, emissiveIntensity: 0.5 });
            const mesh = new THREE.Mesh(this.geo, mat);
            mesh.visible = false;
            scene.add(mesh);
            this.items.push({ mesh, mat, vel: new THREE.Vector3(), spin: 0, age: 0, life: 0 });
        }
        this.next = 0;
    }
    // pos: world position, dir: 2D swing direction (unit), color
    spawn(pos, dir, color) {
        const perpX = -dir.y, perpY = dir.x;
        for (const sign of [1, -1]) {
            const it = this.items[this.next]; this.next = (this.next + 1) % this.items.length;
            it.mesh.visible = true;
            it.mat.color.copy(color); it.mat.emissive.copy(color); it.mat.opacity = 1;
            it.mesh.position.set(pos.x + perpX * 0.12 * sign, pos.y + perpY * 0.12 * sign, pos.z);
            it.mesh.rotation.set(0, 0, Math.atan2(dir.y, dir.x));
            it.vel.set(perpX * 1.6 * sign + dir.x * 1.4, perpY * 1.6 * sign + dir.y * 1.4 + 1.2, 1.6);
            it.spin = (Math.random() - 0.5) * 9;
            it.age = 0; it.life = 0.5;
        }
    }
    update(dt) {
        for (const it of this.items) {
            if (!it.mesh.visible) continue;
            it.age += dt;
            it.vel.y -= 9 * dt;
            it.mesh.position.addScaledVector(it.vel, dt);
            it.mesh.rotation.x += it.spin * dt;
            it.mat.opacity = 1 - it.age / it.life;
            if (it.age >= it.life) it.mesh.visible = false;
        }
    }
    clear() { for (const it of this.items) it.mesh.visible = false; }
}

// ---------- Engine ----------
// msaa: samples on the post-processing target (High only — it's costly on
// integrated/mobile GPUs); refrEvery: refresh the wall-refraction capture every
// N frames; bloomDiv: extra downscale of the bloom blur chain.
const QUALITY = {
    high:   { maxScale: 2, msaa: 4, refrDiv: 2, refrEvery: 1, bloomDiv: 1, dynamic: false },
    medium: { maxScale: 1.25, msaa: 0, refrDiv: 2, refrEvery: 2, bloomDiv: 2, dynamic: false },
    low:    { maxScale: 0.8, msaa: 0, refrDiv: 4, refrEvery: 3, bloomDiv: 2, dynamic: false },
    auto:   { maxScale: 2, msaa: 0, refrDiv: 2, refrEvery: 2, bloomDiv: 2, dynamic: true },
};

export class Engine {
    constructor(container) {
        this.container = container;
        this.scene = new THREE.Scene();
        this.scene.fog = new THREE.FogExp2(0x05050c, 0.028);
        this.baseFogDensity = 0.028;

        this.camera = new THREE.PerspectiveCamera(72, innerWidth / innerHeight, 0.1, 300);
        this.camera.position.copy(CAM_HOME);
        this.camera.lookAt(CAM_LOOK);
        this.camHomeQuat = this.camera.quaternion.clone();
        this.scene.add(this.camera);

        // MSAA happens in the composer's render target (the default framebuffer
        // is never drawn to by the scene, so antialias:true there only cost memory)
        this.renderer = new THREE.WebGLRenderer({ antialias: false, stencil: false, powerPreference: 'high-performance' });
        this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
        this.renderer.toneMappingExposure = 0.95;
        container.appendChild(this.renderer.domElement);

        const q = settings.get('quality') || 'auto';
        this.qualityName = QUALITY[q] ? q : 'auto';
        this.q = QUALITY[this.qualityName];
        const dpr = Math.min(window.devicePixelRatio || 1, 2);
        this.maxScale = Math.min(dpr, this.q.maxScale);
        this.minScale = 0.5;
        this.renderScale = this.maxScale;
        this.renderer.setPixelRatio(this.renderScale);
        this.renderer.setSize(innerWidth, innerHeight);

        const dbs = this.renderer.getDrawingBufferSize(new THREE.Vector2());
        const rt = new THREE.WebGLRenderTarget(dbs.x, dbs.y, {
            type: THREE.HalfFloatType,
            samples: this.renderer.capabilities.isWebGL2 ? this.q.msaa : 0,
        });
        this.composer = new EffectComposer(this.renderer, rt);
        this.composer.addPass(new RenderPass(this.scene, this.camera));
        this.bloom = new UnrealBloomPass(new THREE.Vector2(innerWidth, innerHeight), 0.5, 0.45, 0.35);
        if (this.renderer.capabilities.isWebGL2 && this.bloom.materialHighPassFilter) {
            this.bloom.materialHighPassFilter.fragmentShader = SAFE_HIGHPASS_FRAG;   // needs GLSL ES 3 isnan/isinf
            this.bloom.materialHighPassFilter.needsUpdate = true;
        }
        this.composer.addPass(this.bloom);
        this.composer.addPass(new OutputPass());
        this.useComposer = true;

        // Scene capture for refractive walls (they warp what's behind them)
        this.resolution = new THREE.Vector2();
        this.refractionRT = new THREE.WebGLRenderTarget(2, 2, { minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter });
        this.wallUniforms = {
            uTime: { value: 0 },
            uScene: { value: this.refractionRT.texture },
            uResolution: { value: this.resolution },
        };
        this.frame = 0;

        this.arrowTex = makeArrowTexture();
        this.dotTex = makeDotTexture();
        this.assets = this.makeAssets();
        this.particles = new ParticlePool(this.scene, 1500, makeSparkTexture());
        this.slices = new SlicePool(this.scene);

        this.clockTime = performance.now() / 1000;
        this.attractTimer = 0;
        this.gameplay = null;
        this.onGameplayError = null;
        this.onContextLost = null;
        this._gpErrors = 0;
        this._perf = { acc: 0, frames: 0, lastChange: 0 };

        this.buildEnvironment();
        this.applySize();

        addEventListener('resize', () => this.applySize());
        const canvas = this.renderer.domElement;
        canvas.addEventListener('webglcontextlost', (e) => {
            e.preventDefault();               // allow the browser to restore it
            this.contextLost = true;
            if (this.onContextLost) this.onContextLost();
        }, false);
        canvas.addEventListener('webglcontextrestored', () => {
            this.contextLost = false;
            this.applySize();
        }, false);
    }

    // Geometry/materials shared by every note, bomb and wall (no per-object GPU buffers)
    makeAssets() {
        const a = {
            noteBox: new THREE.BoxGeometry(0.48, 0.48, 0.48),
            chainBox: new THREE.BoxGeometry(0.3, 0.3, 0.3),
            noteFace: new THREE.PlaneGeometry(0.48 * 0.86, 0.48 * 0.86),
            chainFace: new THREE.PlaneGeometry(0.3 * 0.86, 0.3 * 0.86),
            bomb: new THREE.IcosahedronGeometry(0.22, 0),
            wallBox: new THREE.BoxGeometry(1, 1, 1),
            head: new THREE.BoxGeometry(0.22, 0.12, 0.12),
        };
        a.wallEdges = new THREE.EdgesGeometry(a.wallBox);
        a.arrowMat = new THREE.MeshBasicMaterial({ map: this.arrowTex, transparent: true, depthWrite: false });
        a.dotMat = new THREE.MeshBasicMaterial({ map: this.dotTex, transparent: true, depthWrite: false });
        a.bombMat = new THREE.MeshStandardMaterial({
            color: 0x14141a, roughness: 0.5, metalness: 0.6,
            emissive: 0xff2020, emissiveIntensity: 0.5, flatShading: true,
        });
        return a;
    }

    applySize() {
        this.camera.aspect = innerWidth / innerHeight;
        this.camera.updateProjectionMatrix();
        this.renderer.setPixelRatio(this.renderScale);
        this.renderer.setSize(innerWidth, innerHeight);
        this.composer.setPixelRatio(this.renderScale);
        this.composer.setSize(innerWidth, innerHeight);
        const dbs = this.renderer.getDrawingBufferSize(new THREE.Vector2());
        this.resolution.copy(dbs);
        const rd = this.q.refrDiv;
        this.refractionRT.setSize(Math.max(2, Math.floor(dbs.x / rd)), Math.max(2, Math.floor(dbs.y / rd)));
        if (this.q.bloomDiv > 1) this.bloom.setSize(Math.floor(dbs.x / this.q.bloomDiv), Math.floor(dbs.y / this.q.bloomDiv));
    }

    setQuality(name) {
        if (!QUALITY[name]) return;
        this.qualityName = name;
        this.q = QUALITY[name];
        const samples = this.renderer.capabilities.isWebGL2 ? this.q.msaa : 0;
        for (const rt of [this.composer.renderTarget1, this.composer.renderTarget2]) {
            if (rt.samples !== samples) { rt.samples = samples; rt.dispose(); }
        }
        const dpr = Math.min(window.devicePixelRatio || 1, 2);
        this.maxScale = Math.min(dpr, this.q.maxScale);
        this.renderScale = this.maxScale;
        this.applySize();
    }

    // Dynamic resolution: drop render scale when frames run long, creep back up
    // when there's headroom (Auto quality only).
    trackPerformance(dt) {
        if (!this.q.dynamic || dt > 0.2) return;
        const p = this._perf;
        p.acc += dt; p.frames++;
        if (p.acc < 1.5) return;
        const avg = p.acc / p.frames;
        const now = this.clockTime;
        p.acc = 0; p.frames = 0;
        if (avg > 1 / 48 && this.renderScale > this.minScale + 0.01) {
            this.renderScale = Math.max(this.minScale, this.renderScale * 0.85);
            p.lastChange = now; p.lastDrop = now;
            this.applySize();
        } else if (avg < 1 / 57 && this.renderScale < this.maxScale - 0.01 &&
                   now - (p.lastDrop || -1e9) > 8 && now - p.lastChange > 3) {
            this.renderScale = Math.min(this.maxScale, this.renderScale * 1.08);
            p.lastChange = now;
            this.applySize();
        }
    }

    buildEnvironment() {
        const s = this.scene;
        s.add(new THREE.AmbientLight(0x334, 1.2));
        const key = new THREE.DirectionalLight(0x8899ff, 0.8);
        key.position.set(3, 8, 4);
        s.add(key);
        this.decor = [];           // [object, group] stock scenery a map may switch off

        // Floor
        const floor = new THREE.Mesh(
            new THREE.PlaneGeometry(60, 140),
            new THREE.MeshStandardMaterial({ color: 0x07070f, roughness: 0.35, metalness: 0.8 })
        );
        floor.rotation.x = -Math.PI / 2;
        floor.position.z = -40;
        s.add(floor);
        this.addDecor(floor, 'floor');

        const grid = new THREE.GridHelper(140, 70, 0x222244, 0x14142a);
        grid.position.y = 0.005;
        grid.position.z = -40;
        s.add(grid);
        this.addDecor(grid, 'floor');

        // Runway edge strips (react to center-light events)
        const stripGeo = new THREE.BoxGeometry(0.09, 0.02, 120);
        this.centerMats = [];
        for (const x of [-1.7, 1.7]) {
            const m = new THREE.MeshStandardMaterial({ color: 0x111122, emissive: 0x2d7dff, emissiveIntensity: 0.8 });
            const strip = new THREE.Mesh(stripGeo, m);
            strip.position.set(x, 0.02, -50);
            s.add(strip);
            this.addDecor(strip, 'strips');
            this.centerMats.push(m);
        }

        // Big glow panel far back
        const backMat = new THREE.MeshStandardMaterial({ color: 0x05050c, emissive: 0x7c5cff, emissiveIntensity: 0.4 });
        const back = new THREE.Mesh(new THREE.PlaneGeometry(30, 14), backMat);
        back.position.set(0, 6, -95);
        s.add(back);
        this.addDecor(back, 'back');
        this.centerMats.push(backMat);

        // Side light towers (types 2 & 3)
        this.leftMats = [];
        this.rightMats = [];
        const towerGeo = new THREE.BoxGeometry(0.14, 9, 0.14);
        for (let i = 0; i < 6; i++) {
            const z = -12 - i * 13;
            for (const side of [-1, 1]) {
                const m = new THREE.MeshStandardMaterial({ color: 0x0a0a18, emissive: 0x2d7dff, emissiveIntensity: 0 });
                const tower = new THREE.Mesh(towerGeo, m);
                tower.position.set(side * (5 + i * 0.6), 4.5, z);
                s.add(tower);
                this.addDecor(tower, 'towers');
                (side < 0 ? this.leftMats : this.rightMats).push(m);
            }
        }

        // Back laser fan (type 0)
        this.backMats = [];
        this.backLasers = [];
        const laserGeo = new THREE.BoxGeometry(0.07, 26, 0.07);
        for (let i = 0; i < 9; i++) {
            const m = new THREE.MeshStandardMaterial({ color: 0x0a0a18, emissive: 0xff2d55, emissiveIntensity: 0 });
            const beam = new THREE.Mesh(laserGeo, m);
            const spread = (i - 4) / 4;
            beam.position.set(spread * 12, 10, -88);
            beam.rotation.z = spread * 0.55;
            s.add(beam);
            this.addDecor(beam, 'lasers');
            this.backMats.push(m);
            this.backLasers.push(beam);
        }

        // Ring stack (type 1 lights, type 8 spin, type 9 zoom)
        this.rings = [];
        this.ringMats = [];
        const ringGeo = new THREE.TorusGeometry(7.5, 0.09, 4, 8);
        for (let i = 0; i < 9; i++) {
            const m = new THREE.MeshStandardMaterial({ color: 0x0c0c1c, emissive: 0x7c5cff, emissiveIntensity: 0.3 });
            const ring = new THREE.Mesh(ringGeo, m);
            ring.position.z = -14 - i * 8;
            ring.position.y = 3.4;
            ring.rotation.z = Math.PI / 8;
            ring.userData = { baseZ: ring.position.z, spinTarget: Math.PI / 8, zoomOffset: 0 };
            this.scene.add(ring);
            this.addDecor(ring, 'rings');
            this.rings.push(ring);
            this.ringMats.push(m);
        }

        // Stars
        const starGeo = new THREE.BufferGeometry();
        const starPos = [];
        for (let i = 0; i < 500; i++) {
            const r = 60 + Math.random() * 60;
            const a = Math.random() * Math.PI * 2;
            starPos.push(Math.cos(a) * r, 6 + Math.random() * 50, -30 - Math.random() * 90);
        }
        starGeo.setAttribute('position', new THREE.Float32BufferAttribute(starPos, 3));
        const stars = new THREE.Points(starGeo, new THREE.PointsMaterial({ color: 0x8888bb, size: 0.14, sizeAttenuation: true }));
        s.add(stars);
        this.addDecor(stars, 'stars');

        // Light groups keyed by basic event type
        this.lightGroups = {
            0: new LightGroup(this.backMats, 1.5),
            1: new LightGroup(this.ringMats, 1.0),
            2: new LightGroup(this.leftMats, 1.4),
            3: new LightGroup(this.rightMats, 1.4),
            4: new LightGroup(this.centerMats, 0.9),
        };
        this.resetLights();
    }

    // Back to the calm menu look (called after every level so nothing a map
    // did — white flashes, fog, hidden scenery — sticks around)
    resetLights() {
        for (const key in this.lightGroups) this.lightGroups[key].reset(0, BASE_BLUE);
        this.lightGroups[4].trigger(1, 0.8);
        this.lightGroups[1].trigger(1, 0.4);
        this.laserSpeed = { left: 0.4, right: 0.4 };
        for (const ring of this.rings) { ring.userData.zoomOffset = 0; }
        if (this.scene.fog) this.scene.fog.density = this.baseFogDensity;
        this.hideDecor([]);
    }

    addDecor(obj, group) { this.decor.push([obj, group]); }

    // groups: subset of floor/strips/back/towers/lasers/rings/stars
    hideDecor(groups) {
        const hidden = new Set(groups || []);
        for (const [o, g] of this.decor) o.visible = !hidden.has(g);
    }

    handleEvent(ev) {
        const g = this.lightGroups[ev.type];
        if (g) {
            if (ev.legacyColor) {               // legacy Chroma RGB: tints later events
                if (ev.legacyColor === 'reset') g.legacy = null;
                else { g.legacy = g.legacy || new THREE.Color(); tameColor(g.legacy, ev.legacyColor); }
                return;
            }
            g.trigger(ev.value, ev.float, ev.chroma, ev.gradient);
            return;
        }
        const c = ev.custom || null;
        if (ev.type === 8) {                       // ring spin (Chroma: precise rotation/step)
            if (c && (c.rotation !== null || c.step !== null)) {
                const dir = c.direction === 0 ? 1 : c.direction === 1 ? -1 : (Math.random() < 0.5 ? 1 : -1);
                const rot = THREE.MathUtils.degToRad(Number(c.rotation ?? 45) || 0) * dir;
                const step = THREE.MathUtils.degToRad(Number(c.step ?? 0) || 0) * dir;
                this.rings.forEach((ring, i) => { ring.userData.spinTarget += rot + step * i; });
            } else {
                for (const ring of this.rings) {
                    ring.userData.spinTarget += (Math.random() - 0.5) * 1.6;
                }
            }
        } else if (ev.type === 9) {                // ring zoom (Chroma: step = spacing)
            if (c && c.step !== null && Number.isFinite(Number(c.step))) {
                const st = clamp(Number(c.step), -10, 10);
                this.rings.forEach((ring, i) => { ring.userData.zoomOffset = st * i; });
            } else {
                const zoomed = this.rings[0].userData.zoomOffset === 0;
                this.rings.forEach((ring, i) => { ring.userData.zoomOffset = zoomed ? i * 3.2 : 0; });
            }
        } else if (ev.type === 12 || ev.type === 13) {
            const raw = c && c.speed !== null ? Number(c.speed) : ev.value;
            const speed = clamp(Number.isFinite(raw) ? raw : 0, 0, 20);
            this.laserSpeed[ev.type === 12 ? 'left' : 'right'] = 0.25 + speed * 0.28;
        }
    }

    setBloom(on) { this.bloom.enabled = on; }
    setBloomStrength(v) { this.bloom.strength = v; }

    updateEnvironment(dt, t) {
        for (const key in this.lightGroups) this.lightGroups[key].update(dt);

        // lazy laser sway
        for (let i = 0; i < this.backLasers.length; i++) {
            const spread = (i - 4) / 4;
            this.backLasers[i].rotation.z = spread * 0.55 + Math.sin(t * this.laserSpeed.left + i * 1.3) * 0.35;
        }

        for (const ring of this.rings) {
            // keep spin targets bounded so float precision never degrades
            if (Math.abs(ring.userData.spinTarget) > 1000) {
                const wrap = Math.round(ring.userData.spinTarget / (Math.PI * 2)) * Math.PI * 2;
                ring.userData.spinTarget -= wrap; ring.rotation.z -= wrap;
            }
            ring.rotation.z += (ring.userData.spinTarget - ring.rotation.z) * Math.min(1, dt * 3.2);
            const targetZ = ring.userData.baseZ - ring.userData.zoomOffset;
            ring.position.z += (targetZ - ring.position.z) * Math.min(1, dt * 2.4);
        }
    }

    // Ambient light show while in menus
    updateAttract(dt, t) {
        this.attractTimer -= dt;
        if (this.attractTimer <= 0) {
            this.attractTimer = 1.6 + Math.random() * 1.6;
            const types = [0, 1, 2, 3, 4];
            const type = types[Math.floor(Math.random() * types.length)];
            const value = [1, 2, 3, 5, 6, 7][Math.floor(Math.random() * 6)];
            this.handleEvent({ type, value, float: 0.35 + Math.random() * 0.4, chroma: null });
            if (Math.random() < 0.22) this.handleEvent({ type: 8, value: 0, float: 1, chroma: null });
        }
        this.camera.position.x = Math.sin(t * 0.11) * 0.35;
        this.camera.position.y = 1.85 + Math.sin(t * 0.17) * 0.1;
        this.camera.lookAt(0, 1.4, -12);
    }

    update() {
        const now = performance.now() / 1000;
        const rawDt = now - this.clockTime;
        const dt = Math.min(0.05, rawDt);
        this.clockTime = now;
        this.wallUniforms.uTime.value = now;
        if (this.contextLost) return dt;
        this.trackPerformance(rawDt);

        if (this.gameplay) {
            // A broken frame (bad map data, etc.) must never freeze the render
            // loop — that's how the screen used to get stuck on one frame.
            try {
                this.gameplay.update(dt);
                this._gpErrors = 0;
            } catch (err) {
                this._gpErrors++;
                if (this._gpErrors === 1) console.error('Gameplay frame failed:', err);
                if (this._gpErrors > 30 && this.onGameplayError) {
                    const cb = this.onGameplayError;
                    this._gpErrors = 0;
                    cb(err);
                }
            }
        } else {
            this.updateAttract(dt, now);
        }
        this.updateEnvironment(dt, now);
        this.particles.update(dt);
        this.slices.update(dt);
        this.render();
        return dt;
    }

    render() {
        this.frame++;
        // Refraction pre-pass: capture the scene without distortion walls so
        // the wall shader can warp what's behind them (like the real game).
        const gp = this.gameplay;
        if (gp && gp.liveWalls.length && this.frame % this.q.refrEvery === 0) {
            const hidden = this._hidden || (this._hidden = []);
            hidden.length = 0;
            for (const w of gp.liveWalls) {
                if (w.userData.mat.isShaderMaterial && w.visible) { w.visible = false; hidden.push(w); }
            }
            if (hidden.length) {
                this.renderer.setRenderTarget(this.refractionRT);
                this.renderer.render(this.scene, this.camera);
                this.renderer.setRenderTarget(null);
                for (const w of hidden) w.visible = true;
            }
        }

        if (this.useComposer) {
            try {
                this.composer.render();
                return;
            } catch (err) {
                console.error('Post-processing failed, falling back to direct rendering:', err);
                this.useComposer = false;
            }
        }
        this.renderer.setRenderTarget(null);
        this.renderer.render(this.scene, this.camera);
    }
}

// ---------- Saber ----------
const _segAB = new THREE.Vector3(), _segAP = new THREE.Vector3();

class Saber {
    constructor(parent, colorHex, homeX) {
        this.color = new THREE.Color(colorHex);
        this.homeX = homeX;
        this.group = new THREE.Group();
        this.geos = [];
        this.mats = [];

        const handleGeo = new THREE.CylinderGeometry(0.035, 0.042, 0.24, 12);
        const handleMat = new THREE.MeshStandardMaterial({ color: 0x222230, roughness: 0.4, metalness: 0.9 });
        this.group.add(new THREE.Mesh(handleGeo, handleMat));

        this.bladeMat = new THREE.MeshStandardMaterial({
            color: 0xffffff, emissive: this.color, emissiveIntensity: 2.0, roughness: 0.3,
        });
        const bladeGeo = new THREE.CylinderGeometry(0.028, 0.02, BLADE_LEN, 10);
        this.blade = new THREE.Mesh(bladeGeo, this.bladeMat);
        this.blade.position.y = 0.14 + BLADE_LEN / 2;
        this.group.add(this.blade);

        const glowMat = new THREE.MeshBasicMaterial({
            color: this.color, transparent: true, opacity: 0.14,
            blending: THREE.AdditiveBlending, depthWrite: false,
        });
        const glowGeo = new THREE.CylinderGeometry(0.075, 0.055, BLADE_LEN * 1.02, 10);
        const glow = new THREE.Mesh(glowGeo, glowMat);
        glow.position.copy(this.blade.position);
        this.group.add(glow);
        this.geos.push(handleGeo, bladeGeo, glowGeo);
        this.mats.push(handleMat, this.bladeMat, glowMat);

        // Tilt blade slightly forward so it points up + away
        this.group.rotation.x = -0.5;
        this.group.position.set(homeX, 1.1, SABER_Z);
        parent.add(this.group);

        this.pos = new THREE.Vector2(homeX, 1.1);   // logical xy
        this.vel = new THREE.Vector2();
        this.smoothVel = new THREE.Vector2();
        this.tip = new THREE.Vector3();
        this.base = new THREE.Vector3();
        this.prevTip = new THREE.Vector3();
        this.hasPrev = false;

        // Trail: ring buffer of blade segments, limited by AGE (not frame
        // count) so it looks the same at 30 fps as at 144 fps
        this.trailLen = 24;
        this.trailMaxAge = 0.12;
        this.trailTips = Array.from({ length: this.trailLen }, () => new THREE.Vector3());
        this.trailBases = Array.from({ length: this.trailLen }, () => new THREE.Vector3());
        this.trailTimes = new Float64Array(this.trailLen);
        this.trailCount = 0;
        this.trailHead = 0;
        const geo = new THREE.BufferGeometry();
        geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array((this.trailLen - 1) * 6 * 3), 3).setUsage(THREE.DynamicDrawUsage));
        geo.setAttribute('color', new THREE.BufferAttribute(new Float32Array((this.trailLen - 1) * 6 * 3), 3).setUsage(THREE.DynamicDrawUsage));
        this.trailMat = new THREE.MeshBasicMaterial({
            vertexColors: true, transparent: true, opacity: 0.5,
            blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide,
        });
        this.trailMesh = new THREE.Mesh(geo, this.trailMat);
        this.trailMesh.frustumCulled = false;
        this.scene = parent;
        while (this.scene.parent) this.scene = this.scene.parent;
        this.scene.add(this.trailMesh);
    }

    // stick: {x: -1..1, y: -1..1 (down positive)}
    move(stick, dt) {
        const targetX = this.homeX * 0.25 + stick.x * 1.45;
        const targetY = 1.25 - stick.y * 1.0;
        const k = 1 - Math.exp(-22 * dt);           // snappy, still smooth
        const oldX = this.pos.x, oldY = this.pos.y;
        this.pos.x += (targetX - this.pos.x) * k;
        this.pos.y += (targetY - this.pos.y) * k;

        if (dt > 0) {
            this.vel.set((this.pos.x - oldX) / dt, (this.pos.y - oldY) / dt);
            this.smoothVel.lerp(this.vel, Math.min(1, dt * 18));
        }

        this.group.position.set(this.pos.x, this.pos.y, SABER_Z);
        // lean into the swing
        this.group.rotation.set(
            -0.5 + clamp(this.smoothVel.y * 0.05, -0.5, 0.5), 0,
            clamp(-this.smoothVel.x * 0.06, -0.7, 0.7));
    }

    // Replay: absolute pose in the hand rig's space
    setPose(pos, quat) {
        this.group.position.copy(pos);
        this.group.quaternion.copy(quat);
    }

    // Recompute the blade's world segment (after any aim-assist nudges) and
    // update velocity (replays) + trail.
    finalize(dt, trackVelocity = false) {
        this.group.updateWorldMatrix(true, false);
        const m = this.group.matrixWorld;
        this.base.set(0, 0.14, 0).applyMatrix4(m);
        this.tip.set(0, 0.14 + BLADE_LEN, 0).applyMatrix4(m);
        if (trackVelocity && dt > 0) {
            if (this.hasPrev) {
                this.vel.set((this.tip.x - this.prevTip.x) / dt, (this.tip.y - this.prevTip.y) / dt);
                this.smoothVel.lerp(this.vel, Math.min(1, dt * 18));
            }
            this.prevTip.copy(this.tip);
            this.hasPrev = true;
        }
        this.pushTrail();
    }

    pushTrail() {
        const now = performance.now() / 1000;
        this.trailHead = (this.trailHead + this.trailLen - 1) % this.trailLen;
        this.trailTips[this.trailHead].copy(this.tip);
        this.trailBases[this.trailHead].copy(this.base);
        this.trailTimes[this.trailHead] = now;
        if (this.trailCount < this.trailLen) this.trailCount++;

        const pos = this.trailMesh.geometry.attributes.position.array;
        const col = this.trailMesh.geometry.attributes.color.array;
        const c = this.color;
        let vi = 0;
        for (let i = 0; i < this.trailCount - 1; i++) {
            const ia = (this.trailHead + i) % this.trailLen, ib = (ia + 1) % this.trailLen;
            const age = now - this.trailTimes[ib];
            if (age > this.trailMaxAge) break;
            const aT = this.trailTips[ia], aB = this.trailBases[ia], bT = this.trailTips[ib], bB = this.trailBases[ib];
            const fade = 1 - (now - this.trailTimes[ia]) / this.trailMaxAge;
            const quad = [aB, aT, bT, aB, bT, bB];
            for (let q = 0; q < 6; q++) {
                const p = quad[q];
                pos[vi] = p.x; pos[vi + 1] = p.y; pos[vi + 2] = p.z;
                col[vi] = c.r * fade; col[vi + 1] = c.g * fade; col[vi + 2] = c.b * fade;
                vi += 3;
            }
        }
        for (; vi < pos.length; vi++) { pos[vi] = 0; col[vi] = 0; }
        this.trailMesh.geometry.attributes.position.needsUpdate = true;
        this.trailMesh.geometry.attributes.color.needsUpdate = true;
    }

    // shortest distance from point to blade segment (world space, cached segment)
    distanceTo(point) {
        _segAB.subVectors(this.tip, this.base);
        _segAP.subVectors(point, this.base);
        const t = clamp(_segAP.dot(_segAB) / (_segAB.lengthSq() || 1), 0, 1);
        return _segAP.copy(this.base).addScaledVector(_segAB, t).distanceTo(point);
    }

    dispose() {
        this.group.removeFromParent();
        this.trailMesh.removeFromParent();
        this.trailMesh.geometry.dispose();
        this.trailMat.dispose();
        for (const g of this.geos) g.dispose();
        for (const m of this.mats) m.dispose();
    }
}

// ---------- Replay pose sampling ----------
// Beat Saber (left-handed, +z forward) → ours (mirrored z): positions flip z,
// quaternions become (-x, -y, z, w).
const SABER_FIX = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), -Math.PI / 2);
const _qa = new THREE.Quaternion(), _qb = new THREE.Quaternion();

class ReplayPose {
    constructor(frames, calib) {
        this.f = frames.data;
        this.count = frames.count;
        this.idx = 0;
        this.calib = calib;
        this.head = { pos: new THREE.Vector3(), quat: new THREE.Quaternion() };
        this.left = { pos: new THREE.Vector3(), quat: new THREE.Quaternion() };
        this.right = { pos: new THREE.Vector3(), quat: new THREE.Quaternion() };
    }

    _find(t) {
        const f = this.f, S = FRAME_STRIDE;
        let i = this.idx;
        if (i >= this.count - 1 || f[i * S] > t) {           // jumped back: binary search
            let lo = 0, hi = this.count - 1;
            while (lo < hi) {
                const mid = (lo + hi + 1) >> 1;
                if (f[mid * S] <= t) lo = mid; else hi = mid - 1;
            }
            i = lo;
        }
        while (i < this.count - 2 && f[(i + 1) * S] <= t) i++;
        this.idx = i;
        return i;
    }

    _sample(i, k, off, out) {
        const f = this.f, S = FRAME_STRIDE, c = this.calib;
        const a = i * S + off, b = Math.min(this.count - 1, i + 1) * S + off;
        const lerp = (x, y) => x + (y - x) * k;
        out.pos.set(
            lerp(f[a], f[b]) - c.dx,
            lerp(f[a + 1], f[b + 1]) - c.dy,
            -(lerp(f[a + 2], f[b + 2]) - c.dz));
        _qa.set(-f[a + 3], -f[a + 4], f[a + 5], f[a + 6]);
        _qb.set(-f[b + 3], -f[b + 4], f[b + 5], f[b + 6]);
        if (_qa.lengthSq() < 1e-6) _qa.identity();
        if (_qb.lengthSq() < 1e-6) _qb.identity();
        out.quat.slerpQuaternions(_qa.normalize(), _qb.normalize(), k);
    }

    update(t) {
        const i = this._find(t);
        const f = this.f, S = FRAME_STRIDE;
        const t0 = f[i * S], t1 = f[Math.min(this.count - 1, i + 1) * S];
        const k = t1 > t0 ? clamp((t - t0) / (t1 - t0), 0, 1) : 0;
        this._sample(i, k, 1, this.head);
        this._sample(i, k, 8, this.left);
        this._sample(i, k, 15, this.right);
        this.left.quat.multiply(SABER_FIX);    // blade along the controller's forward
        this.right.quat.multiply(SABER_FIX);
    }
}

function median(arr, fallback) {
    if (!arr.length) return fallback;
    const s = [...arr].sort((a, b) => a - b);
    return s[s.length >> 1];
}

// ---------- Gameplay session ----------
const _v = new THREE.Vector3(), _v2 = new THREE.Vector3(), _q = new THREE.Quaternion(), _m4 = new THREE.Matrix4();
const _swing = new THREE.Vector2();

export class Gameplay {
    /**
     * @param engine Engine
     * @param mapData parsed difficulty {notes,bombs,walls,events,customEvents,environment}
     * @param songBuffer AudioBuffer
     * @param opts {songName, njs, offsetBeats, bpm, mapId, onEnd(results),
     *              replay?: {data, match, playerName, speed, mods}}
     */
    constructor(engine, mapData, songBuffer, opts) {
        this.engine = engine;
        this.scene = engine.scene;
        this.map = mapData;
        this.songBuffer = songBuffer;
        this.opts = opts;
        this.replay = opts.replay || null;
        this.v2 = mapData.version === 2;

        const speedMult = this.replay ? 1 : settings.get('noteSpeed');
        this.speedMult = speedMult;
        this.bpm = opts.bpm || 120;
        if (this.replay) {
            this.njs = Math.max(1, opts.njs || 10);
            const jd = this.replay.data.info.jumpDistance;
            this.rt = jd > 1 ? jd / 2 / this.njs : reactionTime(this.njs, opts.offsetBeats || 0, this.bpm);
        } else {
            this.njs = Math.max(8, Math.min(20, (opts.njs || 12))) * speedMult;
            this.rt = Math.max(1.15, reactionTime(this.njs, opts.offsetBeats || 0, this.bpm) / speedMult);
        }
        this.aimAssist = this.replay ? 0 : settings.get('aimAssist');

        // Beat Saber's player origin for gameplay objects
        this.objRoot = new THREE.Group();
        this.objRoot.name = 'objects';
        this.objRoot.position.z = HIT_Z;
        this.scene.add(this.objRoot);

        // Noodle player rigs: Root moves everything; Head moves the camera;
        // LeftHand/RightHand move the sabers (AssignPlayerToTrack targets).
        this.playerRig = new THREE.Group();
        this.playerRig.position.z = HIT_Z;
        this.headRig = new THREE.Group();
        this.leftHandRig = new THREE.Group();
        this.rightHandRig = new THREE.Group();
        this.playerRig.add(this.headRig, this.leftHandRig, this.rightHandRig);
        this.scene.add(this.playerRig);
        const cam = engine.camera;
        this.headRig.add(cam);
        this.camLocalHome = new THREE.Vector3(CAM_HOME.x, CAM_HOME.y, CAM_HOME.z - HIT_Z);
        cam.position.copy(this.camLocalHome);
        cam.quaternion.copy(engine.camHomeQuat);
        this.camMode = 'third';

        this.saberLeft = new Saber(this.leftHandRig, settings.get('leftColor'), -0.55);
        this.saberRight = new Saber(this.rightHandRig, settings.get('rightColor'), 0.55);
        this.tracks = new TrackSystem(this.objRoot, mapData.customEvents || [], {
            Root: this.playerRig,
            Head: this.headRig,
            LeftHand: this.leftHandRig,
            RightHand: this.rightHandRig,
        }, { v2: this.v2 });

        this._matCache = new Map();
        this._ownMats = new Set();       // per-object materials to dispose with the session

        const mods = this.replay ? (this.replay.mods || []) : [];
        const bombs = mods.includes('NB') ? [] : mapData.bombs;
        const walls = mods.includes('NO') ? [] : mapData.walls;

        // Spawn queues sorted by SPAWN time (not hit time) so Noodle objects with
        // large spawn offsets appear exactly when they should, never late.
        const bySpawn = (arr) => arr
            .map(o => ({ o, at: o.time - this.noteRt(o) }))
            .sort((a, b) => a.at - b.at);
        this.noteQueue = bySpawn(mapData.notes);
        this.bombQueue = bySpawn(bombs);
        this.wallQueue = bySpawn(walls);

        // Chroma environment geometry — the "custom models" in model maps
        this.spawnEnvironment(mapData.environment);
        if (mapData.environment && mapData.environment.hideGroups) engine.hideDecor(mapData.environment.hideGroups);

        this.noteIdx = 0; this.bombIdx = 0; this.wallIdx = 0; this.eventIdx = 0;
        this.liveNotes = [];
        this.liveBombs = [];
        this.liveWalls = [];

        this.score = 0;
        this.combo = 0;
        this.maxCombo = 0;
        this.multiplier = 1;
        this.multProgress = 0;
        this.hits = 0;
        this.misses = 0;
        this.processed = 0;
        this.maxScore = 0;           // replay: max possible so far (Beat Saber rules)
        this.energy = 0.5;
        this.failed = false;
        this.finished = false;
        this.paused = false;
        this.noFail = this.replay ? true : settings.get('noFail');

        // HUD refs + write cache (only touch the DOM when a value changes)
        this.$ = (id) => document.getElementById(id);
        this._hud = {};
        this.$('hud-song-name').textContent = opts.songName || '';
        this.$('hud-nofail-tag').classList.toggle('hidden', !this.noFail || !!this.replay);
        const tag = this.$('hud-replay-tag');
        if (tag) {
            tag.classList.toggle('hidden', !this.replay);
            if (this.replay) tag.textContent = `REPLAY · ${this.replay.playerName || this.replay.data.info.playerName || 'Player'}`;
        }
        this.updateHud();

        let startAt = -2.2;
        let rate = 1;
        if (this.replay) {
            this.setupReplay();
            rate = this.replay.speed || 1;
            const st = this.replay.data.info.startTime || 0;
            if (st > 0.5) startAt = st - 1.0;
        }
        audio.onSongEnd = () => { if (!this.failed) this.finish(); };
        audio.startSong(songBuffer, startAt, rate);
    }

    // ----- materials -----
    noteMaterial(color, chroma) {
        const base = color === 0 ? settings.get('leftColor') : settings.get('rightColor');
        const c = chroma
            ? new THREE.Color(Math.min(1, Math.max(0, chroma[0])), Math.min(1, Math.max(0, chroma[1])), Math.min(1, Math.max(0, chroma[2])))
            : new THREE.Color(base);
        const key = 'n' + c.getHexString();
        let m = this._matCache.get(key);
        if (!m) {
            m = new THREE.MeshStandardMaterial({
                color: c, roughness: 0.32, metalness: 0.15,
                emissive: c, emissiveIntensity: 0.28,
            });
            this._matCache.set(key, m);
        }
        return m;
    }

    ownMaterial(m) {
        const c = m.clone();
        c.transparent = true;
        this._ownMats.add(c);
        return c;
    }

    releaseMaterial(m) {
        if (m && this._ownMats.has(m)) { this._ownMats.delete(m); m.dispose(); }
    }

    // Per-note speed / reaction time (Noodle per-object njs + spawn offset)
    noteSpeed(n) {
        if (this.replay) return n.njs ? Math.max(1, n.njs) : this.njs;
        return n.njs ? Math.max(6, Math.min(24, n.njs)) * this.speedMult : this.njs;
    }
    noteRt(n) {
        let rt = this.rt * (this.njs / this.noteSpeed(n));
        if (n.spawnOffset != null) rt = Math.max(0.3, rt + n.spawnOffset * (60 / this.bpm));
        return rt;
    }
    // Notes way outside the reachable grid are scenery on Noodle maps
    isReachable(n) {
        return n.x >= -0.6 && n.x <= 3.6 && n.y >= -0.6 && n.y <= 2.9;
    }

    // ----- Chroma environment geometry ("custom models") -----
    envGeometry(type) {
        if (!this._envGeoCache) this._envGeoCache = {};
        const key = String(type);
        if (!this._envGeoCache[key]) {
            let g;
            switch (key) {   // sized to match Unity's primitives
                case 'Sphere':   g = new THREE.SphereGeometry(0.5, 16, 12); break;
                case 'Capsule':  g = new THREE.CapsuleGeometry(0.5, 1, 4, 12); break;
                case 'Cylinder': g = new THREE.CylinderGeometry(0.5, 0.5, 2, 16); break;   // Unity: 2m tall
                case 'Plane':    g = new THREE.PlaneGeometry(10, 10).rotateX(-Math.PI / 2); break; // Unity: flat, +Y normal
                case 'Quad':     g = new THREE.PlaneGeometry(1, 1); break;
                case 'Triangle': {
                    const shape = new THREE.Shape();
                    shape.moveTo(0, 0.577);
                    shape.lineTo(-0.5, -0.289);
                    shape.lineTo(0.5, -0.289);
                    shape.closePath();
                    g = new THREE.ShapeGeometry(shape);
                    break;
                }
                default:         g = new THREE.BoxGeometry(1, 1, 1); break; // Cube
            }
            this._envGeoCache[key] = g;
        }
        return this._envGeoCache[key];
    }

    envMaterial(shader, colorArr) {
        const c = new THREE.Color(0x8899bb);
        let alpha = 1, boost = 1;
        if (colorArr) {
            boost = tameColor(c, colorArr, 1.5);
            alpha = colorArr.length >= 4 ? clamp(Number(colorArr[3]) || 0, 0, 1) : 1;
        }
        const key = 'e' + shader + '|' + c.getHexString() + '|' + alpha.toFixed(2) + '|' + boost.toFixed(2);
        let m = this._matCache.get(key);
        if (!m) {
            if (/OpaqueLight/i.test(shader)) {
                m = new THREE.MeshStandardMaterial({
                    color: c.clone().multiplyScalar(0.15), emissive: c,
                    emissiveIntensity: clamp(1.1 * boost * Math.max(alpha, 0.25), 0, 1.8),
                    side: THREE.DoubleSide,
                });
            } else if (/TransparentLight|BillieWater|Water|Glow/i.test(shader)) {
                // alpha is the glow amount in Chroma; a big white "sky" sphere at
                // full additive opacity would otherwise white out the screen
                m = new THREE.MeshBasicMaterial({
                    color: c, transparent: true, opacity: clamp(0.35 * alpha * boost, 0.012, 0.4),
                    blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide,
                });
            } else {           // Standard / BTSPillar / InterscopeConcrete / etc.
                m = new THREE.MeshStandardMaterial({
                    color: c, roughness: 0.45, metalness: 0.35, side: THREE.DoubleSide,
                });
            }
            this._matCache.set(key, m);
        }
        return m;
    }

    // Static placement in world space (merged pieces)
    _envTransform(target, e, localZ) {
        const s = this.v2 ? UNIT : 1;     // Chroma v2 positions are in Noodle units
        const pos = e.position || e.localPosition || [0, 0, 0];
        // Chroma env positions are anchored at the player, +z forward → our -z
        target.position.set(pos[0] * s, pos[1] * s, localZ - pos[2] * s);
        const rot = e.rotation || e.localRotation || [0, 0, 0];
        setUnityRotation(target, rot[0], rot[1], rot[2]);
        const sc = e.scale || [1, 1, 1];
        target.scale.set(sc[0] || 0.0001, sc[1] || 0.0001, sc[2] || 0.0001);
    }

    spawnEnvironment(list) {
        this.envMeshes = [];
        this.envGeos = [];
        this.trackedEnvMeshes = [];
        if (!list || !list.length) return;

        // Model maps place pieces 30–100m out; our default fog would swallow
        // them, so thin it while environment geometry is present.
        if (this.scene.fog) {
            this.scene.fog.density = Math.min(this.scene.fog.density, 0.009);
        }

        // No cap — model maps need every piece. Static (untracked) geometry is
        // merged per material into single draw calls so huge models stay fast.
        const staticBuckets = new Map();   // material -> geometries[]
        const helper = new THREE.Object3D();

        for (const e of list) {
            const material = this.envMaterial(e.shader, e.color);
            if (e.track && e.track.length) {
                // animated pieces stay individual so their track can move them
                const mesh = new THREE.Mesh(this.envGeometry(e.type), material);
                this._envTransform(mesh, e, ENV_LOCAL_Z);
                this.tracks.containerFor(e.track).add(mesh);
                this.tracks.markEnv(e.track[0]);
                mesh.userData.envBase = { pos: mesh.position.clone(), scale: mesh.scale.clone(), quat: mesh.quaternion.clone() };
                mesh.userData.envTrack = e.track[0];
                this.trackedEnvMeshes.push(mesh);
                this.envMeshes.push(mesh);
            } else {
                this._envTransform(helper, e, ENV_Z_ORIGIN);
                helper.updateMatrix();
                const geo = this.envGeometry(e.type).clone().applyMatrix4(helper.matrix);
                if (!staticBuckets.has(material)) staticBuckets.set(material, []);
                staticBuckets.get(material).push(geo);
            }
        }

        for (const [material, geometries] of staticBuckets) {
            let merged = null;
            try { merged = mergeGeometries(geometries, false); } catch (err) { merged = null; }
            if (merged) {
                for (const g of geometries) g.dispose();
                const mesh = new THREE.Mesh(merged, material);
                this.scene.add(mesh);
                this.envMeshes.push(mesh);
                this.envGeos.push(merged);
            } else {
                // merge can fail on exotic attribute sets — fall back to individual meshes
                for (const geo of geometries) {
                    const mesh = new THREE.Mesh(geo, material);
                    this.scene.add(mesh);
                    this.envMeshes.push(mesh);
                    this.envGeos.push(geo);
                }
            }
        }
    }

    // Chroma env track semantics: position/rotation/scale are absolute
    updateEnvPieces() {
        const s = this.tracks.absUnit;
        for (const mesh of this.trackedEnvMeshes) {
            const tr = this.tracks.tracks.get(mesh.userData.envTrack);
            if (!tr) continue;
            const v = tr.values, b = mesh.userData.envBase;
            const p = v.localPosition || v.position;
            if (p) mesh.position.set(p[0] * s, p[1] * s, ENV_LOCAL_Z - p[2] * s);
            else mesh.position.copy(b.pos);
            if (v.localRotation) mesh.quaternion.copy(v.localRotation);
            else if (v.rotation) mesh.quaternion.copy(v.rotation);
            else mesh.quaternion.copy(b.quat);
            if (v.scale) mesh.scale.set(v.scale[0] || 0.0001, v.scale[1] || 0.0001, v.scale[2] || 0.0001);
            else mesh.scale.copy(b.scale);
        }
    }

    // Wrap an object so world rotation + tracks compose correctly, and attach
    // it to its track's group (or the object root).
    attachObject(obj3d, obj) {
        const wrapper = new THREE.Group();
        if (obj.worldRot) unityQuat(obj.worldRot[0], obj.worldRot[1], obj.worldRot[2], wrapper.quaternion);
        wrapper.userData.baseQuat = wrapper.quaternion.clone();
        wrapper.add(obj3d);
        const container = (obj.track && this.tracks.containerFor(obj.track)) || this.objRoot;
        container.add(wrapper);
        return wrapper;
    }

    removeObj(o) {
        const ud = o.userData;
        const w = ud.wrapper;
        if (w) w.removeFromParent(); else o.removeFromParent();
        if (ud.ownMat) this.releaseMaterial(ud.mat);
        if (ud.ownFace) this.releaseMaterial(ud.faceMat);
        if (ud.ownEdge) this.releaseMaterial(ud.edgeMat);
    }

    // does this object possibly need its own material (dissolve/color animation)?
    needsOwnMaterial(o) {
        if (o.track) return true;
        const a = o.anim;
        return !!(a && (a.dissolve || a.color || a.dissolveArrow));
    }

    spawnNote(n) {
        const A = this.engine.assets;
        const group = new THREE.Group();
        let mat = this.noteMaterial(n.color, n.chroma);
        const own = this.needsOwnMaterial(n);
        if (own) mat = this.ownMaterial(mat);
        const box = new THREE.Mesh(n.chainLink ? A.chainBox : A.noteBox, mat);
        group.add(box);

        const dot = n.dir === 8 || n.chainLink;
        let faceMat = dot ? A.dotMat : A.arrowMat;
        const ownFace = own && !!(n.track || (n.anim && n.anim.dissolveArrow));
        if (ownFace) faceMat = this.ownMaterial(faceMat);
        const size = n.chainLink ? 0.3 : 0.48;
        const face = new THREE.Mesh(n.chainLink ? A.chainFace : A.noteFace, faceMat);
        face.position.z = size / 2 + 0.012;
        group.add(face);

        // Arrow orientation. Cut direction rotates the arrow; v3 angle offsets
        // and Noodle's absolute cut angle rotate the whole note (CCW).
        const v = DIR_VECTORS[n.dir] || [0, 0];
        let swingX = v[0], swingY = v[1];
        let noteAngle = 0;
        if (n.angleAbs) {
            face.rotation.z = Math.PI;                 // "down" arrow, then rotate the note
            noteAngle = (n.angle || 0) * DEG;
            swingX = Math.sin(noteAngle); swingY = -Math.cos(noteAngle);
        } else {
            if (!dot) face.rotation.z = Math.atan2(-v[0], v[1]);
            if (n.angle) {
                noteAngle = n.angle * DEG;
                const c = Math.cos(noteAngle), s = Math.sin(noteAngle);
                [swingX, swingY] = [swingX * c - swingY * s, swingX * s + swingY * c];
            }
        }
        const restQuat = new THREE.Quaternion();
        if (n.localRot) unityQuat(n.localRot[0], n.localRot[1], n.localRot[2], restQuat);
        if (noteAngle) restQuat.multiply(_q.setFromAxisAngle(AXIS_Z, noteAngle));

        const animated = !!(n.anim || n.track);
        group.userData = {
            note: n,
            targetY: layerY(n.y),
            x: colX(n.x),
            mat, faceMat, ownMat: own, ownFace,
            baseColor: mat.color.clone(),
            speed: this.noteSpeed(n),
            rt: this.noteRt(n),
            decorative: n.decorative || (!n.anim && !this.isReachable(n)),
            animated,
            fxBuf: animated ? makeFx() : null,
            fx: null,
            restQuat,
            swing: [swingX, swingY],
            wp: new THREE.Vector3(),
            zt: 0,
            rev: this.replay ? (this.replay.match.noteEvents.get(n) || null) : null,
        };
        group.userData.wrapper = this.attachObject(group, n);
        this.liveNotes.push(group);
    }

    spawnBomb(b) {
        const A = this.engine.assets;
        const own = this.needsOwnMaterial(b);
        const mat = own ? this.ownMaterial(A.bombMat) : A.bombMat;
        const mesh = new THREE.Mesh(A.bomb, mat);
        const animated = !!(b.anim || b.track);
        mesh.userData = {
            bomb: b, targetY: layerY(b.y), x: colX(b.x), mat, ownMat: own,
            speed: this.noteSpeed(b), rt: this.noteRt(b),
            decorative: !!b.decorative,
            animated,
            fxBuf: animated ? makeFx() : null,
            restQuat: b.localRot ? unityQuat(b.localRot[0], b.localRot[1], b.localRot[2]) : null,
            spinX: Math.random() * 6, spinY: Math.random() * 6,
            wp: new THREE.Vector3(),
            rev: this.replay ? (this.replay.match.bombEvents.get(b) || null) : null,
        };
        mesh.userData.wrapper = this.attachObject(mesh, b);
        this.liveBombs.push(mesh);
    }

    wallMaterials(color, own) {
        const distortion = settings.get('wallDistortion');
        const key = 'w' + (distortion ? 'd' : 'b') + color.getHexString();
        const make = () => {
            const body = distortion
                ? new THREE.ShaderMaterial({
                    uniforms: {
                        uColor: { value: color.clone() },
                        uOpacity: { value: 1.0 },              // dissolve factor
                        uTime: this.engine.wallUniforms.uTime,  // shared, updated once per frame
                        uScene: this.engine.wallUniforms.uScene,
                        uResolution: this.engine.wallUniforms.uResolution,
                    },
                    vertexShader: WALL_VERT,
                    fragmentShader: WALL_FRAG,
                    transparent: true, depthWrite: false, side: THREE.DoubleSide,
                })
                : new THREE.MeshBasicMaterial({
                    color, transparent: true, opacity: 0.16, depthWrite: false,
                    blending: THREE.AdditiveBlending, side: THREE.DoubleSide,
                });
            const edge = new THREE.LineBasicMaterial({ color, transparent: true, opacity: 0.7 });
            return { body, edge };
        };
        if (own) {
            const m = make();
            this._ownMats.add(m.body); this._ownMats.add(m.edge);
            return m;
        }
        let m = this._matCache.get(key);
        if (!m) { m = make(); this._matCache.set(key, m); }
        return m;
    }

    spawnWall(w) {
        const A = this.engine.assets;
        // Wall art uses huge/tiny/negative sizes — preserve them, just keep sane bounds
        const width = Math.min(60, Math.max(0.03, Math.abs(w.w))) * COL_STEP;
        const height = Math.min(60, Math.max(0.03, Math.abs(w.h))) * WALL_STEP;
        // NE size[2] overrides duration-based length (grid units)
        const length = w.l != null
            ? Math.min(300, Math.max(0.05, Math.abs(w.l) * UNIT))
            : Math.min(300, Math.max(0.05, w.duration * this.noteSpeed(w)));
        const color = new THREE.Color(0xff2d55);
        if (w.chroma) tameColor(color, w.chroma);
        const own = this.needsOwnMaterial(w);
        const { body, edge } = this.wallMaterials(color, own);
        const mesh = new THREE.Mesh(A.wallBox, body);
        mesh.add(new THREE.LineSegments(A.wallEdges, edge));
        const animated = !!(w.anim || w.track);
        mesh.userData = {
            wall: w,
            // left edge at column x, extending `w.w` columns (negative w extends left)
            x: colX(w.x) - COL_STEP / 2 + (w.w * COL_STEP) / 2,
            y: 0.1 + w.y * WALL_STEP + (w.h >= 0 ? height : -height) / 2,
            width, height, length,
            mat: body, edgeMat: edge, ownMat: own, ownEdge: own,
            baseColor: color.clone(),
            speed: this.noteSpeed(w),
            rt: this.noteRt(w),
            decorative: !!w.decorative,
            animated,
            fxBuf: animated ? makeFx() : null,
            restQuat: w.localRot ? unityQuat(w.localRot[0], w.localRot[1], w.localRot[2]) : null,
            baseOpacity: body.isShaderMaterial ? 1 : 0.16,
            wp: new THREE.Vector3(),
        };
        mesh.userData.wrapper = this.attachObject(mesh, w);
        this.liveWalls.push(mesh);
    }

    // ----- game update -----
    update(dt) {
        if (this.paused || this.finished) return;

        const t = audio.songTime;

        // countdown display
        const cd = this.$('countdown');
        if (t < 0) {
            const n = Math.ceil(-t / (this.replay ? (this.replay.speed || 1) : 1));
            const label = n > 3 ? 'READY' : String(n);
            if (cd.textContent !== label) {
                cd.textContent = label;
                cd.classList.remove('hidden', 'tick');
                void cd.offsetWidth;
                cd.classList.add('tick');
            }
        } else if (!cd.classList.contains('hidden')) {
            if (t < 0.8 && cd.textContent !== 'GO!') {
                cd.textContent = 'GO!';
                cd.classList.remove('tick'); void cd.offsetWidth; cd.classList.add('tick');
                setTimeout(() => cd.classList.add('hidden'), 900);
            } else if (t >= 0.8 && cd.textContent !== 'GO!') {
                cd.classList.add('hidden');
            }
        }

        // sabers (gamepad is polled once per frame by the main loop)
        if (this.replay) this.updateReplayPose(t);
        else {
            this.saberLeft.move(gamepad.leftStick, dt);
            this.saberRight.move(gamepad.rightStick, dt);
        }

        // spawn objects whose spawn time has arrived (queues pre-sorted by spawn time)
        while (this.noteIdx < this.noteQueue.length && this.noteQueue[this.noteIdx].at <= t) {
            this.spawnNote(this.noteQueue[this.noteIdx++].o);
        }
        while (this.bombIdx < this.bombQueue.length && this.bombQueue[this.bombIdx].at <= t) {
            this.spawnBomb(this.bombQueue[this.bombIdx++].o);
        }
        while (this.wallIdx < this.wallQueue.length && this.wallQueue[this.wallIdx].at <= t) {
            this.spawnWall(this.wallQueue[this.wallIdx++].o);
        }
        while (this.eventIdx < this.map.events.length && this.map.events[this.eventIdx].time <= t) {
            this.engine.handleEvent(this.map.events[this.eventIdx++]);
        }

        // Noodle: custom events, track animations, player movement
        this.tracks.update(t);
        if (this.trackedEnvMeshes.length) this.updateEnvPieces();

        // Chroma fog (AssignFogTrack / AnimateComponent BloomFogEnvironment)
        const fog = this.tracks.fogValues();
        if (fog && this.scene.fog && fog.attenuation !== undefined) {
            this.scene.fog.density = clamp(fog.attenuation[0] * 8, 0.0004, 0.25);
        }

        this.moveNotes(t, dt);
        this.moveBombs(t, dt);
        this.moveWalls(t, dt);
        if (this.replay) this.updateReplayEvents(t);

        // progress bar (transform only — no layout)
        const dur = audio.songDuration || 1;
        const prog = Math.round(clamp(t / dur, 0, 1) * 1000) / 1000;
        if (prog !== this._hud.prog) {
            this._hud.prog = prog;
            this.$('hud-progress-fill').style.transform = `scaleX(${prog})`;
        }
    }

    // Apply combined Noodle effects (object anim + track paths + track values)
    applyNoodleFx(o, ud, fx) {
        if (fx) {
            if (fx.hasPos) {
                o.position.x += fx.pos[0] * UNIT;
                o.position.y += fx.pos[1] * UNIT;
                o.position.z -= fx.pos[2] * UNIT;
            }
            if (fx.hasLrot) o.quaternion.premultiply(fx.lrot);
            if (fx.hasScale) o.scale.multiply(_v.set(fx.scale[0], fx.scale[1], fx.scale[2]));
        }
        const w = ud.wrapper;
        if (w) {
            if (fx && fx.hasRot) w.quaternion.copy(fx.rot).multiply(w.userData.baseQuat);
            else w.quaternion.copy(w.userData.baseQuat);
        }

        // dissolve / color (own materials only — shared ones stay untouched)
        const dis = fx && fx.hasDissolve ? clamp(fx.dissolve, 0, 1) : 1;
        o.visible = dis > 0.002;
        if (ud.ownMat && ud.mat) {
            const m = ud.mat;
            let alpha = dis;
            if (fx && fx.hasColor) {
                const c = fx.color;
                if (m.isShaderMaterial) m.uniforms.uColor.value.setRGB(clamp(c[0], 0, 1), clamp(c[1], 0, 1), clamp(c[2], 0, 1));
                else {
                    m.color.setRGB(clamp(c[0], 0, 1), clamp(c[1], 0, 1), clamp(c[2], 0, 1));
                    if (m.emissive) m.emissive.copy(m.color);
                }
                alpha *= clamp(c[3] ?? 1, 0, 1);
            } else if (ud.baseColor) {
                if (m.isShaderMaterial) m.uniforms.uColor.value.copy(ud.baseColor);
                else { m.color.copy(ud.baseColor); if (m.emissive) m.emissive.copy(ud.baseColor); }
            }
            if (m.isShaderMaterial) m.uniforms.uOpacity.value = alpha;
            else m.opacity = alpha * (ud.baseOpacity ?? 1);
            if (ud.edgeMat && ud.ownEdge) {
                ud.edgeMat.opacity = alpha * 0.7;
                if (fx && fx.hasColor) ud.edgeMat.color.setRGB(clamp(fx.color[0], 0, 1), clamp(fx.color[1], 0, 1), clamp(fx.color[2], 0, 1));
            }
        }
        if (ud.ownFace && ud.faceMat) {
            ud.faceMat.opacity = fx && fx.hasDissolveArrow ? clamp(fx.dissolveArrow, 0, 1) : 1;
        }
    }

    moveNotes(t, dt) {
        // pass 1: transforms (position, jump-in, Noodle animation)
        for (const g of this.liveNotes) {
            const ud = g.userData;
            const n = ud.note;
            const p = 1 - (n.time - t) / ud.rt;      // 0 spawn → 1 hit
            const lifeP = clamp(p * 0.5, 0, 1);      // 0.5 = hit plane
            const fx = ud.animated ? this.tracks.combine(n.anim, n.track, lifeP, ud.fxBuf) : null;

            if (fx && fx.hasDef) {
                // full flight path defined by the map — relative to the
                // object's lane x/y per the Heck spec
                g.position.set(ud.x + fx.def[0] * UNIT, ud.targetY + fx.def[1] * UNIT, -fx.def[2] * UNIT);
                g.quaternion.copy(ud.restQuat);
                g.scale.setScalar(1);
            } else {
                // Noodle "time" property remaps the note's own life progress
                const z = fx && fx.hasTime
                    ? -(0.5 - fx.time) * 2 * ud.rt * ud.speed
                    : -(n.time - t) * ud.speed;
                const rise = n.noGravity ? 1 : clamp(p / 0.4, 0, 1);
                const easedRise = 1 - Math.pow(1 - rise, 3);
                g.position.set(ud.x, THREE.MathUtils.lerp(ud.targetY - SPAWN_LEAD_Y, ud.targetY, easedRise), z);
                g.quaternion.copy(ud.restQuat);
                if (easedRise < 1) g.quaternion.multiply(_q.setFromAxisAngle(AXIS_Z, (1 - easedRise) * 0.8));
                g.scale.setScalar(0.5 + easedRise * 0.5);
            }

            if (ud.animated) this.applyNoodleFx(g, ud, fx);
            ud.fx = fx;
            // canonical lifetime z: like the real game, hit/miss timing follows
            // the note's own life span — player movement never despawns notes
            ud.zt = -(n.time - t) * ud.speed;
        }
        // one matrix pass for everything instead of walking parents per note
        this.objRoot.updateMatrixWorld(true);
        for (const g of this.liveNotes) g.userData.wp.setFromMatrixPosition(g.matrixWorld);

        // pass 2: gentle aim assist pulls sabers toward the nearest matching note
        if (!this.replay) this.applyAimAssist();
        this.saberLeft.finalize(dt, !!this.replay);
        this.saberRight.finalize(dt, !!this.replay);

        if (this.replay) { this.resolveReplayNotes(t); return; }

        // pass 3: hits and misses. Timing windows follow each note's LIFETIME
        // (world-anchored), exactly like the real game — player/camera movement
        // can never despawn notes. Whether you can hit one is purely whether
        // your saber physically reaches it (world-space blade distance).
        for (let i = this.liveNotes.length - 1; i >= 0; i--) {
            const g = this.liveNotes[i];
            const ud = g.userData;
            const n = ud.note;
            const zt = ud.zt;
            const lifeOver = (t - n.time) / ud.rt;   // >1 = well past despawn

            if (ud.decorative) {                     // scenery: never hit, never punish
                if (lifeOver > 2.5 || (lifeOver > 1.2 && zt > 2)) {
                    this.removeObj(g); this.liveNotes.splice(i, 1);
                }
                continue;
            }

            // animated interactable: fully interactable only when >= 1 (Heck spec)
            const uninteractableNow = ud.fx && ud.fx.hasInteractable && ud.fx.interactable < 1;

            if (!uninteractableNow && zt > -1.0 && zt < 1.0) {
                const saber = n.color === 0 ? this.saberLeft : this.saberRight;
                const wrongSaber = n.color === 0 ? this.saberRight : this.saberLeft;
                if (saber.distanceTo(ud.wp) < 0.6) {
                    this.hitNote(g, saber, i);
                    continue;
                }
                // wrong saber only counts against you on a deliberate fast swing
                if (wrongSaber.distanceTo(ud.wp) < 0.22 && wrongSaber.smoothVel.length() > 1.6) {
                    this.badCut(g, i);
                    continue;
                }
            }

            if (zt > 1.3 || (t - n.time) > 0.45) {
                // a note that was uninteractable as it passed is never a miss
                if (uninteractableNow) { this.removeObj(g); this.liveNotes.splice(i, 1); }
                else this.miss(g, i);
            }
        }
    }

    applyAimAssist() {
        if (this.aimAssist <= 0) return;
        for (const saber of [this.saberLeft, this.saberRight]) {
            const want = saber === this.saberLeft ? 0 : 1;
            saber.group.updateWorldMatrix(true, false);
            const sp = _v2.setFromMatrixPosition(saber.group.matrixWorld);
            let best = null, bestD = 1.1;
            for (const g of this.liveNotes) {
                const ud = g.userData;
                if (ud.decorative || ud.note.color !== want) continue;
                if (ud.zt < -1.6 || ud.zt > 1.0) continue;
                const d = Math.hypot(ud.wp.x - sp.x, ud.wp.y - sp.y);
                if (d < bestD) { bestD = d; best = g; }
            }
            if (best) {
                const k = this.aimAssist * 0.45 * Math.max(0, 1 - bestD / 1.1);
                // nudge in world space, converted back into the hand rig's space
                _v.set(sp.x + (best.userData.wp.x - sp.x) * k, sp.y + (best.userData.wp.y - sp.y) * k, sp.z);
                saber.group.parent.worldToLocal(_v);
                saber.group.position.x = _v.x;
                saber.group.position.y = _v.y;
            }
        }
    }

    // effects for a cut note: two halves + sparks, swing direction dir (2D)
    cutEffects(g, dir) {
        const ud = g.userData;
        _swing.copy(dir);
        if (_swing.lengthSq() < 0.01) _swing.set(0, -1);
        _swing.normalize();
        const color = ud.mat.color;
        this.engine.slices.spawn(ud.wp, _swing, color);
        this.engine.particles.burst(ud.wp, color);
    }

    hitNote(g, saber, idx) {
        const ud = g.userData;
        const n = ud.note;
        const vel = saber.smoothVel;
        const speed = vel.length();

        // Friendly scoring: any contact scores; direction + a real flick earn the bonus
        let judgement = 'OK', points = 80;
        const dv = ud.swing;
        const dot = speed > 0.3 ? (vel.x * dv[0] + vel.y * dv[1]) / speed : 0;
        const dirOk = n.dir === 8 || n.chainLink || dot > 0.45;
        if (dirOk && speed > 1.1) { judgement = 'PERFECT'; points = 115; }
        else if (speed > 0.35) { judgement = 'GOOD'; points = 100; }

        this.score += points * this.multiplier;
        this.combo++;
        this.hits++;
        this.processed++;
        this.maxCombo = Math.max(this.maxCombo, this.combo);
        this.bumpMultiplier();
        this.energy = Math.min(1, this.energy + 0.009);

        audio.playHit(judgement === 'PERFECT' ? 1.0 : 0.85);
        gamepad.rumble(60, 0.5, 0.2);

        this.showJudgement(judgement);
        this.cutEffects(g, vel);
        this.removeObj(g);
        this.liveNotes.splice(idx, 1);
        this.updateHud(true);
    }

    badCut(g, idx) {
        this.combo = 0;
        this.multiplier = 1;
        this.multProgress = 0;
        this.processed++;
        this.misses++;
        this.addEnergy(-0.05);
        audio.playSfx('miss', 0.6);
        this.showJudgement('WRONG SABER', '#ff5a5a');
        this.removeObj(g);
        this.liveNotes.splice(idx, 1);
        this.updateHud();
    }

    miss(g, idx) {
        this.combo = 0;
        this.multiplier = 1;
        this.multProgress = 0;
        this.processed++;
        this.misses++;
        this.addEnergy(-0.07);
        audio.playSfx('miss', 0.55);
        this.showJudgement('MISS', '#ff5a5a');
        this.removeObj(g);
        this.liveNotes.splice(idx, 1);
        this.updateHud();
    }

    moveBombs(t, dt) {
        for (const m of this.liveBombs) {
            const ud = m.userData;
            const b = ud.bomb;
            const p = 1 - (b.time - t) / ud.rt;
            const lifeP = clamp(p * 0.5, 0, 1);
            const fx = ud.animated ? this.tracks.combine(b.anim, b.track, lifeP, ud.fxBuf) : null;

            if (fx && fx.hasDef) {
                m.position.set(ud.x + fx.def[0] * UNIT, ud.targetY + fx.def[1] * UNIT, -fx.def[2] * UNIT);
            } else {
                const z = fx && fx.hasTime ? -(0.5 - fx.time) * 2 * ud.rt * ud.speed : -(b.time - t) * ud.speed;
                m.position.set(ud.x, ud.targetY, z);
            }
            // frame-rate independent tumble, rebuilt every frame (never accumulates)
            ud.spinX += 1.8 * dt; ud.spinY += 3.0 * dt;
            m.rotation.set(ud.spinX, ud.spinY, 0);
            if (ud.restQuat) m.quaternion.premultiply(ud.restQuat);
            m.scale.setScalar(1);
            if (ud.animated) this.applyNoodleFx(m, ud, fx);
            ud.zt = -(b.time - t) * ud.speed;   // lifetime z
        }
        if (!this.liveBombs.length) return;
        this.objRoot.updateMatrixWorld(true);

        for (let i = this.liveBombs.length - 1; i >= 0; i--) {
            const m = this.liveBombs[i];
            const ud = m.userData;
            const b = ud.bomb;
            ud.wp.setFromMatrixPosition(m.matrixWorld);
            const zt = ud.zt;

            if (this.replay) {
                if (ud.rev && t >= ud.rev.eventTime) {
                    this.bombHit(m, i);
                    continue;
                }
            } else if (!ud.decorative && zt > -0.8 && zt < 0.8) {
                const touching = (s) => s.distanceTo(ud.wp) < 0.22 && s.smoothVel.length() > 0.6;
                if (touching(this.saberLeft) || touching(this.saberRight)) {
                    this.bombHit(m, i);
                    continue;
                }
            }
            const bLifeOver = (t - b.time) / ud.rt;
            if (bLifeOver > 2.5 || (bLifeOver > 1.2 && zt > 1.4)) {
                this.removeObj(m);
                this.liveBombs.splice(i, 1);
            }
        }
    }

    bombHit(m, i) {
        const ud = m.userData;
        this.combo = 0;
        if (this.replay) this.dropMultiplier(); else { this.multiplier = 1; this.multProgress = 0; }
        this.addEnergy(this.replay ? -0.15 : -0.13);
        audio.playSfx('miss', 0.9, 0.7);
        if (!this.replay) gamepad.rumble(220, 1, 1);
        this.showJudgement('BOMB!', '#ff2d2d');
        this.engine.particles.burst(ud.wp, _bombColor, 26);
        this.removeObj(m);
        this.liveBombs.splice(i, 1);
        this.updateHud();
    }

    moveWalls(t, dt) {
        for (let i = this.liveWalls.length - 1; i >= 0; i--) {
            const m = this.liveWalls[i];
            const ud = m.userData;
            const w = ud.wall;
            const life = ud.rt * 2 + w.duration;
            const lifeP = clamp((t - (w.time - ud.rt)) / life, 0, 1);
            const fx = ud.animated ? this.tracks.combine(w.anim, w.track, lifeP, ud.fxBuf) : null;

            const headZ = -(w.time - t) * ud.speed;
            if (fx && fx.hasDef) {
                // relative to the wall's lane position per the Heck spec
                m.position.set(ud.x + fx.def[0] * UNIT, ud.y + fx.def[1] * UNIT, -fx.def[2] * UNIT - ud.length / 2);
            } else {
                m.position.set(ud.x, ud.y, headZ - ud.length / 2);
            }
            if (ud.restQuat) m.quaternion.copy(ud.restQuat); else m.quaternion.identity();
            m.scale.set(ud.width, ud.height, ud.length);
            if (ud.animated) this.applyNoodleFx(m, ud, fx);

            // saber inside a real wall drains energy a bit (never for wall art)
            if (!ud.decorative && !this.replay && headZ > -2 && headZ - ud.length < 2) {
                m.updateWorldMatrix(true, false);
                ud.wp.setFromMatrixPosition(m.matrixWorld);
                const inside = (saber) => {
                    const p = saber.tip;
                    return Math.abs(p.x - ud.wp.x) < ud.width / 2 &&
                           Math.abs(p.y - ud.wp.y) < ud.height / 2 &&
                           Math.abs(p.z - ud.wp.z) < ud.length / 2;
                };
                if (inside(this.saberLeft) || inside(this.saberRight)) {
                    this.addEnergy(-0.15 * dt);
                    gamepad.rumble(50, 0.3, 0.6);
                }
            }

            if (lifeP >= 1 && headZ - ud.length > 3) {
                this.removeObj(m);
                this.liveWalls.splice(i, 1);
            }
        }
    }

    bumpMultiplier() {
        if (this.multiplier >= 8) return;
        this.multProgress++;
        const need = this.multiplier * 2;
        if (this.multProgress >= need) {
            this.multiplier *= 2;
            this.multProgress = 0;
        }
    }

    // Beat Saber: a mistake halves the multiplier instead of resetting it
    dropMultiplier() {
        if (this.multiplier > 1) this.multiplier /= 2;
        this.multProgress = 0;
    }

    addEnergy(d) {
        this.energy = Math.max(0, Math.min(1, this.energy + d));
        if (this.energy <= 0 && !this.noFail && !this.failed) {
            this.failed = true;
            this.finish();
        }
    }

    // ----- replay playback -----
    setupReplay() {
        const rp = this.replay;
        const info = rp.data.info;
        // Calibrate the recorded play space onto our grid using the replay's
        // own cut points (handles player height and note jump offsets).
        const dxs = [], dys = [], dzs = [];
        const njs = this.njs;
        for (const [n, ev] of rp.match.noteEvents) {
            if (!ev.cut || ev.eventType !== NOTE_EVENT.GOOD || n.anim || n.track || n.chainLink) continue;
            if (n.x !== n.lx || n.y !== n.ly) continue;
            const cp = ev.cut.cutPoint;
            dxs.push(cp[0] - colX(n.lx));
            dys.push(cp[1] - layerY(n.ly));
            dzs.push(cp[2] - (ev.spawnTime - ev.eventTime) * njs);
            if (dxs.length > 400) break;
        }
        const calib = {
            dx: clamp(median(dxs, 0), -0.3, 0.3),
            dy: clamp(median(dys, 0.1), -0.6, 0.6),
            dz: clamp(median(dzs, 0.77), -0.5, 2),
        };
        this.replayState = {
            pose: new ReplayPose(rp.data.frames, calib),
            walls: [...(rp.data.walls || [])].sort((a, b) => a.time - b.time),
            wallIdx: 0,
            failTime: info.failTime > 0 ? info.failTime : 0,
            calib,
        };

        // visible head for the third-person view
        const visor = new THREE.Mesh(this.engine.assets.head, new THREE.MeshStandardMaterial({
            color: 0x1a1a28, emissive: 0x7c5cff, emissiveIntensity: 0.6, roughness: 0.4,
        }));
        this.headModel = visor;
        this.playerRig.add(visor);
    }

    setCameraMode(mode) {
        this.camMode = mode;
        if (mode === 'third') {
            this.engine.camera.position.copy(this.camLocalHome);
            this.engine.camera.quaternion.copy(this.engine.camHomeQuat);
        }
        if (this.headModel) this.headModel.visible = mode !== 'first';
    }

    toggleCamera() {
        if (!this.replay) return;
        this.setCameraMode(this.camMode === 'third' ? 'first' : 'third');
        return this.camMode;
    }

    updateReplayPose(t) {
        const st = this.replayState;
        st.pose.update(t);
        const P = st.pose;
        this.saberLeft.setPose(P.left.pos, P.left.quat);
        this.saberRight.setPose(P.right.pos, P.right.quat);
        if (this.headModel) {
            this.headModel.position.copy(P.head.pos);
            this.headModel.quaternion.copy(P.head.quat);
        }
        if (this.camMode === 'first') {
            const cam = this.engine.camera;
            // light smoothing so recorded head jitter doesn't shake the view
            cam.position.lerp(P.head.pos, 0.6);
            cam.quaternion.slerp(P.head.quat, 0.5);
        }
    }

    resolveReplayNotes(t) {
        // collect everything due this frame and apply it in event order — the
        // multiplier/combo outcome depends on the order of hits and misses
        const due = [];
        for (let i = this.liveNotes.length - 1; i >= 0; i--) {
            const g = this.liveNotes[i];
            const ud = g.userData;
            const n = ud.note;
            const ev = ud.rev;
            const lifeOver = (t - n.time) / ud.rt;
            if (!ev) {                       // scenery, or a note the player never saw
                const gone = ud.decorative
                    ? (lifeOver > 2.5 || (lifeOver > 1.2 && ud.zt > 2))
                    : lifeOver > 1.2;
                if (gone) { this.removeObj(g); this.liveNotes.splice(i, 1); }
                continue;
            }
            if (t >= ev.eventTime) due.push(g);
        }
        if (!due.length) return;
        due.sort((a, b) => a.userData.rev.eventTime - b.userData.rev.eventTime);
        for (const g of due) {
            const ev = g.userData.rev;
            const { scoringType } = splitNoteId(ev.noteID);
            this.processed++;
            this.maxScore += maxCutScore(scoringType) * idealMult(this.processed);
            if (ev.eventType === NOTE_EVENT.GOOD && ev.cut) {
                this.bumpMultiplierBS();
                const pts = cutScore(ev.cut, scoringType);
                this.score += pts * this.multiplier;
                this.combo++; this.hits++;
                this.maxCombo = Math.max(this.maxCombo, this.combo);
                this.addEnergy(0.01);
                audio.playHit(pts >= 110 ? 1.0 : 0.85);
                this.showJudgement(String(pts), pts >= 115 ? '#ffd76a' : pts >= 108 ? '#ffffff' : pts >= 100 ? '#9fd8ff' : '#ffb27a');
                const sd = ev.cut.saberDir;
                this.cutEffects(g, _swing.set(sd[0], sd[1]));
            } else {
                const bad = ev.eventType === NOTE_EVENT.BAD;
                this.combo = 0; this.misses++;
                this.dropMultiplier();
                this.addEnergy(bad ? -0.1 : -0.15);
                audio.playSfx('miss', 0.55);
                this.showJudgement(bad ? 'BAD CUT' : 'MISS', '#ff5a5a');
            }
            this.removeObj(g);
            this.liveNotes.splice(this.liveNotes.indexOf(g), 1);
            this.updateHud(ev.eventType === NOTE_EVENT.GOOD);
        }
    }

    // Beat Saber's multiplier: progress counts first, the note scores at the new value
    bumpMultiplierBS() {
        if (this.multiplier >= 8) return;
        this.multProgress++;
        if (this.multProgress >= this.multiplier * 2) {
            this.multiplier *= 2;
            this.multProgress = 0;
        }
    }

    updateReplayEvents(t) {
        const st = this.replayState;
        while (st.wallIdx < st.walls.length && st.walls[st.wallIdx].time <= t) {
            const ev = st.walls[st.wallIdx++];
            this.combo = 0;
            this.dropMultiplier();
            if (Number.isFinite(ev.energy)) this.energy = clamp(ev.energy, 0, 1);
            this.showJudgement('WALL', '#ff8a5a');
            this.updateHud();
        }
        if (st.failTime && t >= st.failTime && !this.failed) {
            this.failed = true;
            this.showJudgement('FAILED', '#ff2d55');
            this.finish();
        }
    }

    showJudgement(text, color = '') {
        const el = this.$('hud-judgement');
        el.textContent = text;
        el.style.color = color || (text === 'PERFECT' ? '#ffd76a' : '#cfd6ff');
        el.classList.remove('show');
        void el.offsetWidth;
        el.classList.add('show');
    }

    get accuracy() {
        if (this.replay) return this.maxScore > 0 ? this.score / this.maxScore : 1;
        const max = idealScore(this.processed);
        return max > 0 ? this.score / max : 1;
    }

    get rank() {
        const a = this.accuracy;
        if (this.processed === 0) return '—';
        if (this.replay) {   // Beat Saber's thresholds
            return a >= 0.9 ? 'SS' : a >= 0.8 ? 'S' : a >= 0.65 ? 'A' : a >= 0.5 ? 'B' : a >= 0.35 ? 'C' : a >= 0.2 ? 'D' : 'E';
        }
        return a >= 0.9 ? 'SS' : a >= 0.8 ? 'S' : a >= 0.65 ? 'A' : a >= 0.5 ? 'B' : a >= 0.35 ? 'C' : 'D';
    }

    _set(id, key, value, prop = 'textContent') {
        if (this._hud[key] === value) return;
        this._hud[key] = value;
        const el = this.$(id);
        if (prop === 'textContent') el.textContent = value; else el.style[prop] = value;
    }

    updateHud(comboPulse = false) {
        this._set('hud-score', 'score', this.score.toLocaleString());
        this._set('hud-acc', 'acc', (this.accuracy * 100).toFixed(this.replay ? 2 : 1) + '%');
        this._set('hud-rank', 'rank', this.rank);
        this._set('hud-combo', 'combo', String(this.combo));
        this._set('hud-mult', 'mult', 'x' + this.multiplier);
        const need = this.multiplier >= 8 ? 1 : this.multiplier * 2;
        const frac = this.multiplier >= 8 ? 1 : this.multProgress / need;
        this._set('mult-ring-fg', 'ring', String(163.4 * (1 - frac)), 'strokeDashoffset');
        this._set('hud-energy-fill', 'energy', `scaleY(${this.energy.toFixed(3)})`, 'transform');
        const low = this.energy < 0.25;
        if (this._hud.low !== low) { this._hud.low = low; this.$('hud-energy-fill').classList.toggle('low', low); }
        if (comboPulse) {
            const c = this.$('hud-combo');
            c.classList.remove('pulse'); void c.offsetWidth; c.classList.add('pulse');
        }
    }

    pause() {
        if (this.finished) return;
        this.paused = true;
        audio.pause();
    }

    resume() {
        this.paused = false;
        audio.resume();
    }

    finish() {
        if (this.finished) return;
        this.finished = true;
        audio.stopSong();
        const results = {
            score: this.score,
            accuracy: this.accuracy,
            rank: this.failed ? 'F' : this.rank,
            maxCombo: this.maxCombo,
            hits: this.hits,
            misses: this.misses,
            failed: this.failed,
            fullCombo: this.misses === 0 && this.processed > 0,
            replay: !!this.replay,
        };
        setTimeout(() => this.opts.onEnd(results), this.failed ? 300 : 600);
    }

    destroy() {
        audio.onSongEnd = null;
        audio.stopSong();
        for (const g of this.liveNotes) this.removeObj(g);
        for (const m of this.liveBombs) this.removeObj(m);
        for (const m of this.liveWalls) this.removeObj(m);
        this.liveNotes = []; this.liveBombs = []; this.liveWalls = [];
        this.engine.particles.clear();
        this.engine.slices.clear();

        for (const m of (this.envMeshes || [])) m.removeFromParent();
        for (const g of (this.envGeos || [])) g.dispose();
        for (const k in (this._envGeoCache || {})) this._envGeoCache[k].dispose();
        this.envMeshes = []; this.envGeos = []; this.trackedEnvMeshes = [];

        this.saberLeft.dispose();
        this.saberRight.dispose();
        if (this.headModel) { this.headModel.removeFromParent(); this.headModel.material.dispose(); }

        // restore camera from the head rig
        const cam = this.engine.camera;
        cam.removeFromParent();
        this.scene.add(cam);
        cam.position.copy(CAM_HOME);
        cam.quaternion.copy(this.engine.camHomeQuat);

        this.tracks.destroy();
        this.scene.remove(this.playerRig);
        this.scene.remove(this.objRoot);

        for (const m of this._ownMats) m.dispose();
        this._ownMats.clear();
        for (const m of this._matCache.values()) {
            if (m.body) { m.body.dispose(); m.edge.dispose(); } else m.dispose();
        }
        this._matCache.clear();
        this.engine.resetLights();
    }
}

const _bombColor = new THREE.Color(0xff3020);
