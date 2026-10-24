// ============ MOSU UI: menus, level select, results, settings, calibration ============
import { audio } from './audio.js';
import { input } from './input.js';
import { settings, getBest, saveResult, customLevels } from './storage.js';
import {
    LEVELS, PACKS, STYLE_LABEL, levelSong, generateChart, approachFor,
    endlessChart, classicChart, normalizeCustomLevel, exportLevelJson,
} from './levels.js';
import { renderSong, renderSongProgressive, compose, hashString, STYLE_NAMES } from './music.js';
import { Game } from './game.js';
import { Editor } from './editor.js';

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const starsHtml = (n) => `<span class="stars">${'★'.repeat(n)}<span class="off">${'★'.repeat(10 - n)}</span></span>`;
const fmtTime = (s) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;

export function toast(msg, kind = '') {
    const el = document.createElement('div');
    el.className = 'toast ' + kind;
    el.textContent = msg;
    $('toasts').appendChild(el);
    setTimeout(() => el.remove(), kind === 'error' ? 4200 : 2600);
}

export class UI {
    constructor(renderer) {
        this.r = renderer;
        this.root = $('ui');
        this.game = null;
        this.cache = new Map();          // level id -> {song, buffer}
        this.pack = 'p1';
        this.editor = new Editor(this);
        $('hud-pause').onclick = () => this.pause();
        document.addEventListener('visibilitychange', () => { if (document.hidden) this.pause(); });
        this.root.addEventListener('click', (e) => { if (e.target.closest('button, .level-card')) audio.click(); });
    }

    screen(html, cls = '') {
        this.root.innerHTML = `<div class="screen ${cls}">${html}</div>`;
        return this.root.firstChild;
    }

    // ============ TITLE ============
    showTitle() {
        this.screen(`
            <h1 class="logo"><span>M</span><span>O</span><span>S</span><span>U</span></h1>
            <div class="tagline">Hit the arrows. Ride the beat. ${LEVELS.length} levels + endless.</div>
            <div class="menu">
                <button class="btn primary" id="b-play">Play</button>
                <button class="btn" id="b-endless">Endless</button>
                <button class="btn" id="b-mine">My Levels</button>
                <button class="btn" id="b-editor">Level Editor</button>
                <div class="btn-row">
                    <button class="btn small" id="b-how">How to Play</button>
                    <button class="btn small" id="b-settings">Settings</button>
                </div>
            </div>
            <div class="controls-hint">
                <span><span class="key">W</span><span class="key">A</span><span class="key">S</span><span class="key">D</span> or arrow keys</span>
                <span>🎮 D-pad / face buttons / stick</span>
                <span>📱 swipe</span>
            </div>`);
        $('b-play').onclick = () => this.showLevels();
        $('b-endless').onclick = () => this.showEndless();
        $('b-mine').onclick = () => this.showMyLevels();
        $('b-editor').onclick = () => this.editor.open();
        $('b-how').onclick = () => this.showHowTo();
        $('b-settings').onclick = () => this.showSettings();
        $('b-play').focus();
    }

    // ============ LEVEL SELECT ============
    packUnlocked(i) {
        if (i === 0 || settings.get('unlockAll')) return true;
        const prev = PACKS[i - 1].id;
        return LEVELS.filter(l => l.pack === prev && getBest(l.id)?.cleared).length >= 3;
    }

    showLevels(packId = this.pack) {
        this.pack = packId;
        const pi = PACKS.findIndex(p => p.id === packId);
        const pack = PACKS[pi];
        const unlocked = this.packUnlocked(pi);
        const cleared = LEVELS.filter(l => getBest(l.id)?.cleared).length;
        const el = this.screen(`
            <div class="panel">
                <div class="panel-head">
                    <div class="panel-title">Levels <small style="font-size:14px;color:var(--dim);font-weight:500">${cleared}/${LEVELS.length} cleared</small></div>
                    <button class="btn small" id="b-back">← Back</button>
                </div>
                <div class="panel-body">
                    <div class="tabs" style="margin-bottom:12px">
                        ${PACKS.map((p, i) => `<button class="tab ${p.id === packId ? 'active' : ''} ${this.packUnlocked(i) ? '' : 'locked'}" data-pack="${p.id}" style="color:${p.color}">
                            <span class="dot" style="background:${p.color}"></span>${esc(p.name)}${this.packUnlocked(i) ? '' : ' 🔒'}</button>`).join('')}
                    </div>
                    <p class="pack-blurb">${esc(pack.blurb)}${unlocked ? '' : ` — clear 3 levels in <b>${esc(PACKS[pi - 1].name)}</b> to unlock (or turn on “Unlock all” in Settings).`}</p>
                    <div class="level-grid" id="grid"></div>
                </div>
            </div>`);
        $('b-back').onclick = () => this.showTitle();
        el.querySelectorAll('[data-pack]').forEach(b => { b.onclick = () => this.showLevels(b.dataset.pack); });
        const grid = $('grid');
        LEVELS.filter(l => l.pack === packId).forEach((lv) => {
            const idx = LEVELS.indexOf(lv) + 1;
            const best = getBest(lv.id);
            const card = document.createElement('div');
            card.className = 'level-card' + (unlocked ? '' : ' locked');
            card.tabIndex = 0;
            card.style.setProperty('--c', pack.color);
            card.innerHTML = `
                <div class="level-num">LEVEL ${idx}</div>
                <div class="level-name">${esc(lv.title)}</div>
                <div class="level-meta"><span>${STYLE_LABEL[lv.style]}</span><span>${lv.bpm} BPM</span></div>
                <div style="margin-top:6px">${starsHtml(lv.stars)}</div>
                ${best ? `<div class="grade-badge grade-${best.grade}">${best.grade}</div>
                    <div class="level-meta" style="margin-top:6px"><span>${best.score.toLocaleString()}</span><span>${(best.accuracy * 100).toFixed(1)}%</span>${best.fc ? '<span class="fc-tag">FULL COMBO</span>' : ''}</div>` : ''}`;
            const go = () => { if (unlocked) this.playLevel(lv); else toast('This pack is locked'); };
            card.onclick = go;
            card.onkeydown = (e) => { if (e.key === 'Enter' || e.key === ' ') go(); };
            grid.appendChild(card);
        });
        const first = grid.querySelector('.level-card');
        if (first) first.focus();
        if (unlocked) this.prefetch(LEVELS.filter(l => l.pack === packId).find(l => !getBest(l.id)?.cleared));
    }

    loading(what, sub = '') {
        this.screen(`<div class="loader"><div class="spinner"></div><div class="what">${esc(what)}</div><div class="sub">${esc(sub)}</div></div>`, 'dim');
    }

    // Progressive render: resolves once the opening is ready; `rest` follows.
    // Cached entries keep the full song once both parts exist.
    songFor(level) {
        let c = this.cache.get(level.id);
        if (!c) {
            const song = levelSong(level);
            const r = renderSongProgressive(song);
            c = { song, first: r.first, split: r.split };
            c.rest = r.rest ? r.rest.then(buffer => ({ buffer, at: r.split })) : null;
            c.ready = r.first.then(async (first) => {
                c.firstBuffer = first;
                if (c.rest) c.rest.then(({ buffer }) => { c.restBuffer = buffer; }).catch(() => {});
            });
            this.cache.set(level.id, c);
            if (this.cache.size > 3) this.cache.delete(this.cache.keys().next().value);   // ~20 MB per song
        }
        return c;
    }

    // what to hand the audio engine for a cached song
    sourceFor(c) {
        const parts = [{ buffer: c.firstBuffer, at: 0 }];
        if (c.restBuffer) parts.push({ buffer: c.restBuffer, at: c.split });
        const pending = !!c.rest && !c.restBuffer;
        return { src: { parts, duration: c.song.duration, pending }, rest: pending ? c.rest : null };
    }

    // warm up a level's song in the background (menus are idle time)
    prefetch(level) {
        if (!level || this.cache.has(level.id)) return;
        setTimeout(() => { if (!this.game) this.songFor(level); }, 400);
    }

    async playLevel(level) {
        audio.init();
        try {
            const c = this.songFor(level);
            if (!c.firstBuffer) {
                this.loading(`Composing “${level.title}”…`, `${STYLE_LABEL[level.style]} · ${level.bpm} BPM`);
                await c.ready;
            }
            const { src, rest } = this.sourceFor(c);
            const pack = PACKS.find(p => p.id === level.pack);
            this.start({
                id: level.id, kind: 'level', level,
                title: `${level.title} · ${STYLE_LABEL[level.style]}`,
                notes: generateChart(c.song, level.stars, { seed: hashString(level.id) }),
                approach: approachFor(level.stars),
                buffer: src, rest, beats: c.song.beats, theme: pack.color, mode: 'level',
            });
        } catch (err) {
            console.error(err);
            toast('Could not start: ' + err.message, 'error');
            this.showLevels();
        }
    }

    // ============ ENDLESS ============
    showEndless() {
        const remix = getBest('endless-remix'), classic = getBest('endless-classic');
        this.screen(`
            <div class="panel narrow">
                <div class="panel-head"><div class="panel-title">Endless</div><button class="btn small" id="b-back">← Back</button></div>
                <div class="panel-body">
                    <div class="mode-grid" style="grid-template-columns:1fr">
                        <div class="level-card" id="m-remix" tabindex="0" style="--c:var(--flip)">
                            <div class="level-num">TODAY'S MIX</div>
                            <div class="level-name">Endless Remix</div>
                            <div class="level-meta"><span>A new track every day. It loops, and every loop gets faster and denser — how long can you last?</span></div>
                            ${remix ? `<div class="level-meta" style="margin-top:6px"><span>Best ${remix.score.toLocaleString()}</span></div>` : ''}
                        </div>
                        <div class="level-card" id="m-classic" tabindex="0" style="--c:var(--up)">
                            <div class="level-num">THE ORIGINAL</div>
                            <div class="level-name">Endless Classic</div>
                            <div class="level-meta"><span>The original MOSU loop and random arrows that keep speeding up.</span></div>
                            ${classic ? `<div class="level-meta" style="margin-top:6px"><span>Best ${classic.score.toLocaleString()}</span></div>` : ''}
                        </div>
                    </div>
                </div>
            </div>`);
        $('b-back').onclick = () => this.showTitle();
        $('m-remix').onclick = () => this.playEndless();
        $('m-classic').onclick = () => this.playClassic();
        $('m-remix').focus();
        this.endlessSong();          // start mixing in the background
    }

    endlessSong() {
        const day = Math.floor(Date.now() / 86400000);
        const id = 'endless-' + day;
        let c = this.cache.get(id);
        if (!c) {
            const style = STYLE_NAMES[day % STYLE_NAMES.length];
            const song = compose({ seed: day * 7919, bpm: 120 + (day % 5) * 6, root: 52 + (day % 9), scale: day % 2 ? 'minor' : 'dorian', style, loop: true });
            c = { song, style, buffer: null };
            c.ready = renderSong(song).then(b => { c.buffer = b; });
            this.cache.set(id, c);
        }
        return c;
    }

    async playEndless() {
        audio.init();
        const c = this.endlessSong();
        if (!c.buffer) {
            this.loading('Mixing today\'s endless track…', STYLE_LABEL[c.style]);
            await c.ready;
        }
        const { notes, approach } = endlessChart(c.song, 40, 2);
        this.start({
            id: 'endless-remix', kind: 'endless', title: 'Endless Remix',
            notes, buffer: c.buffer, loop: true, loopDuration: c.song.duration, beats: c.song.beats,
            approachAt: (t) => approach[Math.max(0, Math.min(approach.length - 1, Math.floor(t / c.song.duration)))].approach,
            theme: '#b96fff', mode: 'endless',
        });
    }

    async playClassic() {
        audio.init();
        try {
            if (!this.classicBuffer) {
                this.loading('Loading the original loop…');
                const raw = await audio.decode(await (await fetch('background_music.mp3')).arrayBuffer());
                // cut an exact 3.0 s bar (the file has MP3 padding) so the loop never drifts
                const start = Math.round(0.03 * raw.sampleRate), len = Math.round(3.0 * raw.sampleRate);
                const buf = audio.ctx.createBuffer(raw.numberOfChannels, len, raw.sampleRate);
                for (let ch = 0; ch < raw.numberOfChannels; ch++) buf.copyToChannel(raw.getChannelData(ch).subarray(start, start + len), ch);
                this.classicBuffer = buf;
            }
            const bpm = 80, phase = 0.342;
            const beats = [0, 1, 2, 3].map(i => ({ t: phase + i * 0.75, down: i === 0 }));
            this.start({
                id: 'endless-classic', kind: 'endless', title: 'Endless Classic',
                notes: classicChart(bpm, phase), buffer: this.classicBuffer, loop: true, loopDuration: 3.0, beats,
                approachAt: (t) => Math.max(0.75, 1.8 - t * 0.008), theme: '#4fc3f7', mode: 'classic',
            });
        } catch (err) {
            console.error(err);
            toast('Could not load the classic track', 'error');
            this.showEndless();
        }
    }

    // ============ MY LEVELS ============
    async showMyLevels() {
        this.screen(`
            <div class="panel narrow">
                <div class="panel-head">
                    <div class="panel-title">My Levels</div>
                    <button class="btn small" id="b-import">Import .zip</button>
                    <button class="btn small" id="b-new">+ New</button>
                    <button class="btn small" id="b-back">← Back</button>
                </div>
                <div class="panel-body" id="list"><div class="spinner"></div></div>
            </div>`);
        $('b-back').onclick = () => this.showTitle();
        $('b-new').onclick = () => this.editor.open();
        $('b-import').onclick = () => this.importZip();
        const list = $('list');
        const recs = await customLevels.list().catch(() => []);
        if (!list.isConnected) return;
        if (!recs.length) {
            list.innerHTML = `<p class="pack-blurb" style="text-align:center;margin:40px 0">No custom levels yet.<br>Make one in the <b>Level Editor</b> — upload any song, then record your taps or let MOSU auto-chart it.</p>`;
            return;
        }
        list.innerHTML = '';
        for (const rec of recs) {
            const best = getBest(rec.id);
            const row = document.createElement('div');
            row.className = 'level-card';
            row.style.marginBottom = '10px';
            row.innerHTML = `
                <div class="level-name">${esc(rec.meta.title)}</div>
                <div class="level-meta"><span>${esc(rec.meta.artist || 'Custom')}</span><span>${rec.notes.length} notes</span><span>${Math.round(rec.meta.bpm)} BPM</span>
                    ${best ? `<span class="grade-${best.grade}">${best.grade} · ${best.score.toLocaleString()}</span>` : ''}</div>
                <div class="btn-row" style="justify-content:flex-start;margin-top:10px">
                    <button class="btn small primary" data-a="play">Play</button>
                    <button class="btn small" data-a="edit">Edit</button>
                    <button class="btn small" data-a="export">Export</button>
                    <button class="btn small danger" data-a="del">Delete</button>
                </div>`;
            row.querySelectorAll('[data-a]').forEach(b => {
                b.onclick = async (e) => {
                    e.stopPropagation();
                    const a = b.dataset.a;
                    if (a === 'play') this.playCustom(rec);
                    else if (a === 'edit') this.editor.open(rec);
                    else if (a === 'export') this.exportZip(rec);
                    else if (a === 'del' && confirm(`Delete "${rec.meta.title}"?`)) { await customLevels.remove(rec.id); this.showMyLevels(); }
                };
            });
            row.onclick = () => this.playCustom(rec);
            list.appendChild(row);
        }
    }

    async playCustom(rec, fromEditor = false) {
        audio.init();
        try {
            this.loading('Loading level…');
            const buffer = await audio.decode(rec.audio);
            const spb = 60 / (rec.meta.bpm || 120);
            const beats = [];
            for (let t = rec.meta.offset || 0; t < buffer.duration; t += spb) beats.push({ t, down: beats.length % 4 === 0 });
            this.start({
                id: rec.id, kind: 'custom', rec, fromEditor,
                title: rec.meta.title + (rec.meta.artist ? ` · ${rec.meta.artist}` : ''),
                notes: rec.notes, approach: rec.meta.approach || 1.4, buffer, beats,
                theme: '#3dffa0', mode: 'custom',
            });
        } catch (err) {
            console.error(err);
            toast('Could not play that level: ' + err.message, 'error');
            if (fromEditor) this.editor.open(rec); else this.showMyLevels();
        }
    }

    async importZip() {
        const pick = document.createElement('input');
        pick.type = 'file';
        pick.accept = '.zip,application/zip';
        pick.onchange = async () => {
            const f = pick.files && pick.files[0];
            if (!f) return;
            try {
                const rec = await readLevelZip(f);
                await customLevels.put(rec);
                toast(`Imported "${rec.meta.title}"`, 'ok');
                this.showMyLevels();
            } catch (err) {
                console.error(err);
                toast('Import failed: ' + err.message, 'error');
            }
        };
        pick.click();
    }

    async exportZip(rec) {
        const zip = new JSZip();
        zip.file('level.json', exportLevelJson(rec.meta, rec.notes));
        zip.file(rec.audioName || 'song.mp3', rec.audio);
        const blob = await zip.generateAsync({ type: 'blob' });
        const a = document.createElement('a');
        a.href = URL.createObjectURL(blob);
        a.download = (rec.meta.title || 'mosu-level').replace(/[^\w\- ]+/g, '').trim() + '.zip';
        a.click();
        setTimeout(() => URL.revokeObjectURL(a.href), 4000);
    }

    // ============ GAME FLOW ============
    start(session) {
        this.session = session;
        this.root.innerHTML = '';
        $('hud').classList.remove('hidden');
        $('hud-title').textContent = session.title;
        $('hud-time').textContent = '';
        $('hud-progress').classList.toggle('hidden', !!session.loop);
        if (this.game) this.game.destroy();
        this.game = new Game(this.r, session, {
            onEnd: (res) => this.finished(res),
            onPause: () => this.pause(),
        });
        // Browsers only unlock audio on a click/key/touch (not a gamepad button).
        // The game clock is the audio clock, so ask for one if it's still locked.
        setTimeout(() => {
            const g = this.game;
            if (!g || g.paused || !audio.ctx || audio.ctx.state === 'running') return;
            this.screen(`<div class="loader"><div class="what">Click, tap or press any key to start</div>
                <div class="sub">Your browser needs one click before it plays sound.</div></div>`, 'dim');
            const go = () => {
                window.removeEventListener('pointerdown', go, true);
                window.removeEventListener('keydown', go, true);
                audio.ctx.resume();
                if (this.game === g) this.root.innerHTML = '';
            };
            window.addEventListener('pointerdown', go, true);
            window.addEventListener('keydown', go, true);
        }, 350);
    }

    pause() {
        const g = this.game;
        if (!g || g.finished || g.paused) return;
        g.pause();
        this.screen(`
            <div class="panel narrow" style="width:min(380px,92vw)">
                <div class="panel-body" style="text-align:center">
                    <div class="panel-title" style="margin-bottom:16px">Paused</div>
                    <div class="menu" style="width:100%">
                        <button class="btn primary" id="p-resume">Resume</button>
                        <button class="btn" id="p-restart">Restart</button>
                        <button class="btn danger" id="p-quit">Quit</button>
                    </div>
                </div>
            </div>`, 'dim');
        $('p-resume').onclick = () => this.resumeWithCountdown();
        $('p-restart').onclick = () => this.restart();
        $('p-quit').onclick = () => this.quit();
        $('p-resume').focus();
        // Esc again resumes
        this._pauseKey = (e) => { if (e.code === 'Escape') { e.preventDefault(); this.resumeWithCountdown(); } };
        window.addEventListener('keydown', this._pauseKey);
    }

    resumeWithCountdown() {
        window.removeEventListener('keydown', this._pauseKey);
        let n = 3;
        const tick = () => {
            if (!this.game || this.game.finished) return;
            if (n === 0) { this.root.innerHTML = ''; this.game.resume(); return; }
            this.screen(`<div class="countdown">${n}</div>`);
            n--;
            setTimeout(tick, 420);
        };
        tick();
    }

    restart() {
        window.removeEventListener('keydown', this._pauseKey);
        const s = this.session;
        this.game.destroy(); this.game = null;
        if (s.kind === 'level') this.playLevel(s.level);
        else this.start({ ...s, notes: s.notes });
    }

    quit() {
        window.removeEventListener('keydown', this._pauseKey);
        const s = this.session;
        if (this.game) { this.game.destroy(); this.game = null; }
        $('hud').classList.add('hidden');
        this.back(s);
    }

    back(s) {
        if (s.kind === 'level') this.showLevels(s.level.pack);
        else if (s.kind === 'endless') this.showEndless();
        else if (s.kind === 'custom' && s.fromEditor) this.editor.open(s.rec, true);
        else if (s.kind === 'custom') this.showMyLevels();
        else this.showTitle();
    }

    finished(res) {
        const s = this.session;
        this.game = null;
        $('hud').classList.add('hidden');
        const isEndless = s.kind === 'endless';
        const isBest = s.fromEditor ? false : saveResult(s.id, res);
        const nextLevel = s.kind === 'level' ? LEVELS[LEVELS.indexOf(s.level) + 1] : null;
        const nextOk = nextLevel && this.packUnlocked(PACKS.findIndex(p => p.id === nextLevel.pack));
        const off = Math.round(res.meanOffsetMs);
        const timingTip = res.offsets.length >= 12 && Math.abs(off) >= 15
            ? `On average you hit <b>${Math.abs(off)} ms ${off > 0 ? 'late' : 'early'}</b>. <button class="btn small" id="r-fix">Adjust offset</button>`
            : res.offsets.length >= 12 ? 'Your timing is centered. Nice.' : '';
        const C = res.counts;
        this.screen(`
            <div class="panel narrow results">
                <div class="panel-body">
                    <div class="big-grade grade-${res.grade}">${isEndless ? fmtTime(Math.max(0, res.survived)) : res.grade}</div>
                    <div class="title">${esc(s.title)}${res.failed && !isEndless ? ' — FAILED' : ''}${isEndless ? ' — survived' : ''}</div>
                    ${isBest ? '<div class="new-best">NEW BEST!</div>' : ''}
                    <div class="stat-grid">
                        <div class="stat"><div class="v">${res.score.toLocaleString()}</div><div class="l">Score</div></div>
                        <div class="stat"><div class="v">${(res.accuracy * 100).toFixed(2)}%</div><div class="l">Accuracy</div></div>
                        <div class="stat"><div class="v">${res.maxCombo}</div><div class="l">Max Combo</div></div>
                    </div>
                    <div class="judgement-row">
                        <span style="color:#ffd76a">Perfect ${C.perfect}</span>
                        <span style="color:#7fffd4">Great ${C.great}</span>
                        <span style="color:#9fb7ff">Good ${C.good}</span>
                        <span style="color:#ff5a7a">Miss ${C.miss + C.wrong}</span>
                        ${C.holdOk + C.holdBreak ? `<span style="color:#c9b8ff">Holds ${C.holdOk}/${C.holdOk + C.holdBreak}</span>` : ''}
                    </div>
                    ${res.offsets.length ? `<div class="timing-box"><canvas id="r-hist" width="600" height="70"></canvas>${timingTip}</div>` : ''}
                    <div class="btn-row">
                        <button class="btn primary" id="r-retry">Retry</button>
                        ${nextOk ? '<button class="btn" id="r-next">Next Level →</button>' : ''}
                        <button class="btn" id="r-back">${s.fromEditor ? 'Back to Editor' : 'Back'}</button>
                    </div>
                </div>
            </div>`, 'dim');
        if (res.offsets.length) drawHistogram($('r-hist'), res.offsets);
        $('r-retry').onclick = () => {
            if (s.kind === 'endless') { s.mode === 'classic' ? this.playClassic() : this.playEndless(); }
            else if (s.kind === 'level') this.playLevel(s.level);
            else this.start({ ...s });
        };
        if (nextOk) this.prefetch(nextLevel);
        if (nextOk) $('r-next').onclick = () => this.playLevel(nextLevel);
        $('r-back').onclick = () => this.back(s);
        const fix = $('r-fix');
        if (fix) fix.onclick = () => {
            const v = Math.max(-300, Math.min(300, (settings.get('offsetMs') || 0) + off));
            settings.set('offsetMs', v);
            toast(`Audio offset set to ${v} ms`, 'ok');
            fix.disabled = true;
        };
        $('r-retry').focus();
    }

    // ============ HOW TO PLAY ============
    showHowTo() {
        const icon = (c, ch, extra = '') => `<span class="note-icon" style="--c:${c};${extra}">${ch}</span>`;
        this.screen(`
            <div class="panel">
                <div class="panel-head"><div class="panel-title">How to Play</div><button class="btn small" id="b-back">← Back</button></div>
                <div class="panel-body">
                    <p class="pack-blurb">Arrows fly toward the ring. Press the matching direction the moment one reaches it.
                    Keys: <span class="key">W</span><span class="key">A</span><span class="key">S</span><span class="key">D</span>, arrow keys, or <span class="key">I</span><span class="key">J</span><span class="key">K</span><span class="key">L</span>.
                    Controller: D-pad, face buttons (Y↑ A↓ X← B→) or flick the left stick. Phone: swipe. <span class="key">Esc</span> pauses.</p>
                    <div class="howto">
                        <div class="card">${icon('var(--up)', '↑')}<h3>Tap</h3><p>Press the arrow's direction. Each direction has its own color.</p></div>
                        <div class="card">${icon('#f2f2ff', '★', 'color:#222')}<h3>Star</h3><p>Any direction works (on phones, a tap does too).</p></div>
                        <div class="card">${icon('var(--right)', '→', 'border-bottom:8px solid rgba(61,255,160,0.4)')}<h3>Hold</h3><p>Press and keep holding until the trail ends.</p></div>
                        <div class="card">${icon('var(--flip)', '↑', 'box-shadow:0 0 0 3px #b96fff, 0 0 16px #b96fff;background:#1a0828')}<h3>Flip</h3><p>Purple, crossed-out arrows: press the <b>opposite</b> direction.</p></div>
                        <div class="card">${icon('var(--down)', '↘', 'box-shadow:0 0 0 3px #fff')}<h3>Diagonal</h3><p>White outline: press <b>both</b> directions together (↘ = down + right).</p></div>
                        <div class="card">${icon('var(--left)', '%')}<h3>Timing</h3><p>Perfect ±45 ms, Great ±90 ms, Good ±135 ms. Streaks raise your multiplier up to x3.</p></div>
                    </div>
                </div>
            </div>`);
        $('b-back').onclick = () => this.showTitle();
    }

    // ============ SETTINGS ============
    showSettings() {
        this.screen(`
            <div class="panel narrow">
                <div class="panel-head"><div class="panel-title">Settings</div><button class="btn small" id="b-back">← Back</button></div>
                <div class="panel-body" id="sbody"></div>
            </div>`);
        $('b-back').onclick = () => this.showTitle();
        const body = $('sbody');
        const row = (label, sub, ctl) => {
            const r = document.createElement('div');
            r.className = 'row';
            r.innerHTML = `<div class="row-label">${label}<small>${sub}</small></div><div class="row-ctl"></div>`;
            r.querySelector('.row-ctl').append(...ctl);
            body.appendChild(r);
            return r;
        };
        const slider = (key, min, max, step, fmt, onInput) => {
            const inp = document.createElement('input');
            inp.type = 'range'; inp.min = min; inp.max = max; inp.step = step; inp.value = settings.get(key);
            const v = document.createElement('span'); v.className = 'val'; v.textContent = fmt(Number(inp.value));
            inp.oninput = () => { settings.set(key, Number(inp.value)); v.textContent = fmt(Number(inp.value)); if (onInput) onInput(Number(inp.value)); };
            return [inp, v];
        };
        const toggle = (key, onChange) => {
            const t = document.createElement('div');
            t.className = 'toggle' + (settings.get(key) ? ' on' : '');
            t.onclick = () => { const v = !settings.get(key); settings.set(key, v); t.classList.toggle('on', v); if (onChange) onChange(v); };
            return [t];
        };
        const seg = (key, opts) => {
            const s = document.createElement('div');
            s.className = 'seg';
            for (const [v, l] of opts) {
                const b = document.createElement('button');
                b.textContent = l; b.className = settings.get(key) === v ? 'active' : '';
                b.onclick = () => { settings.set(key, v); s.querySelectorAll('button').forEach(x => x.classList.toggle('active', x === b)); };
                s.appendChild(b);
            }
            return [s];
        };
        const vol = () => audio.setVolumes(settings.get('musicVolume'), settings.get('sfxVolume'));
        const pct = (v) => Math.round(v * 100) + '%';
        row('Music volume', '', slider('musicVolume', 0, 1, 0.05, pct, vol));
        row('Effects volume', 'Hit sounds and clicks', slider('sfxVolume', 0, 1, 0.05, pct, vol));
        row('Scroll speed', 'How fast arrows fly in (higher = more spread out)', slider('scrollSpeed', 0.6, 2, 0.05, v => v.toFixed(2) + 'x'));
        const cal = document.createElement('button');
        cal.className = 'btn small'; cal.textContent = 'Calibrate…';
        cal.onclick = () => this.showCalibration();
        row('Audio offset', 'Positive if you tend to hit late. Use Calibrate to measure it.', [...slider('offsetMs', -300, 300, 1, v => v + ' ms'), cal]);
        row('Timing windows', 'Relaxed widens every window by 40%', seg('leniency', [['normal', 'Normal'], ['relaxed', 'Relaxed']]));
        row('No fail', 'Keep playing when health runs out', toggle('noFail'));
        row('Visual effects', 'Low turns off sparks and stars for slower devices (applies on reload)', seg('effects', [['high', 'High'], ['low', 'Low']]));
        row('Unlock all packs', 'Skip the progression', toggle('unlockAll'));
    }

    // tap along to a click track to measure audio + input latency
    showCalibration() {
        audio.init();
        this.screen(`
            <div class="panel narrow" style="text-align:center">
                <div class="panel-head"><div class="panel-title">Calibrate</div><button class="btn small" id="b-back">← Back</button></div>
                <div class="panel-body">
                    <p class="pack-blurb">Press any arrow key (or tap) on every click. 16 clicks.</p>
                    <div class="countdown" id="c-beat" style="font-size:80px">♪</div>
                    <p id="c-out" class="pack-blurb"></p>
                    <button class="btn primary" id="c-start">Start</button>
                </div>
            </div>`);
        let stop = false;
        $('b-back').onclick = () => { stop = true; input.enabled = false; input.onPress = null; this.showSettings(); };
        $('c-start').onclick = () => {
            $('c-start').disabled = true;
            const spb = 0.5, n = 16;
            const ctx = audio.ctx;
            const t0 = ctx.currentTime + 1.0;
            for (let i = 0; i < n; i++) audio.tick(i % 4 === 0, t0 - ctx.currentTime + i * spb);
            const offsets = [];
            input.enabled = true;
            input.onPause = null;
            input.onPress = (dir, ms) => {
                // convert the press to audio-clock time as heard
                const pressCtx = ctx.currentTime - (performance.now() - ms) / 1000 - audio.latency;
                const k = Math.round((pressCtx - t0) / spb);
                if (k < 0 || k >= n) return;
                const off = pressCtx - (t0 + k * spb);
                if (Math.abs(off) < 0.2) offsets.push(off);
                $('c-beat').textContent = String(k + 1);
            };
            setTimeout(() => {
                input.enabled = false; input.onPress = null;
                if (stop) return;
                if (offsets.length < 6) { $('c-out').textContent = 'Not enough taps — try again.'; $('c-start').disabled = false; return; }
                offsets.sort((a, b) => a - b);
                const med = offsets[offsets.length >> 1];
                const ms = Math.round(med * 1000);
                settings.set('offsetMs', ms);
                $('c-out').innerHTML = `Measured offset: <b>${ms} ms</b>. Saved.`;
                $('c-start').disabled = false;
            }, 1000 + n * spb * 1000 + 600);
        };
    }
}

// hit-error histogram (-window..+window)
function drawHistogram(canvas, offsets) {
    const ctx = canvas.getContext('2d');
    const w = canvas.width, h = canvas.height;
    const range = 0.15, bins = 31;
    const counts = new Array(bins).fill(0);
    for (const o of offsets) {
        const b = Math.round((Math.max(-range, Math.min(range, o)) / range) * (bins - 1) / 2 + (bins - 1) / 2);
        counts[b]++;
    }
    const max = Math.max(1, ...counts);
    ctx.clearRect(0, 0, w, h);
    ctx.fillStyle = 'rgba(255,255,255,0.15)';
    ctx.fillRect(w / 2 - 1, 0, 2, h);
    const bw = w / bins;
    counts.forEach((c, i) => {
        const x = i * bw, bh = (c / max) * (h - 8);
        const d = Math.abs(i - (bins - 1) / 2) / ((bins - 1) / 2) * range;
        ctx.fillStyle = d <= 0.045 ? '#ffd76a' : d <= 0.09 ? '#7fffd4' : '#9fb7ff';
        ctx.fillRect(x + 1, h - bh, bw - 2, bh);
    });
    ctx.fillStyle = '#a3a1c4';
    ctx.font = '12px Inter, sans-serif';
    ctx.fillText('early', 4, 12);
    ctx.fillText('late', w - 28, 12);
}

// .zip with a level JSON (v1 or v2) + an audio file
export async function readLevelZip(file) {
    const zip = await JSZip.loadAsync(file);
    let jsonFile = null, audioFile = null;
    zip.forEach((path, entry) => {
        if (entry.dir || path.startsWith('__MACOSX')) return;
        if (!jsonFile && /\.json$/i.test(path)) jsonFile = entry;
        if (!audioFile && /\.(mp3|ogg|egg|wav|m4a)$/i.test(path)) audioFile = entry;
    });
    if (!jsonFile) throw new Error('the zip has no .json level file');
    if (!audioFile) throw new Error('the zip has no song (.mp3 / .ogg / .wav)');
    const { meta, notes } = normalizeCustomLevel(await jsonFile.async('string'));
    if (!notes.length) throw new Error('the level has no notes');
    if (meta.title === 'Custom Level') meta.title = file.name.replace(/\.zip$/i, '');
    return {
        id: 'custom-' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
        meta, notes,
        audio: await audioFile.async('arraybuffer'),
        audioName: audioFile.name.split('/').pop(),
    };
}
