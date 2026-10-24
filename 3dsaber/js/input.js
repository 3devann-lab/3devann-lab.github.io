// ============ Gamepad manager + virtual cursor ============
// Standard mapping: button 0 = A (Xbox) / Cross (PS), 1 = B / Circle, 9 = Start/Options.
// Right stick = axes[2], axes[3].

const DEADZONE = 0.14;

export const Buttons = {
    CONFIRM: 0,
    BACK: 1,
    Y: 3,
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

class GamepadManager {
    constructor() {
        this.index = null;
        this.isPlayStation = false;
        this.prev = [];
        this.curr = [];
        this.axes = [0, 0, 0, 0];
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
        if (this.index === null) return;
        const gp = navigator.getGamepads()[this.index];
        if (!gp) return;
        this.curr = gp.buttons.map(b => b.pressed);
        this.axes = [dz(gp.axes[0] || 0), dz(gp.axes[1] || 0), dz(gp.axes[2] || 0), dz(gp.axes[3] || 0)];
    }

    down(i) { return !!this.curr[i]; }
    justPressed(i) { return !!this.curr[i] && !this.prev[i]; }

    // Raw (un-deadzoned) axes for saber control, with deadzone applied per-axis
    get leftStick() { return { x: this.axes[0], y: this.axes[1] }; }
    get rightStick() { return { x: this.axes[2], y: this.axes[3] }; }

    rumble(duration = 80, strong = 0.6, weak = 0.3) {
        if (this.index === null) return;
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
