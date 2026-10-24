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
            const cur = s.get(key);
            const row = add(`${label(title, sub)}
                <div class="setting-control seg">${options.map(([v, l], i) =>
                    `<button class="sort-btn ${cur === v || String(cur) === String(v) ? 'active' : ''}" data-i="${i}">${esc(l)}</button>`).join('')}</div>`);
            row.querySelectorAll('[data-i]').forEach(btn => {
                btn.onclick = () => {
                    const v = options[Number(btn.dataset.i)][0];     // keeps numbers as numbers
                    s.set(key, v);
                    row.querySelectorAll('[data-i]').forEach(x => x.classList.toggle('active', x === btn));
                    onChange(key, v);
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

export const CONTROL_ROWS = [
    ['slider', 'saberReachX', 'Horizontal Reach', 'How far sideways a full push moves the saber (lanes are 0.6 m apart)', 0.6, 2, 0.05, fmt.m],
    ['slider', 'saberReachY', 'Vertical Reach', 'How far up/down a full push moves the saber (rows are 0.55 m apart)', 0.4, 1.4, 0.05, fmt.m],
    ['slider', 'saberRestHeight', 'Rest Height', 'Where the saber cuts with the stick centred (1.40 m = middle row)', 0.8, 2, 0.05, fmt.m],
    ['slider', 'saberRestSpread', 'Rest Spread', 'How far apart the sabers rest (0.30 m = each on its inner lane)', 0, 0.9, 0.05, fmt.m],
    ['toggle', 'stickSquare', 'Reach Corners', 'Diagonals reach the grid corners (a round stick only gets 71% of the way)'],
    ['slider', 'stickDeadzone', 'Deadzone', 'Ignore small stick drift (round, so diagonals stay smooth)', 0, 0.4, 0.01, fmt.pct],
    ['slider', 'stickRange', 'Full Tilt At', 'How far you push for the edge of the reach (lower = less thumb travel)', 0.6, 1, 0.01, fmt.pct],
    ['slider', 'stickCurve', 'Response Curve', '1.00 = linear · higher = finer control near centre, faster at the edge', 0.5, 2.5, 0.05, (v) => v.toFixed(2)],
    ['slider', 'saberSmoothing', 'Saber Smoothing', 'Steadies the saber; 0 = follows the stick instantly', 0, 0.08, 0.002, (v) => (v < 0.001 ? 'Off' : Math.round(v * 1000) + ' ms')],
    ['slider', 'saberTilt', 'Blade Tilt', 'How far the blade leans toward the notes', 0, 60, 1, fmt.deg],
    ['toggle', 'swapSticks', 'Swap Sticks', 'Left stick moves the right (blue) saber and vice versa'],
    ['toggle', 'invertY', 'Invert Vertical', 'Push up to move the saber down'],
    ['slider', 'aimAssist', 'Aim Assist', 'Sabers drift toward matching notes (0 = off)', 0, 1, 0.1, fmt.pct],
    ['slider', 'rumble', 'Vibration', 'Controller rumble strength', 0, 1, 0.05, (v) => (v < 0.01 ? 'Off' : fmt.pct(v))],
];

export const MOD_ROWS = [
    ['choice', 'modSpeed', 'Song Speed', 'Slower is great for practice (no high score below 1x)', [[0.5, '0.5x'], [0.75, '0.75x'], [1, '1x'], [1.25, '1.25x'], [1.5, '1.5x'], [2, '2x']]],
    ['toggle', 'noFail', 'No Fail', 'Never fail a song'],
    ['toggle', 'modInstantFail', 'Instant Fail', 'One mistake ends the song'],
    ['toggle', 'modStrict', 'Strict Angles', 'Cutting against the arrow is a bad cut'],
    ['toggle', 'modNoArrows', 'No Arrows', 'Every note can be cut any way'],
    ['toggle', 'modGhost', 'Ghost Notes', 'Only the arrows are visible'],
    ['toggle', 'modDisappear', 'Disappearing Arrows', 'Arrows vanish before the note arrives'],
    ['toggle', 'modSmallNotes', 'Small Notes', 'Notes look smaller (same hit area)'],
    ['toggle', 'modNoBombs', 'No Bombs', ''],
    ['toggle', 'modNoWalls', 'No Walls', ''],
];

export const SOUND_ROWS = [
    ['slider', 'musicVolume', 'Music Volume', 'Song playback level', 0, 1, 0.05, fmt.pct],
    ['slider', 'sfxVolume', 'Effects Volume', 'Hit sounds and UI', 0, 1, 0.05, fmt.pct],
    ['choice', 'hitSound', 'Hit Sound', '', [['soft', 'Soft'], ['classic', 'Classic'], ['off', 'Off']]],
    ['toggle', 'missSound', 'Miss Sound', 'Sound for misses, bad cuts and bombs'],
    ['slider', 'audioOffset', 'Audio Offset', 'Notes reach you late vs the music? Lower it. Early (common with Bluetooth)? Raise it.', -300, 300, 5, (v) => (v > 0 ? '+' : '') + Math.round(v) + ' ms'],
];

export const LOOK_ROWS = [
    ['slider', 'noteSize', 'Note Size', 'Bigger notes are easier to read (same hit area)', 0.6, 1.4, 0.05, fmt.x],
    ['choice', 'judgeStyle', 'Hit Text', 'What pops up when you cut', [['words', 'PERFECT'], ['numbers', '115'], ['off', 'Off']]],
    ['slider', 'hitParticles', 'Hit Sparks', 'Amount of sparks per cut', 0, 2, 0.1, (v) => (v < 0.05 ? 'Off' : fmt.x(v))],
    ['toggle', 'cutHalves', 'Cut Halves', 'Cut notes split into two flying halves'],
    ['slider', 'lightBrightness', 'Light Brightness', 'How bright the map\'s light show is', 0.2, 1.6, 0.05, fmt.pct],
    ['toggle', 'reduceFlashing', 'Reduce Flashing', 'No strobes or flashes — lights fade smoothly (photosensitivity)'],
];

export const HUD_ROWS = [
    ['slider', 'hudScale', 'HUD Size', '', 0.6, 1.4, 0.05, fmt.pct],
    ['slider', 'hudOpacity', 'HUD Opacity', '', 0.2, 1, 0.05, fmt.pct],
    ['toggle', 'hudTimer', 'Song Timer', 'Elapsed / total time under the song name'],
    ['toggle', 'showFps', 'FPS Counter', 'Frames per second in the corner'],
];

export const SPEEDS = [0.25, 0.5, 0.75, 1, 1.25, 1.5, 2];

export function fmtTime(sec) {
    if (!Number.isFinite(sec)) return '0:00';
    const neg = sec < 0;
    sec = Math.abs(sec);
    const m = Math.floor(sec / 60), s = Math.floor(sec % 60);
    return `${neg ? '-' : ''}${m}:${String(s).padStart(2, '0')}`;
}
