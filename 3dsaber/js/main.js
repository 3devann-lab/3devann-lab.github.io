// ============ SABER//3D bootstrap ============
import { Engine } from './game.js';
import { Menu, toast } from './menu.js';
import { audio } from './audio.js';
import { gamepad, cursor, Buttons } from './input.js';
import { settings } from './settings.js';

const engine = new Engine(document.getElementById('game-container'));
engine.setBloom(settings.get('bloom'));
engine.setBloomStrength(settings.get('bloomStrength'));
const menu = new Menu(engine);

// The GPU can drop the WebGL context (driver reset, memory pressure). Pause so
// nobody loses their run, and let the browser restore it.
engine.onContextLost = () => {
    toast('Graphics were reset by the browser — recovering…', 'error');
    if (menu.gameplay && !menu.gameplay.paused && !menu.gameplay.finished) menu.pauseGame();
};
// A level whose data keeps throwing every frame gets ended instead of hanging
engine.onGameplayError = (err) => {
    toast('This level hit an error and was stopped: ' + (err && err.message ? err.message : err), 'error');
    menu.abortGameplay();
    menu.showSongs();
};

// Audio context needs a user gesture; also load SFX lazily on first interaction
let audioReady = false;
function ensureAudio() {
    audio.init();                 // also resumes a context that started suspended
    if (audioReady) return;
    audioReady = true;
    audio.setVolumes(settings.get('musicVolume'), settings.get('sfxVolume'));
    audio.loadSfx('hit', 'hitsound.mp3');
    audio.loadSfx('miss', 'misssound.mp3');
}
window.addEventListener('pointerdown', ensureAudio);
window.addEventListener('keydown', ensureAudio);

menu.showHome();
window.__saber = { engine, menu };   // handy for debugging from the console

let lastTime = performance.now();
function loop() {
    requestAnimationFrame(loop);
    const now = performance.now();
    const dt = Math.min(0.05, (now - lastTime) / 1000);
    lastTime = now;

    gamepad.poll();          // exactly once per frame (double polling ate button presses)
    if (!audioReady && gamepad.curr.some(Boolean)) ensureAudio();

    const gp = menu.gameplay;
    if (gp && !gp.paused && !gp.finished) {
        if (gamepad.justPressed(Buttons.START)) menu.pauseGame();
    } else {
        cursor.update(dt);
        if (gp && gp.paused && gamepad.justPressed(Buttons.START)) menu.resumeGame();
    }
    if (menu.replayControls && menu.gameplay) menu.replayControls.update(dt);

    engine.update();
}

loop();
