// ============ Gamepad manager + virtual cursor ============
// Standard mapping: button 0 = A (Xbox) / Cross (PS), 1 = B / Circle, 9 = Start/Options.
// Right stick = axes[2], axes[3].

const DEADZONE = 0.14;

export const Buttons = {
    CONFIRM: 0,
    BACK: 1,
    X: 2,
    Y: 3,
    LB: 4,
    RB: 5,
    LT: 6,
    RT: 7,
    START: 9,
    DPAD_UP: 12,
    DPAD_DOWN: 13,
    DPAD_LEFT: 14,
    DPAD_RIGHT: 15,
};

function dz(v) {
    if (Math.abs(v) < DEADZONE) return 0;
    const s = Math.sign(v);
    return s * (Math.abs(v) - DEADZONE) / (1 - DEADZONE);
}

/**
 * Turn a raw stick reading into saber input, -1..1 per axis.
 * - radial deadzone (a per-axis one drags diagonals onto the axes)
 * - outer deadzone: most sticks never quite report 1.0, worst on diagonals
 * - response curve on the distance from centre (1 = linear)
 * - square: stretch the round stick range onto a square so a full diagonal
 *   reaches the corners of the note grid (a circle only gets 71% of the way)
 */
export function shapeStick(x, y, { deadzone = 0.1, outer = 0.94, curve = 1, square = true } = {}) {
    const m = Math.hypot(x, y);
    if (!(m > deadzone)) return { x: 0, y: 0 };
    let r = Math.min(1, (m - deadzone) / Math.max(0.05, outer - deadzone));
    if (curve !== 1) r = Math.pow(r, curve);
    let ux = x / m, uy = y / m;
    if (square) {
        const k = 1 / Math.max(Math.abs(ux), Math.abs(uy));   // 1 on the axes, √2 on the diagonals
        ux *= k; uy *= k;
    }
    return { x: ux * r, y: uy * r };
}

class GamepadManager {
    constructor() {
        this.index = null;
        this.isPlayStation = false;
        this.prev = [];
        this.curr = [];
        this.values = [];        // analog button values (triggers)
        this.axes = [0, 0, 0, 0];
        this.raw = [0, 0, 0, 0];   // untouched axes (sabers shape them themselves)
        this.rumbleScale = 1;
        this.listeners = { connect: [], disconnect: [] };

        window.addEventListener('gamepadconnected', (e) => {
            if (this.index === null) {
                this.index = e.gamepad.index;
                this.isPlayStation = /054c|playstation|dualshock|dualsense|sony/i.test(e.gamepad.id);
                this.listeners.connect.forEach(fn => fn(e.gamepad));
            }
        });
        window.addEventListener('gamepaddisconnected', (e) => {
            if (this.index === e.gamepad.index) {
                this.index = null;
                this.listeners.disconnect.forEach(fn => fn());
            }
        });
    }

    on(event, fn) { this.listeners[event].push(fn); }

    get connected() { return this.index !== null; }

    poll() {
        this.prev = this.curr;
        this.curr = [];
        this.values = [];
        if (this.index === null) return;
        const gp = navigator.getGamepads()[this.index];
        if (!gp) return;
        this.curr = gp.buttons.map(b => b.pressed);
        this.values = gp.buttons.map(b => b.value || (b.pressed ? 1 : 0));
        this.raw = [gp.axes[0] || 0, gp.axes[1] || 0, gp.axes[2] || 0, gp.axes[3] || 0];
        this.axes = this.raw.map(dz);
    }

    down(i) { return !!this.curr[i]; }
    justPressed(i) { return !!this.curr[i] && !this.prev[i]; }
    trigger(i) { return this.values[i] || 0; }

    // Raw (un-deadzoned) axes for saber control, with deadzone applied per-axis
    get leftStick() { return { x: this.axes[0], y: this.axes[1] }; }
    get rightStick() { return { x: this.axes[2], y: this.axes[3] }; }

    rumble(duration = 80, strong = 0.6, weak = 0.3) {
        if (this.index === null || this.rumbleScale <= 0) return;
        strong *= this.rumbleScale; weak *= this.rumbleScale;
        const gp = navigator.getGamepads()[this.index];
        const act = gp && (gp.vibrationActuator || (gp.hapticActuators && gp.hapticActuators[0]));
        if (act && act.playEffect) {
            act.playEffect('dual-rumble', { duration, strongMagnitude: strong, weakMagnitude: weak }).catch(() => {});
        }
    }
}

export const gamepad = new GamepadManager();

// ============ Virtual cursor (right stick + A/Cross to click) ============
class VirtualCursor {
    constructor() {
        this.el = document.getElementById('cursor');
        this.x = window.innerWidth / 2;
        this.y = window.innerHeight / 2;
        this.enabled = false;
        this.speed = 1.0; // user setting multiplier
        this.hovered = null;
        this.scrollAccum = 0;
        this.onBack = null; // callback for B button

        // Real mouse takes over cursor position (both input methods work)
        window.addEventListener('mousemove', (e) => {
            if (!this.enabled) return;
            this.x = e.clientX;
            this.y = e.clientY;
            this.render();
        });
    }

    enable() {
        this.enabled = true;
        this.el.classList.remove('hidden');
        this.render();
    }

    disable() {
        this.enabled = false;
        this.el.classList.add('hidden');
        this.setHover(null);
    }

    setHover(el) {
        if (this.hovered === el) return;
        if (this.hovered) this.hovered.classList.remove('gp-hover');
        this.hovered = el;
        if (el) el.classList.add('gp-hover');
    }

    hoverTargetAt(x, y) {
        let el = document.elementFromPoint(x, y);
        while (el && el !== document.body) {
            if (el.matches('button, .btn, .song-row, .map-card, .toggle, input, .diff-btn, .sort-btn, .dl-btn, a')) return el;
            el = el.parentElement;
        }
        return null;
    }

    click() {
        const target = document.elementFromPoint(this.x, this.y);
        if (!target) return;
        this.el.classList.add('clicking');
        setTimeout(() => this.el.classList.remove('clicking'), 110);
        const opts = { bubbles: true, cancelable: true, clientX: this.x, clientY: this.y, view: window };
        target.dispatchEvent(new PointerEvent('pointerdown', opts));
        target.dispatchEvent(new MouseEvent('mousedown', opts));
        target.dispatchEvent(new PointerEvent('pointerup', opts));
        target.dispatchEvent(new MouseEvent('mouseup', opts));
        target.dispatchEvent(new MouseEvent('click', opts));
        if (target.matches('input[type="text"], input[type="search"]')) target.focus();
    }

    findScrollable(el) {
        while (el && el !== document.body) {
            const style = getComputedStyle(el);
            if ((style.overflowY === 'auto' || style.overflowY === 'scroll') && el.scrollHeight > el.clientHeight) return el;
            el = el.parentElement;
        }
        return null;
    }

    // the main loop polls the gamepad once per frame before calling this
    update(dt) {
        if (!this.enabled) return;

        const rs = gamepad.rightStick;
        if (rs.x !== 0 || rs.y !== 0) {
            const px = 1050 * this.speed * dt;
            // ease curve for finer control near center
            this.x += Math.sign(rs.x) * Math.pow(Math.abs(rs.x), 1.6) * px;
            this.y += Math.sign(rs.y) * Math.pow(Math.abs(rs.y), 1.6) * px;
            this.x = Math.max(0, Math.min(window.innerWidth - 2, this.x));
            this.y = Math.max(0, Math.min(window.innerHeight - 2, this.y));
            this.render();
        }

        this.setHover(this.hoverTargetAt(this.x, this.y));

        // Left stick or d-pad scrolls the panel under the cursor
        const ls = gamepad.leftStick;
        let scroll = ls.y * 900 * dt;
        if (gamepad.down(Buttons.DPAD_DOWN)) scroll += 640 * dt;
        if (gamepad.down(Buttons.DPAD_UP)) scroll -= 640 * dt;
        if (scroll !== 0) {
            const sc = this.findScrollable(document.elementFromPoint(this.x, this.y));
            if (sc) sc.scrollTop += scroll;
        }

        if (gamepad.justPressed(Buttons.CONFIRM)) this.click();
        if (gamepad.justPressed(Buttons.BACK) && this.onBack) this.onBack();
    }

    render() {
        this.el.style.left = this.x + 'px';
        this.el.style.top = this.y + 'px';
    }
}

export const cursor = new VirtualCursor();
