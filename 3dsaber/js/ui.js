// ============ Shared UI helpers: toasts, setting rows, camera/replay options ============
import { audio } from './audio.js';
import { settings } from './settings.js';

const $ = (id) => document.getElementById(id);

export function toast(msg, type = '') {
    const el = document.createElement('div');
    el.className = 'toast ' + type;
    el.textContent = msg;
    $('toast-container').appendChild(el);
    setTimeout(() => { el.classList.add('out'); setTimeout(() => el.remove(), 350); }, type === 'error' ? 4200 : 2600);
}

export function esc(s) {
    return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

export const fmt = {
    pct: (v) => Math.round(v * 100) + '%',
    deg: (v) => Math.round(v) + '°',
    m: (v) => (Math.abs(v) < 0.005 ? '0' : v.toFixed(2)) + ' m',
    x: (v) => v.toFixed(2) + 'x',
    ms: (v) => (v > 0.005 ? Math.round(v * 1000) + ' ms' : 'Off'),
};

// Setting rows bound to `settings`. onChange(key, value) runs after every change.
export function settingBuilders(body, onChange = () => {}) {
    const s = settings;
    const add = (html) => {
        const row = document.createElement('div');
        row.className = 'setting-row';
        row.innerHTML = html;
        body.appendChild(row);
        return row;
    };
    const label = (title, sub) => `<div class="setting-label">${title}${sub ? `<small>${sub}</small>` : ''}</div>`;

    const b = {
        section(title, sub = '', onReset = null) {
            const h = document.createElement('div');
            h.className = 'setting-section';
            h.innerHTML = `<div><div class="setting-section-title">${esc(title)}</div>${sub ? `<small>${esc(sub)}</small>` : ''}</div>`;
            if (onReset) {
                const r = document.createElement('button');
                r.className = 'sort-btn';
                r.textContent = 'Reset';
                r.onclick = onReset;
                h.appendChild(r);
            }
            body.appendChild(h);
            return h;
        },
        slider(key, title, sub, min, max, step, format) {
            const v0 = s.num(key, min, max);
            const row = add(`${label(title, sub)}
                <div class="setting-control">
                    <input type="range" min="${min}" max="${max}" step="${step}" value="${v0}">
                    <div class="setting-value">${format(v0)}</div>
                </div>`);
            const input = row.querySelector('input');
            input.oninput = () => {
                const v = Number(input.value);
                s.set(key, v);
                row.querySelector('.setting-value').textContent = format(v);
                onChange(key, v);
            };
            return row;
        },
        toggle(key, title, sub) {
            const row = add(`${label(title, sub)}
                <div class="setting-control"><div class="toggle ${s.get(key) ? 'on' : ''}"></div></div>`);
            const t = row.querySelector('.toggle');
            t.onclick = () => {
                const v = !s.get(key);
                s.set(key, v);
                t.classList.toggle('on', v);
                audio.playClick(v ? 880 : 440);
                onChange(key, v);
            };
            return row;
        },
        color(key, title, sub) {
            const row = add(`${label(title, sub)}
                <div class="setting-control"><input type="color" value="${esc(s.get(key))}"></div>`);
            row.querySelector('input').oninput = (e) => { s.set(key, e.target.value); onChange(key, e.target.value); };
            return row;
        },
        choice(key, title, sub, options) {
            const row = add(`${label(title, sub)}
                <div class="setting-control seg">${options.map(([v, l]) =>
                    `<button class="sort-btn ${s.get(key) === v ? 'active' : ''}" data-v="${esc(v)}">${esc(l)}</button>`).join('')}</div>`);
            row.querySelectorAll('[data-v]').forEach(btn => {
                btn.onclick = () => {
                    s.set(key, btn.dataset.v);
                    row.querySelectorAll('[data-v]').forEach(x => x.classList.toggle('active', x === btn));
                    onChange(key, btn.dataset.v);
                };
            });
            return row;
        },
        text(key, title, sub, placeholder) {
            const row = add(`${label(title, sub)}
                <div class="setting-control"><input class="search-box setting-text" type="text" placeholder="${esc(placeholder)}" value="${esc(s.get(key) || '')}"></div>`);
            row.querySelector('input').onchange = (e) => { s.set(key, e.target.value.trim()); toast('Saved'); onChange(key, e.target.value.trim()); };
            return row;
        },
        // rows from a table: [type, key, title, sub, ...args]
        rows(list) {
            for (const [type, ...args] of list) b[type](...args);
        },
    };
    return b;
}

export const CAMERA_LABELS = { first: 'First Person', third: 'Third Person', follow: 'Follow', free: 'Free' };

export const PLAY_CAMERA_ROWS = [
    ['slider', 'camFov', 'Field of View', 'Wider shows more of the lane', 40, 120, 1, fmt.deg],
    ['slider', 'camHeight', 'Height', 'Camera height above the floor', 0.8, 3.5, 0.05, fmt.m],
    ['slider', 'camDistance', 'Distance', 'How far behind the sabers', 1.5, 10, 0.1, fmt.m],
    ['slider', 'camTilt', 'Tilt', 'Look down (+) or up (−)', -15, 40, 1, fmt.deg],
];

export const FIRST_PERSON_ROWS = [
    ['slider', 'fpFov', 'Field of View', 'Headsets see about 100°; 80–90° feels natural on a monitor', 40, 130, 1, fmt.deg],
    ['slider', 'fpPosSmooth', 'Movement Smoothing', '0% follows the head exactly', 0, 1, 0.05, fmt.pct],
    ['slider', 'fpRotSmooth', 'Rotation Smoothing', 'Steadies fast head turns and shakes', 0, 1, 0.05, fmt.pct],
    ['toggle', 'fpLevelHorizon', 'Level Horizon', 'Ignore head tilt so the horizon stays flat'],
    ['slider', 'fpOffsetBack', 'Pull Back', 'Move the view behind the head to see more of the sabers', -0.3, 2, 0.05, fmt.m],
    ['slider', 'fpOffsetUp', 'Raise', 'Move the view up or down', -0.5, 1, 0.05, fmt.m],
];

export const FOLLOW_ROWS = [
    ['slider', 'followDistance', 'Distance', 'How far behind the player', 0.5, 6, 0.1, fmt.m],
    ['slider', 'followHeight', 'Height', 'Above the player\'s head', -0.5, 3, 0.05, fmt.m],
    ['slider', 'followSmooth', 'Smoothing', 'How lazily it follows the head', 0, 1, 0.05, fmt.pct],
];

export const REPLAY_VIEW_ROWS = [
    ['choice', 'replayCamera', 'Camera', 'Also used for the next replay', Object.entries(CAMERA_LABELS)],
    ['toggle', 'replayHud', 'Score HUD', 'Score, combo, multiplier and energy'],
    ['choice', 'replayCutText', 'Cut Scores', 'Shown for every cut', [['total', '115'], ['split', '70 · 15 · 30'], ['off', 'Off']]],
    ['toggle', 'replayStats', 'Stats Panel', 'Per-hand averages, swing parts and mistakes'],
    ['toggle', 'replayHitSounds', 'Hit Sounds', 'Cut and miss sounds'],
    ['toggle', 'replayHead', 'Player Head', 'Show the head in the outside views'],
    ['slider', 'trailLength', 'Saber Trails', 'Trail length (also used when you play)', 0, 0.4, 0.01, fmt.ms],
    ['toggle', 'replayShowMisses', 'Mistakes on Timeline', 'Marks where notes were missed or bombs hit'],
    ['toggle', 'replaySkipIntro', 'Skip Intro', 'Start a moment before the first note'],
];

export const SPEEDS = [0.25, 0.5, 0.75, 1, 1.25, 1.5, 2];

export function fmtTime(sec) {
    if (!Number.isFinite(sec)) return '0:00';
    const neg = sec < 0;
    sec = Math.abs(sec);
    const m = Math.floor(sec / 60), s = Math.floor(sec % 60);
    return `${neg ? '-' : ''}${m}:${String(s).padStart(2, '0')}`;
}
