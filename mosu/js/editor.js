// ============ MOSU level editor: record, place, auto-chart, export ============
import { audio } from './audio.js';
import { input } from './input.js';
import { customLevels, settings } from './storage.js';
import { LEVELS, STYLE_LABEL, levelSong, exportLevelJson, OPPOSITE } from './levels.js';
import { renderSong } from './music.js';
import { analyzeAudio, autoChart } from './onset.js';
import { DIR_COLORS } from './game.js';

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const hex = (n) => '#' + n.toString(16).padStart(6, '0');
const KEYDIR = { KeyW: 'up', ArrowUp: 'up', KeyS: 'down', ArrowDown: 'down', KeyA: 'left', ArrowLeft: 'left', KeyD: 'right', ArrowRight: 'right' };

// 16-bit mono WAV (keeps exported levels reasonably small)
function encodeWav(buffer, rate = 22050) {
    const ratio = buffer.sampleRate / rate;
    const len = Math.floor(buffer.length / ratio);
    const chans = [];
    for (let c = 0; c < buffer.numberOfChannels; c++) chans.push(buffer.getChannelData(c));
    const out = new DataView(new ArrayBuffer(44 + len * 2));
    const str = (o, s) => { for (let i = 0; i < s.length; i++) out.setUint8(o + i, s.charCodeAt(i)); };
    str(0, 'RIFF'); out.setUint32(4, 36 + len * 2, true); str(8, 'WAVE');
    str(12, 'fmt '); out.setUint32(16, 16, true); out.setUint16(20, 1, true); out.setUint16(22, 1, true);
    out.setUint32(24, rate, true); out.setUint32(28, rate * 2, true); out.setUint16(32, 2, true); out.setUint16(34, 16, true);
    str(36, 'data'); out.setUint32(40, len * 2, true);
    for (let i = 0; i < len; i++) {
        const j = Math.floor(i * ratio);
        let s = 0;
        for (const d of chans) s += d[j];
        s = Math.max(-1, Math.min(1, s / chans.length));
        out.setInt16(44 + i * 2, s < 0 ? s * 0x8000 : s * 0x7fff, true);
    }
    return out.buffer;
}

export class Editor {
    constructor(ui) {
        this.ui = ui;
        this.rec = null;
        this.buffer = null;
        this.peaks = null;
        this.sel = -1;
        this.brush = 'up';
        this.snap = 4;              // divisions per beat (0 = off)
        this.zoom = 120;            // px per second
        this.scroll = 0;            // seconds at left edge
        this.playing = false;
        this.recording = false;
        this.hitsounds = true;
        this.heldRec = {};          // dir -> note being recorded (for holds)
        this.dirty = false;
        this._onKey = (e) => this.key(e, true);
        this._onKeyUp = (e) => this.key(e, false);
    }

    blank() {
        return {
            id: 'custom-' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
            meta: { title: 'My Level', artist: '', bpm: 120, approach: 1.4, offset: 0 },
            notes: [], audio: null, audioName: null,
        };
    }

    async open(rec = null, dirty = false) {
        this.rec = rec ? JSON.parse(JSON.stringify({ ...rec, audio: null })) : this.blank();
        if (rec) { this.rec.audio = rec.audio; }
        this.buffer = null; this.peaks = null; this.sel = -1; this.scroll = 0; this.dirty = dirty;
        this.cursor = 0; this.analysis = null;
        this.knownTempo = !!(rec && rec.knownTempo);
        this.render();
        if (this.rec.audio) {
            try {
                this.status('Loading song…');
                this.buffer = await audio.decode(this.rec.audio);
                this.computePeaks();
                this.status('');
            } catch (e) { this.status('Could not decode the song: ' + e.message); }
        }
        this.draw();
    }

    render() {
        // never stack listeners / loops if the editor is re-opened
        window.removeEventListener('keydown', this._onKey);
        window.removeEventListener('keyup', this._onKeyUp);
        if (this._resize) window.removeEventListener('resize', this._resize);
        cancelAnimationFrame(this.raf);
        const m = this.rec.meta;
        this.ui.screen(`
            <div class="panel editor">
                <div class="panel-head">
                    <div class="panel-title">Level Editor</div>
                    <button class="btn small" id="e-import">Import .zip</button>
                    <button class="btn small" id="e-export">Export .zip</button>
                    <button class="btn small primary" id="e-save">Save</button>
                    <button class="btn small" id="e-back">← Back</button>
                </div>
                <div class="panel-body">
                    <div class="ed-grid">
                        <label>TITLE<input type="text" id="e-title" value="${esc(m.title)}"></label>
                        <label>ARTIST<input type="text" id="e-artist" value="${esc(m.artist)}"></label>
                        <label>BPM<span style="display:flex;gap:6px"><input type="number" id="e-bpm" step="0.1" min="30" max="300" value="${m.bpm}" style="flex:1"><button class="btn small" id="e-tap">Tap</button></span></label>
                        <label>BEAT OFFSET (ms)<input type="number" id="e-offset" step="1" value="${Math.round((m.offset || 0) * 1000)}"></label>
                        <label>NOTE SPEED (ms visible)<input type="number" id="e-approach" step="50" min="500" max="3000" value="${Math.round((m.approach || 1.4) * 1000)}"></label>
                        <label>SONG<span style="display:flex;gap:6px"><button class="btn small" id="e-upload">Upload…</button>
                            <select id="e-builtin" style="flex:1"><option value="">MOSU track…</option>${LEVELS.map(l => `<option value="${l.id}">${esc(l.title)} (${STYLE_LABEL[l.style]})</option>`).join('')}</select></span></label>
                    </div>
                    <div class="ed-bar">
                        <button class="btn small" id="e-play">▶ Play</button>
                        <button class="btn small" id="e-rec">● Record</button>
                        <button class="btn small" id="e-stop">■ Stop</button>
                        <span class="seg" id="e-brush">${['up', 'right', 'down', 'left', 'any'].map(d => `<button data-b="${d}" style="color:${hex(DIR_COLORS[d])}">${{ up: '↑', right: '→', down: '↓', left: '←', any: '★' }[d]}</button>`).join('')}</span>
                        <span class="seg" id="e-snap">${[[0, 'free'], [1, '1/1'], [2, '1/2'], [4, '1/4'], [8, '1/8']].map(([v, l]) => `<button data-s="${v}">${l}</button>`).join('')}</span>
                        <label style="display:flex;align-items:center;gap:6px;font-size:13px;color:var(--dim)"><input type="checkbox" id="e-hits" checked> ticks</label>
                    </div>
                    <div class="timeline" id="e-tl"><canvas id="e-canvas"></canvas></div>
                    <div class="ed-bar">
                        <span style="font-size:13px;color:var(--dim)">Auto-chart density</span>
                        <input type="range" id="e-density" min="1" max="10" step="1" value="5"><span class="val" id="e-dval">5</span>
                        <button class="btn small" id="e-auto">✨ Auto-chart</button>
                        <button class="btn small" id="e-clear">Clear notes</button>
                        <button class="btn small primary" id="e-test">Test Play</button>
                        <span class="ed-status" id="e-status"></span>
                    </div>
                    <div class="ed-help">
                        <b>Record:</b> press ● Record, then hit <span class="key">W</span><span class="key">A</span><span class="key">S</span><span class="key">D</span>/arrows along with the music — hold a key for a hold note.
                        <b>Edit:</b> click the timeline to place the selected arrow, click a note to select it, then
                        <span class="key">W</span><span class="key">A</span><span class="key">S</span><span class="key">D</span> changes direction, <span class="key">F</span> flip, <span class="key">H</span> hold, <span class="key">Del</span> remove.
                        <span class="key">Space</span> play/pause · mouse wheel scrolls · <span class="key">Ctrl</span>+wheel zooms.
                        <span id="e-count"></span>
                    </div>
                </div>
            </div>`);

        const bind = (id, key, conv) => {
            $(id).onchange = () => { this.rec.meta[key] = conv($(id).value); this.dirty = true; this.draw(); };
        };
        bind('e-title', 'title', v => v.trim() || 'My Level');
        bind('e-artist', 'artist', v => v.trim());
        bind('e-bpm', 'bpm', v => Math.max(30, Math.min(300, Number(v) || 120)));
        bind('e-offset', 'offset', v => (Number(v) || 0) / 1000);
        bind('e-approach', 'approach', v => Math.max(0.5, Math.min(3, (Number(v) || 1400) / 1000)));
        $('e-back').onclick = () => this.close();
        $('e-save').onclick = () => this.save();
        $('e-export').onclick = () => this.export();
        $('e-import').onclick = () => this.importZip();
        $('e-upload').onclick = () => this.upload();
        $('e-builtin').onchange = () => this.useBuiltin($('e-builtin').value);
        $('e-play').onclick = () => this.togglePlay(false);
        $('e-rec').onclick = () => this.togglePlay(true);
        $('e-stop').onclick = () => this.stop(true);
        $('e-auto').onclick = () => this.autoChart();
        $('e-clear').onclick = () => { if (this.rec.notes.length && confirm('Remove all notes?')) { this.rec.notes = []; this.sel = -1; this.dirty = true; this.draw(); } };
        $('e-test').onclick = () => this.test();
        $('e-tap').onclick = () => this.tapTempo();
        $('e-hits').onchange = () => { this.hitsounds = $('e-hits').checked; };
        $('e-density').oninput = () => { $('e-dval').textContent = $('e-density').value; };
        this.root = $('e-tl');
        this.canvas = $('e-canvas');
        document.querySelectorAll('#e-brush [data-b]').forEach(b => { b.onclick = () => { this.brush = b.dataset.b; this.syncBars(); }; });
        document.querySelectorAll('#e-snap [data-s]').forEach(b => { b.onclick = () => { this.snap = Number(b.dataset.s); this.syncBars(); }; });
        this.syncBars();

        this.canvas.addEventListener('pointerdown', (e) => this.pointer(e));
        this.canvas.addEventListener('wheel', (e) => {
            e.preventDefault();
            if (e.ctrlKey || e.metaKey) {
                const t = this.xToTime(e.offsetX);
                this.zoom = Math.max(20, Math.min(800, this.zoom * (e.deltaY < 0 ? 1.2 : 1 / 1.2)));
                this.scroll = Math.max(0, t - e.offsetX / this.zoom);
            } else {
                this.scroll = Math.max(0, this.scroll + (e.deltaY + e.deltaX) / this.zoom);
            }
            this.draw();
        }, { passive: false });
        window.addEventListener('keydown', this._onKey);
        window.addEventListener('keyup', this._onKeyUp);
        window.addEventListener('resize', this._resize = () => this.draw());
        this.loop();
    }

    syncBars() {
        document.querySelectorAll('#e-brush [data-b]').forEach(b => b.classList.toggle('active', b.dataset.b === this.brush));
        document.querySelectorAll('#e-snap [data-s]').forEach(b => b.classList.toggle('active', Number(b.dataset.s) === this.snap));
    }

    status(msg) { const el = $('e-status'); if (el) el.textContent = msg; }

    detach() {
        this.stop(false);
        window.removeEventListener('keydown', this._onKey);
        window.removeEventListener('keyup', this._onKeyUp);
        window.removeEventListener('resize', this._resize);
        cancelAnimationFrame(this.raf);
        input.enabled = false;
        input.onPress = input.onRelease = null;
    }

    close() {
        if (this.dirty && !confirm('Leave without saving?')) return;
        this.detach();
        this.ui.showTitle();
    }

    // ---------- song ----------
    upload() {
        const pick = document.createElement('input');
        pick.type = 'file';
        pick.accept = 'audio/*,.mp3,.ogg,.wav,.m4a';
        pick.onchange = async () => {
            const f = pick.files && pick.files[0];
            if (!f) return;
            try {
                this.status('Decoding…');
                const ab = await f.arrayBuffer();
                this.buffer = await audio.decode(ab);
                this.rec.audio = ab;
                this.rec.audioName = f.name.replace(/[^\w.\- ]+/g, '_');
                this.knownTempo = false;
                this.rec.knownTempo = false;
                if (this.rec.meta.title === 'My Level') {
                    this.rec.meta.title = f.name.replace(/\.[^.]+$/, '');
                    $('e-title').value = this.rec.meta.title;
                }
                this.computePeaks();
                this.dirty = true;
                this.status(`Loaded ${f.name} (${this.buffer.duration.toFixed(1)} s). Try ✨ Auto-chart or ● Record.`);
                this.draw();
            } catch (e) { this.status('That file could not be decoded: ' + e.message); }
        };
        pick.click();
    }

    async useBuiltin(id) {
        const lv = LEVELS.find(l => l.id === id);
        if (!lv) return;
        this.status(`Composing ${lv.title}…`);
        await new Promise(r => setTimeout(r, 30));
        const song = levelSong(lv);
        const buf = await renderSong(song, 22050);
        this.rec.audio = encodeWav(buf);
        this.rec.audioName = lv.id + '.wav';
        this.knownTempo = true;
        this.rec.knownTempo = true;
        this.buffer = await audio.decode(this.rec.audio);
        Object.assign(this.rec.meta, { bpm: lv.bpm, offset: 0, artist: 'MOSU · ' + STYLE_LABEL[lv.style] });
        if (this.rec.meta.title === 'My Level') this.rec.meta.title = lv.title + ' (remix)';
        $('e-bpm').value = lv.bpm; $('e-offset').value = 0; $('e-title').value = this.rec.meta.title; $('e-artist').value = this.rec.meta.artist;
        this.computePeaks();
        this.dirty = true;
        this.status(`${lv.title} ready — BPM and grid are set for you.`);
        this.draw();
    }

    computePeaks() {
        const b = this.buffer;
        const per = 256;
        const n = Math.ceil(b.length / per);
        const d = b.getChannelData(0);
        const peaks = new Float32Array(n);
        for (let i = 0; i < n; i++) {
            let m = 0;
            const end = Math.min(b.length, (i + 1) * per);
            for (let j = i * per; j < end; j += 4) { const v = Math.abs(d[j]); if (v > m) m = v; }
            peaks[i] = m;
        }
        this.peaks = { data: peaks, rate: b.sampleRate / per };
    }

    // ---------- timeline ----------
    xToTime(x) { return this.scroll + x / this.zoom; }
    timeToX(t) { return (t - this.scroll) * this.zoom; }

    snapTime(t) {
        if (!this.snap) return Math.max(0, t);
        const grid = 60 / this.rec.meta.bpm / this.snap;
        const off = this.rec.meta.offset || 0;
        return Math.max(0, Math.round((t - off) / grid) * grid + off);
    }

    pointer(e) {
        const x = e.offsetX, y = e.offsetY;
        const t = this.xToTime(x);
        // hit test notes (lane in the middle)
        const mid = this.canvas.clientHeight * 0.55;
        let hit = -1, best = 12;
        this.rec.notes.forEach((n, i) => {
            const d = Math.abs(this.timeToX(n.t) - x);
            if (d < best && Math.abs(y - mid) < 30) { best = d; hit = i; }
        });
        if (hit >= 0) { this.sel = hit; this.draw(); return; }
        if (y < 22) {           // ruler: seek
            this.seek(t);
            return;
        }
        const nt = this.snapTime(t);
        if (this.rec.notes.some(n => Math.abs(n.t - nt) < 0.02)) return;
        this.rec.notes.push({ t: +nt.toFixed(4), d: this.brush });
        this.sortNotes(nt);
        this.dirty = true;
        this.draw();
    }

    sortNotes(selectTime = null) {
        this.rec.notes.sort((a, b) => a.t - b.t);
        if (selectTime != null) this.sel = this.rec.notes.findIndex(n => Math.abs(n.t - selectTime) < 1e-6);
    }

    key(e, down) {
        if (e.target && e.target.matches && e.target.matches('input, textarea, select')) return;
        if (!$('e-canvas')) return;
        if (down && e.code === 'Space') { e.preventDefault(); this.togglePlay(this.recording); return; }
        if (this.recording) return;            // recording keys go through the input system
        if (!down) return;
        const n = this.rec.notes[this.sel];
        const dir = KEYDIR[e.code];
        if (dir) {
            e.preventDefault();
            if (n) { n.d = dir; delete n.d2; } else this.brush = dir;
            this.syncBars(); this.dirty = true; this.draw();
        } else if (n && (e.code === 'Delete' || e.code === 'Backspace')) {
            e.preventDefault();
            this.rec.notes.splice(this.sel, 1);
            this.sel = Math.min(this.sel, this.rec.notes.length - 1);
            this.dirty = true; this.draw();
        } else if (n && e.code === 'KeyF') {
            if (n.d !== 'any') n.flip = !n.flip;
            if (!n.flip) delete n.flip;
            this.dirty = true; this.draw();
        } else if (n && e.code === 'KeyH') {
            if (n.hold) delete n.hold; else n.hold = +(60 / this.rec.meta.bpm).toFixed(3);
            this.dirty = true; this.draw();
        } else if (e.code === 'BracketLeft' || e.code === 'BracketRight') {
            if (n && n.hold) { n.hold = Math.max(0.1, n.hold + (e.code === 'BracketRight' ? 1 : -1) * 60 / this.rec.meta.bpm / 2); this.draw(); }
        }
    }

    // ---------- transport ----------
    togglePlay(record) {
        if (!this.buffer) { this.status('Load a song first (Upload… or pick a MOSU track).'); return; }
        if (this.playing) { this.stop(false); return; }
        audio.init();
        const from = Math.max(0, this.cursor ?? this.scroll);
        // same calibration as gameplay, so recorded taps line up in test play
        audio.userOffset = (settings.get('offsetMs') || 0) / 1000;
        audio.start(this.buffer, from - (record ? 1.0 : 0), false);
        audio.onEnded = () => this.stop(false);
        this.playing = true;
        this.recording = record;
        this.lastTickT = from;
        $('e-play').textContent = '❚❚ Pause';
        $('e-rec').innerHTML = record ? '<span class="rec-dot"></span> Recording' : '● Record';
        if (record) {
            input.enabled = true;
            input.onPause = () => this.stop(false);
            input.onPress = (dir, ms) => {
                if (dir === 'tap') dir = this.brush;
                const t = this.snapTime(audio.timeAt(ms));
                if (this.rec.notes.some(n => Math.abs(n.t - t) < 0.03)) return;
                const note = { t: +t.toFixed(4), d: dir };
                this.rec.notes.push(note);
                this.heldRec[dir] = note;
                this.sortNotes();
                this.dirty = true;
                audio.hit('great');
            };
            input.onRelease = (dir, ms) => {
                const note = this.heldRec[dir];
                delete this.heldRec[dir];
                if (!note) return;
                const end = this.snapTime(audio.timeAt(ms));
                const len = end - note.t;
                if (len >= 60 / this.rec.meta.bpm * 0.75) note.hold = +len.toFixed(3);
            };
        }
    }

    stop(rewind) {
        if (this.playing) {
            this.cursor = rewind ? 0 : Math.max(0, audio.time);
            audio.onEnded = null;
            audio.stop();
        } else if (rewind) this.cursor = 0;
        this.playing = false;
        this.recording = false;
        this.heldRec = {};
        input.enabled = false;
        input.onPress = input.onRelease = input.onPause = null;
        if ($('e-play')) { $('e-play').textContent = '▶ Play'; $('e-rec').textContent = '● Record'; }
        if (rewind) this.scroll = 0;
        this.draw();
    }

    seek(t) {
        const wasPlaying = this.playing, rec = this.recording;
        if (wasPlaying) this.stop(false);
        this.cursor = Math.max(0, t);
        if (wasPlaying) this.togglePlay(rec);
        this.draw();
    }

    loop() {
        this.raf = requestAnimationFrame(() => this.loop());
        if (!this.playing) return;
        const t = audio.time;
        const w = this.canvas.clientWidth;
        // follow the playhead
        if (this.timeToX(t) > w * 0.75 || this.timeToX(t) < 0) this.scroll = Math.max(0, t - (w * 0.25) / this.zoom);
        if (this.hitsounds && !this.recording) {
            for (const n of this.rec.notes) if (n.t > this.lastTickT && n.t <= t) { audio.hit('perfect'); break; }
        }
        this.lastTickT = t;
        this.draw(t);
    }

    draw(playT = null) {
        const c = this.canvas;
        if (!c || !c.isConnected) return;
        const dpr = Math.min(2, window.devicePixelRatio || 1);
        const w = c.clientWidth, h = c.clientHeight;
        if (c.width !== Math.round(w * dpr)) { c.width = Math.round(w * dpr); c.height = Math.round(h * dpr); }
        const ctx = c.getContext('2d');
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        ctx.clearRect(0, 0, w, h);
        const t0 = this.scroll, t1 = this.xToTime(w);
        const mid = h * 0.55;

        // waveform
        if (this.peaks) {
            ctx.fillStyle = 'rgba(124,92,255,0.35)';
            const p = this.peaks;
            for (let x = 0; x < w; x++) {
                const i = Math.floor(this.xToTime(x) * p.rate);
                const v = p.data[i] || 0;
                ctx.fillRect(x, mid - v * h * 0.4, 1, v * h * 0.8);
            }
        }
        // beat grid + ruler
        const m = this.rec.meta;
        const spb = 60 / m.bpm;
        const off = m.offset || 0;
        let b = Math.floor((t0 - off) / spb);
        ctx.font = '11px Inter, sans-serif';
        for (let t = off + b * spb; t < t1; t += spb, b++) {
            const x = this.timeToX(t);
            ctx.fillStyle = b % 4 === 0 ? 'rgba(255,255,255,0.28)' : 'rgba(255,255,255,0.09)';
            ctx.fillRect(x, 20, 1, h - 20);
            if (b % 4 === 0 && b >= 0) { ctx.fillStyle = '#a3a1c4'; ctx.fillText(String(b / 4 + 1), x + 3, 13); }
        }
        ctx.fillStyle = 'rgba(255,255,255,0.06)';
        ctx.fillRect(0, 0, w, 20);

        // notes
        const glyph = { up: '↑', right: '→', down: '↓', left: '←', any: '★' };
        this.rec.notes.forEach((n, i) => {
            if (n.t + (n.hold || 0) < t0 || n.t > t1) return;
            const x = this.timeToX(n.t);
            const col = n.flip ? '#b96fff' : hex(DIR_COLORS[n.d] ?? 0xffffff);
            if (n.hold) {
                ctx.fillStyle = col + '55';
                ctx.fillRect(x, mid - 7, n.hold * this.zoom, 14);
            }
            ctx.fillStyle = col;
            ctx.beginPath();
            if (ctx.roundRect) ctx.roundRect(x - 11, mid - 13, 22, 26, 6); else ctx.rect(x - 11, mid - 13, 22, 26);
            ctx.fill();
            if (i === this.sel) { ctx.strokeStyle = '#fff'; ctx.lineWidth = 2; ctx.stroke(); }
            ctx.fillStyle = n.flip ? '#fff' : '#111';
            ctx.font = 'bold 15px Inter, sans-serif';
            ctx.textAlign = 'center';
            ctx.fillText(glyph[n.d] || '?', x, mid + 5);
            ctx.textAlign = 'left';
        });

        // playhead / cursor
        const ph = playT ?? this.cursor ?? 0;
        const px = this.timeToX(ph);
        ctx.fillStyle = this.recording ? '#ff2d55' : '#ffd76a';
        ctx.fillRect(px - 1, 0, 2, h);

        const cnt = $('e-count');
        if (cnt) cnt.textContent = ` · ${this.rec.notes.length} notes${this.buffer ? ` · ${this.buffer.duration.toFixed(0)} s song` : ''}`;
    }

    // ---------- tools ----------
    tapTempo() {
        const now = performance.now();
        this.taps = (this.taps || []).filter(t => now - t < 3000);
        this.taps.push(now);
        if (this.taps.length >= 4) {
            const d = (this.taps[this.taps.length - 1] - this.taps[0]) / (this.taps.length - 1);
            const bpm = Math.round(60000 / d * 10) / 10;
            this.rec.meta.bpm = bpm;
            $('e-bpm').value = bpm;
            this.draw();
            this.status(`Tapped ${bpm} BPM`);
        } else this.status(`Keep tapping… (${this.taps.length})`);
    }

    async autoChart() {
        if (!this.buffer) { this.status('Load a song first.'); return; }
        if (this.rec.notes.length && !confirm('Replace the current notes with an auto-generated chart?')) return;
        this.status('Listening to the song…');
        try {
            if (!this.analysis || this.analysis.buf !== this.buffer) {
                this.analysis = await analyzeAudio(this.buffer, (p) => this.status(`Listening to the song… ${Math.round(p * 100)}%`));
                this.analysis.buf = this.buffer;
                if (!this.knownTempo) {
                    // adopt the detected tempo for uploaded songs (MOSU tracks know theirs)
                    this.rec.meta.bpm = this.analysis.bpm;
                    this.rec.meta.offset = +this.analysis.phase.toFixed(3);
                    $('e-bpm').value = this.rec.meta.bpm;
                    $('e-offset').value = Math.round(this.rec.meta.offset * 1000);
                }
            }
            const density = Number($('e-density').value);
            this.rec.notes = autoChart(this.analysis, density, { bpm: this.rec.meta.bpm, phase: this.rec.meta.offset });
            this.sel = -1; this.dirty = true;
            this.status(`Auto-charted ${this.rec.notes.length} notes at ${this.rec.meta.bpm} BPM. Tweak anything you like.`);
            this.draw();
        } catch (e) {
            console.error(e);
            this.status('Auto-chart failed: ' + e.message);
        }
    }

    async save() {
        if (!this.rec.audio) { this.status('Add a song before saving.'); return; }
        if (!this.rec.notes.length) { this.status('Add some notes first.'); return; }
        await customLevels.put(this.rec);
        this.dirty = false;
        this.status('Saved to My Levels.');
    }

    async export() {
        if (!this.rec.audio) { this.status('Add a song before exporting.'); return; }
        await this.ui.exportZip(this.rec);
    }

    async importZip() {
        const { readLevelZip } = await import('./ui.js');
        const pick = document.createElement('input');
        pick.type = 'file'; pick.accept = '.zip';
        pick.onchange = async () => {
            const f = pick.files && pick.files[0];
            if (!f) return;
            try {
                const rec = await readLevelZip(f);
                this.detach();
                await this.open(rec);
                this.dirty = true;
                this.status(`Imported ${f.name}. Save to keep it.`);
            } catch (e) { this.status('Import failed: ' + e.message); }
        };
        pick.click();
    }

    async test() {
        if (!this.rec.audio || !this.rec.notes.length) { this.status('Need a song and some notes to test.'); return; }
        const rec = { ...this.rec, notes: this.rec.notes.map(n => ({ ...n })) };
        this.detach();
        await this.ui.playCustom(rec, true);
    }
}

export { OPPOSITE };
