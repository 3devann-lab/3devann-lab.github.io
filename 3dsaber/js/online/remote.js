// ============ Other players in a match: their sabers, head and name, beside you ============
import * as THREE from 'three';
import { HIT_Z } from '../game.js';

const BLADE = 1.05;
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
    constructor(parent, name, seatX, colors) {
        this.group = new THREE.Group();
        this.group.position.set(seatX, 0, HIT_Z);
        this.group.rotation.y = -Math.atan2(seatX, 9) * 0.6;       // turned a little toward the track
        parent.add(this.group);
        this.disposables = [];
        this.sabers = colors.map((col) => {
            const s = new THREE.Group();
            const handle = new THREE.Mesh(new THREE.CylinderGeometry(0.03, 0.036, 0.22, 8), new THREE.MeshBasicMaterial({ color: 0x2a2a3a }));
            const blade = new THREE.Mesh(new THREE.CylinderGeometry(0.024, 0.018, BLADE, 8),
                new THREE.MeshBasicMaterial({ color: new THREE.Color(col).multiplyScalar(1.6) }));
            blade.position.y = 0.13 + BLADE / 2;
            const glow = new THREE.Mesh(new THREE.CylinderGeometry(0.06, 0.045, BLADE, 8),
                new THREE.MeshBasicMaterial({ color: col, transparent: true, opacity: 0.18, blending: THREE.AdditiveBlending, depthWrite: false }));
            glow.position.y = blade.position.y;
            s.add(handle, blade, glow);
            s.visible = false;
            this.group.add(s);
            for (const m of [handle, blade, glow]) this.disposables.push(m.geometry, m.material);
            return s;
        });
        const head = new THREE.Mesh(new THREE.SphereGeometry(0.13, 16, 12), new THREE.MeshBasicMaterial({ color: 0xcfd6ff, transparent: true, opacity: 0.85 }));
        head.position.set(0, 1.72, 0.55);
        const visor = new THREE.Mesh(new THREE.BoxGeometry(0.2, 0.06, 0.05), new THREE.MeshBasicMaterial({ color: 0x7c5cff }));
        visor.position.set(0, 1.74, 0.43);
        const pad = new THREE.Mesh(new THREE.RingGeometry(0.42, 0.5, 40).rotateX(-Math.PI / 2), new THREE.MeshBasicMaterial({ color: 0x7c5cff, transparent: true, opacity: 0.45, side: THREE.DoubleSide, depthWrite: false }));
        pad.position.set(0, 0.02, 0.45);
        this.group.add(head, visor, pad);
        for (const m of [head, visor, pad]) this.disposables.push(m.geometry, m.material);
        this.labelMat = new THREE.SpriteMaterial({ map: nameTexture(name), transparent: true, depthWrite: false });
        this.label = new THREE.Sprite(this.labelMat);
        this.label.scale.set(1.3, 0.325, 1);
        this.label.position.set(0, 2.25, 0.55);
        this.group.add(this.label);
        this.name = name;
        this.scoreText = '';
        this.frames = [];        // [{t, l, r}] newest last
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

    update(now) {
        const f = this.frames;
        if (!f.length) return;
        const t = now - DELAY * 1000;
        let a = f[0], b = f[0];
        for (let i = 0; i < f.length - 1; i++) { if (f[i + 1].t >= t) { a = f[i]; b = f[i + 1]; break; } a = b = f[i + 1]; }
        const k = b.t > a.t ? Math.min(1, Math.max(0, (t - a.t) / (b.t - a.t))) : 1;
        this.apply(this.sabers[0], a.l, b.l, k);
        this.apply(this.sabers[1], a.r, b.r, k);
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
        this.labelMat.map.dispose();
        this.labelMat.dispose();
    }
}

const _qa = new THREE.Quaternion(), _qb = new THREE.Quaternion();

export class RemotePlayers {
    constructor(scene, colors) {
        this.root = new THREE.Group();
        this.root.name = 'remote-players';
        scene.add(this.root);
        this.colors = colors;
        this.avatars = new Map();     // uid -> Avatar
    }

    // players: [{uid, name}] (not you); seats follow the order given
    setPlayers(players) {
        const keep = new Set(players.map(p => p.uid));
        for (const [uid, av] of this.avatars) if (!keep.has(uid)) { av.dispose(); this.avatars.delete(uid); }
        players.forEach((p, i) => {
            if (!this.avatars.has(p.uid) && i < SEATS.length) this.avatars.set(p.uid, new Avatar(this.root, p.name || 'Player', SEATS[i], this.colors));
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

    update(now) { for (const av of this.avatars.values()) av.update(now); }

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
