// ============ MOSU bootstrap + frame loop ============
import { Renderer } from './game.js';
import { UI } from './ui.js';
import { audio } from './audio.js';
import { input } from './input.js';
import { settings } from './storage.js';

const renderer = new Renderer(document.getElementById('game'));
const ui = new UI(renderer);
input.attachTouch(renderer.canvas);

// browsers only start audio after a user gesture
const unlock = () => {
    audio.init();
    audio.setVolumes(settings.get('musicVolume'), settings.get('sfxVolume'));
};
window.addEventListener('pointerdown', unlock, { once: true });
window.addEventListener('keydown', unlock, { once: true });

ui.showTitle();
window.__mosu = { ui, renderer, audio };   // handy for debugging from the console

// Gamepad menu navigation: d-pad/stick moves focus, A clicks, B goes back
let navPrev = [];
function navigateMenus() {
    if (ui.game && !ui.game.paused) { navPrev = []; return; }
    const pads = navigator.getGamepads ? navigator.getGamepads() : [];
    const gp = pads && [...pads].find(p => p && p.connected);
    if (!gp) return;
    const cur = gp.buttons.map(b => b.pressed);
    const ax = gp.axes[0] || 0, ay = gp.axes[1] || 0;
    cur[100] = ay < -0.6; cur[101] = ay > 0.6; cur[102] = ax < -0.6; cur[103] = ax > 0.6;
    const pressed = (i) => cur[i] && !navPrev[i];
    const focusables = [...document.querySelectorAll('#ui button:not(:disabled), #ui .level-card, #ui input, #ui select')]
        .filter(el => el.offsetParent !== null);
    if (focusables.length) {
        let idx = focusables.indexOf(document.activeElement);
        const move = (d) => { idx = idx < 0 ? 0 : (idx + d + focusables.length) % focusables.length; focusables[idx].focus(); };
        if (pressed(13) || pressed(101) || pressed(15) || pressed(103)) move(1);
        if (pressed(12) || pressed(100) || pressed(14) || pressed(102)) move(-1);
        if (pressed(0) && document.activeElement && document.activeElement !== document.body) { unlock(); document.activeElement.click(); }
        if (pressed(1)) {
            const back = document.querySelector('#ui #b-back, #ui #r-back, #ui #p-resume, #ui #e-back');
            if (back) back.click();
        }
    }
    navPrev = cur;
}

let last = performance.now();
function frame() {
    requestAnimationFrame(frame);
    const now = performance.now();
    const dt = Math.min(0.05, (now - last) / 1000);
    last = now;
    input.pollGamepad();
    navigateMenus();
    if (ui.game) ui.game.update(dt);
    else renderer.update(dt, null);
}
frame();
