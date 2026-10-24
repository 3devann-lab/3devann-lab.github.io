// ============ Map editor: the whole song at a glance ============
// A strip under the 3D view: waveform, where the notes are (red above, blue
// below), walls, bookmarks and BPM changes. Click or drag to go anywhere.

export class Overview {
    constructor(canvas, ed) {
        this.canvas = canvas;
        this.ctx = canvas.getContext('2d');
        this.ed = ed;
        this.bg = document.createElement('canvas');
        this.dirty = true;
        this._last = null;
        this.layout();
        this.bind();
    }

    invalidate() { this.dirty = true; }

    layout() {
        const r = this.canvas.getBoundingClientRect();
        const dpr = Math.min(2, window.devicePixelRatio || 1);
        this.W = Math.max(100, r.width);
        this.H = Math.max(30, r.height);
        this.canvas.width = this.bg.width = Math.round(this.W * dpr);
        this.canvas.height = this.bg.height = Math.round(this.H * dpr);
        this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        this.bg.getContext('2d').setTransform(dpr, 0, 0, dpr, 0, 0);
        this.dirty = true;
    }

    get end() { return Math.max(4, this.ed.endBeat < 1e8 ? this.ed.endBeat : 64); }
    beatAt(x) { return Math.max(0, Math.min(this.end, (x / this.W) * this.end)); }
    xOf(b) { return (b / this.end) * this.W; }

    bind() {
        const cv = this.canvas;
        let down = false;
        const go = (e, final) => {
            const r = cv.getBoundingClientRect();
            const b = this.beatAt(e.clientX - r.left);
            const ed = this.ed;
            if (ed.view) ed.view.instant = !final;
            ed.setCursor(final ? ed.snapBeat(b) : b);
        };
        cv.addEventListener('pointerdown', (e) => {
            if (e.button !== 0) return;
            down = true;
            try { cv.setPointerCapture(e.pointerId); } catch (err) { /* synthetic */ }
            this.ed.focusView();
            go(e, false);
        });
        cv.addEventListener('pointermove', (e) => { if (down) go(e, false); });
        const up = (e) => { if (!down) return; down = false; go(e, true); if (this.ed.view) this.ed.view.instant = false; };
        cv.addEventListener('pointerup', up);
        cv.addEventListener('pointercancel', () => { down = false; if (this.ed.view) this.ed.view.instant = false; });
        cv.addEventListener('wheel', (e) => { e.preventDefault(); this.ed.stepCursor(-Math.sign(e.deltaY || e.deltaX) * 4); }, { passive: false });
    }

    drawStatic() {
        const g = this.bg.getContext('2d'), W = this.W, H = this.H, ed = this.ed, D = ed.data;
        g.clearRect(0, 0, W, H);
        g.fillStyle = '#0b0b16';
        g.fillRect(0, 0, W, H);
        const mid = H / 2;
        // waveform
        const w = ed.wave;
        if (w) {
            const clock = ed.clock;
            g.fillStyle = 'rgba(124,92,255,0.45)';
            for (let x = 0; x < W; x++) {
                const t0 = clock.toSeconds(this.beatAt(x)), t1 = clock.toSeconds(this.beatAt(x + 1));
                const i0 = Math.max(0, Math.floor(t0 * w.rate)), i1 = Math.min(w.peaks.length - 1, Math.ceil(t1 * w.rate));
                let m = 0;
                for (let i = i0; i <= i1; i += 2) if (w.peaks[i] > m) m = w.peaks[i];
                const h = m * (H * 0.36);
                g.fillRect(x, mid - h, 1, h * 2);
            }
        }
        // measures
        g.fillStyle = 'rgba(255,255,255,0.05)';
        const every = Math.max(4, Math.ceil(this.end / (W / 6) / 4) * 4);
        for (let b = 0; b <= this.end; b += every) g.fillRect(Math.round(this.xOf(b)), 0, 1, H);
        // walls along the bottom edge
        g.fillStyle = 'rgba(255,45,85,0.55)';
        for (const o of D.walls) g.fillRect(this.xOf(o.b), H - 4, Math.max(1, this.xOf(o.d)), 3);
        // notes: red ticks above the middle, blue below
        const tick = (o, y0, h, color) => { g.fillStyle = color; g.fillRect(Math.round(this.xOf(o.b)), y0, 1, h); };
        for (const o of D.notes) tick(o, o.c ? mid + 2 : mid - 2 - H * 0.3, H * 0.3, o.c ? 'rgba(80,140,255,0.8)' : 'rgba(255,70,100,0.8)');
        for (const o of D.bombs) tick(o, mid - 3, 6, 'rgba(200,200,220,0.7)');
        // light events along the top edge
        g.fillStyle = 'rgba(150,160,255,0.5)';
        for (const o of D.events) g.fillRect(Math.round(this.xOf(o.b)), 1, 1, 3);
        // BPM changes + bookmarks
        g.font = '600 10px Rajdhani, sans-serif';
        g.textAlign = 'left';
        for (const e of D.bpm) {
            const x = Math.round(this.xOf(e.b));
            g.fillStyle = '#ffb02d'; g.fillRect(x, 0, 2, H);
            g.fillText(`♩${e.m}`, x + 3, H - 6);
        }
        for (const bm of D.bookmarks) {
            const x = Math.round(this.xOf(bm.b));
            g.fillStyle = '#3dffa0'; g.fillRect(x, 0, 2, H);
            g.fillText((bm.name || '').slice(0, 16), x + 3, 11);
        }
    }

    render() {
        const ed = this.ed;
        const key = `${ed.cursorBeat.toFixed(3)}|${ed.spacing}|${this.W}`;
        if (!this.dirty && key === this._last) return;
        if (this.dirty) { this.drawStatic(); this.dirty = false; }
        this._last = key;
        const g = this.ctx, W = this.W, H = this.H;
        g.clearRect(0, 0, W, H);
        g.drawImage(this.bg, 0, 0, W, H);
        // what the 3D view shows
        const x = this.xOf(ed.cursorBeat), span = this.xOf(78 / ed.spacing);
        g.fillStyle = 'rgba(185,166,255,0.13)';
        g.fillRect(x, 0, span, H);
        g.fillStyle = '#ffffff';
        g.fillRect(Math.round(x) - 1, 0, 2, H);
    }
}
