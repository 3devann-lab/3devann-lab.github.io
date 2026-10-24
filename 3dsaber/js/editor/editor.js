// ============ Map editor: screens, tools, playback, 3D preview, save / export ============
import { audio } from '../audio.js';
import { cursor, gamepad } from '../input.js';
import { settings } from '../settings.js';
import { parseDifficulty, parseInfo } from '../beatmap.js';
import { Gameplay } from '../game.js';
import { getSavedMaps, idb, PROJECT_STORE, PROJECT_FILES, saveLibraryRecord, deleteSavedMap } from '../beatsaver.js';
import { toast, esc } from '../ui.js';
import * as M from './model.js';
import { Timeline, dirFromDrag } from './timeline.js';

const $ = (id) => document.getElementById(id);

// ---------- storage ----------
const store = {
    list: () => idb(PROJECT_STORE, 'readonly', s => s.getAll()),
    get: (id) => idb(PROJECT_STORE, 'readonly', s => s.get(id)),
    put: (p) => idb(PROJECT_STORE, 'readwrite', s => s.put(p)),
    files: (id) => idb(PROJECT_FILES, 'readonly', s => s.get(id)),
    putFiles: (f) => idb(PROJECT_FILES, 'readwrite', s => s.put(f)),
    del: async (id) => {
        await idb(PROJECT_STORE, 'readwrite', s => s.delete(id));
        await idb(PROJECT_FILES, 'readwrite', s => s.delete(id));
    },
};

const SNAPS = [1, 2, 3, 4, 6, 8, 12, 16, 24, 32, 48, 64];
const ARROWS = ['↑', '↓', '←', '→', '↖', '↗', '↙', '↘', '•'];
const DIR_PAD = [4, 0, 5, 2, 8, 3, 6, 1, 7];     // 3×3 layout of the direction pad
const WALL_TYPES = { full: [0, 5], crouch: [2, 3] };
const ENVIRONMENTS = ['DefaultEnvironment', 'TriangleEnvironment', 'NiceEnvironment', 'BigMirrorEnvironment', 'KDAEnvironment',
    'MonstercatEnvironment', 'CrabRaveEnvironment', 'DragonsEnvironment', 'OriginsEnvironment', 'PanicEnvironment',
    'RocketEnvironment', 'GreenDayEnvironment', 'TimbalandEnvironment', 'FitBeatEnvironment', 'LinkinParkEnvironment',
    'BTSEnvironment', 'KaleidoscopeEnvironment', 'InterscopeEnvironment', 'SkrillexEnvironment', 'BillieEnvironment',
    'HalloweenEnvironment', 'GagaEnvironment', 'WeaveEnvironment', 'PyroEnvironment', 'EDMEnvironment', 'TheSecondEnvironment',
    'LizzoEnvironment', 'TheWeekndEnvironment', 'RockMixtapeEnvironment', 'Dragons2Environment', 'Panic2Environment', 'QueenEnvironment'];
// which way the keyboard aims a note (WASD + QEZC, F/X dot; numpad by position)
const KEY_DIRS = { w: 0, s: 1, a: 2, d: 3, q: 4, e: 5, z: 6, c: 7, f: 8, x: 8 };
const NUMPAD_DIRS = { Numpad8: 0, Numpad2: 1, Numpad4: 2, Numpad6: 3, Numpad7: 4, Numpad9: 5, Numpad1: 6, Numpad3: 7, Numpad5: 8 };

function kindOf(o) {
    if ('et' in o) return 'events';
    if ('sc' in o) return 'chains';
    if ('mu' in o) return 'arcs';
    if ('c' in o) return 'notes';
    if ('w' in o) return 'walls';
    return 'bombs';
}
function fmtSec(s) {
    if (!Number.isFinite(s)) return '0:00.000';
    const neg = s < 0; s = Math.abs(s);
    return `${neg ? '-' : ''}${Math.floor(s / 60)}:${(s % 60).toFixed(3).padStart(6, '0')}`;
}
function sanitize(s) { return String(s || 'map').replace(/[\\/:*?"<>|]+/g, '').trim().slice(0, 60) || 'map'; }
function download(blob, name) {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = name;
    document.body.appendChild(a);
    a.click();
    setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 2000);
}
function hexToRgb(hex) {
    const v = parseInt(String(hex).replace('#', ''), 16);
    return [((v >> 16) & 255) / 255, ((v >> 8) & 255) / 255, (v & 255) / 255];
}
function rgbToHex(c) {
    const f = (v) => Math.round(Math.max(0, Math.min(1, v)) * 255).toString(16).padStart(2, '0');
    return '#' + f(c[0]) + f(c[1]) + f(c[2]);
}

// ---------- audio analysis ----------
// Loudness per 5 ms (RMS), stretched between the song's quiet and loud parts
// so beats stand out even on heavily compressed songs
function computePeaks(buffer, rate = 200) {
    const sr = buffer.sampleRate, n = Math.ceil(buffer.duration * rate);
    const peaks = new Float32Array(n);
    const chans = [];
    for (let c = 0; c < Math.min(2, buffer.numberOfChannels); c++) chans.push(buffer.getChannelData(c));
    const step = sr / rate;
    for (let i = 0; i < n; i++) {
        const a = Math.floor(i * step), b = Math.min(chans[0].length, Math.floor((i + 1) * step));
        let sum = 0, cnt = 0;
        for (const d of chans) for (let k = a; k < b; k += 2) { sum += d[k] * d[k]; cnt++; }
        peaks[i] = cnt ? Math.sqrt(sum / cnt) : 0;
    }
    const sorted = Float32Array.from(peaks).sort();
    const lo = sorted[Math.floor(n * 0.05)] || 0, hi = sorted[Math.floor(n * 0.995)] || 1;
    const span = Math.max(1e-6, hi - lo);
    for (let i = 0; i < n; i++) peaks[i] = Math.max(0, Math.min(1, (peaks[i] - lo) / span)) ** 1.6;
    return { rate, peaks };
}

// Tempo from the song itself: onset strength, then the beat period that
// lines up best with it (comb filter over 70–210 BPM, refined to 0.1)
export function detectBpm(buffer) {
    const sr = buffer.sampleRate, d = buffer.getChannelData(0);
    const hop = Math.round(sr / 200);
    const start = Math.min(Math.floor(d.length * 0.1), sr * 10);
    const frames = Math.floor(Math.min(d.length - start, sr * 120) / hop);
    if (frames < 400) return null;
    const env = new Float32Array(frames);
    for (let i = 0; i < frames; i++) {
        let e = 0;
        for (let k = start + i * hop, end = k + hop; k < end; k += 2) e += d[k] * d[k];
        env[i] = Math.log(1 + 100 * e);
    }
    const on = new Float32Array(frames);
    for (let i = 1; i < frames; i++) on[i] = Math.max(0, env[i] - env[i - 1]);
    const score = (bpm) => {
        const lag = 60 * 200 / bpm;
        let s = 0;
        for (let k = 1; k <= 4; k++) {
            const L = lag * k, li = Math.floor(L), f = L - li;
            for (let i = 0; i + li + 1 < frames; i += 1) s += on[i] * (on[i + li] * (1 - f) + on[i + li + 1] * f) / k;
        }
        return s;
    };
    let best = 0, bestScore = -1;
    for (let bpm = 70; bpm <= 210; bpm += 1) { const sc = score(bpm); if (sc > bestScore) { bestScore = sc; best = bpm; } }
    for (let bpm = best - 1; bpm <= best + 1; bpm += 0.1) { const sc = score(bpm); if (sc > bestScore) { bestScore = sc; best = bpm; } }
    while (best < 90) best *= 2;
    while (best > 200) best /= 2;
    const r = Math.round(best);
    return Math.abs(best - r) < 0.35 ? r : Math.round(best * 10) / 10;
}

// A cover for maps that have none
async function makeCover(project) {
    const c = document.createElement('canvas');
    c.width = c.height = 512;
    const g = c.getContext('2d');
    const h = [...project.info.songName].reduce((a, ch) => (a * 31 + ch.charCodeAt(0)) >>> 0, 7);
    const grd = g.createLinearGradient(0, 0, 512, 512);
    grd.addColorStop(0, `hsl(${h % 360}, 80%, 45%)`);
    grd.addColorStop(1, `hsl(${(h * 7 + 160) % 360}, 80%, 25%)`);
    g.fillStyle = grd; g.fillRect(0, 0, 512, 512);
    g.fillStyle = 'rgba(255,255,255,0.08)';
    for (let i = 0; i < 12; i++) g.fillRect(0, i * 44 + 10, 512, 2);
    g.fillStyle = '#fff'; g.textAlign = 'center';
    g.font = 'bold 54px Orbitron, sans-serif';
    const words = project.info.songName.split(' ');
    const lines = [];
    let line = '';
    for (const w of words) { if ((line + ' ' + w).trim().length > 14 && line) { lines.push(line); line = w; } else line = (line + ' ' + w).trim(); }
    if (line) lines.push(line);
    lines.slice(0, 4).forEach((l, i) => g.fillText(l, 256, 220 + i * 62 - (lines.length - 1) * 31));
    g.font = '28px Rajdhani, sans-serif';
    g.fillText(project.info.songAuthor || '', 256, 440);
    g.font = 'bold 18px Orbitron, sans-serif'; g.globalAlpha = 0.7;
    g.fillText('SABER//3D', 256, 490);
    return new Promise(res => c.toBlob(res, 'image/jpeg', 0.88));
}

async function thumbOf(blob) {
    if (!blob) return null;
    try {
        const bmp = await createImageBitmap(blob);
        const c = document.createElement('canvas');
        c.width = c.height = 96;
        c.getContext('2d').drawImage(bmp, 0, 0, 96, 96);
        return c.toDataURL('image/jpeg', 0.8);
    } catch (e) { return null; }
}

// ---------- unpack a map zip (for importing into the editor) ----------
async function unpackZip(file) {
    const zip = await JSZip.loadAsync(file);
    let infoFile = null;
    zip.forEach((path, f) => { if (!infoFile && /(^|\/)info\.dat$/i.test(path)) infoFile = f; });
    if (!infoFile) throw new Error('That zip has no Info.dat — is it a Beat Saber map?');
    const dir = infoFile.name.includes('/') ? infoFile.name.slice(0, infoFile.name.lastIndexOf('/') + 1) : '';
    const get = (name) => name && (zip.file(dir + name) || zip.file(Object.keys(zip.files).find(k => k.toLowerCase() === (dir + name).toLowerCase()) || '__none__'));
    const infoRaw = await infoFile.async('string');
    const info = parseInfo(infoRaw);
    const diffFiles = {};
    if (info.audioDataFilename) { const f = get(info.audioDataFilename); if (f) diffFiles.__bpm = await f.async('string'); }
    for (const d of info.difficulties) {
        const f = get(d.filename);
        if (f) diffFiles[d.filename] = await f.async('string');
        if (d.lightshowFilename) { const lf = get(d.lightshowFilename); if (lf) diffFiles[d.lightshowFilename] = await lf.async('string'); }
    }
    let song = get(info.songFilename);
    if (!song) zip.forEach((p, f) => { if (!song && /\.(egg|ogg|mp3|wav)$/i.test(p)) song = f; });
    if (!song) throw new Error('No song audio in that zip');
    const songBuf = await song.async('arraybuffer');
    let coverBlob = null;
    const cf = get(info.coverFilename);
    if (cf) { const b = await cf.async('blob'); coverBlob = b.slice(0, b.size, /png$/i.test(info.coverFilename) ? 'image/png' : 'image/jpeg'); }
    return { infoRaw, diffFiles, songBuf, coverBlob, songExt: (song.name.split('.').pop() || 'egg').toLowerCase() };
}

export class Editor {
    constructor(menu) {
        this.menu = menu;
        this.engine = menu.engine;
        this.active = false;
        this.project = null;
        this.files = null;
        this.songBuffer = null;
        this.wave = null;
        this.gp = null;
        this.sel = new Set();
        this.history = new M.History();
        this.clipboard = null;
        this.diffIndex = 0;
        this.cursorBeat = 0;
        this.snap = 4;
        this.zoom = 120;
        this.tool = 'red';
        this.dir = 1;
        this.angle = 0;
        this.wallType = 'full';
        this.eventColor = 'blue';
        this.eventMode = 'on';
        this.eventBrightness = 1;
        this.laserSpeed = 3;
        this.customColor = null;          // Chroma colour for new notes / walls / lights, or null
        this.playing = false;
        this.playRate = 1;
        this.hitsounds = settings.get('editorHitsounds') !== false;
        this.metronome = !!settings.get('editorMetronome');
        this.panel = 'inspect';
        this._onKey = (e) => this.onKey(e);
        this._onResize = () => this.layout();
        // switching tabs: stop the music and save
        document.addEventListener('visibilitychange', () => {
            if (document.hidden && this.active) { this.pause(); this.saveNow().catch(() => {}); }
        });
    }

    get diff() { return this.project.diffs[this.diffIndex]; }
    get data() { return this.diff.data; }
    get clock() { return this._clock || (this._clock = M.clockFor(this.project, this.diff)); }
    get cursorSec() { return this.clock.toSeconds(this.cursorBeat); }
    get songLen() { return this.songBuffer ? this.songBuffer.duration : (this.project.song.duration || 0); }
    get endBeat() { return this.songLen ? this.clock.toBeats(this.songLen) : 1e9; }

    // =====================================================================
    // Project list
    // =====================================================================
    async showProjects() {
        this.close();
        const m = this.menu;
        m.setScreen(`
        <div class="screen panel-screen">
            <div class="panel" style="max-width:920px">
                <div class="panel-header">
                    <div class="panel-title">MAP EDITOR</div>
                    <div class="ed-list-actions">
                        <button class="btn small primary" id="ed-new">+ New Map</button>
                        <button class="btn small" id="ed-import">Import .zip</button>
                        <button class="btn small" id="ed-from-lib">Edit a Downloaded Map</button>
                        <button class="btn small" id="btn-back">← Back</button>
                    </div>
                </div>
                <div class="panel-body" id="ed-projects"><div class="loading-spinner"></div></div>
            </div>
            <input type="file" id="ed-zip" accept=".zip,application/zip" hidden>
        </div>`);
        m.enterMenuMode(() => m.showHome());
        $('btn-back').onclick = () => m.showHome();
        $('ed-new').onclick = () => this.showNewProject();
        $('ed-import').onclick = () => $('ed-zip').click();
        $('ed-zip').onchange = (e) => { const f = e.target.files[0]; if (f) this.importZip(f); };
        $('ed-from-lib').onclick = () => this.showLibraryPicker();

        const list = await store.list().catch(() => []);
        const box = $('ed-projects');
        if (!box) return;
        list.sort((a, b) => b.updated - a.updated);
        if (!list.length) {
            box.innerHTML = `<div class="ed-empty">
                <h3>Make your own Beat Saber maps</h3>
                <p>Pick a song, place notes, walls, bombs and lights on the timeline, watch it in 3D as you go, and test-play it any time.
                Your maps save automatically, show up in <b>Play</b>, and export as a zip that works in Beat Saber and ChroMapper.</p>
                <button class="btn primary" id="ed-new2">+ Start a New Map</button>
            </div>`;
            $('ed-new2').onclick = () => this.showNewProject();
            return;
        }
        box.innerHTML = '';
        for (const p of list) {
            const row = document.createElement('div');
            row.className = 'ed-proj';
            const diffs = p.diffs.map(d => `<span class="badge">${esc(M.diffName(d))}</span>`).join('');
            const notes = p.diffs.reduce((a, d) => a + d.data.notes.length, 0);
            row.innerHTML = `
                <div class="ed-proj-cover" style="${p.thumb ? `background-image:url(${p.thumb})` : ''}"></div>
                <div class="ed-proj-info">
                    <div class="song-name">${esc(p.info.songName)}</div>
                    <div class="song-artist">${esc(p.info.songAuthor)} · mapped by ${esc(p.info.levelAuthor || 'you')} · ${p.info.bpm} BPM</div>
                    <div class="ed-proj-diffs">${diffs} <span class="ed-proj-meta">${notes} notes · edited ${new Date(p.updated).toLocaleString()}</span></div>
                </div>
                <div class="ed-proj-btns">
                    <button class="btn small primary" data-a="open">Edit</button>
                    <button class="btn small" data-a="export">Export</button>
                    <button class="btn small" data-a="dup">Copy</button>
                    <button class="btn small danger" data-a="del">Delete</button>
                </div>`;
            row.querySelector('[data-a="open"]').onclick = () => this.openProject(p.id);
            row.querySelector('.ed-proj-cover').onclick = () => this.openProject(p.id);
            row.querySelector('[data-a="export"]').onclick = async () => {
                const files = await store.files(p.id);
                this.exportZip(p, files);
            };
            row.querySelector('[data-a="dup"]').onclick = async () => {
                const files = await store.files(p.id);
                const copy = structuredClone(p);
                copy.id = 'p' + M.uid();
                copy.info.songName += ' (copy)';
                copy.updated = copy.created = Date.now();
                await store.putFiles({ ...files, id: copy.id });
                await store.put(copy);
                toast('Copied');
                this.showProjects();
            };
            const del = row.querySelector('[data-a="del"]');
            del.onclick = async () => {
                if (del.dataset.armed !== '1') { del.dataset.armed = '1'; del.textContent = 'Really delete?'; return; }
                await store.del(p.id);
                await deleteSavedMap('edit-' + p.id).catch(() => {});
                toast('Map deleted');
                this.showProjects();
            };
            box.appendChild(row);
        }
    }

    // =====================================================================
    // New map
    // =====================================================================
    showNewProject() {
        const m = this.menu;
        m.setScreen(`
        <div class="screen panel-screen">
            <div class="panel" style="max-width:640px">
                <div class="panel-header">
                    <div class="panel-title">NEW MAP</div>
                    <button class="btn small" id="btn-back">← Back</button>
                </div>
                <div class="panel-body ed-form">
                    <label class="ed-field ed-file"><span>Song file <small>.ogg / .egg / .mp3 / .wav</small></span>
                        <input type="file" id="nf-song" accept="audio/*,.egg,.ogg,.mp3,.wav"></label>
                    <div class="ed-song-status" id="nf-status">Choose the song you want to map.</div>
                    <label class="ed-field"><span>Song name</span><input class="search-box" id="nf-name" placeholder="Song name"></label>
                    <label class="ed-field"><span>Sub name <small>optional</small></span><input class="search-box" id="nf-sub" placeholder="(feat. …)"></label>
                    <label class="ed-field"><span>Artist</span><input class="search-box" id="nf-artist" placeholder="Artist"></label>
                    <label class="ed-field"><span>Mapper</span><input class="search-box" id="nf-mapper" placeholder="Your name" value="${esc(settings.get('editorMapper') || '')}"></label>
                    <div class="ed-field"><span>BPM</span><div class="ed-bpm-row">
                        <input class="search-box" id="nf-bpm" type="number" min="20" max="500" step="0.01" value="120">
                        <button class="btn small" id="nf-detect" disabled>Detect</button>
                        <button class="btn small" id="nf-tap">Tap</button>
                        <span id="nf-bpm-hint" class="ed-hint"></span></div></div>
                    <label class="ed-field"><span>Cover image <small>optional — one is made for you</small></span><input type="file" id="nf-cover" accept="image/*"></label>
                    <label class="ed-field"><span>First difficulty</span><select class="search-box" id="nf-diff">
                        ${M.DIFFICULTIES.map(d => `<option value="${d}" ${d === 'Expert' ? 'selected' : ''}>${M.DIFF_LABEL[d]}</option>`).join('')}</select></label>
                    <button class="btn primary" id="nf-create" disabled>Create Map</button>
                </div>
            </div>
        </div>`);
        m.enterMenuMode(() => this.showProjects());
        $('btn-back').onclick = () => this.showProjects();
        let songBuf = null, ext = 'ogg', decoded = null;
        $('nf-song').onchange = async (e) => {
            const f = e.target.files[0];
            if (!f) return;
            $('nf-status').textContent = 'Reading the song…';
            $('nf-create').disabled = true;
            try {
                songBuf = await f.arrayBuffer();
                ext = (f.name.split('.').pop() || 'ogg').toLowerCase();
                decoded = await audio.decode(songBuf, { allowStream: false });
                const base = f.name.replace(/\.[^.]+$/, '');
                const parts = base.split(/\s+-\s+/);
                if (!$('nf-name').value) $('nf-name').value = parts.length > 1 ? parts.slice(1).join(' - ') : base;
                if (!$('nf-artist').value && parts.length > 1) $('nf-artist').value = parts[0];
                $('nf-status').textContent = `${f.name} · ${Math.floor(decoded.duration / 60)}:${String(Math.floor(decoded.duration % 60)).padStart(2, '0')}`
                    + (ext === 'ogg' || ext === 'egg' ? '' : ' · plays here; Beat Saber itself needs an .ogg/.egg song');
                $('nf-create').disabled = false;
                $('nf-detect').disabled = false;
                $('nf-detect').click();
            } catch (err) {
                songBuf = null;
                $('nf-status').textContent = 'Couldn\'t read that file: ' + err.message;
            }
        };
        $('nf-detect').onclick = () => {
            if (!decoded) return;
            $('nf-bpm-hint').textContent = 'Listening…';
            setTimeout(() => {
                const bpm = detectBpm(decoded);
                if (bpm) { $('nf-bpm').value = bpm; $('nf-bpm-hint').textContent = `Detected ${bpm} — check it with Tap`; }
                else $('nf-bpm-hint').textContent = 'Couldn\'t tell — use Tap';
            }, 30);
        };
        const taps = [];
        $('nf-tap').onclick = () => {
            const now = performance.now();
            if (taps.length && now - taps[taps.length - 1] > 2000) taps.length = 0;
            taps.push(now);
            if (taps.length >= 4) {
                const span = (taps[taps.length - 1] - taps[0]) / (taps.length - 1);
                const bpm = Math.round(60000 / span * 10) / 10;
                $('nf-bpm').value = bpm;
                $('nf-bpm-hint').textContent = `Tapped ${bpm} (${taps.length} taps)`;
            } else $('nf-bpm-hint').textContent = `Keep tapping… (${taps.length})`;
        };
        $('nf-create').onclick = async () => {
            if (!songBuf) return;
            const name = $('nf-name').value.trim() || 'Untitled';
            const mapper = $('nf-mapper').value.trim();
            settings.set('editorMapper', mapper);
            const p = M.newProject({
                songName: name, songSubName: $('nf-sub').value.trim(), songAuthor: $('nf-artist').value.trim(),
                levelAuthor: mapper, bpm: Number($('nf-bpm').value) || 120, songExt: ext, duration: decoded.duration,
            });
            p.diffs = [M.newDifficulty('Standard', $('nf-diff').value)];
            const cf = $('nf-cover').files[0];
            const coverBlob = cf ? cf.slice(0, cf.size, cf.type || 'image/jpeg') : null;
            p.hasCover = !!coverBlob;
            p.thumb = await thumbOf(coverBlob || await makeCover(p));
            await store.putFiles({ id: p.id, songBuf, coverBlob });
            await store.put(p);
            this.openProject(p.id, decoded);
        };
    }

    // pick a map from the downloaded library to edit
    async showLibraryPicker() {
        const maps = (await getSavedMaps().catch(() => [])).filter(r => !String(r.id).startsWith('edit-'));
        const bd = document.createElement('div');
        bd.className = 'modal-backdrop';
        bd.innerHTML = `<div class="modal" style="width:min(560px,94vw)">
            <h2>Edit a downloaded map</h2>
            <div class="sub">A copy is made — the original stays as it is. Noodle / Chroma effects beyond colours aren't editable.</div>
            <div class="ed-lib">${maps.length ? maps.map((r, i) => `<button class="song-row" data-i="${i}">
                <div class="song-info"><div class="song-name">${esc(r.info.songName)}</div>
                <div class="song-artist">${esc(r.info.songAuthor)} · ${esc(r.info.levelAuthor || '')}</div></div></button>`).join('')
                : '<div class="browse-msg">No downloaded maps yet — get some from Custom Levels.</div>'}</div>
            <button class="btn small modal-close">Cancel</button></div>`;
        document.body.appendChild(bd);
        const close = () => bd.remove();
        bd.addEventListener('click', (e) => { if (e.target === bd || e.target.closest('.modal-close')) close(); });
        bd.querySelectorAll('[data-i]').forEach(b => {
            b.onclick = async () => {
                const rec = maps[Number(b.dataset.i)];
                close();
                await this.importMap({ infoRaw: rec.infoRaw, diffFiles: rec.diffFiles, songBuf: rec.songBuf, coverBlob: rec.coverBlob,
                    songExt: (rec.info.songFilename || 'song.egg').split('.').pop() });
            };
        });
    }

    async importZip(file) {
        try {
            toast('Reading ' + file.name + '…');
            await this.importMap(await unpackZip(file));
        } catch (err) {
            console.error(err);
            toast('Import failed: ' + err.message, 'error');
        }
    }

    async importMap(src) {
        const { project, modded } = M.projectFromMap(src);
        project.song.ext = src.songExt || project.song.ext;
        let decoded = null;
        try { decoded = await audio.decode(src.songBuf, { allowStream: false }); project.song.duration = decoded.duration; } catch (e) { /* streamed later */ }
        project.hasCover = !!src.coverBlob;
        project.thumb = await thumbOf(src.coverBlob || await makeCover(project));
        await store.putFiles({ id: project.id, songBuf: src.songBuf, coverBlob: src.coverBlob || null });
        await store.put(project);
        if (modded) toast(`${modded} Noodle/Chroma effects can't be edited here and won't be in the export`, 'error');
        this.openProject(project.id, decoded);
    }

    // =====================================================================
    // Open / close the editor
    // =====================================================================
    async openProject(id, decoded = null) {
        const m = this.menu;
        m.setScreen('<div class="screen"><div class="loading-spinner"></div><div class="browse-msg small-msg">Opening the map…</div></div>');
        try {
            const p = await store.get(id);
            const files = await store.files(id);
            if (!p || !files) throw new Error('map not found');
            this.project = p;
            this.files = files;
            if (!this.songBuffer || this._songFor !== id) {
                this.songBuffer = decoded || await audio.decode(files.songBuf);
                this._songFor = id;
                this.wave = this.songBuffer.isMedia ? null : computePeaks(this.songBuffer);
            }
            if (!p.song.duration) p.song.duration = this.songBuffer.duration;
            const st = p.editor || {};
            this.diffIndex = Math.min(st.diff || 0, p.diffs.length - 1);
            this.cursorBeat = st.cursor || 0;
            this.snap = st.snap || 4;
            this.zoom = st.zoom || 120;
            this._clock = null;
            this.sel.clear();
            this.history = new M.History();
            this.buildView();
        } catch (err) {
            console.error(err);
            toast('Couldn\'t open the map: ' + err.message, 'error');
            this.showProjects();
        }
    }

    // leave the editing view (saves, publishes to the song list, tears down the preview)
    close() {
        if (!this.active) return;
        this.active = false;
        this.pause();
        this.destroyPreview();
        this.engine.setViewBox(null);
        removeEventListener('keydown', this._onKey, true);
        removeEventListener('resize', this._onResize);
        if (this._ro) { this._ro.disconnect(); this._ro = null; }
        document.body.classList.remove('editing');
        if (this.project) this.saveNow(true).catch(err => console.error(err));
    }

    buildView() {
        const m = this.menu;
        const p = this.project;
        m.setScreen(`
        <div class="ed-root">
            <div class="ed-top">
                <button class="ed-btn" id="ed-exit" title="Back to your maps (saves)">← Maps</button>
                <div class="ed-title" title="${esc(p.info.songName)}">${esc(p.info.songName)}</div>
                <select class="ed-sel" id="ed-diff" title="Difficulty"></select>
                <button class="ed-btn" id="ed-diffs" title="Add, remove and set up difficulties">Difficulties…</button>
                <span class="ed-sep"></span>
                <button class="ed-btn icon" id="ed-undo" title="Undo (Ctrl+Z)">⟲</button>
                <button class="ed-btn icon" id="ed-redo" title="Redo (Ctrl+Y)">⟳</button>
                <span class="ed-sep"></span>
                <button class="ed-btn icon play" id="ed-play" title="Play / pause (Space)">▶</button>
                <div class="ed-time" id="ed-time">0:00.000</div>
                <label class="ed-lbl">Snap <select class="ed-sel" id="ed-snap">${SNAPS.map(s => `<option value="${s}">1/${s}</option>`).join('')}</select></label>
                <label class="ed-lbl">Speed <select class="ed-sel" id="ed-rate">${[1, 0.75, 0.5, 0.25].map(r => `<option value="${r}">${r}x</option>`).join('')}</select></label>
                <button class="ed-btn ed-toggle" id="ed-hits" title="Tick on every note while playing">Hitsounds</button>
                <button class="ed-btn ed-toggle" id="ed-metro" title="Click on every beat while playing">Metronome</button>
                <span class="ed-grow"></span>
                <span class="ed-saved" id="ed-saved">Saved</span>
                <button class="ed-btn accent" id="ed-test" title="Play it from the cursor (T) — needs a controller">▶ Test</button>
                <div class="ed-menu-wrap"><button class="ed-btn" id="ed-tools">Tools ▾</button><div class="ed-menu hidden" id="ed-tools-menu"></div></div>
                <button class="ed-btn" id="ed-song" title="Song name, BPM, cover, environment">Song…</button>
                <button class="ed-btn" id="ed-export" title="Download a Beat Saber map zip">Export</button>
                <button class="ed-btn icon" id="ed-help" title="Shortcuts (?)">?</button>
            </div>
            <div class="ed-main">
                <div class="ed-left" id="ed-left"></div>
                <div class="ed-center" id="ed-center"><canvas id="ed-canvas"></canvas></div>
                <div class="ed-right">
                    <div class="ed-preview" id="ed-preview"><span class="ed-preview-label">3D PREVIEW</span></div>
                    <div class="ed-tabs" id="ed-tabs">
                        ${[['inspect', 'Inspect'], ['grid', 'Grid'], ['stats', 'Stats'], ['checks', 'Checks']].map(([k, l]) =>
                            `<button class="ed-tab" data-tab="${k}">${l}</button>`).join('')}
                    </div>
                    <div class="ed-panel" id="ed-panel"></div>
                </div>
            </div>
            <div class="ed-status" id="ed-status"></div>
        </div>`);
        this.menu._cleanup = () => this.close();
        cursor.disable();
        $('hint-bar').classList.add('hidden');
        document.body.classList.add('editing');
        $('hud').classList.add('hidden');

        this.timeline = new Timeline($('ed-canvas'), this);
        this.active = true;
        this.bindTop();
        this.renderTools();
        this.refreshDiffSelect();
        this.setPanel(this.panel);
        addEventListener('keydown', this._onKey, true);
        addEventListener('resize', this._onResize);
        this._ro = new ResizeObserver(() => this.layout());
        this._ro.observe($('ed-center'));
        this._ro.observe($('ed-preview'));
        this.layout();
        this.status('Click a cell to place · drag while placing to aim · right-click (or right-drag) deletes · Shift-drag selects · wheel scrolls, Ctrl+wheel zooms');
        this.rebuildPreview();
        this.updateTime();
    }

    layout() {
        if (!this.active) return;
        this.timeline.layout();
        const pv = $('ed-preview');
        this.engine.setViewBox(pv && pv.offsetParent ? pv.getBoundingClientRect() : null);
        this.timeline.invalidate();
    }

    focusTimeline() {
        if (document.activeElement && document.activeElement !== document.body) document.activeElement.blur();
    }

    // =====================================================================
    // Top bar + tool palette
    // =====================================================================
    bindTop() {
        $('ed-exit').onclick = () => this.showProjects();
        $('ed-undo').onclick = () => this.undo();
        $('ed-redo').onclick = () => this.redo();
        $('ed-play').onclick = () => this.togglePlay();
        const snapSel = $('ed-snap');
        snapSel.value = String(this.snap);
        snapSel.onchange = () => { this.snap = Number(snapSel.value); this.timeline.invalidate(); this.focusTimeline(); };
        const rate = $('ed-rate');
        rate.value = String(this.playRate);
        rate.onchange = () => { this.playRate = Number(rate.value); if (this.playing) audio.setRate(this.playRate); this.focusTimeline(); };
        const hits = $('ed-hits'), metro = $('ed-metro');
        hits.classList.toggle('on', this.hitsounds);
        metro.classList.toggle('on', this.metronome);
        hits.onclick = () => { this.hitsounds = !this.hitsounds; settings.set('editorHitsounds', this.hitsounds); hits.classList.toggle('on', this.hitsounds); };
        metro.onclick = () => { this.metronome = !this.metronome; settings.set('editorMetronome', this.metronome); metro.classList.toggle('on', this.metronome); };
        $('ed-diff').onchange = () => this.switchDiff(Number($('ed-diff').value));
        $('ed-diffs').onclick = () => this.showDiffDialog();
        $('ed-test').onclick = () => this.testPlay(true);
        $('ed-song').onclick = () => this.showSongDialog();
        $('ed-export').onclick = () => this.exportZip(this.project, this.files);
        $('ed-help').onclick = () => this.showHelp();
        $('ed-tabs').querySelectorAll('[data-tab]').forEach(b => { b.onclick = () => this.setPanel(b.dataset.tab); });

        const menu = $('ed-tools-menu');
        const items = [
            ['Mirror selection', 'M', () => this.mirror()],
            ['Swap colours of selection', 'N', () => this.flipColors()],
            ['Snap selection to grid', '', () => this.quantize()],
            ['Select everything', 'Ctrl+A', () => this.selectAll()],
            ['Make an arc from 2 notes', '', () => this.makeArc()],
            ['Make a chain from 2 notes', '', () => this.makeChain()],
            ['Add bookmark here', 'B', () => this.addBookmark()],
            ['Add BPM change here', '', () => this.addBpmChange()],
            ['Strobe generator…', '', () => this.showStrobe()],
            ['Light show from notes', '', () => this.autoLights()],
            ['Clear all lights', '', () => this.clearKind('events', 'Clear lights')],
            ['Clear all walls', '', () => this.clearKind('walls', 'Clear walls')],
        ];
        menu.innerHTML = items.map(([l, k], i) => `<button class="ed-menu-item" data-i="${i}"><span>${l}</span><kbd>${k}</kbd></button>`).join('');
        menu.querySelectorAll('[data-i]').forEach(b => { b.onclick = () => { menu.classList.add('hidden'); items[Number(b.dataset.i)][2](); }; });
        $('ed-tools').onclick = (e) => { e.stopPropagation(); menu.classList.toggle('hidden'); };
        document.addEventListener('click', () => menu.classList.add('hidden'));
    }

    renderTools() {
        const box = $('ed-left');
        const toolBtn = (k, label, key, extra = '') => `<button class="ed-tool ${this.tool === k ? 'active' : ''} ${extra}" data-tool="${k}" title="${label} (${key})"><span class="ed-tool-ico ${k}"></span>${label}<kbd>${key}</kbd></button>`;
        box.innerHTML = `
            <div class="ed-group"><div class="ed-group-title">Place</div>
                ${toolBtn('red', 'Red note', '1')}${toolBtn('blue', 'Blue note', '2')}${toolBtn('bomb', 'Bomb', '3')}${toolBtn('select', 'Select', 'V')}
                <div class="ed-tip">Walls and lights: just click in their columns.</div>
            </div>
            <div class="ed-group"><div class="ed-group-title">Direction</div>
                <div class="ed-dirpad">${DIR_PAD.map(d => `<button class="ed-dir ${this.dir === d ? 'active' : ''}" data-dir="${d}" title="${M.DIR_NAMES[d]}">${ARROWS[d]}</button>`).join('')}</div>
                <label class="ed-mini">Angle <input type="range" id="ed-angle" min="-45" max="45" step="5" value="${this.angle}"><span id="ed-angle-v">${this.angle}°</span></label>
            </div>
            <div class="ed-group"><div class="ed-group-title">Walls</div>
                <div class="ed-seg">${['full', 'crouch'].map(t => `<button class="ed-chip ${this.wallType === t ? 'active' : ''}" data-wall="${t}">${t === 'full' ? 'Full' : 'Crouch'}</button>`).join('')}</div>
            </div>
            <div class="ed-group"><div class="ed-group-title">Lights</div>
                <div class="ed-seg">${['blue', 'red', 'white', 'off'].map(c => `<button class="ed-chip lc-${c} ${this.eventColor === c ? 'active' : ''}" data-ecolor="${c}">${c[0].toUpperCase() + c.slice(1)}</button>`).join('')}</div>
                <div class="ed-seg">${M.LIGHT_MODES.map(md => `<button class="ed-chip ${this.eventMode === md ? 'active' : ''}" data-emode="${md}">${md === 'transition' ? 'Trans' : md[0].toUpperCase() + md.slice(1)}</button>`).join('')}</div>
                <label class="ed-mini">Brightness <input type="range" id="ed-bright" min="0" max="2" step="0.05" value="${this.eventBrightness}"><span id="ed-bright-v">${Math.round(this.eventBrightness * 100)}%</span></label>
                <label class="ed-mini">Laser speed <input type="range" id="ed-lspeed" min="0" max="20" step="1" value="${this.laserSpeed}"><span id="ed-lspeed-v">${this.laserSpeed}</span></label>
            </div>
            <div class="ed-group"><div class="ed-group-title">Custom colour <small>Chroma</small></div>
                <label class="ed-mini"><input type="checkbox" id="ed-cc-on" ${this.customColor ? 'checked' : ''}> Use <input type="color" id="ed-cc" value="${this.customColor ? rgbToHex(this.customColor) : '#ff00ff'}"></label>
            </div>`;
        box.querySelectorAll('[data-tool]').forEach(b => { b.onclick = () => this.setTool(b.dataset.tool); });
        box.querySelectorAll('[data-dir]').forEach(b => { b.onclick = () => this.setDir(Number(b.dataset.dir)); });
        box.querySelectorAll('[data-wall]').forEach(b => { b.onclick = () => { this.wallType = b.dataset.wall; this.renderTools(); }; });
        box.querySelectorAll('[data-ecolor]').forEach(b => { b.onclick = () => { this.eventColor = b.dataset.ecolor; this.renderTools(); }; });
        box.querySelectorAll('[data-emode]').forEach(b => { b.onclick = () => { this.eventMode = b.dataset.emode; this.renderTools(); }; });
        const ang = $('ed-angle');
        ang.oninput = () => { this.angle = Number(ang.value); $('ed-angle-v').textContent = this.angle + '°'; };
        const br = $('ed-bright');
        br.oninput = () => { this.eventBrightness = Number(br.value); $('ed-bright-v').textContent = Math.round(this.eventBrightness * 100) + '%'; };
        const ls = $('ed-lspeed');
        ls.oninput = () => { this.laserSpeed = Number(ls.value); $('ed-lspeed-v').textContent = this.laserSpeed; };
        const ccOn = $('ed-cc-on'), cc = $('ed-cc');
        const upd = () => { this.customColor = ccOn.checked ? hexToRgb(cc.value) : null; };
        ccOn.onchange = upd; cc.oninput = () => { ccOn.checked = true; upd(); };
        box.querySelectorAll('input[type="range"], input[type="checkbox"]').forEach(i => i.addEventListener('change', () => this.focusTimeline()));
    }

    setTool(t) { this.tool = t; this.renderTools(); this.timeline.invalidate(); }

    setDir(d) {
        // with notes selected, a direction re-aims them (like ChroMapper)
        const notes = [...this.sel].filter(o => kindOf(o) === 'notes');
        if (notes.length) {
            this.edit('Change direction', () => { for (const n of notes) n.d = d; });
        }
        this.dir = d;
        this.renderTools();
    }

    eventValue(et) {
        const lane = M.EVENT_LANES.find(l => l.et === et);
        if (!lane) return 0;
        if (lane.kind === 'speed') return this.laserSpeed;
        if (lane.kind === 'trigger') return 0;
        return this.eventColor === 'off' ? 0 : M.lightValue(this.eventColor, this.eventMode);
    }

    refreshDiffSelect() {
        const sel = $('ed-diff');
        if (!sel) return;
        sel.innerHTML = this.project.diffs.map((d, i) => `<option value="${i}">${esc(M.diffName(d))}</option>`).join('');
        sel.value = String(this.diffIndex);
    }

    status(msg) { const el = $('ed-status'); if (el) el.textContent = msg; }

    // =====================================================================
    // Editing
    // =====================================================================
    edit(label, fn) {
        this.history.record(this.diffIndex, this.data, label);
        fn(this.data);
        this.afterChange(label);
    }

    afterChange(label = '') {
        this._clock = null;
        for (const o of this.sel) if (!this.data[kindOf(o)].includes(o)) this.sel.delete(o);
        this.timeline.invalidate();
        this.schedulePreview();
        this.scheduleSave();
        this.refreshPanel();
        this.updateUndoButtons();
        if (label) this.status(label);
    }

    updateUndoButtons() {
        const u = $('ed-undo'), r = $('ed-redo');
        if (u) u.disabled = !this.history.canUndo;
        if (r) r.disabled = !this.history.canRedo;
    }

    removeAt(list, b, x, y) {
        for (let i = list.length - 1; i >= 0; i--) {
            const o = list[i];
            if (Math.abs(o.b - b) < 1e-4 && o.x === x && o.y === y) list.splice(i, 1);
        }
    }

    placeNote(lane, layer, beat, dirOverride = null) {
        if (this.tool === 'select') return;
        if (beat < 0) return;
        if (this.tool === 'bomb') {
            this.edit('Placed a bomb', (D) => {
                this.removeAt(D.notes, beat, lane, layer);
                this.removeAt(D.bombs, beat, lane, layer);
                D.bombs.push({ b: beat, x: lane, y: layer });
            });
        } else {
            const c = this.tool === 'blue' ? 1 : 0;
            const d = dirOverride ?? this.dir;
            if (dirOverride != null && dirOverride !== this.dir) { this.dir = dirOverride; this.renderTools(); }
            this.edit(`Placed a ${c ? 'blue' : 'red'} ${M.DIR_NAMES[d].toLowerCase()} note`, (D) => {
                this.removeAt(D.notes, beat, lane, layer);
                this.removeAt(D.bombs, beat, lane, layer);
                const n = { b: beat, x: lane, y: layer, c, d, a: d === 8 ? 0 : this.angle };
                if (this.customColor) n.color = [...this.customColor, 1];
                D.notes.push(n);
            });
        }
        audio.playClick(this.tool === 'blue' ? 990 : 760);
    }

    placeWall(x, w, b, d) {
        const [y, h] = WALL_TYPES[this.wallType];
        this.edit('Placed a wall', (D) => {
            const wall = { b, x, y, d, w, h };
            if (this.customColor) wall.color = [...this.customColor, 1];
            D.walls.push(wall);
        });
    }

    placeEvent(et, b) {
        if (b < 0) return;
        this.edit('Placed a light event', (D) => {
            for (let i = D.events.length - 1; i >= 0; i--) if (D.events[i].et === et && Math.abs(D.events[i].b - b) < 1e-4) D.events.splice(i, 1);
            const e = { b, et, i: this.eventValue(et), f: this.eventBrightness };
            if (this.customColor && M.EVENT_LANES.find(l => l.et === et).kind === 'light' && e.i) e.color = [...this.customColor, 1];
            D.events.push(e);
        });
    }

    // right-click / right-drag deletion: one undo step per stroke
    erase(objs, first) {
        if (first || !this._erasing) { this.history.record(this.diffIndex, this.data, 'Delete'); this._erasing = true; }
        for (const o of objs) {
            const list = this.data[kindOf(o)];
            const i = list.indexOf(o);
            if (i >= 0) list.splice(i, 1);
            this.sel.delete(o);
        }
        this.timeline.invalidate();
    }
    commitErase() { this._erasing = false; this.afterChange('Deleted'); }

    select(list, add = false) {
        if (!add) this.sel.clear();
        for (const o of list) this.sel.add(o);
        this.timeline.invalidate();
        this.refreshPanel();
        if (list.length) this.status(`${this.sel.size} selected · arrows / Alt+wheel move · M mirror · Del delete · Ctrl+C copy`);
    }
    toggleSelect(o) { if (this.sel.has(o)) this.sel.delete(o); else this.sel.add(o); this.timeline.invalidate(); this.refreshPanel(); }
    selectAll() {
        const D = this.data;
        this.select([...D.notes, ...D.bombs, ...D.walls, ...D.events, ...D.arcs, ...D.chains]);
    }

    moveSelection(dBeat, dLane) {
        if (!this.sel.size) return;
        this.edit('Moved', () => {
            for (const o of this.sel) {
                const k = kindOf(o);
                o.b = Math.max(0, Math.round((o.b + dBeat) * 10000) / 10000);
                if ('tb' in o) o.tb = Math.max(0, Math.round((o.tb + dBeat) * 10000) / 10000);
                if (!dLane || k === 'events') continue;
                if (k === 'walls') o.x = Math.max(0, Math.min(4 - Math.max(1, o.w), o.x + dLane));
                else {
                    o.x = Math.max(0, Math.min(3, o.x + dLane));
                    if ('tx' in o) o.tx = Math.max(0, Math.min(3, o.tx + dLane));
                }
            }
        });
    }

    deleteSelection() {
        if (!this.sel.size) return;
        const list = [...this.sel];
        this.edit(`Deleted ${list.length}`, (D) => {
            for (const o of list) { const arr = D[kindOf(o)]; const i = arr.indexOf(o); if (i >= 0) arr.splice(i, 1); }
        });
        this.sel.clear();
        this.refreshPanel();
    }

    copy(cut = false) {
        if (!this.sel.size) return;
        const items = [...this.sel];
        const base = Math.min(...items.map(o => o.b));
        this.clipboard = items.map(o => ({ kind: kindOf(o), o: { ...structuredClone(o), b: o.b - base, ...('tb' in o ? { tb: o.tb - base } : {}) } }));
        if (cut) this.deleteSelection();
        toast(`${cut ? 'Cut' : 'Copied'} ${items.length}`);
    }

    paste() {
        if (!this.clipboard || !this.clipboard.length) return;
        const at = this.timeline.snap(this.cursorBeat);
        const added = [];
        this.edit(`Pasted ${this.clipboard.length}`, (D) => {
            for (const { kind, o } of this.clipboard) {
                const c = structuredClone(o);
                c.b += at;
                if ('tb' in c) c.tb += at;
                D[kind].push(c);
                added.push(c);
            }
        });
        this.select(added);
    }

    mirror() {
        if (!this.sel.size) { toast('Select something to mirror first'); return; }
        const groups = { notes: [], bombs: [], walls: [], arcs: [], chains: [], events: [] };
        for (const o of this.sel) groups[kindOf(o)].push(o);
        this.edit('Mirrored', () => M.mirrorObjects(groups));
    }

    flipColors() {
        const items = [...this.sel].filter(o => 'c' in o);
        if (!items.length) { toast('Select notes to swap colours'); return; }
        this.edit('Swapped colours', () => { for (const o of items) o.c = 1 - o.c; });
    }

    quantize() {
        if (!this.sel.size) return;
        this.edit('Snapped to grid', () => {
            for (const o of this.sel) {
                o.b = this.timeline.snap(o.b);
                if ('tb' in o) o.tb = this.timeline.snap(o.tb);
            }
        });
    }

    selectedNotesPair() {
        const notes = [...this.sel].filter(o => kindOf(o) === 'notes').sort((a, b) => a.b - b.b);
        if (notes.length !== 2 || notes[0].c !== notes[1].c || notes[1].b <= notes[0].b) {
            toast('Select two notes of the same colour at different times', 'error');
            return null;
        }
        return notes;
    }

    makeArc() {
        const pair = this.selectedNotesPair();
        if (!pair) return;
        const [h, t] = pair;
        this.edit('Made an arc', (D) => {
            D.arcs.push({ c: h.c, b: h.b, x: h.x, y: h.y, d: h.d, mu: 1, tb: t.b, tx: t.x, ty: t.y, tc: t.d, tmu: 1, m: 0 });
        });
    }

    makeChain() {
        const pair = this.selectedNotesPair();
        if (!pair) return;
        const [h, t] = pair;
        this.edit('Made a chain', (D) => {
            D.chains.push({ b: h.b, x: h.x, y: h.y, c: h.c, d: h.d, tb: t.b, tx: t.x, ty: t.y, sc: 5, s: 1 });
            const i = D.notes.indexOf(t);      // the tail is just a position; the head note stays
            if (i >= 0) D.notes.splice(i, 1);
        });
        this.sel.clear();
    }

    addBookmark() {
        const name = prompt('Bookmark name', `Part ${this.data.bookmarks.length + 1}`);
        if (name == null) return;
        const b = this.timeline.snap(this.cursorBeat);
        this.edit('Added a bookmark', (D) => { D.bookmarks.push({ b, name: name.slice(0, 40) }); D.bookmarks.sort((a, c) => a.b - c.b); });
    }

    addBpmChange() {
        const b = this.timeline.snap(this.cursorBeat);
        const cur = this.clock.bpmAt(b);
        const v = Number(prompt(`New BPM from beat ${b}`, String(cur)));
        if (!(v > 0)) return;
        if (b <= 0) { this.project.info.bpm = v; this.afterChange('Song BPM changed'); return; }
        this.edit('Added a BPM change', (D) => {
            D.bpm = D.bpm.filter(e => Math.abs(e.b - b) > 1e-4);
            D.bpm.push({ b, m: v });
            D.bpm.sort((a, c) => a.b - c.b);
        });
    }

    clearKind(kind, label) {
        if (!this.data[kind].length) return;
        if (!confirm(`${label}? (${this.data[kind].length}) — you can undo this.`)) return;
        this.edit(label, (D) => { D[kind] = []; });
    }

    autoLights() {
        if (!this.data.notes.length) { toast('Place some notes first'); return; }
        const keep = this.data.events.length && !confirm('Replace the existing light events? (Cancel keeps them and adds the new ones.)');
        this.edit('Light show from notes', (D) => {
            const gen = M.autoLights(this.diff);
            D.events = keep ? [...D.events, ...gen] : gen;
        });
        toast('Light show added — tweak it on the timeline');
    }

    showStrobe() {
        const from = this.timeline.snap(this.cursorBeat);
        const bd = this.modal(`<h2>Strobe generator</h2>
            <div class="sub">Alternating light events on a lane.</div>
            <div class="ed-form">
                <label class="ed-field"><span>Lane</span><select class="search-box" id="sg-lane">${M.EVENT_LANES.filter(l => l.kind === 'light').map(l => `<option value="${l.et}">${l.name}</option>`).join('')}</select></label>
                <label class="ed-field"><span>From beat</span><input class="search-box" type="number" id="sg-from" value="${from}" step="0.25"></label>
                <label class="ed-field"><span>To beat</span><input class="search-box" type="number" id="sg-to" value="${from + 4}" step="0.25"></label>
                <label class="ed-field"><span>Every</span><select class="search-box" id="sg-step">${[1, 2, 4, 8, 16].map(s => `<option value="${1 / s}" ${s === 4 ? 'selected' : ''}>1/${s} beat</option>`).join('')}</select></label>
                <label class="ed-field"><span>Pattern</span><select class="search-box" id="sg-pat">
                    <option value="1,0">Blue · off</option><option value="5,0">Red · off</option><option value="1,5">Blue · red</option>
                    <option value="2,6">Blue flash · red flash</option><option value="9,0">White · off</option></select></label>
            </div>
            <div class="menu-buttons" style="width:100%"><button class="btn primary" id="sg-go">Add strobe</button><button class="btn small modal-close">Cancel</button></div>`);
        bd.querySelector('#sg-go').onclick = () => {
            const et = Number(bd.querySelector('#sg-lane').value);
            const f = Number(bd.querySelector('#sg-from').value), t = Number(bd.querySelector('#sg-to').value);
            const step = Number(bd.querySelector('#sg-step').value);
            const values = bd.querySelector('#sg-pat').value.split(',').map(Number);
            if (!(t > f)) { toast('“To” must be after “From”', 'error'); return; }
            this.edit('Strobe', (D) => {
                D.events = D.events.filter(e => !(e.et === et && e.b >= f - 1e-6 && e.b <= t + 1e-6));
                D.events.push(...M.strobe({ et, from: f, to: t, step, values }));
            });
            bd.remove();
        };
    }

    undo() {
        const step = this.history.undo((i) => this.project.diffs[i].data);
        if (!step) return;
        this.project.diffs[step.diffIndex].data = step.data;
        if (step.diffIndex !== this.diffIndex) { this.diffIndex = step.diffIndex; this.refreshDiffSelect(); }
        this.sel.clear();
        this.afterChange('Undid: ' + step.label);
    }

    redo() {
        const step = this.history.redo((i) => this.project.diffs[i].data);
        if (!step) return;
        this.project.diffs[step.diffIndex].data = step.data;
        if (step.diffIndex !== this.diffIndex) { this.diffIndex = step.diffIndex; this.refreshDiffSelect(); }
        this.sel.clear();
        this.afterChange('Redid: ' + step.label);
    }

    switchDiff(i) {
        if (i === this.diffIndex || !this.project.diffs[i]) return;
        this.diffIndex = i;
        this.sel.clear();
        this._clock = null;
        this.refreshDiffSelect();
        this.timeline.invalidate();
        this.rebuildPreview();
        this.refreshPanel();
        this.scheduleSave();
    }

    // =====================================================================
    // Cursor, zoom, playback
    // =====================================================================
    setCursor(beat) {
        const b = Math.max(0, Math.min(this.endBeat, beat));
        this.cursorBeat = b;
        if (this.playing && this.gp) { this.gp.seek(this.cursorSec); audio.setRate(this.playRate); }
        else this._pendingSeek = true;
        this.timeline.invalidate();
        this.updateTime();
        if (this.panel === 'grid') this.refreshPanel();
    }

    stepCursor(n) {
        const s = this.snap;
        const base = Math.round(this.cursorBeat * s) / s;
        this.setCursor(base + n / s);
    }

    setZoom(z) { this.zoom = Math.max(20, Math.min(900, z)); this.timeline.invalidate(); }

    updateTime() {
        const el = $('ed-time');
        if (!el) return;
        el.textContent = `${fmtSec(this.cursorSec)} · beat ${this.cursorBeat.toFixed(3)}`;
    }

    togglePlay() { if (this.playing) this.pause(); else this.play(); }

    play() {
        if (!this.gp) this.rebuildPreview();
        if (!this.gp) return;
        if (this.cursorSec >= this.songLen - 0.05) this.setCursor(0);
        this.playing = true;
        this.gp.paused = false;
        this.gp.seek(this.cursorSec);
        audio.setRate(this.playRate);
        this._lastBeat = this.cursorBeat;
        const b = $('ed-play');
        if (b) { b.textContent = '❚❚'; b.classList.add('on'); }
    }

    pause() {
        if (!this.playing) return;
        this.playing = false;
        this.holdPreview();
        const b = $('ed-play');
        if (b) { b.textContent = '▶'; b.classList.remove('on'); }
        this.timeline.invalidate();
        this.updateTime();
        if (this.panel === 'grid') this.refreshPanel();
    }

    onSongEnd() {
        this.pause();
        this.setCursor(this.endBeat);
    }

    // per frame, from the main loop
    update() {
        if (!this.active) return;
        if (this.playing && this.gp) {
            const sec = audio.songTime - (this.gp.latency || 0);
            const beat = this.clock.toBeats(sec);
            const prev = this._lastBeat ?? beat;
            if (beat > prev && beat - prev < 1) {
                if (this.hitsounds && this.data.notes.some(n => n.b > prev && n.b <= beat)) audio.playHit(0.8);
                if (this.metronome && Math.floor(beat) > Math.floor(prev)) audio.playClick(Math.floor(beat) % 4 === 0 ? 1400 : 950);
            }
            this._lastBeat = beat;
            this.cursorBeat = Math.max(0, beat);
            this.timeline.invalidate();
            const now = performance.now();
            if (now - (this._lastTimeUi || 0) > 60) { this._lastTimeUi = now; this.updateTime(); }
        } else if (this._pendingSeek && this.gp) {
            this._pendingSeek = false;
            this.gp.seek(this.cursorSec);
        }
        if (this._previewAt && performance.now() >= this._previewAt) this.rebuildPreview();
        this.timeline.render();
    }

    // =====================================================================
    // 3D preview (the game itself, in preview mode)
    // =====================================================================
    schedulePreview() { this._previewAt = performance.now() + (this.playing ? 400 : 120); }

    rebuildPreview() {
        this._previewAt = 0;
        if (!this.active || !this.songBuffer) return;
        const was = this.playing;
        const sec = this.cursorSec;
        this.destroyPreview();
        try {
            const mapData = parseDifficulty(M.toV3(this.diff, this.project), this.project.info.bpm);
            const gp = new Gameplay(this.engine, mapData, this.songBuffer, {
                preview: true,
                songName: this.project.info.songName,
                njs: this.diff.njs,
                offsetBeats: this.diff.offset,
                bpm: this.project.info.bpm,
                mapId: 'editor',
                startAt: Math.max(0, sec),
                onEnd: () => this.onSongEnd(),
            });
            this.gp = gp;
            this.engine.gameplay = gp;
            $('hud').classList.add('hidden');
            if (was) { gp.seek(sec); audio.setRate(this.playRate); }
            else { this.holdPreview(); gp.seek(sec); }
        } catch (err) {
            console.error('Preview failed', err);
            this.status('3D preview failed: ' + err.message);
        }
    }

    // freeze the preview on the cursor: the music stops but the audio
    // context keeps running, so placement clicks and hitsounds still play
    holdPreview() {
        if (!this.gp) return;
        this.gp.paused = true;
        audio.stopSong();
    }

    destroyPreview() {
        if (!this.gp) return;
        if (this.engine.gameplay === this.gp) this.engine.gameplay = null;
        try { this.gp.destroy(); } catch (e) { console.error(e); }
        this.gp = null;
    }

    previewError(err) {
        this.destroyPreview();
        this.playing = false;
        this.status('3D preview stopped after an error: ' + (err && err.message ? err.message : err));
    }

    // =====================================================================
    // Save / publish / export / test play
    // =====================================================================
    scheduleSave() {
        const el = $('ed-saved');
        if (el) { el.textContent = 'Saving…'; el.classList.add('busy'); }
        clearTimeout(this._saveT);
        this._saveT = setTimeout(() => this.saveNow().catch(err => { console.error(err); toast('Couldn\'t save: ' + err.message, 'error'); }), 700);
    }

    async saveNow(publish = false) {
        clearTimeout(this._saveT);
        const p = this.project;
        if (!p) return;
        p.updated = Date.now();
        p.editor = { diff: this.diffIndex, cursor: this.cursorBeat, snap: this.snap, zoom: this.zoom };
        await store.put(p);
        if (publish) await saveLibraryRecord(await this.buildRecord(p, this.files));
        const el = $('ed-saved');
        if (el) { el.textContent = 'Saved'; el.classList.remove('busy'); }
    }

    // the map as a song-list entry (also what test play and export use)
    async buildRecord(p, files) {
        let coverBlob = files && files.coverBlob;
        if (!coverBlob) coverBlob = await makeCover(p);
        const coverName = coverBlob.type === 'image/png' ? 'cover.png' : 'cover.jpg';
        const { infoRaw, info, diffFiles } = M.buildMapFiles(p, coverName);
        return {
            id: 'edit-' + p.id,
            meta: {
                id: 'edit-' + p.id, name: p.info.songName, songName: p.info.songName, songAuthor: p.info.songAuthor,
                mapper: p.info.levelAuthor, bpm: p.info.bpm, duration: p.song.duration, own: true,
                hasChroma: p.diffs.some(M.usesChroma), hasNoodle: false,
            },
            info, infoRaw, diffFiles,
            songBuf: files.songBuf,
            coverBlob,
            savedAt: Date.now(),
        };
    }

    async exportZip(p, files) {
        try {
            const rec = await this.buildRecord(p, files);
            const zip = new JSZip();
            zip.file('Info.dat', rec.infoRaw);
            for (const [name, text] of Object.entries(rec.diffFiles)) zip.file(name, text);
            zip.file(M.songFilename(p), files.songBuf);
            zip.file(rec.coverBlob.type === 'image/png' ? 'cover.png' : 'cover.jpg', rec.coverBlob);
            const blob = await zip.generateAsync({ type: 'blob', compression: 'DEFLATE' });
            download(blob, `${sanitize(p.info.songName)} - ${sanitize(p.info.levelAuthor || 'map')}.zip`);
            const ext = (p.song.ext || '').toLowerCase();
            toast(ext === 'ogg' || ext === 'egg' ? 'Exported — drop the zip into Beat Saber\'s CustomLevels (unzipped) or ChroMapper'
                : 'Exported. Beat Saber needs the song as .ogg/.egg — convert it (e.g. with Audacity) before using the map there', ext === 'ogg' || ext === 'egg' ? '' : 'error');
            return blob;
        } catch (err) {
            console.error(err);
            toast('Export failed: ' + err.message, 'error');
            return null;
        }
    }

    async testPlay(fromCursor = true) {
        if (!gamepad.connected) { toast('Connect a controller to test-play (the 3D preview plays it without one: press Space)', 'error'); return; }
        this.pause();
        await this.saveNow(true);
        const rec = await this.buildRecord(this.project, this.files);
        const d = rec.info.difficulties.find(x => x.characteristic === this.diff.characteristic && x.difficulty === this.diff.difficulty);
        const m = this.menu;
        m.practice = { id: rec.id, start: fromCursor ? Math.max(0, this.cursorSec) : 0 };
        m.returnTo = { editor: this.project.id };
        if (this.songBuffer) { m.dropAudioCache(); m.audioCache = { id: rec.id, buffer: this.songBuffer }; }
        this.close();
        await m.startLevel(null, rec, d);
    }

    // =====================================================================
    // Right-hand panel: inspector, placement grid, stats, checks
    // =====================================================================
    setPanel(name) {
        this.panel = name;
        $('ed-tabs').querySelectorAll('[data-tab]').forEach(b => b.classList.toggle('active', b.dataset.tab === name));
        this.refreshPanel();
    }

    refreshPanel() {
        const box = $('ed-panel');
        if (!box || !this.active) return;
        if (this.panel === 'grid') this.renderGrid(box);
        else if (this.panel === 'stats') this.renderStats(box);
        else if (this.panel === 'checks') this.renderChecks(box);
        else this.renderInspector(box);
    }

    renderInspector(box) {
        const items = [...this.sel];
        if (!items.length) {
            box.innerHTML = `<div class="ed-insp-empty">Nothing selected.<br><br>Click an object to inspect it, Shift-drag to select many, or use the <b>Select</b> tool (V).</div>`;
            return;
        }
        if (items.length > 1) {
            const counts = {};
            for (const o of items) counts[kindOf(o)] = (counts[kindOf(o)] || 0) + 1;
            box.innerHTML = `<div class="ed-insp-title">${items.length} selected</div>
                <div class="ed-insp-counts">${Object.entries(counts).map(([k, v]) => `<span>${v} ${k}</span>`).join('')}</div>
                <div class="ed-insp-actions">
                    <button class="btn small" data-a="mirror">Mirror (M)</button><button class="btn small" data-a="flip">Swap colours (N)</button>
                    <button class="btn small" data-a="earlier">− ${'1/' + this.snap}</button><button class="btn small" data-a="later">+ ${'1/' + this.snap}</button>
                    <button class="btn small" data-a="quant">Snap to grid</button><button class="btn small" data-a="copy">Copy</button>
                    ${counts.notes === 2 && items.length === 2 ? '<button class="btn small" data-a="arc">Make arc</button><button class="btn small" data-a="chain">Make chain</button>' : ''}
                    <button class="btn small danger" data-a="del">Delete</button>
                </div>`;
            const act = { mirror: () => this.mirror(), flip: () => this.flipColors(), earlier: () => this.moveSelection(-1 / this.snap, 0),
                later: () => this.moveSelection(1 / this.snap, 0), quant: () => this.quantize(), copy: () => this.copy(), del: () => this.deleteSelection(),
                arc: () => this.makeArc(), chain: () => this.makeChain() };
            box.querySelectorAll('[data-a]').forEach(b => { b.onclick = () => act[b.dataset.a](); });
            return;
        }
        const o = items[0], k = kindOf(o);
        const num = (key, label, step = 1, min = '', max = '') => `<label class="ed-field"><span>${label}</span><input class="search-box" type="number" data-k="${key}" value="${o[key] ?? 0}" step="${step}" min="${min}" max="${max}"></label>`;
        const sel = (key, label, opts) => `<label class="ed-field"><span>${label}</span><select class="search-box" data-k="${key}">${opts.map(([v, l]) => `<option value="${v}" ${String(o[key]) === String(v) ? 'selected' : ''}>${l}</option>`).join('')}</select></label>`;
        const lanes = [[0, 'Far left'], [1, 'Left'], [2, 'Right'], [3, 'Far right']];
        const rows = [[0, 'Bottom'], [1, 'Middle'], [2, 'Top']];
        const color = `<label class="ed-field"><span>Custom colour <small>Chroma</small></span><span class="ed-cc"><input type="checkbox" data-cc ${o.color ? 'checked' : ''}><input type="color" data-ccv value="${o.color ? rgbToHex(o.color) : '#ff00ff'}"></span></label>`;
        let html = '', title = '';
        if (k === 'notes') {
            title = `${o.c ? 'Blue' : 'Red'} note`;
            html = num('b', 'Beat', 1 / this.snap, 0) + sel('x', 'Lane', lanes) + sel('y', 'Row', rows) + sel('c', 'Colour', [[0, 'Red'], [1, 'Blue']])
                + sel('d', 'Direction', M.DIR_NAMES.map((n, i) => [i, `${ARROWS[i]} ${n}`])) + num('a', 'Angle offset (°)', 5, -360, 360) + color;
        } else if (k === 'bombs') {
            title = 'Bomb';
            html = num('b', 'Beat', 1 / this.snap, 0) + sel('x', 'Lane', lanes) + sel('y', 'Row', rows);
        } else if (k === 'walls') {
            title = 'Wall';
            html = num('b', 'Beat', 1 / this.snap, 0) + num('d', 'Length (beats)', 1 / this.snap, 0) + sel('x', 'Lane', lanes) + num('w', 'Width (lanes)', 1, 1, 4)
                + sel('y', 'Bottom row', rows) + num('h', 'Height (rows)', 1, 1, 5) + color;
        } else if (k === 'events') {
            const lane = M.EVENT_LANES.find(l => l.et === o.et) || { name: 'Event ' + o.et, kind: 'light' };
            title = lane.name + ' light event';
            html = num('b', 'Beat', 1 / this.snap, 0);
            if (lane.kind === 'light') {
                const opts = [[0, 'Off']];
                for (const c of M.LIGHT_COLORS) for (const mo of M.LIGHT_MODES) opts.push([M.lightValue(c, mo), `${c} ${mo}`]);
                html += sel('i', 'Value', opts) + num('f', 'Brightness', 0.05, 0, 3) + color;
            } else if (lane.kind === 'speed') html += num('i', 'Laser speed', 1, 0, 20);
        } else if (k === 'arcs') {
            title = `${o.c ? 'Blue' : 'Red'} arc`;
            html = num('b', 'Head beat', 1 / this.snap, 0) + num('tb', 'Tail beat', 1 / this.snap, 0) + num('mu', 'Head curve', 0.1, 0, 5) + num('tmu', 'Tail curve', 0.1, 0, 5)
                + sel('m', 'Mid anchor', [[0, 'Straight'], [1, 'Clockwise'], [2, 'Counter-clockwise']]);
        } else if (k === 'chains') {
            title = `${o.c ? 'Blue' : 'Red'} chain`;
            html = num('b', 'Head beat', 1 / this.snap, 0) + num('tb', 'Tail beat', 1 / this.snap, 0) + sel('tx', 'Tail lane', lanes) + sel('ty', 'Tail row', rows)
                + num('sc', 'Segments', 1, 2, 32) + num('s', 'Squish', 0.1, 0.1, 2);
        }
        box.innerHTML = `<div class="ed-insp-title">${esc(title)}</div><div class="ed-form">${html}</div>
            <div class="ed-insp-actions"><button class="btn small" data-a="copy">Copy</button><button class="btn small danger" data-a="del">Delete</button></div>`;
        box.querySelectorAll('[data-k]').forEach(inp => {
            inp.onchange = () => {
                const key = inp.dataset.k;
                let v = Number(inp.value);
                if (!Number.isFinite(v)) return;
                if (['x', 'tx'].includes(key)) v = Math.max(0, Math.min(3, Math.round(v)));
                if (['y', 'ty'].includes(key)) v = Math.max(0, Math.min(2, Math.round(v)));
                if (key === 'b' || key === 'tb' || key === 'd') v = Math.max(0, v);
                this.edit(`Edited ${title.toLowerCase()}`, () => { o[key] = v; });
            };
        });
        const ccOn = box.querySelector('[data-cc]'), ccV = box.querySelector('[data-ccv]');
        if (ccOn) {
            ccOn.onchange = () => this.edit('Colour', () => { if (ccOn.checked) o.color = [...hexToRgb(ccV.value), 1]; else delete o.color; });
            ccV.onchange = () => this.edit('Colour', () => { o.color = [...hexToRgb(ccV.value), 1]; });
        }
        box.querySelector('[data-a="copy"]').onclick = () => this.copy();
        box.querySelector('[data-a="del"]').onclick = () => this.deleteSelection();
    }

    // the 4×3 grid at the cursor, as the player sees it
    renderGrid(box) {
        const b = this.timeline.snap(this.cursorBeat);
        const D = this.data;
        const at = (list) => list.filter(o => Math.abs(o.b - b) < 1e-4);
        const notes = at(D.notes), bombs = at(D.bombs);
        let cells = '';
        for (let y = 2; y >= 0; y--) {
            for (let x = 0; x < 4; x++) {
                const n = notes.find(o => o.x === x && o.y === y), bo = bombs.find(o => o.x === x && o.y === y);
                const inner = n ? `<span class="ed-gnote c${n.c}" style="transform:rotate(${-(n.a || 0)}deg)">${ARROWS[n.d]}</span>` : bo ? '<span class="ed-gbomb"></span>' : '';
                cells += `<button class="ed-gcell" data-x="${x}" data-y="${y}">${inner}</button>`;
            }
        }
        box.innerHTML = `<div class="ed-insp-title">Grid at beat ${b}</div>
            <div class="ed-grid">${cells}</div>
            <div class="ed-tip">Click to place the current tool here, drag inside a cell to aim, right-click to remove. Scroll the timeline to move in time.</div>`;
        box.querySelectorAll('.ed-gcell').forEach(c => {
            let start = null;
            c.addEventListener('contextmenu', (e) => {
                e.preventDefault();
                const x = Number(c.dataset.x), y = Number(c.dataset.y);
                const objs = [...notes, ...bombs].filter(o => o.x === x && o.y === y);
                if (objs.length) { this.erase(objs, true); this.commitErase(); }
            });
            c.addEventListener('pointerdown', (e) => { if (e.button === 0) start = { x: e.clientX, y: e.clientY }; });
            c.addEventListener('pointerup', (e) => {
                if (!start || e.button !== 0) return;
                const dx = e.clientX - start.x, dy = e.clientY - start.y;
                start = null;
                const dir = Math.hypot(dx, dy) > 10 ? dirFromDrag(dx, dy) : null;
                if (this.tool === 'select') this.setTool('red');
                this.placeNote(Number(c.dataset.x), Number(c.dataset.y), b, dir);
            });
        });
    }

    renderStats(box) {
        const s = M.stats(this.project, this.diff, this.songLen);
        const d = this.diff;
        box.innerHTML = `<div class="ed-insp-title">${esc(M.diffName(d))}</div>
            <div class="ed-stats">
                <div><b>${s.notes}</b><span>notes</span></div><div><b>${s.nps.toFixed(2)}</b><span>notes / sec</span></div>
                <div><b class="red">${s.red}</b><span>red</span></div><div><b class="blue">${s.blue}</b><span>blue</span></div>
                <div><b>${s.bombs}</b><span>bombs</span></div><div><b>${s.walls}</b><span>walls</span></div>
                <div><b>${s.events}</b><span>light events</span></div><div><b>${s.arcs + s.chains}</b><span>arcs + chains</span></div>
            </div>
            <div class="ed-form">
                <label class="ed-field"><span>Note jump speed</span><input class="search-box" type="number" id="st-njs" value="${d.njs}" step="0.5" min="1" max="40"></label>
                <label class="ed-field"><span>Start beat offset</span><input class="search-box" type="number" id="st-off" value="${d.offset}" step="0.05" min="-5" max="5"></label>
            </div>
            <div class="ed-jd">Jump distance <b>${s.jd.toFixed(2)} m</b> · reaction time <b>${Math.round(s.rt * 1000)} ms</b>
                <div class="ed-tip">Most players like 550–800 ms. Higher NJS = faster notes; a negative offset brings them closer.</div></div>
            <div class="ed-tip">Song ${fmtSec(this.songLen)} · ${this.project.info.bpm} BPM${this.data.bpm.length ? ` · ${this.data.bpm.length} BPM change${this.data.bpm.length > 1 ? 's' : ''}` : ''}</div>`;
        const njs = $('st-njs'), off = $('st-off');
        njs.onchange = () => { d.njs = Math.max(1, Number(njs.value) || d.njs); this.afterChange('NJS changed'); };
        off.onchange = () => { d.offset = Number(off.value) || 0; this.afterChange('Offset changed'); };
    }

    renderChecks(box) {
        const issues = M.checkMap(this.project, this.diff, this.songLen);
        box.innerHTML = `<div class="ed-insp-title">${issues.length ? `${issues.length} thing${issues.length > 1 ? 's' : ''} to check` : 'No problems found ✓'}</div>
            <div class="ed-checks">${issues.slice(0, 200).map((it, i) => `<button class="ed-check k-${it.kind}" data-i="${i}"><b>beat ${Math.round(it.b * 1000) / 1000}</b> ${esc(it.msg)}</button>`).join('')}</div>`;
        box.querySelectorAll('[data-i]').forEach(b => { b.onclick = () => this.setCursor(issues[Number(b.dataset.i)].b); });
    }

    // =====================================================================
    // Dialogs
    // =====================================================================
    modal(html) {
        const bd = document.createElement('div');
        bd.className = 'modal-backdrop ed-modal';
        bd.innerHTML = `<div class="modal" style="width:min(560px,94vw)">${html}</div>`;
        document.body.appendChild(bd);
        bd.addEventListener('click', (e) => { if (e.target === bd || e.target.closest('.modal-close')) bd.remove(); });
        return bd;
    }

    showDiffDialog() {
        const p = this.project;
        const bd = this.modal(`<h2>Difficulties</h2><div class="sub">Each difficulty is its own set of notes, walls and lights.</div>
            <div class="ed-diff-list" id="dd-list"></div>
            <div class="ed-diff-add">
                <select class="search-box" id="dd-char">${M.CHARACTERISTICS.map(c => `<option>${c}</option>`).join('')}</select>
                <select class="search-box" id="dd-diff">${M.DIFFICULTIES.map(d => `<option value="${d}">${M.DIFF_LABEL[d]}</option>`).join('')}</select>
                <select class="search-box" id="dd-copy"><option value="-1">Empty</option>${p.diffs.map((d, i) => `<option value="${i}">Copy of ${esc(M.diffName(d))}</option>`).join('')}</select>
                <button class="btn small primary" id="dd-add">Add</button>
            </div>
            <button class="btn small modal-close">Done</button>`);
        const list = bd.querySelector('#dd-list');
        const render = () => {
            list.innerHTML = p.diffs.map((d, i) => {
                const s = M.stats(p, d, this.songLen);
                return `<div class="ed-diff-row ${i === this.diffIndex ? 'active' : ''}">
                    <div class="ed-diff-name">${esc(M.diffName(d))}<small>${s.notes} notes · ${s.nps.toFixed(1)} nps</small></div>
                    <label>NJS <input class="search-box" type="number" data-i="${i}" data-k="njs" value="${d.njs}" step="0.5"></label>
                    <label>Offset <input class="search-box" type="number" data-i="${i}" data-k="offset" value="${d.offset}" step="0.05"></label>
                    <label>Label <input class="search-box" type="text" data-i="${i}" data-k="label" value="${esc(d.label)}" placeholder="${M.DIFF_LABEL[d.difficulty]}"></label>
                    <button class="btn small" data-open="${i}">Edit</button>
                    <button class="btn small danger" data-del="${i}" ${p.diffs.length < 2 ? 'disabled' : ''}>✕</button>
                </div>`;
            }).join('');
            list.querySelectorAll('[data-k]').forEach(inp => {
                inp.onchange = () => {
                    const d = p.diffs[Number(inp.dataset.i)];
                    d[inp.dataset.k] = inp.dataset.k === 'label' ? inp.value.trim().slice(0, 30) : Number(inp.value) || 0;
                    this.refreshDiffSelect();
                    this.afterChange('Difficulty settings changed');
                };
            });
            list.querySelectorAll('[data-open]').forEach(b => { b.onclick = () => { this.switchDiff(Number(b.dataset.open)); bd.remove(); }; });
            list.querySelectorAll('[data-del]').forEach(b => {
                b.onclick = () => {
                    const i = Number(b.dataset.del);
                    if (b.dataset.armed !== '1') { b.dataset.armed = '1'; b.textContent = 'Sure?'; return; }
                    p.diffs.splice(i, 1);
                    this.history = new M.History();
                    this.diffIndex = Math.min(this.diffIndex, p.diffs.length - 1);
                    this.refreshDiffSelect();
                    this.switchDiffForce();
                    render();
                };
            });
        };
        render();
        bd.querySelector('#dd-add').onclick = () => {
            const ch = bd.querySelector('#dd-char').value, df = bd.querySelector('#dd-diff').value;
            if (p.diffs.some(d => d.characteristic === ch && d.difficulty === df)) { toast('That difficulty already exists', 'error'); return; }
            const from = Number(bd.querySelector('#dd-copy').value);
            p.diffs.push(M.newDifficulty(ch, df, from >= 0 ? p.diffs[from] : null));
            M.sortDiffs(p.diffs);
            this.history = new M.History();
            const idx = p.diffs.findIndex(d => d.characteristic === ch && d.difficulty === df);
            this.diffIndex = idx;
            this.refreshDiffSelect();
            this.switchDiffForce();
            render();
            toast(`${M.diffName(p.diffs[idx])} added`);
        };
    }

    switchDiffForce() {
        this.sel.clear();
        this._clock = null;
        this.timeline.invalidate();
        this.rebuildPreview();
        this.refreshPanel();
        this.scheduleSave();
        this.updateUndoButtons();
    }

    showSongDialog() {
        const p = this.project, I = p.info;
        const bd = this.modal(`<h2>Song</h2>
            <div class="ed-form">
                <label class="ed-field"><span>Song name</span><input class="search-box" id="sd-name" value="${esc(I.songName)}"></label>
                <label class="ed-field"><span>Sub name</span><input class="search-box" id="sd-sub" value="${esc(I.songSubName || '')}"></label>
                <label class="ed-field"><span>Artist</span><input class="search-box" id="sd-artist" value="${esc(I.songAuthor)}"></label>
                <label class="ed-field"><span>Mapper</span><input class="search-box" id="sd-mapper" value="${esc(I.levelAuthor)}"></label>
                <div class="ed-field"><span>BPM <small>notes stay on their beats</small></span><div class="ed-bpm-row">
                    <input class="search-box" id="sd-bpm" type="number" step="0.01" value="${I.bpm}">
                    <button class="btn small" id="sd-detect" ${this.songBuffer && !this.songBuffer.isMedia ? '' : 'disabled'}>Detect</button>
                    <span class="ed-hint" id="sd-hint"></span></div></div>
                <label class="ed-field"><span>Preview start (s)</span><input class="search-box" id="sd-ps" type="number" step="0.5" value="${I.previewStart}"></label>
                <label class="ed-field"><span>Preview length (s)</span><input class="search-box" id="sd-pd" type="number" step="0.5" value="${I.previewDuration}"></label>
                <label class="ed-field"><span>Environment <small>for Beat Saber</small></span><select class="search-box" id="sd-env">${ENVIRONMENTS.map(e => `<option ${e === I.environment ? 'selected' : ''}>${e}</option>`).join('')}</select></label>
                <label class="ed-field"><span>Cover image</span><span class="ed-cover-row"><span class="ed-cover-thumb" style="${p.thumb ? `background-image:url(${p.thumb})` : ''}"></span><input type="file" id="sd-cover" accept="image/*"></span></label>
                <label class="ed-field"><span>Replace song audio</span><input type="file" id="sd-song" accept="audio/*,.egg,.ogg,.mp3,.wav"></label>
            </div>
            <div class="menu-buttons" style="width:100%"><button class="btn primary" id="sd-save">Save</button><button class="btn small modal-close">Cancel</button></div>`);
        bd.querySelector('#sd-detect').onclick = () => {
            const bpm = detectBpm(this.songBuffer);
            bd.querySelector('#sd-hint').textContent = bpm ? `Detected ${bpm}` : 'Couldn\'t tell';
            if (bpm) bd.querySelector('#sd-bpm').value = bpm;
        };
        bd.querySelector('#sd-save').onclick = async () => {
            const v = (id) => bd.querySelector(id).value;
            I.songName = v('#sd-name').trim() || I.songName;
            I.songSubName = v('#sd-sub').trim();
            I.songAuthor = v('#sd-artist').trim();
            I.levelAuthor = v('#sd-mapper').trim();
            I.bpm = Number(v('#sd-bpm')) > 0 ? Number(v('#sd-bpm')) : I.bpm;
            I.previewStart = Math.max(0, Number(v('#sd-ps')) || 0);
            I.previewDuration = Math.max(1, Number(v('#sd-pd')) || 10);
            I.environment = v('#sd-env');
            const cf = bd.querySelector('#sd-cover').files[0];
            const sf = bd.querySelector('#sd-song').files[0];
            if (cf) {
                this.files.coverBlob = cf.slice(0, cf.size, cf.type || 'image/jpeg');
                p.hasCover = true;
            }
            if (sf) {
                try {
                    const buf = await sf.arrayBuffer();
                    const dec = await audio.decode(buf, { allowStream: false });
                    this.files.songBuf = buf;
                    p.song.ext = (sf.name.split('.').pop() || 'ogg').toLowerCase();
                    p.song.duration = dec.duration;
                    this.songBuffer = dec;
                    this.wave = computePeaks(dec);
                } catch (err) { toast('Couldn\'t read that song: ' + err.message, 'error'); return; }
            }
            if (cf || sf) await store.putFiles(this.files);
            p.thumb = await thumbOf(this.files.coverBlob || await makeCover(p));
            const t = document.querySelector('.ed-title');
            if (t) t.textContent = I.songName;
            bd.remove();
            this.afterChange('Song details saved');
            this.rebuildPreview();
        };
    }

    showHelp() {
        this.modal(`<h2>Shortcuts</h2>
            <div class="rb-keys ed-keys">
                <div><b>Click</b><span>place (notes / walls / lights by column)</span></div>
                <div><b>Drag while placing</b><span>aim the note / size the wall</span></div>
                <div><b>Right-click / drag</b><span>delete</span></div>
                <div><b>Shift-drag</b><span>box select (Ctrl-click adds)</span></div>
                <div><b>Drag selection</b><span>move in time and lanes</span></div>
                <div><b>Wheel</b> / <b>↑ ↓</b><span>move in time (Shift: 4×)</span></div>
                <div><b>Ctrl+wheel</b> / <b>− =</b><span>zoom</span></div>
                <div><b>[ ]</b><span>snap finer / coarser</span></div>
                <div><b>Space</b><span>play / pause</span></div>
                <div><b>1 2 3 V</b><span>red / blue / bomb / select</span></div>
                <div><b>W A S D Q E Z C</b> · <b>F</b><span>aim up / left / down / right / diagonals · dot (numpad too)</span></div>
                <div><b>← →</b><span>move selection across lanes</span></div>
                <div><b>Alt+↑ ↓</b><span>move selection in time</span></div>
                <div><b>Ctrl+C X V</b><span>copy / cut / paste at the cursor</span></div>
                <div><b>Ctrl+Z / Ctrl+Y</b><span>undo / redo</span></div>
                <div><b>Del</b><span>delete selection</span></div>
                <div><b>M</b> · <b>N</b><span>mirror · swap colours</span></div>
                <div><b>B</b><span>bookmark</span></div>
                <div><b>T</b><span>test-play from the cursor</span></div>
                <div><b>Home / End</b> · <b>PgUp / PgDn</b><span>start / end · one bar</span></div>
                <div><b>Ctrl+S</b><span>save (and update the song list)</span></div>
            </div>
            <button class="btn small modal-close">Close</button>`);
    }

    // =====================================================================
    // Keyboard
    // =====================================================================
    onKey(e) {
        if (!this.active) return;
        if (document.querySelector('.ed-modal, .modal-backdrop')) {
            if (e.key === 'Escape') { const m = document.querySelector('.ed-modal'); if (m) m.remove(); }
            return;
        }
        const tg = e.target;
        if (tg && tg.matches && tg.matches('input:not([type="range"]):not([type="checkbox"]), select, textarea')) {
            if (e.key === 'Escape') tg.blur();
            return;
        }
        const k = e.key, low = k.length === 1 ? k.toLowerCase() : k, ctrl = e.ctrlKey || e.metaKey;
        let handled = true;
        if (ctrl) {
            if (low === 'z') { if (e.shiftKey) this.redo(); else this.undo(); }
            else if (low === 'y') this.redo();
            else if (low === 'c') this.copy();
            else if (low === 'x') this.copy(true);
            else if (low === 'v') this.paste();
            else if (low === 'a') this.selectAll();
            else if (low === 's') { this.saveNow(true).then(() => toast('Saved — it\'s in your song list')); }
            else handled = false;
        } else if (NUMPAD_DIRS[e.code] != null) this.setDir(NUMPAD_DIRS[e.code]);
        else switch (low) {
            case ' ': this.togglePlay(); break;
            case 'ArrowUp': if (e.altKey && this.sel.size) this.moveSelection(1 / this.snap, 0); else this.stepCursor(e.shiftKey ? 4 : 1); break;
            case 'ArrowDown': if (e.altKey && this.sel.size) this.moveSelection(-1 / this.snap, 0); else this.stepCursor(e.shiftKey ? -4 : -1); break;
            case 'ArrowLeft': if (this.sel.size) this.moveSelection(0, -1); break;
            case 'ArrowRight': if (this.sel.size) this.moveSelection(0, 1); break;
            case 'PageUp': this.setCursor(this.cursorBeat + 4); break;
            case 'PageDown': this.setCursor(this.cursorBeat - 4); break;
            case 'Home': this.setCursor(0); break;
            case 'End': this.setCursor(this.endBeat); break;
            case 'Delete': case 'Backspace': this.deleteSelection(); break;
            case 'Escape': this.select([]); break;
            case '1': this.setTool('red'); break;
            case '2': this.setTool('blue'); break;
            case '3': this.setTool('bomb'); break;
            case 'v': this.setTool('select'); break;
            case 'm': this.mirror(); break;
            case 'n': this.flipColors(); break;
            case 'b': this.addBookmark(); break;
            case 't': this.testPlay(true); break;
            case '[': this.changeSnap(-1); break;
            case ']': this.changeSnap(1); break;
            case '-': this.setZoom(this.zoom / 1.2); break;
            case '=': case '+': this.setZoom(this.zoom * 1.2); break;
            case '?': this.showHelp(); break;
            default:
                if (KEY_DIRS[low] != null) this.setDir(KEY_DIRS[low]);
                else handled = false;
        }
        if (handled) { e.preventDefault(); e.stopPropagation(); }
    }

    changeSnap(d) {
        const i = Math.max(0, Math.min(SNAPS.length - 1, SNAPS.indexOf(this.snap) + d));
        this.snap = SNAPS[i];
        const s = $('ed-snap');
        if (s) s.value = String(this.snap);
        this.status(`Snap 1/${this.snap} beat`);
        this.timeline.invalidate();
    }
}

