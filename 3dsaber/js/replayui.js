// ============ Replay viewer controls: timeline, speed, cameras, live options ============
import { audio } from './audio.js';
import { gamepad, Buttons } from './input.js';
import { settings, CAMERA_KEYS, REPLAY_KEYS } from './settings.js';
import { FREE_PRESET_NAMES } from './game.js';
import {
    toast, fmt, settingBuilders, fmtTime, SPEEDS, CAMERA_LABELS,
    PLAY_CAMERA_ROWS, FIRST_PERSON_ROWS, FOLLOW_ROWS, REPLAY_VIEW_ROWS,
} from './ui.js';

const HIDE_AFTER = 2600;        // ms without input before the bar fades while playing
const PRESET_LABELS = { stage: 'Stage', behind: 'Behind', front: 'Front', side: 'Side', top: 'Top' };
const MOVE_KEYS = { w: 1, a: 1, s: 1, d: 1, q: 1, e: 1, shift: 1 };

export class ReplayControls {
    /**
     * @param menu Menu (pause/resume/quit live there)
     * @param gameplay Gameplay running a replay
     */
    constructor(menu, gameplay) {
        this.menu = menu;
        this.gp = gameplay;
        this.engine = menu.engine;
        this.lastInput = performance.now();
        this.keys = new Set();
        this.drag = null;
        this.panelTab = 'camera';
        this.seekPending = null;

        const el = document.createElement('div');
        el.id = 'replay-ui';
        el.innerHTML = `
            <div class="rb-paused hidden">PAUSED</div>
            <div class="rb-bar">
                <div class="rb-timeline" id="rb-timeline">
                    <div class="rb-track"><div class="rb-fail"></div><div class="rb-fill"></div></div>
                    <div class="rb-markers"></div>
                    <div class="rb-head"></div>
                    <div class="rb-tip hidden"></div>
                </div>
                <div class="rb-row">
                    <div class="rb-group">
                        <button class="rb-btn rb-play" title="Play / pause (Space)">❚❚</button>
                        <button class="rb-btn" data-skip="-5" title="Back 5 s (←)">⟲ 5</button>
                        <button class="rb-btn" data-skip="5" title="Forward 5 s (→)">5 ⟳</button>
                        <span class="rb-time">0:00 / 0:00</span>
                    </div>
                    <div class="rb-group">
                        <button class="rb-btn" data-speed="-1" title="Slower (↓)">−</button>
                        <span class="rb-speed" title="Playback speed">1x</span>
                        <button class="rb-btn" data-speed="1" title="Faster (↑)">+</button>
                    </div>
                    <div class="rb-group rb-cams">
                        ${Object.entries(CAMERA_LABELS).map(([k, l], i) =>
                            `<button class="rb-btn rb-cam" data-cam="${k}" title="${l} camera (${i + 1})">${l}</button>`).join('')}
                    </div>
                    <div class="rb-group">
                        <button class="rb-btn rb-hud" title="Score HUD on/off (H)">HUD</button>
                        <button class="rb-btn rb-opts" title="Camera and replay options (O)">⚙ Options</button>
                        <button class="rb-btn danger rb-exit" title="Back to replays">Exit</button>
                    </div>
                </div>
            </div>
            <div class="rb-panel hidden">
                <div class="rb-panel-head">
                    <div class="seg rb-tabs">
                        <button class="sort-btn" data-tab="camera">Camera</button>
                        <button class="sort-btn" data-tab="view">Replay</button>
                        <button class="sort-btn" data-tab="keys">Controls</button>
                    </div>
                    <button class="btn small rb-close">✕</button>
                </div>
                <div class="rb-panel-body"></div>
            </div>`;
        document.body.appendChild(el);
        document.body.classList.add('rb-on');
        this.el = el;
        this.q = (sel) => el.querySelector(sel);

        this.renderMarkers();
        this.bind();
        this.syncButtons();
        this.update(0);
    }

    destroy() {
        this.gp.saveFreeCam();
        removeEventListener('keydown', this._onKeyDown, true);
        removeEventListener('keyup', this._onKeyUp, true);
        removeEventListener('blur', this._onBlur);
        removeEventListener('mousemove', this._onMouse);
        removeEventListener('pointermove', this._onPointerMove);
        removeEventListener('pointerup', this._onPointerUp);
        const cv = this.engine.renderer.domElement;
        cv.removeEventListener('pointerdown', this._onCanvasDown);
        cv.removeEventListener('wheel', this._onWheel);
        cv.removeEventListener('contextmenu', this._noMenu);
        document.body.classList.remove('rb-on', 'rb-free', 'rb-idle');
        this.el.remove();
    }

    // ---------- wiring ----------
    bind() {
        const q = this.q;
        // buttons never keep focus, so Space / arrows always reach the viewer
        this.el.addEventListener('click', (e) => { const b = e.target.closest('button'); if (b) b.blur(); });
        q('.rb-play').onclick = () => this.togglePause();
        this.el.querySelectorAll('[data-skip]').forEach(b => { b.onclick = () => this.skip(Number(b.dataset.skip)); });
        this.el.querySelectorAll('[data-speed]').forEach(b => { b.onclick = () => this.stepSpeed(Number(b.dataset.speed)); });
        q('.rb-speed').onclick = () => this.setSpeed(1);
        this.el.querySelectorAll('[data-cam]').forEach(b => { b.onclick = () => this.setCamera(b.dataset.cam); });
        q('.rb-hud').onclick = () => this.toggleSetting('replayHud', 'Score HUD');
        q('.rb-opts').onclick = () => this.togglePanel();
        q('.rb-close').onclick = () => this.togglePanel(false);
        q('.rb-exit').onclick = () => this.menu.quitReplay();
        this.el.querySelectorAll('[data-tab]').forEach(b => { b.onclick = () => { this.panelTab = b.dataset.tab; this.renderPanel(); }; });

        // timeline scrubbing (seeks are coalesced to one per frame)
        const tl = q('#rb-timeline');
        tl.addEventListener('pointerdown', (e) => {
            e.preventDefault();
            this.drag = { kind: 'seek' };
            tl.setPointerCapture && tl.setPointerCapture(e.pointerId);
            this.seekPending = this.timeAt(e.clientX);
        });
        tl.addEventListener('pointermove', (e) => {
            const tip = q('.rb-tip');
            tip.classList.remove('hidden');
            const r = tl.getBoundingClientRect();
            tip.style.left = Math.max(0, Math.min(r.width, e.clientX - r.left)) + 'px';
            tip.textContent = fmtTime(this.timeAt(e.clientX));
        });
        tl.addEventListener('pointerleave', () => q('.rb-tip').classList.add('hidden'));

        this._onPointerMove = (e) => {
            this.poke();
            if (!this.drag) return;
            if (this.drag.kind === 'seek') { this.seekPending = this.timeAt(e.clientX); return; }
            const dx = e.clientX - this.drag.x, dy = e.clientY - this.drag.y;
            this.drag.x = e.clientX; this.drag.y = e.clientY;
            if (this.drag.kind === 'orbit') this.gp.freeCamOrbit(-dx * 0.006, dy * 0.005);
            else {
                const k = (this.gp.freeCam ? this.gp.freeCam.dist : 4) * 0.0016;
                this.gp.freeCamMove(-dx * k, dy * k, 0);
            }
        };
        this._onPointerUp = (e) => {
            if (this.drag && this.drag.kind !== 'seek') this.gp.saveFreeCam();
            this.drag = null;
            const c = this.click;
            this.click = null;
            if (c && e.button === 0 && Math.hypot(e.clientX - c.x, e.clientY - c.y) < 5 && performance.now() - c.at < 350) this.togglePause();
        };
        addEventListener('pointermove', this._onPointerMove);
        addEventListener('pointerup', this._onPointerUp);

        // free camera: drag to orbit, right-drag (or Shift) to pan, wheel to zoom
        const cv = this.engine.renderer.domElement;
        // a plain click on the picture pauses / resumes, like a video
        this._onCanvasDown = (e) => {
            this.click = { x: e.clientX, y: e.clientY, at: performance.now() };
            if (this.gp.camMode !== 'free') return;
            e.preventDefault();
            this.drag = { kind: e.button === 2 || e.shiftKey ? 'pan' : 'orbit', x: e.clientX, y: e.clientY };
        };
        this._onWheel = (e) => {
            if (this.gp.camMode !== 'free') return;
            e.preventDefault();
            this.gp.freeCamZoom(Math.exp(Math.sign(e.deltaY) * Math.min(Math.abs(e.deltaY), 120) * 0.0018));
            this.gp.saveFreeCam();
        };
        this._noMenu = (e) => e.preventDefault();
        cv.addEventListener('pointerdown', this._onCanvasDown);
        cv.addEventListener('wheel', this._onWheel, { passive: false });
        cv.addEventListener('contextmenu', this._noMenu);

        this._onMouse = () => this.poke();
        addEventListener('mousemove', this._onMouse);
        this._onKeyDown = (e) => this.onKey(e);
        this._onKeyUp = (e) => this.keys.delete(e.key.toLowerCase());
        this._onBlur = () => this.keys.clear();
        addEventListener('keydown', this._onKeyDown, true);
        addEventListener('keyup', this._onKeyUp, true);
        addEventListener('blur', this._onBlur);
    }

    poke() { this.lastInput = performance.now(); }

    onKey(e) {
        const tg = e.target;
        if (tg && tg.matches && tg.matches('input[type="text"], input[type="search"], input[type="url"]')) return;
        if (tg && tg.matches && tg.matches('input[type="range"]') && /^Arrow|^Page|^Home$|^End$/.test(e.key)) return;
        const gp = this.gp;
        if (gp.finished) return;
        const k = e.key.toLowerCase();
        let handled = true;
        this.poke();
        if (MOVE_KEYS[k] && gp.camMode === 'free') { this.keys.add(k); e.preventDefault(); e.stopPropagation(); return; }
        if (k === 'shift') { this.keys.add(k); return; }
        switch (k) {
            case 'escape':
                if (!this.q('.rb-panel').classList.contains('hidden')) this.togglePanel(false);
                else this.togglePause();
                break;
            case ' ': case 'k': this.togglePause(); break;
            case 'arrowleft': this.skip(e.shiftKey ? -15 : -5); break;
            case 'arrowright': this.skip(e.shiftKey ? 15 : 5); break;
            case 'arrowup': this.stepSpeed(1); break;
            case 'arrowdown': this.stepSpeed(-1); break;
            case ',': this.frameStep(-1); break;
            case '.': this.frameStep(1); break;
            case '1': case '2': case '3': case '4': this.setCamera(Object.keys(CAMERA_LABELS)[Number(k) - 1]); break;
            case 'c': this.cycleCamera(); break;
            case 'h': this.toggleSetting('replayHud', 'Score HUD'); break;
            case 't': this.toggleSetting('replayStats', 'Stats panel'); break;
            case 'o': this.togglePanel(); break;
            case 'r': this.seek(gp.replayStartAt); break;
            case 'f': this.toggleFullscreen(); break;
            default: handled = false;
        }
        if (handled) { e.preventDefault(); e.stopPropagation(); }
    }

    // ---------- actions ----------
    togglePause() {
        if (this.gp.paused) this.menu.resumeGame(); else this.menu.pauseGame();
    }

    setPaused(paused) {
        this.q('.rb-paused').classList.toggle('hidden', !paused);
        this.q('.rb-play').textContent = paused ? '▶' : '❚❚';
        this.el.classList.toggle('paused', paused);
        this.poke();
    }

    seek(t) {
        this.gp.seek(t);
        this.poke();
        this.updateTimeline(true);
    }

    skip(sec) { this.seek(audio.songTime + sec); }

    frameStep(dir) {
        if (!this.gp.paused) this.menu.pauseGame();
        this.seek(audio.songTime + dir / 30);
    }

    setSpeed(v) {
        this.gp.setPlayback(v);
        this.syncButtons();
        this.poke();
    }

    stepSpeed(dir) {
        const cur = this.gp.playback;
        let i = SPEEDS.findIndex(s => s >= cur - 1e-6);
        if (i < 0) i = SPEEDS.length - 1;
        if (dir > 0 && SPEEDS[i] <= cur + 1e-6) i++;
        else if (dir < 0) i--;
        this.setSpeed(SPEEDS[Math.max(0, Math.min(SPEEDS.length - 1, i))]);
    }

    setCamera(mode) {
        const m = this.gp.setCameraMode(mode);
        settings.set('replayCamera', m);
        this.syncButtons();
        if (!this.q('.rb-panel').classList.contains('hidden')) this.renderPanel();
        this.poke();
        return m;
    }

    cycleCamera() {
        const order = Object.keys(CAMERA_LABELS);
        const m = this.setCamera(order[(order.indexOf(this.gp.camMode) + 1) % order.length]);
        if (m === 'free') toast('Free camera: drag to orbit, right-drag to pan, wheel to zoom');
    }

    toggleSetting(key, label) {
        const v = !settings.get(key);
        settings.set(key, v);
        this.gp.applyReplaySettings();
        this.syncButtons();
        if (!this.q('.rb-panel').classList.contains('hidden')) this.renderPanel();
        toast(`${label} ${v ? 'on' : 'off'}`);
    }

    toggleFullscreen() {
        if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
        else document.documentElement.requestFullscreen().catch(() => {});
    }

    togglePanel(show) {
        const p = this.q('.rb-panel');
        const open = show ?? p.classList.contains('hidden');
        p.classList.toggle('hidden', !open);
        this.q('.rb-opts').classList.toggle('active', open);
        if (open) this.renderPanel();
        this.poke();
    }

    // a setting changed in the panel: apply it to the running replay right away
    applySetting(key, value) {
        if (key === 'replayCamera') { this.setCamera(value); return; }
        if (CAMERA_KEYS.includes(key)) this.engine.applyCameraSettings();
        else this.gp.applyReplaySettings();
        if (key === 'replayShowMisses') this.renderMarkers();
        this.syncButtons();
    }

    renderPanel() {
        const body = this.q('.rb-panel-body');
        const keepScroll = body.scrollTop;
        body.innerHTML = '';
        this.el.querySelectorAll('[data-tab]').forEach(b => b.classList.toggle('active', b.dataset.tab === this.panelTab));
        const b = settingBuilders(body, (k, v) => this.applySetting(k, v));
        const mode = this.gp.camMode;
        if (this.panelTab === 'camera') {
            const cams = document.createElement('div');
            cams.className = 'seg rb-panel-cams';
            cams.innerHTML = Object.entries(CAMERA_LABELS).map(([k, l]) =>
                `<button class="sort-btn ${k === mode ? 'active' : ''}" data-pcam="${k}">${l}</button>`).join('');
            cams.querySelectorAll('[data-pcam]').forEach(btn => { btn.onclick = () => this.setCamera(btn.dataset.pcam); });
            body.appendChild(cams);
            const reset = (keys) => () => { settings.reset(keys); this.engine.applyCameraSettings(); this.renderPanel(); toast('Camera reset'); };
            if (mode === 'first') {
                b.section('First-person camera', 'The player\'s own view', reset(CAMERA_KEYS.filter(k => k.startsWith('fp'))));
                b.rows(FIRST_PERSON_ROWS);
            } else if (mode === 'follow') {
                b.section('Follow camera', 'Chases the player\'s head from behind', reset(CAMERA_KEYS.filter(k => k.startsWith('follow'))));
                b.rows(FOLLOW_ROWS);
                b.slider('camFov', 'Field of View', 'Shared with the third-person and free cameras', 40, 120, 1, fmt.deg);
            } else if (mode === 'free') {
                b.section('Free camera', 'Drag to orbit · right-drag or Shift-drag to pan · wheel to zoom · WASD / Q E to fly');
                const pre = document.createElement('div');
                pre.className = 'seg rb-presets';
                pre.innerHTML = FREE_PRESET_NAMES.map(n => `<button class="sort-btn" data-preset="${n}">${PRESET_LABELS[n] || n}</button>`).join('');
                pre.querySelectorAll('[data-preset]').forEach(btn => {
                    btn.onclick = () => { this.gp.freeCamPreset(btn.dataset.preset); this.gp.saveFreeCam(); };
                });
                body.appendChild(pre);
                b.slider('camFov', 'Field of View', 'Shared with the third-person and follow cameras', 40, 120, 1, fmt.deg);
            } else {
                b.section('Third-person camera', 'The same camera you play with', reset(['camFov', 'camHeight', 'camDistance', 'camTilt']));
                b.rows(PLAY_CAMERA_ROWS);
            }
        } else if (this.panelTab === 'view') {
            b.section('Replay view', '', () => {
                settings.reset(REPLAY_KEYS.filter(k => k !== 'freeCam' && k !== 'replayCamera'));
                this.gp.applyReplaySettings();
                this.renderMarkers();
                this.syncButtons();
                this.renderPanel();
                toast('Replay view reset');
            });
            b.rows(REPLAY_VIEW_ROWS.filter(r => r[1] !== 'replayCamera'));
            const sp = document.createElement('div');
            sp.className = 'setting-row';
            sp.innerHTML = `<div class="setting-label">Playback Speed<small>Pitch changes with speed</small></div>
                <div class="setting-control seg">${SPEEDS.map(v =>
                    `<button class="sort-btn ${Math.abs(v - this.gp.playback) < 1e-6 ? 'active' : ''}" data-sp="${v}">${v}x</button>`).join('')}</div>`;
            sp.querySelectorAll('[data-sp]').forEach(btn => { btn.onclick = () => { this.setSpeed(Number(btn.dataset.sp)); this.renderPanel(); }; });
            body.appendChild(sp);
        } else {
            body.innerHTML = `<div class="rb-keys">
                <div><b>Space</b> / <b>K</b><span>Play / pause</span></div>
                <div><b>←</b> <b>→</b><span>Back / forward 5 s (Shift: 15 s)</span></div>
                <div><b>,</b> <b>.</b><span>Step one frame</span></div>
                <div><b>↑</b> <b>↓</b><span>Faster / slower</span></div>
                <div><b>1</b>–<b>4</b> / <b>C</b><span>Camera: first, third, follow, free / next</span></div>
                <div><b>H</b><span>Score HUD</span></div>
                <div><b>T</b><span>Stats panel</span></div>
                <div><b>O</b><span>This panel</span></div>
                <div><b>R</b><span>Back to the start</span></div>
                <div><b>F</b><span>Fullscreen</span></div>
                <div><b>Mouse</b><span>Free camera: drag to orbit, right-drag to pan, wheel to zoom</span></div>
                <div><b>W A S D Q E</b><span>Free camera: fly (Shift: faster)</span></div>
                <div class="rb-keys-head">Controller</div>
                <div><b>≡</b><span>Pause (then the cursor works the bar)</span></div>
                <div><b>D-pad ← →</b><span>Back / forward 5 s</span></div>
                <div><b>D-pad ↑ ↓</b><span>Faster / slower</span></div>
                <div><b>Y</b> / <b>△</b><span>Next camera</span></div>
                <div><b>X</b> / <b>□</b><span>Score HUD</span></div>
                <div><b>Sticks</b><span>Free camera: right orbits, left flies</span></div>
                <div><b>LT</b> <b>RT</b><span>Free camera: zoom</span></div>
                <div><b>LB</b> <b>RB</b><span>Free camera: down / up</span></div>
            </div>`;
        }
        body.scrollTop = keepScroll;
    }

    syncButtons() {
        const mode = this.gp.camMode;
        this.el.querySelectorAll('[data-cam]').forEach(b => b.classList.toggle('active', b.dataset.cam === mode));
        this.q('.rb-hud').classList.toggle('active', settings.get('replayHud') !== false);
        this.q('.rb-speed').textContent = `${this.gp.playback}x`;
        document.body.classList.toggle('rb-free', mode === 'free');
    }

    // ---------- timeline ----------
    get duration() { return Math.max(1, audio.songDuration || 1); }

    timeAt(clientX) {
        const r = this.q('#rb-timeline').getBoundingClientRect();
        const f = Math.max(0, Math.min(1, (clientX - r.left) / Math.max(1, r.width)));
        return f * this.duration;
    }

    renderMarkers() {
        const box = this.q('.rb-markers');
        box.innerHTML = '';
        const dur = this.duration;
        const fail = this.gp.replayState.failTime;
        const failEl = this.q('.rb-fail');
        failEl.style.left = fail ? (fail / dur * 100) + '%' : '100%';
        if (!settings.get('replayShowMisses')) return;
        const frag = document.createDocumentFragment();
        for (const m of this.gp.replayMarkers()) {
            const d = document.createElement('div');
            d.className = 'rb-mark ' + m.type;
            d.style.left = (m.time / dur * 100) + '%';
            d.title = `${m.type === 'bad' ? 'Bad cut' : m.type[0].toUpperCase() + m.type.slice(1)} at ${fmtTime(m.time)}`;
            frag.appendChild(d);
        }
        box.appendChild(frag);
    }

    updateTimeline(force = false) {
        const t = audio.songTime;
        const dur = this.duration;
        const f = Math.max(0, Math.min(1, t / dur));
        const key = Math.round(f * 2000);
        if (!force && key === this._tlKey) return;
        this._tlKey = key;
        this.q('.rb-fill').style.transform = `scaleX(${f})`;
        this.q('.rb-head').style.left = (f * 100) + '%';
        const label = `${fmtTime(Math.max(0, t))} / ${fmtTime(this.gp.replayEnd || dur)}`;
        const el = this.q('.rb-time');
        if (el.textContent !== label) el.textContent = label;
    }

    // ---------- per frame (from the main loop) ----------
    update(dt) {
        const gp = this.gp;
        if (gp.finished) return;
        if (this.seekPending !== null) {
            const t = this.seekPending;
            this.seekPending = null;
            this.seek(t);
        }

        this.pollGamepad(dt);
        if (gp.camMode === 'free') this.flyFreeCam(dt);

        const now = performance.now();
        const panelOpen = !this.q('.rb-panel').classList.contains('hidden');
        const show = gp.paused || panelOpen || !!this.drag || now - this.lastInput < HIDE_AFTER || this.el.matches(':hover');
        if (show !== this._shown) {
            this._shown = show;
            this.el.classList.toggle('idle', !show);
            document.body.classList.toggle('rb-idle', !show);
        }
        this.updateTimeline();
    }

    pollGamepad(dt) {
        const gp = this.gp;
        if (!gamepad.connected) return;
        const jp = (b) => gamepad.justPressed(b);
        if (jp(Buttons.DPAD_LEFT)) this.skip(-5);
        if (jp(Buttons.DPAD_RIGHT)) this.skip(5);
        if (gp.paused) return;                   // the virtual cursor owns the rest while paused
        if (jp(Buttons.DPAD_UP)) this.stepSpeed(1);
        if (jp(Buttons.DPAD_DOWN)) this.stepSpeed(-1);
        if (jp(Buttons.Y)) this.cycleCamera();
        if (jp(Buttons.X)) this.toggleSetting('replayHud', 'Score HUD');
        if (gp.camMode === 'free') {
            const L = gamepad.leftStick, R = gamepad.rightStick;
            if (R.x || R.y) gp.freeCamOrbit(-R.x * 2.2 * dt, R.y * 1.6 * dt);
            const sp = 3 * dt;
            if (L.x || L.y) gp.freeCamMove(L.x * sp, 0, -L.y * sp);
            const up = (gamepad.down(Buttons.RB) ? 1 : 0) - (gamepad.down(Buttons.LB) ? 1 : 0);
            if (up) gp.freeCamMove(0, up * sp, 0);
            const zoom = gamepad.trigger(Buttons.LT) - gamepad.trigger(Buttons.RT);
            if (Math.abs(zoom) > 0.05) gp.freeCamZoom(Math.exp(zoom * 1.4 * dt));
            if (L.x || L.y || R.x || R.y || up || Math.abs(zoom) > 0.05) this.poke();
        }
    }

    flyFreeCam(dt) {
        const K = this.keys;
        if (!K.size) return;
        const sp = (K.has('shift') ? 9 : 3) * dt;
        const right = (K.has('d') ? 1 : 0) - (K.has('a') ? 1 : 0);
        const fwd = (K.has('w') ? 1 : 0) - (K.has('s') ? 1 : 0);
        const up = (K.has('e') ? 1 : 0) - (K.has('q') ? 1 : 0);
        if (right || fwd || up) {
            this.gp.freeCamMove(right * sp, up * sp, fwd * sp);
            this.poke();
        }
    }
}
