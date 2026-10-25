// ============ Your look: saber styles and a little avatar ============
// Shared by the game (your sabers), Settings → Customize (the preview) and
// multiplayer (other players' sabers and avatars). Everything here only
// changes how things look — saber hits use the same blade whatever the style.
import * as THREE from 'three';

export const BLADE_LEN = 1.05;          // same as game.js
const BLADE_BASE = 0.14;                // where the blade leaves the hilt

export const SABER_STYLES = [['classic', 'Classic'], ['beam', 'Beam'], ['katana', 'Katana'], ['pixel', 'Pixel'], ['crystal', 'Crystal']];
export const SABER_HILTS = [['standard', 'Standard'], ['long', 'Long'], ['guard', 'Cross Guard'], ['ring', 'Ring']];

export const AVATAR_OPTIONS = {
    head: [['round', 'Round'], ['square', 'Square'], ['tall', 'Tall']],
    eyes: [['dots', 'Dots'], ['happy', 'Happy'], ['big', 'Big'], ['visor', 'Visor'], ['robot', 'Robot'], ['sleepy', 'Sleepy']],
    mouth: [['smile', 'Smile'], ['grin', 'Grin'], ['flat', 'Flat'], ['open', 'Open'], ['none', 'None']],
    hat: [['none', 'None'], ['cap', 'Cap'], ['beanie', 'Beanie'], ['crown', 'Crown'], ['headphones', 'Headphones'], ['horns', 'Horns'],
        ['halo', 'Halo'], ['antenna', 'Antenna'], ['spiky', 'Spiky Hair'], ['bun', 'Bun']],
    glasses: [['none', 'None'], ['round', 'Round'], ['shades', 'Shades']],
    body: [['hoodie', 'Hoodie'], ['robot', 'Robot'], ['slim', 'Slim']],
};
export const SKIN_TONES = ['#f6d3b3', '#e8b48f', '#c98b5e', '#9a6240', '#6b4129', '#3f2a1d', '#9fe7ff', '#b9a6ff', '#7dffb0'];
export const PALETTE = ['#ff2d55', '#ff8a2d', '#ffd76a', '#3dffa0', '#2dd4bf', '#2d7dff', '#7c5cff', '#ff6fd8', '#ffffff', '#2a2a3a'];

export const DEFAULT_AVATAR = {
    head: 'round', skin: '#f6d3b3', eyes: 'dots', mouth: 'smile', hat: 'none', glasses: 'none',
    body: 'hoodie', bodyColor: '#7c5cff', accent: '#ffd76a',
};

// ---------- checking looks (other players' come from the network) ----------
const isColor = (c) => /^#[0-9a-f]{6}$/i.test(String(c || ''));
const pick = (list, v, fallback) => (list.some(([k]) => k === v) ? v : fallback);

export function cleanAvatar(a) {
    a = a && typeof a === 'object' ? a : {};
    const d = DEFAULT_AVATAR, o = AVATAR_OPTIONS;
    return {
        head: pick(o.head, a.head, d.head), skin: isColor(a.skin) ? a.skin : d.skin,
        eyes: pick(o.eyes, a.eyes, d.eyes), mouth: pick(o.mouth, a.mouth, d.mouth),
        hat: pick(o.hat, a.hat, d.hat), glasses: pick(o.glasses, a.glasses, d.glasses),
        body: pick(o.body, a.body, d.body), bodyColor: isColor(a.bodyColor) ? a.bodyColor : d.bodyColor,
        accent: isColor(a.accent) ? a.accent : d.accent,
    };
}

export function cleanSaber(s) {
    s = s && typeof s === 'object' ? s : {};
    const glow = Number(s.glow);
    return {
        style: pick(SABER_STYLES, s.style, 'classic'), hilt: pick(SABER_HILTS, s.hilt, 'standard'),
        glow: Number.isFinite(glow) ? Math.max(0, Math.min(2, glow)) : 1,
        left: isColor(s.left) ? s.left : '#ff2d55', right: isColor(s.right) ? s.right : '#2d7dff',
    };
}

// what other players see of you
export function myLook(settings) {
    return {
        avatar: cleanAvatar(settings.get('avatar')),
        saber: cleanSaber({
            style: settings.get('saberStyle'), hilt: settings.get('saberHilt'), glow: settings.get('saberGlow'),
            left: settings.get('leftColor'), right: settings.get('rightColor'),
        }),
    };
}

export function randomAvatar() {
    const r = (list) => list[Math.floor(Math.random() * list.length)];
    const o = AVATAR_OPTIONS;
    return cleanAvatar({
        head: r(o.head)[0], skin: r(SKIN_TONES), eyes: r(o.eyes)[0], mouth: r(o.mouth)[0], hat: r(o.hat)[0],
        glasses: Math.random() < 0.3 ? r(o.glasses)[0] : 'none', body: r(o.body)[0], bodyColor: r(PALETTE), accent: r(PALETTE),
    });
}

// ---------- 3D: a saber ----------
// Hilt at the origin, blade up +y — the same frame as the game's sabers.
// Returns { group, dispose() }.
export function buildSaber(colorHex, look) {
    const s = cleanSaber(look);
    const color = new THREE.Color(colorHex);
    const group = new THREE.Group();
    const trash = [];
    const add = (geo, mat, y = 0, parent = group) => {
        const m = new THREE.Mesh(geo, mat);
        m.position.y = y;
        parent.add(m);
        trash.push(geo, mat);
        return m;
    };
    const metal = () => new THREE.MeshStandardMaterial({ color: 0x222230, roughness: 0.4, metalness: 0.9 });
    const lit = (k = 0.7) => new THREE.MeshStandardMaterial({ color: 0x111118, emissive: color, emissiveIntensity: k, roughness: 0.5 });
    const glowMat = (opacity) => new THREE.MeshBasicMaterial({
        color, transparent: true, opacity: Math.min(1, opacity), blending: THREE.AdditiveBlending, depthWrite: false,
    });

    // hilt
    if (s.hilt === 'long') {
        add(new THREE.CylinderGeometry(0.034, 0.04, 0.38, 12), metal(), -0.07);
        add(new THREE.CylinderGeometry(0.044, 0.044, 0.02, 12), lit(), 0.1);
        add(new THREE.CylinderGeometry(0.044, 0.044, 0.02, 12), lit(), -0.22);
    } else {
        add(new THREE.CylinderGeometry(0.035, 0.042, 0.24, 12), metal(), 0);
        add(new THREE.CylinderGeometry(0.046, 0.046, 0.018, 12), lit(), 0.105);
        if (s.hilt === 'guard') {
            const g = add(new THREE.BoxGeometry(0.22, 0.03, 0.05), metal(), 0.125);
            add(new THREE.BoxGeometry(0.2, 0.012, 0.055), lit(1.2), 0.0, g);
        } else if (s.hilt === 'ring') {
            const ring = add(new THREE.TorusGeometry(0.07, 0.011, 8, 24), lit(1.4), 0.08);
            ring.rotation.x = Math.PI / 2;
        }
    }

    // blade (from BLADE_BASE to the tip)
    const mid = BLADE_BASE + BLADE_LEN / 2, g = s.glow;
    if (s.style === 'beam') {
        add(new THREE.CylinderGeometry(0.013, 0.013, BLADE_LEN, 8), new THREE.MeshStandardMaterial({ color: 0xffffff, emissive: color, emissiveIntensity: 3 }), mid);
        if (g > 0) {
            add(new THREE.CylinderGeometry(0.05, 0.045, BLADE_LEN * 1.02, 10), glowMat(0.3 * g), mid);
            add(new THREE.CylinderGeometry(0.11, 0.09, BLADE_LEN * 1.04, 10), glowMat(0.14 * g), mid);
        }
    } else if (s.style === 'katana') {
        const blade = add(new THREE.BoxGeometry(0.014, BLADE_LEN * 0.94, 0.055), new THREE.MeshStandardMaterial({ color: 0xffffff, emissive: color, emissiveIntensity: 1.6, roughness: 0.25, metalness: 0.4 }), BLADE_BASE + BLADE_LEN * 0.47);
        blade.rotation.y = Math.PI / 2;
        const tip = add(new THREE.ConeGeometry(0.039, BLADE_LEN * 0.08, 4), new THREE.MeshStandardMaterial({ color: 0xffffff, emissive: color, emissiveIntensity: 1.6 }), BLADE_BASE + BLADE_LEN * 0.98);
        tip.scale.set(0.36, 1, 1);
        if (g > 0) add(new THREE.BoxGeometry(0.06, BLADE_LEN, 0.1), glowMat(0.12 * g), mid);
    } else if (s.style === 'pixel') {
        const n = 10, h = BLADE_LEN / n;
        const bright = new THREE.MeshStandardMaterial({ color: 0xffffff, emissive: color, emissiveIntensity: 2 });
        const dim = new THREE.MeshStandardMaterial({ color: 0x999999, emissive: color, emissiveIntensity: 1.1 });
        const cube = new THREE.BoxGeometry(0.05, h * 0.82, 0.05);
        for (let i = 0; i < n; i++) { const m = new THREE.Mesh(cube, i % 2 ? dim : bright); m.position.y = BLADE_BASE + h * (i + 0.5); group.add(m); }
        trash.push(cube, bright, dim);
        if (g > 0) add(new THREE.BoxGeometry(0.11, BLADE_LEN, 0.11), glowMat(0.12 * g), mid);
    } else if (s.style === 'crystal') {
        const n = 6, h = BLADE_LEN / n;
        const gem = new THREE.OctahedronGeometry(0.05, 0);
        const m1 = new THREE.MeshStandardMaterial({ color: 0xffffff, emissive: color, emissiveIntensity: 1.8, transparent: true, opacity: 0.9, flatShading: true });
        for (let i = 0; i < n; i++) {
            const m = new THREE.Mesh(gem, m1);
            m.position.y = BLADE_BASE + h * (i + 0.5);
            m.scale.set(1 - i * 0.07, h / 0.1 * 1.05, 1 - i * 0.07);
            m.rotation.y = i * 0.6;
            group.add(m);
        }
        trash.push(gem, m1);
        if (g > 0) add(new THREE.CylinderGeometry(0.08, 0.05, BLADE_LEN, 8), glowMat(0.13 * g), mid);
    } else {
        add(new THREE.CylinderGeometry(0.028, 0.02, BLADE_LEN, 10), new THREE.MeshStandardMaterial({ color: 0xffffff, emissive: color, emissiveIntensity: 2.0, roughness: 0.3 }), mid);
        if (g > 0) add(new THREE.CylinderGeometry(0.075, 0.055, BLADE_LEN * 1.02, 10), glowMat(0.14 * g), mid);
    }
    group.userData.look = { ...s, color: '#' + color.getHexString() };
    return { group, dispose: () => { for (const d of new Set(trash)) d.dispose(); } };
}

// ---------- 3D: the avatar ----------
// A floating head and body (your sabers are your hands), facing −z like the
// player. Feet on y = 0, head around 1.7 m. Returns { root, head, body, dispose() }.
export function buildAvatar(cfg) {
    const a = cleanAvatar(cfg);
    const root = new THREE.Group();
    const trash = [];
    const mat = (hex, opts = {}) => {
        const c = new THREE.Color(hex);
        const m = new THREE.MeshStandardMaterial({ color: c, roughness: 0.62, metalness: 0.04, emissive: c, emissiveIntensity: 0.2, ...opts });
        trash.push(m);
        return m;
    };
    const mesh = (geo, m, parent, x = 0, y = 0, z = 0) => {
        const o = new THREE.Mesh(geo, m);
        o.position.set(x, y, z);
        parent.add(o);
        trash.push(geo);
        return o;
    };
    const skin = mat(a.skin), body = mat(a.bodyColor), accent = mat(a.accent);
    const dark = mat('#14141c', { emissiveIntensity: 0 }), white = mat('#ffffff', { emissiveIntensity: 0.4 });
    const glowAccent = mat(a.accent, { emissiveIntensity: 1.4 });

    // ----- head -----
    const head = new THREE.Group();
    head.position.set(0, 1.68, 0);
    root.add(head);
    let front, top, side;
    if (a.head === 'square') {
        mesh(new THREE.BoxGeometry(0.3, 0.3, 0.3), skin, head);
        front = 0.15; top = 0.15; side = 0.15;
    } else if (a.head === 'tall') {
        mesh(new THREE.CapsuleGeometry(0.13, 0.12, 8, 18), skin, head);
        front = 0.13; top = 0.19; side = 0.13;
    } else {
        mesh(new THREE.SphereGeometry(0.17, 28, 20), skin, head);
        front = 0.165; top = 0.17; side = 0.17;
    }
    const fz = -front - 0.004;                       // the face is on the −z side
    const pair = (fn) => { fn(-0.062); fn(0.062); };

    // eyes
    if (a.eyes === 'visor') {
        mesh(new THREE.BoxGeometry(0.27, 0.065, 0.03), glowAccent, head, 0, 0.03, fz + 0.01);
    } else if (a.eyes === 'big') {
        pair((x) => { mesh(new THREE.SphereGeometry(0.042, 14, 10), white, head, x, 0.03, fz + 0.012); mesh(new THREE.SphereGeometry(0.022, 10, 8), dark, head, x, 0.03, fz - 0.024); });
    } else if (a.eyes === 'happy') {
        pair((x) => { const e = mesh(new THREE.TorusGeometry(0.026, 0.008, 6, 14, Math.PI), dark, head, x, 0.02, fz); e.rotation.y = Math.PI; });
    } else if (a.eyes === 'robot') {
        pair((x) => mesh(new THREE.BoxGeometry(0.05, 0.05, 0.02), glowAccent, head, x, 0.03, fz));
    } else if (a.eyes === 'sleepy') {
        pair((x) => mesh(new THREE.BoxGeometry(0.055, 0.011, 0.012), dark, head, x, 0.025, fz));
    } else {
        pair((x) => mesh(new THREE.SphereGeometry(0.022, 10, 8), dark, head, x, 0.03, fz + 0.006));
    }
    // mouth
    if (a.mouth === 'smile') {
        const m = mesh(new THREE.TorusGeometry(0.045, 0.01, 6, 16, Math.PI), dark, head, 0, -0.045, fz);
        m.rotation.set(0, Math.PI, Math.PI);
    } else if (a.mouth === 'grin') {
        const m = mesh(new THREE.CircleGeometry(0.052, 16, 0, Math.PI), dark, head, 0, -0.04, fz - 0.002);
        m.rotation.set(0, Math.PI, Math.PI);
        const t = mesh(new THREE.BoxGeometry(0.08, 0.014, 0.004), white, head, 0, -0.047, fz - 0.004);
        t.rotation.y = Math.PI;
    } else if (a.mouth === 'flat') {
        mesh(new THREE.BoxGeometry(0.07, 0.013, 0.01), dark, head, 0, -0.06, fz);
    } else if (a.mouth === 'open') {
        const m = mesh(new THREE.CircleGeometry(0.03, 16), dark, head, 0, -0.06, fz - 0.002);
        m.rotation.y = Math.PI;
        m.scale.set(1, 1.25, 1);
    }
    // glasses
    if (a.glasses === 'round') {
        pair((x) => mesh(new THREE.TorusGeometry(0.042, 0.007, 6, 18), dark, head, x, 0.03, fz - 0.012));
        mesh(new THREE.BoxGeometry(0.04, 0.008, 0.008), dark, head, 0, 0.035, fz - 0.012);
    } else if (a.glasses === 'shades') {
        const lens = mat('#0b0b12', { emissiveIntensity: 0, roughness: 0.15, metalness: 0.6 });
        pair((x) => mesh(new THREE.BoxGeometry(0.095, 0.055, 0.012), lens, head, x * 1.05, 0.03, fz - 0.012));
        mesh(new THREE.BoxGeometry(0.25, 0.012, 0.012), lens, head, 0, 0.052, fz - 0.012);
    }
    // headwear
    const crownY = top;
    if (a.hat === 'cap') {
        mesh(new THREE.SphereGeometry(side * 1.06, 24, 12, 0, Math.PI * 2, 0, Math.PI / 2), accent, head, 0, crownY - side * 0.62, 0);
        const brim = mesh(new THREE.CylinderGeometry(0.13, 0.13, 0.014, 20, 1, false, 0, Math.PI), accent, head, 0, crownY - side * 0.6, -front * 0.55);
        brim.rotation.y = Math.PI / 2;
    } else if (a.hat === 'beanie') {
        mesh(new THREE.SphereGeometry(side * 1.07, 24, 12, 0, Math.PI * 2, 0, Math.PI / 2), accent, head, 0, crownY - side * 0.55, 0);
        mesh(new THREE.CylinderGeometry(side * 1.1, side * 1.1, 0.05, 24), body, head, 0, crownY - side * 0.55, 0);
        mesh(new THREE.SphereGeometry(0.04, 12, 10), body, head, 0, crownY + side * 0.5, 0);
    } else if (a.hat === 'crown') {
        const gold = mat(a.accent, { metalness: 0.8, roughness: 0.25, emissiveIntensity: 0.35 });
        mesh(new THREE.CylinderGeometry(0.11, 0.11, 0.06, 20, 1, true), gold, head, 0, crownY + 0.015, 0).material.side = THREE.DoubleSide;
        for (let i = 0; i < 5; i++) {
            const ang = (i / 5) * Math.PI * 2;
            mesh(new THREE.ConeGeometry(0.022, 0.06, 6), gold, head, Math.sin(ang) * 0.1, crownY + 0.07, Math.cos(ang) * 0.1);
        }
    } else if (a.hat === 'headphones') {
        const band = mesh(new THREE.TorusGeometry(side + 0.03, 0.016, 8, 24, Math.PI), accent, head, 0, 0, 0);
        band.rotation.set(0, 0, 0);
        pair((x) => { const c = mesh(new THREE.CylinderGeometry(0.06, 0.06, 0.05, 18), body, head, Math.sign(x) * (side + 0.03), 0, 0); c.rotation.z = Math.PI / 2; });
    } else if (a.hat === 'horns') {
        pair((x) => { const h = mesh(new THREE.ConeGeometry(0.035, 0.13, 10), accent, head, x * 1.4, crownY - 0.01, 0); h.rotation.z = -Math.sign(x) * 0.5; });
    } else if (a.hat === 'halo') {
        const halo = mesh(new THREE.TorusGeometry(0.12, 0.014, 8, 28), glowAccent, head, 0, crownY + 0.09, 0);
        halo.rotation.x = Math.PI / 2;
    } else if (a.hat === 'antenna') {
        mesh(new THREE.CylinderGeometry(0.006, 0.006, 0.14, 6), dark, head, 0, crownY + 0.06, 0);
        mesh(new THREE.SphereGeometry(0.03, 12, 10), glowAccent, head, 0, crownY + 0.14, 0);
    } else if (a.hat === 'spiky') {
        for (let i = 0; i < 7; i++) {
            const ang = (i / 7) * Math.PI * 2;
            const sp = mesh(new THREE.ConeGeometry(0.045, 0.13, 8), accent, head, Math.sin(ang) * 0.075, crownY - 0.005, Math.cos(ang) * 0.075 + 0.02);
            sp.rotation.set(Math.cos(ang) * 0.5, 0, -Math.sin(ang) * 0.5);
        }
    } else if (a.hat === 'bun') {
        mesh(new THREE.SphereGeometry(side * 1.04, 24, 12, 0, Math.PI * 2, 0, Math.PI / 2), accent, head, 0, crownY - side * 0.7, 0.01);
        mesh(new THREE.SphereGeometry(0.06, 14, 10), accent, head, 0, crownY + 0.03, 0.08);
    }

    // ----- body (floats under the head, like Beat Saber's avatars) -----
    const torso = new THREE.Group();
    torso.position.set(0, 1.18, 0.02);
    root.add(torso);
    mesh(new THREE.CylinderGeometry(0.05, 0.055, 0.08, 12), skin, torso, 0, 0.27, 0);       // neck
    if (a.body === 'robot') {
        const metal = mat(a.bodyColor, { metalness: 0.6, roughness: 0.3, emissiveIntensity: 0.12 });
        mesh(new THREE.BoxGeometry(0.36, 0.38, 0.22), metal, torso, 0, 0.02, 0);
        mesh(new THREE.CylinderGeometry(0.045, 0.045, 0.02, 16), glowAccent, torso, 0, 0.06, -0.115).rotation.x = Math.PI / 2;
        pair((x) => mesh(new THREE.SphereGeometry(0.065, 12, 10), metal, torso, x * 3.1, 0.17, 0));
    } else if (a.body === 'slim') {
        mesh(new THREE.CylinderGeometry(0.15, 0.1, 0.42, 18), body, torso, 0, 0.02, 0);
        mesh(new THREE.CylinderGeometry(0.115, 0.115, 0.04, 18), accent, torso, 0, -0.12, 0);
    } else {
        mesh(new THREE.CapsuleGeometry(0.17, 0.16, 8, 18), body, torso, 0, 0.0, 0);
        const hood = mesh(new THREE.TorusGeometry(0.1, 0.04, 8, 20), accent, torso, 0, 0.21, 0.04);
        hood.rotation.x = Math.PI / 2;
        pair((x) => mesh(new THREE.CylinderGeometry(0.006, 0.006, 0.12, 6), white, torso, x * 0.55, 0.12, -0.16));
    }
    root.userData.look = a;
    return { root, head, body: torso, dispose: () => { for (const d of new Set(trash)) d.dispose(); } };
}

// ---------- 2D: a little portrait for player lists ----------
export function drawPortrait(canvas, cfg) {
    const a = cleanAvatar(cfg);
    const g = canvas.getContext('2d'), S = canvas.width, c = S / 2;
    g.clearRect(0, 0, S, S);
    g.fillStyle = a.bodyColor;
    g.beginPath(); g.arc(c, c, c, 0, Math.PI * 2); g.fill();
    g.save();
    g.beginPath(); g.arc(c, c, c, 0, Math.PI * 2); g.clip();
    // shoulders
    g.fillStyle = a.body === 'robot' ? shade(a.bodyColor, 0.75) : shade(a.bodyColor, 0.85);
    g.beginPath(); g.ellipse(c, S * 1.02, S * 0.42, S * 0.3, 0, 0, Math.PI * 2); g.fill();
    // head
    const hr = S * 0.24, hy = S * 0.48;
    g.fillStyle = a.skin;
    g.beginPath();
    if (a.head === 'square') g.roundRect(c - hr, hy - hr, hr * 2, hr * 2, hr * 0.25);
    else if (a.head === 'tall') g.ellipse(c, hy - S * 0.02, hr * 0.85, hr * 1.15, 0, 0, Math.PI * 2);
    else g.arc(c, hy, hr, 0, Math.PI * 2);
    g.fill();
    // eyes
    const ey = hy - S * 0.02, ex = S * 0.085;
    g.fillStyle = '#16161e';
    if (a.eyes === 'visor') { g.fillStyle = a.accent; g.fillRect(c - hr * 0.85, ey - S * 0.035, hr * 1.7, S * 0.07); }
    else if (a.eyes === 'big') { for (const s of [-1, 1]) { g.fillStyle = '#fff'; g.beginPath(); g.arc(c + s * ex, ey, S * 0.055, 0, 7); g.fill(); g.fillStyle = '#16161e'; g.beginPath(); g.arc(c + s * ex, ey, S * 0.028, 0, 7); g.fill(); } }
    else if (a.eyes === 'robot') { g.fillStyle = a.accent; for (const s of [-1, 1]) g.fillRect(c + s * ex - S * 0.035, ey - S * 0.035, S * 0.07, S * 0.07); }
    else if (a.eyes === 'sleepy') { for (const s of [-1, 1]) g.fillRect(c + s * ex - S * 0.04, ey, S * 0.08, S * 0.016); }
    else if (a.eyes === 'happy') { g.strokeStyle = '#16161e'; g.lineWidth = S * 0.02; for (const s of [-1, 1]) { g.beginPath(); g.arc(c + s * ex, ey + S * 0.015, S * 0.035, Math.PI, 0); g.stroke(); } }
    else for (const s of [-1, 1]) { g.beginPath(); g.arc(c + s * ex, ey, S * 0.03, 0, 7); g.fill(); }
    if (a.glasses === 'shades') { g.fillStyle = '#0b0b12'; for (const s of [-1, 1]) g.fillRect(c + s * ex - S * 0.06, ey - S * 0.035, S * 0.12, S * 0.07); }
    else if (a.glasses === 'round') { g.strokeStyle = '#16161e'; g.lineWidth = S * 0.018; for (const s of [-1, 1]) { g.beginPath(); g.arc(c + s * ex, ey, S * 0.055, 0, 7); g.stroke(); } }
    // mouth
    const my = hy + S * 0.09;
    g.strokeStyle = '#16161e'; g.fillStyle = '#16161e'; g.lineWidth = S * 0.02;
    if (a.mouth === 'smile') { g.beginPath(); g.arc(c, my - S * 0.03, S * 0.06, 0.2, Math.PI - 0.2); g.stroke(); }
    else if (a.mouth === 'grin') { g.beginPath(); g.arc(c, my - S * 0.025, S * 0.065, 0, Math.PI); g.fill(); }
    else if (a.mouth === 'flat') g.fillRect(c - S * 0.05, my, S * 0.1, S * 0.018);
    else if (a.mouth === 'open') { g.beginPath(); g.ellipse(c, my + S * 0.005, S * 0.03, S * 0.04, 0, 0, 7); g.fill(); }
    // headwear
    g.fillStyle = a.accent; g.strokeStyle = a.accent;
    const topY = hy - hr;
    if (a.hat === 'cap' || a.hat === 'beanie' || a.hat === 'bun') { g.beginPath(); g.arc(c, hy - hr * 0.25, hr * 1.04, Math.PI, 0); g.fill(); if (a.hat === 'cap') g.fillRect(c - hr * 1.25, hy - hr * 0.3, hr * 1.25, S * 0.04); if (a.hat === 'bun') { g.beginPath(); g.arc(c, topY - S * 0.03, S * 0.07, 0, 7); g.fill(); } if (a.hat === 'beanie') { g.beginPath(); g.arc(c, topY - S * 0.02, S * 0.045, 0, 7); g.fill(); } }
    else if (a.hat === 'crown') { g.beginPath(); g.moveTo(c - hr * 0.8, topY + S * 0.03); for (let i = 0; i <= 4; i++) { g.lineTo(c - hr * 0.8 + i * hr * 0.4, topY - S * (i % 2 ? 0.02 : 0.1)); } g.lineTo(c + hr * 0.8, topY + S * 0.03); g.fill(); }
    else if (a.hat === 'halo') { g.lineWidth = S * 0.03; g.beginPath(); g.ellipse(c, topY - S * 0.06, hr * 0.8, S * 0.035, 0, 0, 7); g.stroke(); }
    else if (a.hat === 'horns') { for (const s of [-1, 1]) { g.beginPath(); g.moveTo(c + s * hr * 0.45, topY + S * 0.04); g.lineTo(c + s * hr * 0.85, topY - S * 0.1); g.lineTo(c + s * hr * 0.8, topY + S * 0.07); g.fill(); } }
    else if (a.hat === 'antenna') { g.fillStyle = '#16161e'; g.fillRect(c - S * 0.008, topY - S * 0.1, S * 0.016, S * 0.1); g.fillStyle = a.accent; g.beginPath(); g.arc(c, topY - S * 0.11, S * 0.035, 0, 7); g.fill(); }
    else if (a.hat === 'spiky') { for (let i = 0; i < 5; i++) { const x = c - hr * 0.8 + i * hr * 0.4; g.beginPath(); g.moveTo(x - S * 0.05, topY + S * 0.06); g.lineTo(x, topY - S * 0.08); g.lineTo(x + S * 0.05, topY + S * 0.06); g.fill(); } }
    else if (a.hat === 'headphones') { g.lineWidth = S * 0.035; g.beginPath(); g.arc(c, hy, hr * 1.12, Math.PI * 1.05, Math.PI * 1.95); g.stroke(); for (const s of [-1, 1]) g.fillRect(c + s * hr * 1.08 - S * 0.04, hy - S * 0.05, S * 0.08, S * 0.12); }
    g.restore();
}

function shade(hex, k) {
    const c = new THREE.Color(hex);
    c.multiplyScalar(k);
    return '#' + c.getHexString();
}
