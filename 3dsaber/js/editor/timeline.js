// ============ Map editor: the timeline (time flows up, "now" line near the bottom) ============
// Columns: ruler · waveform · notes (bottom / middle / top rows × 4 lanes) · walls (4 lanes) · light events.
import { EVENT_LANES, lightParts } from './model.js';

const NOTE_COLORS = ['#e0284a', '#2a6fe0'];
const LIGHT_RGB = { blue: '#3d8bff', red: '#ff3d5e', white: '#f2f4ff' };
const ROW_NAMES = ['BOTTOM', 'MIDDLE', 'TOP'];
// arrow angle per cut direction, radians, 0 = pointing down the screen (down cut)
const DIR_ANGLE = [Math.PI, 0, Math.PI / 2, -Math.PI / 2, Math.PI * 0.75, -Math.PI * 0.75, Math.PI / 4, -Math.PI / 4, 0];

export class Timeline {
    /**
     * @param canvas HTMLCanvasElement
     * @param ed Editor (state + edit operations)
     */
    constructor(canvas, ed) {
        this.canvas = canvas;
        this.ctx = canvas.getContext('2d');
        this.ed = ed;
        this.dirty = true;
        this.hover = null;          // {x, y} in CSS px
        this.drag = null;
        this.layout();
        this.bind();
    }

    invalidate() { this.dirty = true; }

    // ---------- geometry ----------
    layout() {
        const r = this.canvas.getBoundingClientRect();
        const dpr = Math.min(2, window.devicePixelRatio || 1);
        this.W = Math.max(200, r.width);
        this.H = Math.max(200, r.height);
        this.canvas.width = Math.round(this.W * dpr);
        this.canvas.height = Math.round(this.H * dpr);
        this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        // fit the columns to the width (lanes shrink on small screens)
        const fixed = 56 + 54 + 8 + 12 + 10 + 10 + 8;
        const units = 12 * 1.15 + 4 + 9;               // note lanes a bit wider than the rest
        const u = Math.max(16, Math.min(34, (this.W - fixed) / units));
        const L = Math.round(u * 1.15);
        let x = 0;
        const col = (w) => { const c = { x, w }; x += w; return c; };
        this.cols = {};
        this.cols.ruler = col(56);
        this.cols.wave = col(54);
        x += 8;
        this.cols.notes = { x, w: L * 12 + 12, lane: L, gap: 6 };
        x += this.cols.notes.w + 10;
        this.cols.walls = { x, w: Math.round(u) * 4, lane: Math.round(u) };
        x += this.cols.walls.w + 10;
        this.cols.events = { x, w: Math.round(u) * EVENT_LANES.length, lane: Math.round(u) };
        x += this.cols.events.w;
        this.contentW = x;
        this.headerH = 26;
        this.nowY = Math.round(this.H - Math.min(140, this.H * 0.22));
        this.dirty = true;
    }

    get zoom() { return this.ed.zoom; }
    beatToY(b) { return this.nowY - (b - this.ed.cursorBeat) * this.zoom; }
    yToBeat(y) { return this.ed.cursorBeat + (this.nowY - y) / this.zoom; }
    snap(b) { const s = this.ed.snap; return Math.round(b * s) / s; }

    // x of a note cell centre: row (layer) block, then lane
    noteX(lane, layer) {
        const c = this.cols.notes;
        const l = Math.max(0, Math.min(3, lane)), y = Math.max(0, Math.min(2, layer));
        return c.x + y * (c.lane * 4 + c.gap) + l * c.lane + c.lane / 2;
    }
    wallX(lane) { return this.cols.walls.x + lane * this.cols.walls.lane; }
    eventX(et) {
        const i = EVENT_LANES.findIndex(e => e.et === et);
        return i < 0 ? -100 : this.cols.events.x + i * this.cols.events.lane + this.cols.events.lane / 2;
    }

    // which area / cell a screen point is over
    hitArea(x, y) {
        const c = this.cols;
        const beat = this.yToBeat(y);
        if (x < c.wave.x + c.wave.w) return { area: 'ruler', beat };
        const n = c.notes;
        if (x >= n.x && x < n.x + n.w) {
            const blockW = n.lane * 4 + n.gap;
            const layer = Math.min(2, Math.floor((x - n.x) / blockW));
            const lane = Math.floor((x - n.x - layer * blockW) / n.lane);
            if (lane > 3) return { area: 'gap', beat };
            return { area: 'notes', lane, layer, beat };
        }
        if (x >= c.walls.x && x < c.walls.x + c.walls.w) return { area: 'walls', lane: Math.floor((x - c.walls.x) / c.walls.lane), beat };
        if (x >= c.events.x && x < c.events.x + c.events.w) {
            const i = Math.floor((x - c.events.x) / c.events.lane);
            return { area: 'events', et: EVENT_LANES[i].et, beat };
        }
        return { area: 'none', beat };
    }

    // the object drawn under a point (top-most first)
    objectAt(x, y) {
        const D = this.ed.data, n = this.cols.notes;
        const half = Math.min(n.lane - 4, 26) / 2 + 1;
        const near = (o, ox) => Math.abs(this.beatToY(o.b) - y) <= half && Math.abs(ox - x) <= half;
        for (const o of D.notes) if (near(o, this.noteX(o.x, o.y))) return o;
        for (const o of D.bombs) if (near(o, this.noteX(o.x, o.y))) return o;
        for (const o of D.chains) if (near(o, this.noteX(o.x, o.y))) return o;
        for (const o of D.arcs) if (near(o, this.noteX(o.x, o.y))) return o;
        const ev = this.cols.events;
        for (const o of D.events) {
            if (Math.abs(this.beatToY(o.b) - y) <= 6 && Math.abs(this.eventX(o.et) - x) <= ev.lane / 2) return o;
        }
        const wl = this.cols.walls;
        for (const o of D.walls) {
            const x0 = this.wallX(Math.max(0, o.x)), x1 = this.wallX(Math.min(4, o.x + o.w));
            const y0 = this.beatToY(o.b + o.d), y1 = this.beatToY(o.b);
            if (x >= x0 && x <= x1 && y >= y0 - 3 && y <= y1 + 3 && x <= wl.x + wl.w) return o;
        }
        return null;
    }

    // screen rect of an object (for box selection)
    objectPoint(o) {
        if ('et' in o) return [this.eventX(o.et), this.beatToY(o.b)];
        if ('w' in o && 'h' in o && 'd' in o && !('c' in o)) return [this.wallX(o.x + o.w / 2), this.beatToY(o.b)];
        return [this.noteX(o.x, o.y), this.beatToY(o.b)];
    }

    // ---------- input ----------
    bind() {
        const cv = this.canvas;
        const pos = (e) => { const r = cv.getBoundingClientRect(); return { x: e.clientX - r.left, y: e.clientY - r.top }; };
        cv.addEventListener('contextmenu', (e) => e.preventDefault());
        cv.addEventListener('pointerdown', (e) => {
            const p = pos(e);
            cv.setPointerCapture(e.pointerId);
            this.ed.focusTimeline();
            const hit = this.hitArea(p.x, p.y);
            const obj = p.y > this.headerH ? this.objectAt(p.x, p.y) : null;
            if (e.button === 2) {                       // right: delete (drag to delete more)
                this.drag = { kind: 'erase', erased: new Set() };
                if (obj) { this.drag.erased.add(obj); this.ed.erase([obj], true); }
                return;
            }
            if (e.button !== 0) return;
            if (hit.area === 'ruler') { this.drag = { kind: 'scrub' }; this.ed.setCursor(this.snap(hit.beat)); return; }
            if (obj) {
                if (e.ctrlKey || e.metaKey) { this.ed.toggleSelect(obj); return; }
                if (!this.ed.sel.has(obj)) this.ed.select([obj], e.shiftKey);
                this.drag = { kind: 'move', start: p, beat0: hit.beat, lane0: hit.lane ?? 0, dBeat: 0, dLane: 0 };
                return;
            }
            if (this.ed.tool === 'select' || e.shiftKey) {
                this.drag = { kind: 'box', start: p, now: p, add: e.shiftKey || e.ctrlKey };
                return;
            }
            const beat = this.snap(hit.beat);
            if (hit.area === 'notes') this.drag = { kind: 'note', start: p, now: p, lane: hit.lane, layer: hit.layer, beat };
            else if (hit.area === 'walls') this.drag = { kind: 'wall', lane0: hit.lane, lane1: hit.lane, beat0: beat, beat1: beat };
            else if (hit.area === 'events') { this.ed.placeEvent(hit.et, beat); this.drag = null; }
            else this.drag = { kind: 'box', start: p, now: p, add: false };
            this.invalidate();
        });
        cv.addEventListener('pointermove', (e) => {
            const p = pos(e);
            this.hover = p;
            const d = this.drag;
            if (d) {
                if (d.kind === 'erase') {
                    const obj = this.objectAt(p.x, p.y);
                    if (obj && !d.erased.has(obj)) { d.erased.add(obj); this.ed.erase([obj], false); }
                } else if (d.kind === 'scrub') this.ed.setCursor(this.snap(this.yToBeat(p.y)));
                else if (d.kind === 'box' || d.kind === 'note') d.now = p;
                else if (d.kind === 'wall') {
                    const h = this.hitArea(p.x, p.y);
                    d.lane1 = Math.max(0, Math.min(3, h.area === 'walls' ? h.lane : d.lane1));
                    d.beat1 = this.snap(h.beat);
                } else if (d.kind === 'move') {
                    const h = this.hitArea(p.x, p.y);
                    d.dBeat = this.snap(h.beat - d.beat0);
                    d.dLane = h.lane != null ? h.lane - d.lane0 : d.dLane;
                }
            }
            this.invalidate();
        });
        const end = (e) => {
            const d = this.drag;
            this.drag = null;
            if (!d) return;
            if (d.kind === 'erase') { if (d.erased.size) this.ed.commitErase(); }
            else if (d.kind === 'note') {
                const dx = d.now.x - d.start.x, dy = d.now.y - d.start.y;
                const dir = Math.hypot(dx, dy) > 12 ? dirFromDrag(dx, dy) : null;
                this.ed.placeNote(d.lane, d.layer, d.beat, dir);
            } else if (d.kind === 'wall') {
                const b0 = Math.min(d.beat0, d.beat1), b1 = Math.max(d.beat0, d.beat1);
                this.ed.placeWall(Math.min(d.lane0, d.lane1), Math.abs(d.lane1 - d.lane0) + 1, b0, Math.max(1 / this.ed.snap, b1 - b0));
            } else if (d.kind === 'box') {
                const x0 = Math.min(d.start.x, d.now.x), x1 = Math.max(d.start.x, d.now.x);
                const y0 = Math.min(d.start.y, d.now.y), y1 = Math.max(d.start.y, d.now.y);
                if (x1 - x0 < 4 && y1 - y0 < 4) { if (!d.add) this.ed.select([]); }
                else {
                    const D = this.ed.data, hits = [];
                    for (const list of [D.notes, D.bombs, D.walls, D.events, D.arcs, D.chains]) {
                        for (const o of list) {
                            const [ox, oy] = this.objectPoint(o);
                            if (ox >= x0 && ox <= x1 && oy >= y0 && oy <= y1) hits.push(o);
                        }
                    }
                    this.ed.select(hits, d.add);
                }
            } else if (d.kind === 'move' && (d.dBeat || d.dLane)) {
                this.ed.moveSelection(d.dBeat, d.dLane);
            }
            this.invalidate();
        };
        cv.addEventListener('pointerup', end);
        cv.addEventListener('pointercancel', () => { this.drag = null; this.invalidate(); });
        cv.addEventListener('pointerleave', () => { this.hover = null; this.invalidate(); });
        cv.addEventListener('wheel', (e) => {
            e.preventDefault();
            const steps = Math.sign(e.deltaY) * Math.max(1, Math.min(4, Math.round(Math.abs(e.deltaY) / 100)));
            if (e.ctrlKey || e.metaKey) this.ed.setZoom(this.ed.zoom * Math.pow(1.15, -steps));
            else if (e.altKey && this.ed.sel.size) this.ed.moveSelection(-steps / this.ed.snap, 0);
            else this.ed.stepCursor(-steps * (e.shiftKey ? 4 : 1));
        }, { passive: false });
    }

    // ---------- drawing ----------
    render() {
        if (!this.dirty) return;
        this.dirty = false;
        const g = this.ctx, W = this.W, H = this.H, C = this.cols, ed = this.ed;
        g.clearRect(0, 0, W, H);
        g.fillStyle = '#0b0b16';
        g.fillRect(0, 0, W, H);

        const bTop = this.yToBeat(0), bBot = this.yToBeat(H);
        const n = C.notes;

        // column backgrounds
        for (let r = 0; r < 3; r++) {
            const x = n.x + r * (n.lane * 4 + n.gap);
            g.fillStyle = r === 1 ? '#13132a' : '#101022';
            g.fillRect(x, 0, n.lane * 4, H);
            g.strokeStyle = 'rgba(255,255,255,0.05)';
            for (let l = 1; l < 4; l++) { g.beginPath(); g.moveTo(x + l * n.lane + 0.5, 0); g.lineTo(x + l * n.lane + 0.5, H); g.stroke(); }
        }
        g.fillStyle = '#120f1c'; g.fillRect(C.walls.x, 0, C.walls.w, H);
        for (let l = 1; l < 4; l++) { g.strokeStyle = 'rgba(255,255,255,0.05)'; g.beginPath(); g.moveTo(C.walls.x + l * C.walls.lane + 0.5, 0); g.lineTo(C.walls.x + l * C.walls.lane + 0.5, H); g.stroke(); }
        g.fillStyle = '#0f1420'; g.fillRect(C.events.x, 0, C.events.w, H);
        for (let i = 1; i < EVENT_LANES.length; i++) {
            g.strokeStyle = i === 5 || i === 7 ? 'rgba(255,255,255,0.12)' : 'rgba(255,255,255,0.05)';
            g.beginPath(); g.moveTo(C.events.x + i * C.events.lane + 0.5, 0); g.lineTo(C.events.x + i * C.events.lane + 0.5, H); g.stroke();
        }

        // waveform
        this.drawWave(g, bTop, bBot);

        // beat grid: snap lines, beats, measures
        const snap = ed.snap;
        const sub = 1 / snap;
        const first = Math.floor(bBot / sub) * sub;
        const showSub = this.zoom / snap >= 6;
        for (let b = first; b <= bTop + sub; b += sub) {
            const y = Math.round(this.beatToY(b)) + 0.5;
            const isBeat = Math.abs(b - Math.round(b)) < 1e-6;
            if (!isBeat && !showSub) continue;
            const measure = isBeat && Math.round(b) % 4 === 0;
            g.strokeStyle = measure ? 'rgba(255,255,255,0.32)' : isBeat ? 'rgba(255,255,255,0.14)' : 'rgba(124,92,255,0.12)';
            g.beginPath(); g.moveTo(C.wave.x, y); g.lineTo(this.contentW, y); g.stroke();
            if (isBeat && b >= 0) {
                g.fillStyle = measure ? '#cfd6ff' : '#7c82a8';
                g.font = (measure ? '700 12px' : '11px') + ' Rajdhani, sans-serif';
                g.textAlign = 'right';
                g.fillText(String(Math.round(b)), C.ruler.w - 8, y - 3);
            }
        }

        // BPM changes + bookmarks (full-width markers)
        for (const e of ed.data.bpm) {
            const y = this.beatToY(e.b);
            if (y < -10 || y > H + 10) continue;
            g.strokeStyle = '#ffb02d'; g.lineWidth = 2;
            g.beginPath(); g.moveTo(0, y); g.lineTo(this.contentW, y); g.stroke(); g.lineWidth = 1;
            g.fillStyle = '#ffb02d'; g.font = '700 11px Rajdhani, sans-serif'; g.textAlign = 'left';
            g.fillText(`♩ ${e.m}`, 4, y - 4);
        }
        for (const bm of ed.data.bookmarks) {
            const y = this.beatToY(bm.b);
            if (y < -10 || y > H + 10) continue;
            g.strokeStyle = 'rgba(61,255,160,0.7)';
            g.setLineDash([4, 4]); g.beginPath(); g.moveTo(0, y); g.lineTo(this.contentW, y); g.stroke(); g.setLineDash([]);
            g.fillStyle = '#3dffa0'; g.font = '600 11px Rajdhani, sans-serif'; g.textAlign = 'left';
            g.fillText('⚑ ' + (bm.name || 'Bookmark').slice(0, 14), 4, y + 12);
        }

        const sel = ed.sel;
        const vis = (b, extra = 0) => b >= bBot - 1 - extra && b <= bTop + 1;
        const moving = this.drag && this.drag.kind === 'move' ? this.drag : null;
        const mb = (o) => (moving && sel.has(o) ? moving.dBeat : 0);
        const ml = (o) => (moving && sel.has(o) ? moving.dLane : 0);

        // walls
        for (const w of ed.data.walls) {
            if (!vis(w.b, w.d)) continue;
            const b = w.b + mb(w);
            const lx = Math.max(0, Math.min(3, w.x + ml(w)));
            const x0 = this.wallX(lx), x1 = this.wallX(Math.min(4, lx + Math.max(1, w.w)));
            const y0 = this.beatToY(b + w.d), y1 = this.beatToY(b);
            const col = w.color ? rgb(w.color) : '#ff2d55';
            g.fillStyle = hexA(col, 0.28); g.fillRect(x0 + 1, y0, x1 - x0 - 2, y1 - y0);
            g.strokeStyle = sel.has(w) ? '#ffd76a' : hexA(col, 0.9); g.lineWidth = sel.has(w) ? 2 : 1;
            g.strokeRect(x0 + 1.5, y0 + 0.5, x1 - x0 - 3, y1 - y0 - 1); g.lineWidth = 1;
            if (y1 - y0 > 14) {
                g.fillStyle = '#fff'; g.font = '600 10px Rajdhani, sans-serif'; g.textAlign = 'center';
                g.fillText(w.y >= 2 ? 'CROUCH' : w.h >= 5 && w.y === 0 ? 'FULL' : `y${w.y} h${w.h}`, (x0 + x1) / 2, y1 - 4);
            }
        }

        // arcs + chains under the notes
        for (const a of ed.data.arcs) {
            if (!vis(a.b) && !vis(a.tb)) continue;
            const x0 = this.noteX(a.x, a.y), y0 = this.beatToY(a.b + mb(a)), x1 = this.noteX(a.tx, a.ty), y1 = this.beatToY(a.tb + mb(a));
            g.strokeStyle = sel.has(a) ? '#ffd76a' : hexA(NOTE_COLORS[a.c], 0.85); g.lineWidth = 3;
            g.beginPath(); g.moveTo(x0, y0);
            g.bezierCurveTo(x0, y0 - (y0 - y1) * 0.5 * a.mu, x1, y1 + (y0 - y1) * 0.5 * a.tmu, x1, y1); g.stroke(); g.lineWidth = 1;
        }
        for (const c of ed.data.chains) {
            if (!vis(c.b) && !vis(c.tb)) continue;
            const x0 = this.noteX(c.x, c.y), y0 = this.beatToY(c.b + mb(c)), x1 = this.noteX(c.tx, c.ty), y1 = this.beatToY(c.tb + mb(c));
            g.strokeStyle = hexA(NOTE_COLORS[c.c], 0.7); g.lineWidth = 2;
            g.beginPath(); g.moveTo(x0, y0); g.lineTo(x1, y1); g.stroke(); g.lineWidth = 1;
            for (let i = 1; i < c.sc; i++) {
                const f = i / (c.sc - 1) * c.s;
                const x = x0 + (x1 - x0) * Math.min(1, f), y = y0 + (y1 - y0) * (i / (c.sc - 1));
                g.fillStyle = NOTE_COLORS[c.c]; g.fillRect(x - 4, y - 4, 8, 8);
            }
            this.drawNote(g, x0, y0, { c: c.c, d: c.d, a: 0 }, sel.has(c), true);
        }

        // notes + bombs
        const size = Math.min(n.lane - 4, 26);
        for (const o of ed.data.bombs) {
            if (!vis(o.b)) continue;
            const x = this.noteX(Math.max(0, Math.min(3, o.x + ml(o))), o.y), y = this.beatToY(o.b + mb(o));
            g.fillStyle = '#1a1a22'; g.beginPath(); g.arc(x, y, size * 0.42, 0, Math.PI * 2); g.fill();
            g.strokeStyle = sel.has(o) ? '#ffd76a' : '#ff3b3b'; g.lineWidth = 2; g.stroke(); g.lineWidth = 1;
        }
        for (const o of ed.data.notes) {
            if (!vis(o.b)) continue;
            this.drawNote(g, this.noteX(Math.max(0, Math.min(3, o.x + ml(o))), o.y), this.beatToY(o.b + mb(o)), o, sel.has(o));
        }

        // light events
        const el = C.events.lane;
        for (const e of ed.data.events) {
            if (!vis(e.b)) continue;
            const x = this.eventX(e.et), y = this.beatToY(e.b + mb(e));
            if (x < 0) continue;
            this.drawEvent(g, x, y, el, e, sel.has(e));
        }

        this.drawGhost(g);
        this.drawHeader(g);

        // box selection
        const d = this.drag;
        if (d && d.kind === 'box') {
            g.strokeStyle = '#ffd76a'; g.setLineDash([5, 4]);
            g.strokeRect(Math.min(d.start.x, d.now.x) + 0.5, Math.min(d.start.y, d.now.y) + 0.5, Math.abs(d.now.x - d.start.x), Math.abs(d.now.y - d.start.y));
            g.setLineDash([]);
            g.fillStyle = 'rgba(255,215,106,0.06)';
            g.fillRect(Math.min(d.start.x, d.now.x), Math.min(d.start.y, d.now.y), Math.abs(d.now.x - d.start.x), Math.abs(d.now.y - d.start.y));
        }

        // the "now" line
        const ny = this.nowY + 0.5;
        g.strokeStyle = '#7c5cff'; g.lineWidth = 2;
        g.beginPath(); g.moveTo(0, ny); g.lineTo(this.contentW, ny); g.stroke(); g.lineWidth = 1;
        g.fillStyle = '#7c5cff'; g.fillRect(0, ny - 9, C.ruler.w - 2, 18);
        g.fillStyle = '#fff'; g.font = '700 11px Rajdhani, sans-serif'; g.textAlign = 'center';
        g.fillText(ed.cursorBeat.toFixed(ed.cursorBeat % 1 ? 3 : 0), C.ruler.w / 2 - 1, ny + 4);
    }

    drawNote(g, x, y, o, selected, chainHead = false) {
        const s = Math.min(this.cols.notes.lane - 4, 26);
        const fill = o.color ? rgb(o.color) : NOTE_COLORS[o.c];
        g.save();
        g.translate(x, y);
        g.rotate(DIR_ANGLE[o.d] - ((o.a || 0) * Math.PI) / 180);    // v3 angle offset is counter-clockwise
        g.fillStyle = fill;
        roundRect(g, -s / 2, -s / 2, s, s, 4); g.fill();
        if (chainHead) { g.strokeStyle = 'rgba(255,255,255,0.6)'; g.setLineDash([3, 2]); roundRect(g, -s / 2, -s / 2, s, s, 4); g.stroke(); g.setLineDash([]); }
        g.fillStyle = '#fff';
        if (o.d === 8) { g.beginPath(); g.arc(0, 0, s * 0.16, 0, Math.PI * 2); g.fill(); }
        else { g.beginPath(); g.moveTo(-s * 0.3, s * 0.08); g.lineTo(s * 0.3, s * 0.08); g.lineTo(0, s * 0.36); g.closePath(); g.fill(); }
        g.restore();
        if (selected) { g.strokeStyle = '#ffd76a'; g.lineWidth = 2; roundRect(g, x - s / 2 - 2, y - s / 2 - 2, s + 4, s + 4, 5); g.stroke(); g.lineWidth = 1; }
        if (o.color) { g.fillStyle = '#fff'; g.beginPath(); g.arc(x + s / 2 - 3, y - s / 2 + 3, 2, 0, Math.PI * 2); g.fill(); }
    }

    drawEvent(g, x, y, w, e, selected, ghost = false) {
        const lane = EVENT_LANES.find(l => l.et === e.et);
        const bw = w - 6, bh = 9;
        g.globalAlpha = ghost ? 0.45 : 1;
        if (lane && lane.kind === 'light') {
            const p = lightParts(e.i);
            const col = e.color ? rgb(e.color) : p.color ? LIGHT_RGB[p.color] : '#555a70';
            if (p.mode === 'off') { g.strokeStyle = '#6a7090'; g.strokeRect(x - bw / 2 + 0.5, y - bh / 2 + 0.5, bw - 1, bh - 1); }
            else if (p.mode === 'fade') {
                const gr = g.createLinearGradient(0, y + bh / 2, 0, y - bh * 1.6);
                gr.addColorStop(0, col); gr.addColorStop(1, 'rgba(0,0,0,0)');
                g.fillStyle = gr; g.fillRect(x - bw / 2, y - bh * 1.6, bw, bh * 2.1);
            } else {
                g.fillStyle = col; g.fillRect(x - bw / 2, y - bh / 2, bw, bh);
                if (p.mode === 'flash') { g.fillStyle = '#fff'; g.fillRect(x - bw / 2, y - bh / 2, bw, 2); }
                if (p.mode === 'transition') { g.fillStyle = 'rgba(0,0,0,0.35)'; g.fillRect(x, y - bh / 2, bw / 2, bh); }
            }
            if ((e.f ?? 1) !== 1 && p.mode !== 'off') {
                g.fillStyle = '#000'; g.font = '9px Rajdhani, sans-serif'; g.textAlign = 'center';
                g.fillText(Math.round((e.f ?? 1) * 100), x, y + 3);
            }
        } else {
            g.fillStyle = lane && lane.kind === 'speed' ? '#2dd4bf' : '#a78bfa';
            g.fillRect(x - bw / 2, y - bh / 2, bw, bh);
            g.fillStyle = '#081018'; g.font = '700 9px Rajdhani, sans-serif'; g.textAlign = 'center';
            g.fillText(lane && lane.kind === 'speed' ? String(e.i) : lane && lane.et === 8 ? '↻' : '⤢', x, y + 3);
        }
        if (selected) { g.strokeStyle = '#ffd76a'; g.lineWidth = 2; g.strokeRect(x - bw / 2 - 1.5, y - bh / 2 - 1.5, bw + 3, bh + 3); g.lineWidth = 1; }
        g.globalAlpha = 1;
    }

    drawWave(g, bTop, bBot) {
        const wave = this.ed.wave;
        const c = this.cols.wave;
        g.fillStyle = '#0d0d1c'; g.fillRect(c.x, 0, c.w, this.H);
        if (!wave) return;
        const clock = this.ed.clock;
        g.fillStyle = 'rgba(124,92,255,0.55)';
        const mid = c.x + c.w / 2;
        for (let y = 0; y < this.H; y += 2) {
            const t0 = clock.toSeconds(this.yToBeat(y + 2)), t1 = clock.toSeconds(this.yToBeat(y));
            let i0 = Math.floor(t0 * wave.rate), i1 = Math.ceil(t1 * wave.rate);
            if (i1 < 0 || i0 >= wave.peaks.length) continue;
            i0 = Math.max(0, i0); i1 = Math.min(wave.peaks.length - 1, Math.max(i0, i1));
            let m = 0;
            for (let i = i0; i <= i1; i++) if (wave.peaks[i] > m) m = wave.peaks[i];
            const hw = m * (c.w / 2 - 3);
            g.fillRect(mid - hw, y, hw * 2, 2);
        }
    }

    drawGhost(g) {
        const h = this.hover, ed = this.ed;
        if (!h || (this.drag && this.drag.kind !== 'note' && this.drag.kind !== 'wall') || h.y < this.headerH) return;
        const d = this.drag;
        if (d && d.kind === 'wall') {
            const x0 = this.wallX(Math.min(d.lane0, d.lane1)), x1 = this.wallX(Math.max(d.lane0, d.lane1) + 1);
            const y0 = this.beatToY(Math.max(d.beat0, d.beat1) + (d.beat0 === d.beat1 ? 1 / ed.snap : 0)), y1 = this.beatToY(Math.min(d.beat0, d.beat1));
            g.fillStyle = 'rgba(255,45,85,0.25)'; g.fillRect(x0 + 1, y0, x1 - x0 - 2, y1 - y0);
            g.strokeStyle = '#ff2d55'; g.strokeRect(x0 + 1.5, y0 + 0.5, x1 - x0 - 3, y1 - y0 - 1);
            return;
        }
        if (this.objectAt(h.x, h.y) && !d) return;
        const hit = d ? { area: 'notes', lane: d.lane, layer: d.layer, beat: d.beat } : this.hitArea(h.x, h.y);
        const beat = d ? d.beat : this.snap(hit.beat);
        const y = this.beatToY(beat);
        g.globalAlpha = 0.5;
        if (hit.area === 'notes') {
            const x = this.noteX(hit.lane, hit.layer);
            if (ed.tool === 'bomb') {
                g.fillStyle = '#1a1a22'; g.beginPath(); g.arc(x, y, 10, 0, Math.PI * 2); g.fill();
                g.strokeStyle = '#ff3b3b'; g.lineWidth = 2; g.stroke(); g.lineWidth = 1;
            } else if (ed.tool !== 'select') {
                let dir = ed.dir;
                if (d) { const dx = d.now.x - d.start.x, dy = d.now.y - d.start.y; if (Math.hypot(dx, dy) > 12) dir = dirFromDrag(dx, dy); }
                this.drawNote(g, x, y, { c: ed.tool === 'blue' ? 1 : 0, d: dir, a: ed.angle }, false);
            }
        } else if (hit.area === 'walls') {
            const x0 = this.wallX(hit.lane);
            g.fillStyle = 'rgba(255,45,85,0.3)'; g.fillRect(x0 + 1, y - 2, this.cols.walls.lane - 2, 4);
        } else if (hit.area === 'events') {
            this.drawEvent(g, this.eventX(hit.et), y, this.cols.events.lane, { et: hit.et, i: ed.eventValue(hit.et), f: ed.eventBrightness }, false, true);
        }
        g.globalAlpha = 1;
    }

    drawHeader(g) {
        const C = this.cols, n = C.notes;
        g.fillStyle = 'rgba(11,11,22,0.94)'; g.fillRect(0, 0, this.W, this.headerH);
        g.strokeStyle = 'rgba(255,255,255,0.12)'; g.beginPath(); g.moveTo(0, this.headerH + 0.5); g.lineTo(this.W, this.headerH + 0.5); g.stroke();
        g.font = '700 10px Rajdhani, sans-serif'; g.textAlign = 'center'; g.fillStyle = '#9aa0c0';
        g.fillText('BEAT', C.ruler.w / 2, 17);
        g.fillText('AUDIO', C.wave.x + C.wave.w / 2, 17);
        for (let r = 0; r < 3; r++) g.fillText(ROW_NAMES[r] + ' ROW', n.x + r * (n.lane * 4 + n.gap) + n.lane * 2, 17);
        g.fillText('WALLS', C.walls.x + C.walls.w / 2, 17);
        // lane names shrink to fit narrow lanes
        EVENT_LANES.forEach((l, i) => {
            const label = l.name.toUpperCase(), maxW = C.events.lane - 2;
            let size = 10;
            g.font = `700 ${size}px Rajdhani, sans-serif`;
            while (size > 6 && g.measureText(label).width > maxW) { size--; g.font = `700 ${size}px Rajdhani, sans-serif`; }
            g.fillText(label, C.events.x + i * C.events.lane + C.events.lane / 2, 17);
        });
    }
}

// 8-way cut direction from a drag (screen y grows downward; time flows up the screen,
// so dragging down the screen is a down cut, like swinging toward yourself)
export function dirFromDrag(dx, dy) {
    const a = Math.atan2(-dy, dx);          // standard angle, up positive
    const k = ((Math.round(a / (Math.PI / 4)) % 8) + 8) % 8;   // 0 right, 1 up-right, 2 up ...
    return [3, 5, 0, 4, 2, 6, 1, 7][k];
}

function roundRect(g, x, y, w, h, r) {
    g.beginPath();
    g.moveTo(x + r, y); g.lineTo(x + w - r, y); g.quadraticCurveTo(x + w, y, x + w, y + r);
    g.lineTo(x + w, y + h - r); g.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
    g.lineTo(x + r, y + h); g.quadraticCurveTo(x, y + h, x, y + h - r);
    g.lineTo(x, y + r); g.quadraticCurveTo(x, y, x + r, y);
    g.closePath();
}
function rgb(c) {
    const f = (v) => Math.round(Math.max(0, Math.min(1, Number(v) || 0)) * 255);
    return `#${[f(c[0]), f(c[1]), f(c[2])].map(v => v.toString(16).padStart(2, '0')).join('')}`;
}
function hexA(hex, a) {
    const v = parseInt(hex.slice(1), 16);
    return `rgba(${(v >> 16) & 255},${(v >> 8) & 255},${v & 255},${a})`;
}
