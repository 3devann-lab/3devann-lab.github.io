// ============ Customize: your sabers and avatar, with a live 3D preview ============
// Other players see both in multiplayer. You never see your own avatar while
// playing (you play from behind your sabers) — only here.
import * as THREE from 'three';
import { settings } from './settings.js';
import {
    SABER_STYLES, SABER_HILTS, AVATAR_OPTIONS, SKIN_TONES, PALETTE, DEFAULT_AVATAR,
    cleanAvatar, randomAvatar, buildAvatar, buildSaber, myLook,
} from './looks.js';
import { mp } from './online/multiplayer.js';
import { esc } from './ui.js';

const $ = (id) => document.getElementById(id);

// the avatar holding your sabers, floating in front of the menu camera
class Showcase {
    constructor(engine) {
        this.engine = engine;
        this.holder = new THREE.Group();
        this.pivot = new THREE.Group();
        this.holder.add(this.pivot);
        this.key = new THREE.PointLight(0xffffff, 7, 9, 1.4);
        this.key.position.set(0.6, 1.9, 1.6);
        this.fill = new THREE.PointLight(0x9fb4ff, 3, 9, 1.4);
        this.fill.position.set(-1.2, 1.2, 1.2);
        this.holder.add(this.key, this.fill);
        engine.camera.add(this.holder);
        this.yaw = 0;
        this.t = 0;
        this.dragging = false;
        this.idle = 0;
        this.place();
        this.build();
    }

    // the right-hand part of the screen (centred on narrow screens)
    place() {
        const cam = this.engine.camera, dist = 2.05;
        const halfH = Math.tan(THREE.MathUtils.degToRad(cam.fov / 2)) * dist;
        const halfW = halfH * (innerWidth / innerHeight);
        const wide = innerWidth > 980;
        this.holder.position.set(wide ? halfW * 0.42 : 0, wide ? -1.42 : -1.42 - halfH * 0.5, -dist);
        this.holder.rotation.set(0.06, Math.PI, 0);       // the avatar faces −z; turn it toward the camera
    }

    build() {
        this.clear();
        const look = myLook(settings);
        this.avatar = buildAvatar(look.avatar);
        this.pivot.add(this.avatar.root);
        this.sabers = [[look.saber.left, -0.34], [look.saber.right, 0.34]].map(([col, x]) => {
            const s = buildSaber(col, look.saber);
            // held low at the sides, blades up and outward so the face stays in view
            s.group.position.set(x * 1.45, 0.92, -0.12);
            s.group.rotation.set(0.28, 0, -Math.sign(x) * 0.42);
            this.pivot.add(s.group);
            return s;
        });
    }

    clear() {
        if (this.avatar) { this.avatar.root.removeFromParent(); this.avatar.dispose(); this.avatar = null; }
        for (const s of this.sabers || []) { s.group.removeFromParent(); s.dispose(); }
        this.sabers = [];
    }

    update(dt) {
        this.t += dt;
        if (!this.dragging) {
            this.idle += dt;
            // drift back toward a gentle sway after you let go
            const target = Math.sin(this.t * 0.45) * 0.5;
            if (this.idle > 2.5) this.yaw += (target - this.yaw) * Math.min(1, dt * 0.8);
        }
        this.pivot.rotation.y = this.yaw;
        if (this.avatar) this.avatar.head.position.y = 1.68 + Math.sin(this.t * 2.2) * 0.012;
    }

    dispose() {
        this.clear();
        this.holder.removeFromParent();
    }
}

export function showCustomize(menu, { tab = 'sabers', back = null } = {}) {
    const goBack = back || (() => menu.showHome());
    menu.setScreen(`
    <div class="screen custom-screen">
        <div class="panel custom-panel">
            <div class="panel-header">
                <div class="panel-title">CUSTOMIZE</div>
                <div class="seg">${[['sabers', 'Sabers'], ['avatar', 'Avatar']].map(([k, l]) => `<button class="sort-btn ${k === tab ? 'active' : ''}" data-ct="${k}">${l}</button>`).join('')}</div>
                <button class="btn small" id="btn-back">← Back</button>
            </div>
            <div class="panel-body" id="cu-body"></div>
        </div>
        <div class="custom-stage" id="cu-stage"><div class="custom-hint">Drag to turn · other players see this in multiplayer</div></div>
    </div>`);
    menu.enterMenuMode(goBack);
    $('btn-back').onclick = goBack;
    menu.root.querySelectorAll('[data-ct]').forEach(b => { b.onclick = () => { tab = b.dataset.ct; render(); }; });

    const show = new Showcase(menu.engine);
    menu.showcase = show;
    let lookT = 0;
    const changed = () => {
        show.build();
        // others in your lobby see the change right away
        clearTimeout(lookT);
        lookT = setTimeout(() => mp.refreshLook(), 400);
    };
    const onResize = () => show.place();
    addEventListener('resize', onResize);
    menu._cleanup = () => {
        removeEventListener('resize', onResize);
        clearTimeout(lookT);
        if (mp.lobbyId) mp.refreshLook();
        show.dispose();
        if (menu.showcase === show) menu.showcase = null;
    };

    // drag the preview to turn it
    const stage = $('cu-stage');
    let lastX = null;
    stage.addEventListener('pointerdown', (e) => { lastX = e.clientX; show.dragging = true; show.idle = 0; try { stage.setPointerCapture(e.pointerId); } catch (err) { /* synthetic */ } });
    stage.addEventListener('pointermove', (e) => { if (lastX === null) return; show.yaw += (e.clientX - lastX) * 0.01; lastX = e.clientX; });
    const up = () => { lastX = null; show.dragging = false; show.idle = 0; };
    stage.addEventListener('pointerup', up);
    stage.addEventListener('pointercancel', up);

    const avatar = () => cleanAvatar(settings.get('avatar') || DEFAULT_AVATAR);
    const setAv = (key, v) => { settings.set('avatar', { ...avatar(), [key]: v }); changed(); };

    const chips = (id, list, cur) => `<div class="cu-chips">${list.map(([k, l]) => `<button class="mod-chip ${k === cur ? 'active' : ''}" data-opt="${id}" data-v="${esc(k)}">${esc(l)}</button>`).join('')}</div>`;
    const swatches = (id, list, cur) => `<div class="cu-swatches">${list.map(c => `<button class="cu-swatch ${c.toLowerCase() === String(cur).toLowerCase() ? 'active' : ''}" style="background:${c}" data-sw="${id}" data-c="${c}" title="${c}"></button>`).join('')}
        <label class="cu-custom" title="Any colour"><input type="color" data-cc="${id}" value="${esc(cur)}"></label></div>`;
    const row = (title, html, sub = '') => `<div class="cu-row"><div class="cu-label">${title}${sub ? `<small>${sub}</small>` : ''}</div>${html}</div>`;

    const render = () => {
        menu.root.querySelectorAll('[data-ct]').forEach(b => b.classList.toggle('active', b.dataset.ct === tab));
        const body = $('cu-body');
        if (tab === 'sabers') {
            const glow = settings.num('saberGlow', 0, 2);
            body.innerHTML =
                row('Left saber', swatches('set:leftColor', PALETTE, settings.get('leftColor')), 'also colours your left-hand notes')
                + row('Right saber', swatches('set:rightColor', PALETTE, settings.get('rightColor')), 'also colours your right-hand notes')
                + row('Blade', chips('set:saberStyle', SABER_STYLES, settings.get('saberStyle')))
                + row('Hilt', chips('set:saberHilt', SABER_HILTS, settings.get('saberHilt')))
                + row('Glow', `<div class="cu-slider"><input type="range" id="cu-glow" min="0" max="2" step="0.1" value="${glow}"><span id="cu-glow-v">${Math.round(glow * 100)}%</span></div>`)
                + '<div class="cu-note">Only the look changes — every blade cuts exactly the same. Other players see your sabers and colours in multiplayer.</div>';
            const g = $('cu-glow');
            g.oninput = () => { settings.set('saberGlow', Number(g.value)); $('cu-glow-v').textContent = Math.round(g.value * 100) + '%'; changed(); };
        } else {
            const a = avatar(), O = AVATAR_OPTIONS;
            body.innerHTML =
                row('Head', chips('av:head', O.head, a.head))
                + row('Skin', swatches('av:skin', SKIN_TONES, a.skin))
                + row('Eyes', chips('av:eyes', O.eyes, a.eyes))
                + row('Mouth', chips('av:mouth', O.mouth, a.mouth))
                + row('Headwear', chips('av:hat', O.hat, a.hat))
                + row('Glasses', chips('av:glasses', O.glasses, a.glasses))
                + row('Body', chips('av:body', O.body, a.body))
                + row('Body colour', swatches('av:bodyColor', PALETTE, a.bodyColor))
                + row('Accent colour', swatches('av:accent', PALETTE, a.accent), 'headwear, visor, trim')
                + `<div class="cu-actions"><button class="btn small" id="cu-random">🎲 Randomize</button><button class="btn small" id="cu-reset">Reset</button></div>
                <div class="cu-note">Other players see your avatar beside them in multiplayer. You don't see your own while playing.</div>`;
            $('cu-random').onclick = () => { settings.set('avatar', randomAvatar()); changed(); render(); };
            $('cu-reset').onclick = () => { settings.set('avatar', { ...DEFAULT_AVATAR }); changed(); render(); };
        }
        const apply = (id, v) => {
            const [kind, key] = id.split(':');
            if (kind === 'set') settings.set(key, v);
            else setAv(key, v);
            if (kind === 'set') changed();
        };
        body.querySelectorAll('[data-opt]').forEach(b => { b.onclick = () => { apply(b.dataset.opt, b.dataset.v); render(); }; });
        body.querySelectorAll('[data-sw]').forEach(b => { b.onclick = () => { apply(b.dataset.sw, b.dataset.c); render(); }; });
        body.querySelectorAll('[data-cc]').forEach(inp => {
            inp.oninput = () => apply(inp.dataset.cc, inp.value);
            inp.onchange = () => render();
        });
    };
    render();
}
