// ============ MOSU game: 3D tunnel renderer + timing/judgement ============
import * as THREE from 'three';
import { audio } from './audio.js';
import { input } from './input.js';
import { settings } from './storage.js';
import { OPPOSITE } from './levels.js';

export const DIR_COLORS = { up: 0x4fc3f7, right: 0x3dffa0, down: 0xff4f8b, left: 0xffb02d, any: 0xf2f2ff };
const FLIP_COLOR = 0xb96fff;
const SPAWN_Z = -60;
const NOTE = 1.5;
const BASE_WINDOWS = { perfect: 0.045, great: 0.09, good: 0.135 };
const POINTS = { perfect: 300, great: 200, good: 100 };
const ACC_VALUE = { perfect: 1, great: 2 / 3, good: 1 / 3 };
const DIR_ANGLE = { up: 0, right: -Math.PI / 2, down: Math.PI, left: Math.PI / 2 };

// ---------- textures ----------
function canvasTex(draw, size = 128) {
    const c = document.createElement('canvas');
    c.width = c.height = size;
    const ctx = c.getContext('2d');
    draw(ctx, size);
    const t = new THREE.CanvasTexture(c);
    t.anisotropy = 4;
    return t;
}
const arrowPath = (ctx, s) => {
    ctx.beginPath();                              // bold arrow pointing up
    ctx.moveTo(s * 0.5, s * 0.12);
    ctx.lineTo(s * 0.88, s * 0.52);
    ctx.lineTo(s * 0.64, s * 0.52);
    ctx.lineTo(s * 0.64, s * 0.88);
    ctx.lineTo(s * 0.36, s * 0.88);
    ctx.lineTo(s * 0.36, s * 0.52);
    ctx.lineTo(s * 0.12, s * 0.52);
    ctx.closePath();
};
function makeTextures() {
    const glow = (ctx) => { ctx.fillStyle = '#fff'; ctx.shadowColor = '#fff'; ctx.shadowBlur = 10; };
    return {
        arrow: canvasTex((ctx, s) => { glow(ctx); arrowPath(ctx, s); ctx.fill(); }),
        star: canvasTex((ctx, s) => {
            glow(ctx); ctx.beginPath();
            for (let i = 0; i < 10; i++) {
                const r = i % 2 === 0 ? s * 0.4 : s * 0.17, a = -Math.PI / 2 + i * Math.PI / 5;
                ctx.lineTo(s / 2 + Math.cos(a) * r, s / 2 + Math.sin(a) * r);
            }
            ctx.closePath(); ctx.fill();
        }),
        flip: canvasTex((ctx, s) => {
            glow(ctx); arrowPath(ctx, s); ctx.fill();
            ctx.shadowBlur = 0; ctx.strokeStyle = '#2a0040'; ctx.lineWidth = s * 0.06;
            ctx.beginPath(); ctx.moveTo(s * 0.2, s * 0.8); ctx.lineTo(s * 0.8, s * 0.2); ctx.stroke();
        }),
        spark: canvasTex((ctx, s) => {
            const g = ctx.createRadialGradient(s / 2, s / 2, 0, s / 2, s / 2, s / 2);
            g.addColorStop(0, 'rgba(255,255,255,1)'); g.addColorStop(0.4, 'rgba(255,255,255,0.6)'); g.addColorStop(1, 'rgba(255,255,255,0)');
            ctx.fillStyle = g; ctx.fillRect(0, 0, s, s);
        }, 32),
    };
}

// ---------- renderer ----------
export class Renderer {
    constructor(container) {
        this.low = settings.get('effects') === 'low';
        this.renderer = new THREE.WebGLRenderer({ antialias: !this.low, powerPreference: 'high-performance' });
        this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, this.low ? 1 : 2));
        this.renderer.setSize(innerWidth, innerHeight);
        container.appendChild(this.renderer.domElement);
        this.canvas = this.renderer.domElement;

        this.scene = new THREE.Scene();
        this.bg = new THREE.Color(0x06060f);
        this.scene.background = this.bg;
        this.scene.fog = new THREE.Fog(0x06060f, 25, 62);
        this.camera = new THREE.PerspectiveCamera(60, innerWidth / innerHeight, 0.1, 200);
        this.camera.position.set(0, 0.4, 7.2);
        this.camera.lookAt(0, 0, -6);
        this.camBase = this.camera.position.clone();
        this.shake = 0;

        this.scene.add(new THREE.AmbientLight(0xffffff, 0.55));
        const key = new THREE.DirectionalLight(0xffffff, 1.1);
        key.position.set(2, 4, 6);
        this.scene.add(key);

        this.tex = makeTextures();
        this.geo = {
            box: new THREE.BoxGeometry(NOTE, NOTE, NOTE * 0.55),
            face: new THREE.PlaneGeometry(NOTE * 0.82, NOTE * 0.82),
            tail: new THREE.BoxGeometry(1, 1, 1),
            outline: new THREE.EdgesGeometry(new THREE.BoxGeometry(NOTE * 1.12, NOTE * 1.12, NOTE * 0.62)),
        };
        this.mats = {};
        for (const d of ['up', 'right', 'down', 'left', 'any']) {
            const c = new THREE.Color(DIR_COLORS[d]);
            this.mats[d] = new THREE.MeshStandardMaterial({ color: c, emissive: c, emissiveIntensity: 0.35, roughness: 0.35, metalness: 0.1 });
            this.mats[d + 'Tail'] = new THREE.MeshBasicMaterial({ color: c, transparent: true, opacity: 0.35, blending: THREE.AdditiveBlending, depthWrite: false });
        }
        const fc = new THREE.Color(FLIP_COLOR);
        this.mats.flip = new THREE.MeshStandardMaterial({ color: 0x1a0828, emissive: fc, emissiveIntensity: 0.5, roughness: 0.4 });
        this.mats.flipLine = new THREE.LineBasicMaterial({ color: FLIP_COLOR });
        this.mats.diagLine = new THREE.LineBasicMaterial({ color: 0xffffff });
        this.mats.arrow = new THREE.MeshBasicMaterial({ map: this.tex.arrow, transparent: true, depthWrite: false });
        this.mats.star = new THREE.MeshBasicMaterial({ map: this.tex.star, transparent: true, depthWrite: false });
        this.mats.flipFace = new THREE.MeshBasicMaterial({ map: this.tex.flip, transparent: true, depthWrite: false });

        this.buildTunnel();
        this.buildReceptor();
        this.buildSparks();
        this.pool = [];
        addEventListener('resize', () => this.resize());
    }

    resize() {
        this.camera.aspect = innerWidth / innerHeight;
        // keep the ring comfortably big on portrait phones
        this.camera.fov = this.camera.aspect < 0.8 ? 80 : 60;
        this.camera.updateProjectionMatrix();
        this.renderer.setSize(innerWidth, innerHeight);
    }

    buildTunnel() {
        const n = this.low ? 14 : 26;
        const shape = new THREE.EdgesGeometry(new THREE.PlaneGeometry(9, 6.2));
        this.tunnelMat = new THREE.LineBasicMaterial({ color: 0x7c5cff, transparent: true, opacity: 0.55 });
        this.frames = [];
        for (let i = 0; i < n; i++) {
            const f = new THREE.LineSegments(shape, this.tunnelMat);
            f.position.z = -i * (90 / n);
            this.scene.add(f);
            this.frames.push(f);
        }
        this.tunnelLen = 90;
        // floor lines for speed
        const lines = new THREE.BufferGeometry();
        const pts = [];
        for (const x of [-4.5, -1.5, 1.5, 4.5]) { pts.push(x, -3.1, 2, x, -3.1, -90); pts.push(x, 3.1, 2, x, 3.1, -90); }
        lines.setAttribute('position', new THREE.Float32BufferAttribute(pts, 3));
        this.rails = new THREE.LineSegments(lines, new THREE.LineBasicMaterial({ color: 0x3a2f7a }));
        this.scene.add(this.rails);

        if (!this.low) {
            const sg = new THREE.BufferGeometry();
            const sp = [];
            for (let i = 0; i < 400; i++) {
                const a = Math.random() * Math.PI * 2, r = 8 + Math.random() * 30;
                sp.push(Math.cos(a) * r, Math.sin(a) * r, -Math.random() * 120);
            }
            sg.setAttribute('position', new THREE.Float32BufferAttribute(sp, 3));
            this.stars = new THREE.Points(sg, new THREE.PointsMaterial({ color: 0x9aa0ff, size: 0.12, transparent: true, opacity: 0.8 }));
            this.scene.add(this.stars);
        }
    }

    buildReceptor() {
        const g = new THREE.Group();
        this.ringMat = new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.9 });
        this.ring = new THREE.Mesh(new THREE.TorusGeometry(1.25, 0.06, 8, 48), this.ringMat);
        g.add(this.ring);
        this.ringGlowMat = new THREE.MeshBasicMaterial({ color: 0x7c5cff, transparent: true, opacity: 0.25, blending: THREE.AdditiveBlending, depthWrite: false });
        this.ringGlow = new THREE.Mesh(new THREE.TorusGeometry(1.25, 0.22, 8, 48), this.ringGlowMat);
        g.add(this.ringGlow);
        // direction indicators that light up while held
        this.pads = {};
        const tri = new THREE.Shape();
        tri.moveTo(0, 0.32); tri.lineTo(0.3, -0.12); tri.lineTo(-0.3, -0.12); tri.closePath();
        const triGeo = new THREE.ShapeGeometry(tri);
        for (const d of ['up', 'right', 'down', 'left']) {
            const m = new THREE.MeshBasicMaterial({ color: DIR_COLORS[d], transparent: true, opacity: 0.28 });
            const mesh = new THREE.Mesh(triGeo, m);
            const a = DIR_ANGLE[d];
            mesh.position.set(-Math.sin(a) * 1.75, Math.cos(a) * 1.75, 0);
            mesh.rotation.z = a;
            g.add(mesh);
            this.pads[d] = { mesh, mat: m, flash: 0 };
        }
        this.receptor = g;
        this.scene.add(g);
        this.pulse = 0;
    }

    buildSparks() {
        const max = this.low ? 0 : 600;
        this.sparkMax = max;
        if (!max) return;
        this.sp = { pos: new Float32Array(max * 3), col: new Float32Array(max * 3), vel: new Float32Array(max * 3), base: new Float32Array(max * 3), life: new Float32Array(max), age: new Float32Array(max), next: 0, alive: 0 };
        for (let i = 0; i < max; i++) this.sp.pos[i * 3 + 2] = 100;
        const geo = new THREE.BufferGeometry();
        geo.setAttribute('position', new THREE.BufferAttribute(this.sp.pos, 3).setUsage(THREE.DynamicDrawUsage));
        geo.setAttribute('color', new THREE.BufferAttribute(this.sp.col, 3).setUsage(THREE.DynamicDrawUsage));
        this.sparks = new THREE.Points(geo, new THREE.PointsMaterial({ size: 0.28, map: this.tex.spark, vertexColors: true, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false }));
        this.sparks.frustumCulled = false;
        this.scene.add(this.sparks);
    }

    burst(color, count = 26) {
        if (!this.sparkMax) return;
        const c = new THREE.Color(color), s = this.sp;
        for (let k = 0; k < count; k++) {
            const i = s.next; s.next = (s.next + 1) % this.sparkMax;
            const o = i * 3, a = Math.random() * Math.PI * 2, sp = 3 + Math.random() * 5;
            s.pos[o] = Math.cos(a) * 1.2; s.pos[o + 1] = Math.sin(a) * 1.2; s.pos[o + 2] = 0;
            s.vel[o] = Math.cos(a) * sp; s.vel[o + 1] = Math.sin(a) * sp; s.vel[o + 2] = (Math.random() - 0.3) * 3;
            s.base[o] = c.r; s.base[o + 1] = c.g; s.base[o + 2] = c.b;
            s.age[i] = 0; s.life[i] = 0.35 + Math.random() * 0.25;
        }
        s.alive = this.sparkMax;
    }

    updateSparks(dt) {
        const s = this.sp;
        if (!s || !s.alive) return;
        let alive = 0;
        for (let i = 0; i < this.sparkMax; i++) {
            if (s.life[i] <= 0) continue;
            const o = i * 3;
            s.age[i] += dt;
            const f = 1 - s.age[i] / s.life[i];
            if (f <= 0) { s.life[i] = 0; s.col[o] = s.col[o + 1] = s.col[o + 2] = 0; s.pos[o + 2] = 100; continue; }
            alive++;
            s.vel[o] *= 0.92; s.vel[o + 1] *= 0.92;
            s.pos[o] += s.vel[o] * dt; s.pos[o + 1] += s.vel[o + 1] * dt; s.pos[o + 2] += s.vel[o + 2] * dt;
            s.col[o] = s.base[o] * f; s.col[o + 1] = s.base[o + 1] * f; s.col[o + 2] = s.base[o + 2] * f;
        }
        s.alive = alive;
        this.sparks.geometry.attributes.position.needsUpdate = true;
        this.sparks.geometry.attributes.color.needsUpdate = true;
    }

    theme(hex) {
        const c = new THREE.Color(hex);
        this.tunnelMat.color.copy(c);
        this.ringGlowMat.color.copy(c);
        this.bg.copy(c).multiplyScalar(0.012);   // linear space: keep the tint subtle
        this.scene.fog.color.copy(this.bg);
    }

    // ----- note visuals (pooled) -----
    acquire(n) {
        let v = this.pool.pop();
        if (!v) {
            const group = new THREE.Group();
            const body = new THREE.Mesh(this.geo.box, this.mats.up);
            const face = new THREE.Mesh(this.geo.face, this.mats.arrow);
            face.position.z = NOTE * 0.28 + 0.01;
            const outline = new THREE.LineSegments(this.geo.outline, this.mats.flipLine);
            const tail = new THREE.Mesh(this.geo.tail, this.mats.upTail);
            group.add(body, face, outline);
            v = { group, body, face, outline, tail };
        }
        const flip = !!n.flip, diag = !!n.d2;
        v.body.material = flip ? this.mats.flip : this.mats[n.d] || this.mats.any;
        v.face.material = n.d === 'any' ? this.mats.star : flip ? this.mats.flipFace : this.mats.arrow;
        let ang = DIR_ANGLE[n.d] ?? 0;
        if (diag) {
            // average the two directions (shortest way round)
            let b = DIR_ANGLE[n.d2];
            if (Math.abs(b - ang) > Math.PI) b += b < ang ? Math.PI * 2 : -Math.PI * 2;
            ang = (ang + b) / 2;
        }
        v.face.rotation.z = n.d === 'any' ? 0 : ang;
        v.outline.visible = flip || diag;
        v.outline.material = flip ? this.mats.flipLine : this.mats.diagLine;
        v.group.scale.setScalar(1);
        v.group.visible = true;
        this.scene.add(v.group);
        if (n.hold) {
            v.tail.material = this.mats[(n.d === 'any' ? 'any' : n.d) + 'Tail'];
            this.scene.add(v.tail);
        }
        return v;
    }

    release(v) {
        this.scene.remove(v.group);
        this.scene.remove(v.tail);
        this.pool.push(v);
    }

    // state: null in menus (ring hidden, slow drift), {approach, frozen?} in game
    update(dt, state) {
        this.receptor.visible = !!state;
        // tunnel scroll speed follows note speed
        const speed = !state ? 6 : state.frozen ? 0 : -SPAWN_Z / state.approach;
        for (const f of this.frames) {
            f.position.z += speed * dt;
            if (f.position.z > 4) f.position.z -= this.tunnelLen;
        }
        if (this.stars) {
            this.stars.position.z += speed * 0.3 * dt;
            if (this.stars.position.z > 60) this.stars.position.z -= 60;
        }
        // beat pulse + held pads
        this.pulse *= Math.pow(0.02, dt);
        const p = 1 + this.pulse * 0.12;
        this.ring.scale.setScalar(p);
        this.ringGlow.scale.setScalar(p);
        this.ringGlowMat.opacity = 0.2 + this.pulse * 0.5;
        this.tunnelMat.opacity = 0.4 + this.pulse * 0.4;
        for (const d in this.pads) {
            const pd = this.pads[d];
            pd.flash *= Math.pow(0.001, dt);
            pd.mat.opacity = input.held[d] ? 0.95 : 0.28 + pd.flash * 0.6;
        }
        this.updateSparks(dt);
        // shake
        this.shake *= Math.pow(0.001, dt);
        this.camera.position.set(
            this.camBase.x + (Math.random() - 0.5) * this.shake,
            this.camBase.y + (Math.random() - 0.5) * this.shake,
            this.camBase.z);
        this.renderer.render(this.scene, this.camera);
    }
}

// ---------- gameplay ----------
export class Game {
    /**
     * session: {title, subtitle, notes, approach | approachAt(t), buffer, loop, beats[], theme,
     *           mode: 'level'|'custom'|'endless'|'classic', practice?:bool}
     */
    constructor(renderer, session, hooks) {
        this.r = renderer;
        this.s = session;
        this.hooks = hooks;      // {onEnd(results), onPause()}
        const len = settings.get('leniency') === 'relaxed' ? 1.4 : 1;
        this.W = { perfect: BASE_WINDOWS.perfect * len, great: BASE_WINDOWS.great * len, good: BASE_WINDOWS.good * len };
        this.notes = session.notes.map((n, i) => ({ ...n, i, judged: false, v: null }));
        this.spawnIdx = 0;
        this.judgeIdx = 0;
        this.live = [];
        this.holding = [];
        this.beatIdx = 0;
        this.score = 0; this.combo = 0; this.maxCombo = 0;
        this.counts = { perfect: 0, great: 0, good: 0, miss: 0, wrong: 0, holdOk: 0, holdBreak: 0 };
        this.accSum = 0; this.accMax = 0;
        this.health = 1;
        this.offsets = [];
        this.finished = false;
        this.paused = false;
        this.failed = false;
        this.speedMul = settings.get('scrollSpeed') || 1;
        this.lastNoteEnd = this.notes.length ? Math.max(...this.notes.map(n => n.t + (n.hold || 0))) : 0;
        this.$ = (id) => document.getElementById(id);
        this.r.theme(session.theme || '#7c5cff');
        this.hud(true);

        input.onPress = (dir, ms) => this.press(dir, ms);
        input.onRelease = (dir, ms) => this.releaseKey(dir, ms);
        input.onPause = () => hooks.onPause && hooks.onPause();
        input.enabled = true;
        audio.onEnded = () => { if (!this.s.loop) this.finish(false); };
        audio.userOffset = (settings.get('offsetMs') || 0) / 1000;
        audio.start(session.buffer, session.leadIn ?? -1.6, !!session.loop);
        // the rest of a progressively rendered song joins when it's ready
        if (session.rest) {
            session.rest.then(({ buffer, at }) => { if (!this.finished && !this.destroyed) audio.addPart(buffer, at); })
                .catch(err => console.error('Song render failed:', err));
        }
    }

    approachAt(t) {
        const a = this.s.approachAt ? this.s.approachAt(t) : this.s.approach;
        return a / this.speedMul;
    }

    required(n) {
        if (n.d === 'any') return null;                 // anything goes
        if (n.flip) return [OPPOSITE[n.d]];
        if (n.d2) return [n.d, n.d2];
        return [n.d];
    }

    accepts(n, dir) {
        if (n.d === 'any') return true;
        if (dir === 'tap') return false;
        return this.required(n).includes(dir);
    }

    press(dir, ms) {
        if (this.paused || this.finished) return;
        const t = audio.timeAt(ms);
        if (dir !== 'tap' && this.r.pads[dir]) this.r.pads[dir].flash = 1;
        const W = this.W;
        let best = null, bestAbs = Infinity, first = null;
        for (let i = this.judgeIdx; i < this.notes.length; i++) {
            const n = this.notes[i];
            if (n.t - t > W.good) break;
            if (n.judged || t - n.t > W.good) continue;
            if (!first) first = n;
            const a = Math.abs(n.t - t);
            if (this.accepts(n, dir) && a < bestAbs) { best = n; bestAbs = a; }
        }
        if (best) {
            if (best.d2 && !best.flip) {
                // diagonal: both keys within a short window; judge on the second
                best.partial = best.partial || { dirs: new Set(), t };
                best.partial.dirs.add(dir);
                if (best.partial.dirs.size >= 2) this.judge(best, ((best.partial.t + t) / 2) - best.t);
                else if (Math.abs(t - best.partial.t) > 0.15) best.partial = { dirs: new Set([dir]), t };
                return;
            }
            this.judge(best, t - best.t);
        } else if (first && dir !== 'tap' && Math.abs(first.t - t) <= W.great && !(first.partial)) {
            this.judge(first, 'wrong');
        }
    }

    releaseKey(dir, ms) {
        if (this.paused || this.finished) return;
        const t = audio.timeAt(ms);
        for (const n of this.holding) {
            const req = this.required(n);
            const stillHeld = req ? req.some(d => input.held[d]) : Object.values(input.held).some(Boolean);
            if (!stillHeld && t < n.t + n.hold - 0.12) this.endHold(n, false);
        }
    }

    judge(n, offset) {
        n.judged = true;
        while (this.judgeIdx < this.notes.length && this.notes[this.judgeIdx].judged) this.judgeIdx++;
        if (offset === 'miss' || offset === 'wrong') {
            this.counts[offset]++;
            this.combo = 0;
            this.accMax += 1 + (n.hold ? 1 : 0);
            this.health -= offset === 'wrong' ? 0.06 : 0.08;
            this.popup(offset === 'wrong' ? 'WRONG' : 'MISS', '#ff5a7a');
            audio.miss();
            this.r.shake = 0.18;
            n.missedAt = audio.time;
            this.hud();
            this.checkFail();
            return;
        }
        const a = Math.abs(offset);
        const kind = a <= this.W.perfect ? 'perfect' : a <= this.W.great ? 'great' : 'good';
        this.counts[kind]++;
        this.combo++;
        this.maxCombo = Math.max(this.maxCombo, this.combo);
        this.score += POINTS[kind] * this.multiplier;
        this.accSum += ACC_VALUE[kind];
        this.accMax += 1;
        this.offsets.push(offset);
        this.health = Math.min(1, this.health + (kind === 'perfect' ? 0.02 : kind === 'great' ? 0.014 : 0.006));
        this.popup(kind.toUpperCase(), kind === 'perfect' ? '#ffd76a' : kind === 'great' ? '#7fffd4' : '#9fb7ff',
            kind === 'perfect' ? '' : offset < 0 ? 'EARLY' : 'LATE');
        audio.hit(kind);
        this.r.burst(n.flip ? FLIP_COLOR : DIR_COLORS[n.d] ?? 0xffffff, kind === 'perfect' ? 30 : 18);
        this.r.pulse = Math.max(this.r.pulse, 0.6);
        if (n.hold) {
            n.holdStart = audio.time;
            this.holding.push(n);
        } else if (n.v) {
            this.r.release(n.v); n.v = null;
        }
        if (this.combo > 0 && this.combo % 50 === 0) this.popupCombo(this.combo);
        this.hud();
    }

    endHold(n, ok) {
        const i = this.holding.indexOf(n);
        if (i >= 0) this.holding.splice(i, 1);
        this.accMax += 1;
        if (ok) {
            this.counts.holdOk++;
            this.accSum += 1;
            this.score += 100 * this.multiplier;
            this.r.burst(DIR_COLORS[n.d] ?? 0xffffff, 16);
            audio.hit('great');
        } else {
            this.counts.holdBreak++;
            this.combo = 0;
            this.health -= 0.05;
            this.popup('BREAK', '#ff8a5a');
            audio.miss();
            this.checkFail();
        }
        if (n.v) { this.r.release(n.v); n.v = null; }
        this.hud();
    }

    get multiplier() { return 1 + Math.min(4, Math.floor(this.combo / 10)) * 0.5; }
    get accuracy() { return this.accMax ? this.accSum / this.accMax : 1; }

    checkFail() {
        if (this.health > 0) return;
        this.health = 0;
        if (this.s.mode === 'endless' || this.s.mode === 'classic') { this.finish(true); return; }
        if (!settings.get('noFail')) this.finish(true);
    }

    update(dt) {
        if (this.paused || this.finished) { this.r.update(dt, { approach: 1, frozen: true }); return; }
        const t = audio.time;
        const W = this.W;

        // beat pulse
        const beats = this.s.beats;
        if (beats && beats.length) {
            const period = this.s.loop ? this.s.loopDuration : Infinity;
            const lt = this.s.loop ? ((t % period) + period) % period : t;
            if (this.s.loop && this.beatIdx > 0 && lt < beats[Math.max(0, this.beatIdx - 1)].t - 0.5) this.beatIdx = 0;
            while (this.beatIdx < beats.length && beats[this.beatIdx].t <= lt) {
                this.r.pulse = beats[this.beatIdx].down ? 1 : 0.55;
                this.beatIdx++;
            }
        }

        // misses
        for (let i = this.judgeIdx; i < this.notes.length; i++) {
            const n = this.notes[i];
            if (n.t > t) break;
            if (!n.judged && t - n.t > W.good) this.judge(n, 'miss');
        }
        // holds
        for (let i = this.holding.length - 1; i >= 0; i--) {
            const n = this.holding[i];
            if (t >= n.t + n.hold) { this.endHold(n, true); continue; }
            const req = this.required(n);
            const held = req ? req.some(d => input.held[d]) : Object.values(input.held).some(Boolean);
            if (!held && t - n.holdStart > 0.1) this.endHold(n, false);
        }

        // spawn visuals
        while (this.spawnIdx < this.notes.length && this.notes[this.spawnIdx].t - t < this.approachAt(this.notes[this.spawnIdx].t) * 1.02) {
            const n = this.notes[this.spawnIdx++];
            if (!n.judged) { n.v = this.r.acquire(n); this.live.push(n); }
        }
        // position visuals
        for (let i = this.live.length - 1; i >= 0; i--) {
            const n = this.live[i];
            if (!n.v) { this.live.splice(i, 1); continue; }
            const ap = this.approachAt(n.t);
            const zOf = (time) => SPAWN_Z * (time - t) / ap;
            const holdingNow = this.holding.includes(n);
            let z = holdingNow ? 0 : zOf(n.t);
            const v = n.v;
            v.group.position.z = z;
            // fade in from the fog / fade out after a miss
            if (n.missedAt != null) {
                const k = Math.max(0, 1 - (t - n.missedAt) / 0.35);
                v.group.scale.setScalar(0.6 + 0.4 * k);
                if (k <= 0 || z > 6) { this.r.release(v); n.v = null; this.live.splice(i, 1); continue; }
            }
            if (n.hold) {
                const tailEnd = zOf(n.t + n.hold);
                const head = Math.min(z, 0);
                const len = Math.max(0.01, head - tailEnd);
                v.tail.visible = len > 0.05;
                v.tail.scale.set(0.5, 0.5, len);
                v.tail.position.set(0, 0, head - len / 2);
                if (n.missedAt != null) v.tail.visible = false;
            }
        }

        this.progress(t);
        // end of a normal level
        if (!this.s.loop && t > this.lastNoteEnd + 1.2 && this.judgeIdx >= this.notes.length && !this.holding.length) {
            this.finish(false);
        }
        this.r.update(dt, { approach: this.approachAt(t) });
    }

    progress(t) {
        const total = this.s.loop ? null : Math.max(1, audio.duration);
        const el = this.$('hud-progress-fill');
        if (total) {
            const p = Math.max(0, Math.min(1, t / total));
            if (Math.abs(p - (this._p || 0)) > 0.002) { this._p = p; el.style.transform = `scaleX(${p})`; }
        } else {
            this.$('hud-time').textContent = t > 0 ? `${Math.floor(t / 60)}:${String(Math.floor(t % 60)).padStart(2, '0')}` : '';
        }
    }

    popup(text, color, sub = '') {
        const el = this.$('judgement');
        el.textContent = text;
        el.style.color = color;
        el.classList.remove('show'); void el.offsetWidth; el.classList.add('show');
        const s = this.$('judgement-sub');
        s.textContent = sub;
        s.classList.remove('show'); void s.offsetWidth; if (sub) s.classList.add('show');
    }

    popupCombo(c) {
        const el = this.$('combo-burst');
        el.textContent = `${c} COMBO!`;
        el.classList.remove('show'); void el.offsetWidth; el.classList.add('show');
    }

    hud(force = false) {
        const set = (id, v) => { const el = this.$(id); if (force || el.textContent !== v) el.textContent = v; };
        set('hud-score', Math.round(this.score).toLocaleString());
        set('hud-combo', this.combo ? String(this.combo) : '');
        set('hud-mult', `x${this.multiplier.toFixed(1)}`);
        set('hud-acc', (this.accuracy * 100).toFixed(2) + '%');
        const h = this.$('hud-health-fill');
        h.style.transform = `scaleX(${Math.max(0, this.health).toFixed(3)})`;
        h.classList.toggle('low', this.health < 0.3);
        this.$('hud-combo-label').style.opacity = this.combo ? 1 : 0;
    }

    pause() {
        if (this.finished || this.paused) return;
        this.paused = true;
        audio.pause();
        input.releaseAll();
    }

    resume() {
        if (!this.paused) return;
        this.paused = false;
        audio.resume();
    }

    finish(failed) {
        if (this.finished) return;
        this.finished = true;
        this.failed = failed;
        input.enabled = false;
        input.onPress = input.onRelease = input.onPause = null;
        audio.onEnded = null;
        // anything still pending counts as missed
        if (!this.s.loop) {
            for (const n of this.notes) if (!n.judged) { n.judged = true; this.counts.miss++; this.accMax += 1 + (n.hold ? 1 : 0); }
        }
        for (const n of this.holding.slice()) this.endHold(n, false);
        setTimeout(() => audio.stop(), failed ? 0 : 400);
        const acc = this.accuracy;
        const misses = this.counts.miss + this.counts.wrong + this.counts.holdBreak;
        const grade = failed && this.s.mode !== 'endless' && this.s.mode !== 'classic' ? 'F'
            : acc >= 0.98 && misses === 0 ? 'SS' : acc >= 0.94 ? 'S' : acc >= 0.88 ? 'A' : acc >= 0.8 ? 'B' : acc >= 0.7 ? 'C' : 'D';
        const offs = this.offsets;
        const mean = offs.length ? offs.reduce((a, b) => a + b, 0) / offs.length : 0;
        const sd = offs.length ? Math.sqrt(offs.reduce((a, b) => a + (b - mean) ** 2, 0) / offs.length) : 0;
        const results = {
            score: Math.round(this.score), accuracy: acc, grade, failed,
            maxCombo: this.maxCombo, counts: { ...this.counts }, misses,
            meanOffsetMs: mean * 1000, spreadMs: sd * 1000, offsets: offs.slice(-400),
            survived: audio.time, notesHit: this.counts.perfect + this.counts.great + this.counts.good,
        };
        setTimeout(() => {
            for (const n of this.live) if (n.v) { this.r.release(n.v); n.v = null; }
            this.live = [];
            this.hooks.onEnd(results);
        }, failed ? 900 : 700);
    }

    destroy() {
        this.finished = true;
        this.destroyed = true;
        input.enabled = false;
        input.onPress = input.onRelease = input.onPause = null;
        audio.onEnded = null;
        audio.stop();
        for (const n of this.live) if (n.v) { this.r.release(n.v); n.v = null; }
        this.live = [];
    }
}
