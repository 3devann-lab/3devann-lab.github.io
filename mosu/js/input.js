// ============ MOSU input: keyboard, gamepad, touch swipes ============
// Every press carries the timestamp it happened at, so judging is exact
// regardless of frame rate.

const KEYMAP = {
    KeyW: 'up', ArrowUp: 'up', KeyI: 'up',
    KeyS: 'down', ArrowDown: 'down', KeyK: 'down',
    KeyA: 'left', ArrowLeft: 'left', KeyJ: 'left',
    KeyD: 'right', ArrowRight: 'right', KeyL: 'right',
};
// standard gamepad: d-pad 12-15, face buttons Y/A/X/B
const PAD_BUTTONS = { 12: 'up', 13: 'down', 14: 'left', 15: 'right', 3: 'up', 0: 'down', 2: 'left', 1: 'right' };

export class Input {
    constructor() {
        this.held = { up: false, down: false, left: false, right: false };
        this.onPress = null;        // (dir, timeMs, source)
        this.onRelease = null;      // (dir, timeMs)
        this.onPause = null;
        this.enabled = false;
        this._keyCount = { up: 0, down: 0, left: 0, right: 0 };
        this._padPrev = [];
        this._stickDir = null;
        this.gamepadConnected = false;

        window.addEventListener('keydown', (e) => this._key(e, true));
        window.addEventListener('keyup', (e) => this._key(e, false));
        window.addEventListener('blur', () => this.releaseAll());
        window.addEventListener('gamepadconnected', () => { this.gamepadConnected = true; });
        window.addEventListener('gamepaddisconnected', () => { this.gamepadConnected = false; });
        this._codesDown = new Set();
    }

    _key(e, down) {
        if (e.target && e.target.matches && e.target.matches('input, textarea, select')) return;
        if (down && (e.code === 'Escape' || e.code === 'KeyP') && this.enabled) {
            e.preventDefault();
            if (this.onPause) this.onPause();
            return;
        }
        const dir = KEYMAP[e.code];
        if (!dir || !this.enabled) return;
        e.preventDefault();
        if (down) {
            if (e.repeat || this._codesDown.has(e.code)) return;
            this._codesDown.add(e.code);
            this._press(dir, e.timeStamp, 'key');
        } else {
            if (!this._codesDown.has(e.code)) return;
            this._codesDown.delete(e.code);
            this._release(dir, e.timeStamp);
        }
    }

    _press(dir, t, source) {
        this._keyCount[dir]++;
        this.held[dir] = true;
        if (this.onPress) this.onPress(dir, t, source);
    }

    _release(dir, t) {
        this._keyCount[dir] = Math.max(0, this._keyCount[dir] - 1);
        if (this._keyCount[dir] === 0) {
            this.held[dir] = false;
            if (this.onRelease) this.onRelease(dir, t);
        }
    }

    releaseAll() {
        const t = performance.now();
        for (const d in this.held) {
            if (this.held[d]) { this._keyCount[d] = 1; this._release(d, t); }
        }
        this._codesDown.clear();
        this._padPrev = [];
        this._stickDir = null;
    }

    // called once per frame
    pollGamepad() {
        const pads = navigator.getGamepads ? navigator.getGamepads() : [];
        const gp = pads && [...pads].find(p => p && p.connected);
        if (!gp) return;
        const now = performance.now();
        const cur = gp.buttons.map(b => b.pressed);
        if (this.enabled) {
            if (cur[9] && !this._padPrev[9] && this.onPause) this.onPause();
            for (const i in PAD_BUTTONS) {
                if (cur[i] && !this._padPrev[i]) this._press(PAD_BUTTONS[i], now, 'pad');
                else if (!cur[i] && this._padPrev[i]) this._release(PAD_BUTTONS[i], now);
            }
            // left stick flicks
            const x = gp.axes[0] || 0, y = gp.axes[1] || 0;
            const mag = Math.hypot(x, y);
            if (!this._stickDir && mag > 0.65) {
                this._stickDir = Math.abs(x) > Math.abs(y) ? (x > 0 ? 'right' : 'left') : (y > 0 ? 'down' : 'up');
                this._press(this._stickDir, now, 'stick');
            } else if (this._stickDir && mag < 0.35) {
                this._release(this._stickDir, now);
                this._stickDir = null;
            }
        }
        this._padPrev = cur;
    }

    // Swipes on the play area (phones/tablets). Holding after a swipe holds.
    attachTouch(el) {
        const active = new Map();   // pointerId -> {x, y, t, dir}
        el.addEventListener('pointerdown', (e) => {
            if (!this.enabled || e.pointerType === 'mouse') return;
            active.set(e.pointerId, { x: e.clientX, y: e.clientY, t: e.timeStamp, dir: null });
            try { el.setPointerCapture(e.pointerId); } catch (err) { /* pointer already gone */ }
        });
        el.addEventListener('pointermove', (e) => {
            const p = active.get(e.pointerId);
            if (!p || p.dir) return;
            const dx = e.clientX - p.x, dy = e.clientY - p.y;
            if (Math.hypot(dx, dy) > 28) {
                p.dir = Math.abs(dx) > Math.abs(dy) ? (dx > 0 ? 'right' : 'left') : (dy > 0 ? 'down' : 'up');
                this._press(p.dir, e.timeStamp, 'touch');
            }
        });
        const end = (e) => {
            const p = active.get(e.pointerId);
            if (!p) return;
            active.delete(e.pointerId);
            if (p.dir) this._release(p.dir, e.timeStamp);
            else if (e.type === 'pointerup' && e.timeStamp - p.t < 250) {
                // a tap counts for "any" notes
                if (this.onPress) this.onPress('tap', p.t, 'touch');
            }
        };
        el.addEventListener('pointerup', end);
        el.addEventListener('pointercancel', end);
    }
}

export const input = new Input();
