// ============ Other players in a match: their avatar, sabers and name, beside you ============
// (you never see your own avatar — you play from behind your sabers)
import * as THREE from 'three';
import { HIT_Z } from '../game.js';
import { buildSaber, buildAvatar, cleanSaber } from '../looks.js';

// seats left and right of your own spot, closest first
const SEATS = [-2.9, 2.9, -5.4, 5.4, -7.9, 7.9, -10.4, 10.4, -12.9];
const DELAY = 0.15;              // seconds behind live, so there's always a pose to blend toward

function nameTexture(text, score = '') {
    const c = document.createElement('canvas');
    c.width = 512; c.height = 128;
    const g = c.getContext('2d');
    g.fillStyle = 'rgba(10,10,24,0.72)';
    g.beginPath(); g.roundRect(8, 8, 496, 112, 26); g.fill();
    g.fillStyle = '#ffffff';
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    g.font = '700 50px Rajdhani, "Segoe UI", sans-serif';
    g.fillText(text.slice(0, 18), 256, score ? 46 : 64);
    if (score) { g.font = '600 34px Rajdhani, "Segoe UI", sans-serif'; g.fillStyle = '#ffd76a'; g.fillText(score, 256, 94); }
    const t = new THREE.CanvasTexture(c);
    t.colorSpace = THREE.SRGBColorSpace;
    return t;
}

class Avatar {
    // player: {name, look: {avatar, saber}} — their own avatar and sabers, in their colours
    constructor(parent, player, seatX) {
        const look = player.look || {};
        const saber = cleanSaber(look.saber);
        this.group = new THREE.Group();
        this.group.position.set(seatX, 0, HIT_Z);
        this.group.rotation.y = -Math.atan2(seatX, 9) * 0.6;       // turned a little toward the track
        parent.add(this.group);
        this.disposables = [];
        this.models = [saber.left, saber.right].map((col) => {
            const m = buildSaber(col, saber);
            m.group.visible = false;
            this.group.add(m.group);
            return m;
        });
        this.sabers = this.models.map(m => m.group);
        // the character stands just behind its sabers
        this.avatar = buildAvatar(look.avatar);
        this.avatar.root.position.set(0, 0, 0.62);
        this.group.add(this.avatar.root);
        const pad = new THREE.Mesh(new THREE.RingGeometry(0.42, 0.5, 40).rotateX(-Math.PI / 2), new THREE.MeshBasicMaterial({ color: saber.right, transparent: true, opacity: 0.4, side: THREE.DoubleSide, depthWrite: false }));
        pad.position.set(0, 0.02, 0.5);
        this.group.add(pad);
        this.disposables.push(pad.geometry, pad.material);
        this.name = player.name || 'Player';
        this.labelMat = new THREE.SpriteMaterial({ map: nameTexture(this.name), transparent: true, depthWrite: false });
        this.label = new THREE.Sprite(this.labelMat);
        this.label.scale.set(1.3, 0.325, 1);
        this.label.position.set(0, 2.32, 0.62);
        this.group.add(this.label);
        this.scoreText = '';
        this.frames = [];        // [{t, l, r}] newest last
        this.t = Math.random() * 10;
    }

    setScore(text) {
        if (text === this.scoreText) return;
        this.scoreText = text;
        const old = this.labelMat.map;
        this.labelMat.map = nameTexture(this.name, text);
        this.labelMat.needsUpdate = true;
        old.dispose();
    }

    push(p) {
        if (!p || !p.l || !p.r || !Number.isFinite(p.t)) return;
        const last = this.frames[this.frames.length - 1];
        if (last && p.t <= last.t) return;
        this.frames.push(p);
        if (this.frames.length > 12) this.frames.shift();
    }

    update(now, dt = 0.016) {
        // the character bobs a little and leans toward where its sabers are
        this.t += dt;
        const a = this.avatar;
        const lean = this.sabers[0].visible ? (this.sabers[0].position.x + this.sabers[1].position.x) * 0.25 : 0;
        a.head.position.x += (lean - a.head.position.x) * Math.min(1, dt * 4);
        a.head.position.y = 1.68 + Math.sin(this.t * 3.1) * 0.015;
        a.head.rotation.z = -a.head.position.x * 0.6;
        a.body.position.x = a.head.position.x * 0.45;
        const f = this.frames;
        if (!f.length) return;
        const t = now - DELAY * 1000;
        let fa = f[0], fb = f[0];
        for (let i = 0; i < f.length - 1; i++) { if (f[i + 1].t >= t) { fa = f[i]; fb = f[i + 1]; break; } fa = fb = f[i + 1]; }
        const k = fb.t > fa.t ? Math.min(1, Math.max(0, (t - fa.t) / (fb.t - fa.t))) : 1;
        this.apply(this.sabers[0], fa.l, fb.l, k);
        this.apply(this.sabers[1], fa.r, fb.r, k);
    }

    apply(s, A, B, k) {
        s.visible = true;
        s.position.set(A[0] + (B[0] - A[0]) * k, A[1] + (B[1] - A[1]) * k, A[2] + (B[2] - A[2]) * k);
        _qa.set(A[3], A[4], A[5], A[6]).normalize();
        _qb.set(B[3], B[4], B[5], B[6]).normalize();
        s.quaternion.copy(_qa).slerp(_qb, k);
    }

    dispose() {
        this.group.removeFromParent();
        for (const d of this.disposables) d.dispose();
        for (const m of this.models) m.dispose();
        this.avatar.dispose();
        this.labelMat.map.dispose();
        this.labelMat.dispose();
    }
}

const _qa = new THREE.Quaternion(), _qb = new THREE.Quaternion();

export class RemotePlayers {
    constructor(scene) {
        this.root = new THREE.Group();
        this.root.name = 'remote-players';
        scene.add(this.root);
        this.avatars = new Map();     // uid -> Avatar
        this._last = performance.now();
    }

    // players: [{uid, name, look}] (not you); seats follow the order given
    setPlayers(players) {
        const keep = new Set(players.map(p => p.uid));
        for (const [uid, av] of this.avatars) if (!keep.has(uid)) { av.dispose(); this.avatars.delete(uid); }
        players.forEach((p, i) => {
            if (!this.avatars.has(p.uid) && i < SEATS.length) this.avatars.set(p.uid, new Avatar(this.root, p, SEATS[i]));
        });
    }

    pushPoses(poses) {
        for (const [uid, p] of Object.entries(poses || {})) {
            const av = this.avatars.get(uid);
            if (av) av.push(p);
        }
    }

    setScores(scores) {
        for (const [uid, text] of Object.entries(scores)) { const av = this.avatars.get(uid); if (av) av.setScore(text); }
    }

    update(now) {
        const t = performance.now(), dt = Math.min(0.1, (t - this._last) / 1000);
        this._last = t;
        for (const av of this.avatars.values()) av.update(now, dt);
    }

    dispose() {
        for (const av of this.avatars.values()) av.dispose();
        this.avatars.clear();
        this.root.removeFromParent();
    }
}

// your own sabers, compact for the network: [x, y, z, qx, qy, qz, qw] in the hand rig
export function saberPose(saber) {
    const p = saber.group.position, q = saber.group.quaternion;
    const r = (v) => Math.round(v * 1000) / 1000;
    return [r(p.x), r(p.y), r(p.z), r(q.x), r(q.y), r(q.z), r(q.w)];
}
