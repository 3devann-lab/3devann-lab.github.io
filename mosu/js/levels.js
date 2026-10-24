// ============ MOSU levels: catalog + chart generation from the music ============
import { compose, hashString, mulberry32 } from './music.js';

export const DIRS = ['up', 'right', 'down', 'left'];
export const OPPOSITE = { up: 'down', down: 'up', left: 'right', right: 'left', any: 'any' };
const PERP = { up: ['left', 'right'], down: ['left', 'right'], left: ['up', 'down'], right: ['up', 'down'] };

const KEYS = ['C', 'C#', 'D', 'Eb', 'E', 'F', 'F#', 'G', 'Ab', 'A', 'Bb', 'B'];
// root MIDI note in E3..Eb4 so basslines (two octaves down) stay audible
function keyRoot(key) {
    const i = KEYS.indexOf(key);
    return 52 + ((i - 4 + 12) % 12);
}

export const PACKS = [
    { id: 'p1', name: 'First Light', blurb: 'Learn the arrows', color: '#3dffa0' },
    { id: 'p2', name: 'City Pulse', blurb: 'Find the groove', color: '#4fc3f7' },
    { id: 'p3', name: 'Overclock', blurb: 'Holds and streams', color: '#ffb02d' },
    { id: 'p4', name: 'Hyperspace', blurb: 'Flips and diagonals', color: '#ff4f8b' },
    { id: 'p5', name: 'Singularity', blurb: 'Everything, faster', color: '#b96fff' },
];

const L = (id, pack, title, style, bpm, key, scale, stars) => ({ id, pack, title, style, bpm, key, scale, stars });
export const LEVELS = [
    L('hello-arrows', 'p1', 'Hello, Arrows', 'lofi', 84, 'C', 'major', 1),
    L('soft-boot', 'p1', 'Soft Boot', 'synthwave', 96, 'A', 'minor', 1),
    L('neon-drizzle', 'p1', 'Neon Drizzle', 'chiptune', 110, 'F', 'major', 2),
    L('pocket-sunrise', 'p1', 'Pocket Sunrise', 'house', 118, 'D', 'dorian', 2),
    L('paper-planes', 'p1', 'Paper Planes', 'futurebass', 100, 'G', 'major', 2),
    L('night-bus', 'p1', 'Night Bus', 'lofi', 90, 'E', 'minor', 2),

    L('glass-avenue', 'p2', 'Glass Avenue', 'house', 122, 'Bb', 'major', 3),
    L('pixel-rain', 'p2', 'Pixel Rain', 'chiptune', 132, 'E', 'minor', 3),
    L('afterglow-drive', 'p2', 'Afterglow Drive', 'synthwave', 108, 'F#', 'minor', 3),
    L('metro-static', 'p2', 'Metro Static', 'techno', 126, 'A', 'phrygian', 4),
    L('sugar-circuit', 'p2', 'Sugar Circuit', 'futurebass', 140, 'C', 'major', 4),
    L('basement-hum', 'p2', 'Basement Hum', 'trap', 140, 'D', 'minor', 4),

    L('turbo-heart', 'p3', 'Turbo Heart', 'synthwave', 124, 'C', 'minor', 5),
    L('chrome-bloom', 'p3', 'Chrome Bloom', 'house', 128, 'G', 'dorian', 5),
    L('byte-storm', 'p3', 'Byte Storm', 'chiptune', 150, 'A', 'minor', 5),
    L('undercurrent', 'p3', 'Undercurrent', 'dnb', 170, 'F', 'minor', 6),
    L('prism-engine', 'p3', 'Prism Engine', 'trance', 138, 'E', 'minor', 6),
    L('red-line', 'p3', 'Red Line', 'techno', 132, 'D', 'phrygian', 6),

    L('starfall-sprint', 'p4', 'Starfall Sprint', 'trance', 140, 'B', 'minor', 7),
    L('rewired', 'p4', 'Rewired', 'dnb', 174, 'C#', 'minor', 7),
    L('feedback-loop', 'p4', 'Feedback Loop', 'techno', 138, 'F', 'phrygian', 7),
    L('cobalt-fever', 'p4', 'Cobalt Fever', 'futurebass', 150, 'A', 'major', 8),
    L('hexadecimal', 'p4', 'Hexadecimal', 'chiptune', 168, 'G', 'harmonicMinor', 8),
    L('pressure-drop', 'p4', 'Pressure Drop', 'trap', 150, 'E', 'minor', 8),

    L('event-horizon', 'p5', 'Event Horizon', 'dnb', 180, 'D', 'minor', 9),
    L('overdrive-exe', 'p5', 'Overdrive.exe', 'chiptune', 190, 'C', 'harmonicMinor', 9),
    L('afterimage', 'p5', 'Afterimage', 'trance', 145, 'F#', 'minor', 9),
    L('null-pointer', 'p5', 'Null Pointer', 'techno', 145, 'B', 'phrygian', 10),
    L('hyperion', 'p5', 'Hyperion', 'synthwave', 160, 'Eb', 'minor', 10),
    L('mosu-max', 'p5', 'MOSU//MAX', 'dnb', 200, 'A', 'harmonicMinor', 10),
];

export const STYLE_LABEL = {
    synthwave: 'Synthwave', house: 'House', techno: 'Techno', trance: 'Trance', dnb: 'Drum & Bass',
    chiptune: 'Chiptune', trap: 'Trap', futurebass: 'Future Bass', lofi: 'Lo-fi',
};

export function levelSong(level, loop = false) {
    return compose({
        seed: hashString(level.id),
        bpm: level.bpm,
        root: keyRoot(level.key),
        scale: level.scale,
        style: level.style,
        targetSec: 80,
        loop,
    });
}

// Seconds a note is visible before it reaches the ring
export function approachFor(stars) {
    const k = (Math.max(1, Math.min(10, stars)) - 1) / 9;
    return 1.9 - k * 1.1;
}

const WEIGHT = { kick: 3, snare: 3, clap: 3, lead: 4, arp: 1.4, hat: 0.7, ohat: 1, bass: 1.5, pad: 2, crash: 5 };

/**
 * Turn a composed song into notes for a difficulty (1..10).
 * Notes: {t, d, d2?, hold?, flip?}
 * opts: {from, to, timeOffset, seed}
 */
export function generateChart(song, stars, opts = {}) {
    const rand = mulberry32((opts.seed ?? 1) + Math.round(stars * 101));
    const k = (Math.max(1, Math.min(10, stars)) - 1) / 9;
    const from = opts.from ?? 1.2;
    const to = opts.to ?? song.duration - 0.5;
    const step = song.spb / 4;
    const minGap = Math.max(step * 0.98, 0.64 - k * 0.52);
    const sectionAt = (t) => {
        let s = song.sections[0];
        for (const x of song.sections) if (x.start <= t + 1e-6) s = x;
        return s;
    };

    // 1. candidate onsets, merged per 16th
    const cands = new Map();
    for (const e of song.events) {
        if (e.t < from || e.t > to) continue;
        let w = WEIGHT[e.inst];
        if (!w) continue;
        if (e.inst === 'pad' && !e.short) w = 0.5;              // long pads → hold candidates
        const beatPos = (e.t / song.spb) % 1;
        if (Math.abs(beatPos) < 0.02 || Math.abs(beatPos - 1) < 0.02) w += 0.5;   // on the beat
        const key = Math.round(e.t / step);
        const c = cands.get(key) || { t: key * step, w: 0, insts: new Set(), midi: null, dur: 0, padDur: 0 };
        c.t = Math.min(c.t, e.t);
        c.w += w;
        c.insts.add(e.inst);
        if (e.inst === 'lead') { c.midi = e.midi; c.dur = e.dur; }
        if (e.inst === 'pad' && !e.short) c.padDur = Math.max(c.padDur, e.dur);
        cands.set(key, c);
    }
    const list = [...cands.values()].sort((a, b) => a.t - b.t);

    // 2. pick onsets: threshold drops with difficulty; drops are denser, calm parts sparser
    const picked = [];
    for (const c of list) {
        const sec = sectionAt(c.t);
        let thr = 4.4 - k * 3.6;
        if (sec.energy >= 4) thr -= 0.6;
        if (sec.energy <= 1) thr += 1.2;
        if (c.w < thr) continue;
        const last = picked[picked.length - 1];
        if (last && c.t - last.t < minGap) {
            // keep whichever is musically stronger, as long as spacing still works
            const prev = picked[picked.length - 2];
            if (c.w > last.w * 1.35 && (!prev || c.t - prev.t >= minGap)) picked[picked.length - 1] = c;
            continue;
        }
        picked.push(c);
    }

    // 3. holds on long lead notes / calm pads (not on the easiest levels)
    const notes = [];
    for (let i = 0; i < picked.length; i++) {
        const c = picked[i];
        const next = picked[i + 1];
        const room = (next ? next.t : to) - c.t;
        const n = { t: c.t, d: null, _c: c };
        if (stars >= 2) {
            let hold = 0;
            if (c.insts.has('lead') && c.dur >= song.spb * 0.9 && stars >= 3) hold = c.dur * 0.85;
            else if (c.padDur >= song.spb * 2 && sectionAt(c.t).energy <= 1) hold = Math.min(c.padDur * 0.6, song.spb * 3);
            if (hold > 0.25 && room > hold + Math.max(minGap, 0.25) && rand() < 0.55) n.hold = +hold.toFixed(3);
        }
        notes.push(n);
    }

    // 4. directions: melody contour for lead notes, patterns for the rest
    const patterns = k < 0.3 ? ['random', 'alternate', 'random'] : ['random', 'alternate', 'stairs', 'stairsRev', 'mirror', 'random', 'trill'];
    let pattern = 'random', patternLeft = 0, pi = 0, base = DIRS[Math.floor(rand() * 4)];
    let prev = null, prevPrev = null, prevMidi = null;
    for (const n of notes) {
        if (patternLeft <= 0) {
            pattern = patterns[Math.floor(rand() * patterns.length)];
            patternLeft = 4 + Math.floor(rand() * 5);
            pi = 0;
            base = DIRS[Math.floor(rand() * 4)];
        }
        let d;
        const c = n._c;
        if (c.midi != null && prevMidi != null && c.midi !== prevMidi && rand() < 0.5) {
            // melody goes up → up/right, down → down/left
            const upish = c.midi > prevMidi;
            d = rand() < 0.6 ? (upish ? 'up' : 'down') : (upish ? 'right' : 'left');
            if (d === prev && prev === prevPrev) d = upish ? (d === 'up' ? 'right' : 'up') : (d === 'down' ? 'left' : 'down');
        } else {
            const bi = DIRS.indexOf(base);
            switch (pattern) {
                case 'alternate': d = pi % 2 === 0 ? base : OPPOSITE[base]; break;
                case 'stairs': d = DIRS[(bi + pi) % 4]; break;
                case 'stairsRev': d = DIRS[(bi - pi + 400) % 4]; break;
                case 'mirror': d = pi % 2 === 0 ? 'left' : 'right'; break;
                case 'trill': d = pi % 2 === 0 ? base : PERP[base][0]; break;
                default: {
                    const opts2 = DIRS.filter(x => x !== prev);
                    d = opts2[Math.floor(rand() * opts2.length)];
                }
            }
            // no triple repeats on easier levels
            if (k < 0.6 && d === prev && prev === prevPrev) d = PERP[d][Math.floor(rand() * 2)];
        }
        if (c.midi != null) prevMidi = c.midi;
        n.d = d;
        prevPrev = prev; prev = d;
        pi++; patternLeft--;
    }

    // 5. specials
    for (const n of notes) {
        const c = n._c;
        const sec = sectionAt(n.t);
        if (stars <= 2 && rand() < 0.12 && !n.hold) n.d = 'any';
        else if (c.insts.has('crash') && stars <= 4) n.d = 'any';
        if (stars >= 7 && !n.hold && n.d !== 'any' && (c.insts.has('crash') || (sec.energy >= 4 && rand() < 0.03 + (stars - 7) * 0.025))) {
            n.d2 = PERP[n.d][Math.floor(rand() * 2)];
        }
        if (stars >= 6 && !n.d2 && !n.hold && n.d !== 'any' && sec.energy >= 3 && rand() < 0.04 + (stars - 6) * 0.025) {
            n.flip = true;
        }
        delete n._c;
        n.t = +n.t.toFixed(4);
    }
    if (opts.timeOffset) for (const n of notes) n.t = +(n.t + opts.timeOffset).toFixed(4);
    return notes;
}

// Endless: the composed loop repeats; each pass gets denser and faster
export function endlessChart(song, loops = 40, startStars = 2) {
    const notes = [];
    const approach = [];
    for (let i = 0; i < loops; i++) {
        const stars = Math.min(10, startStars + i * 0.75);
        const part = generateChart(song, stars, { from: i === 0 ? 1.5 : 0, to: song.duration - 0.05, timeOffset: i * song.duration, seed: 1000 + i });
        for (const n of part) notes.push(n);
        approach.push({ t: i * song.duration, approach: approachFor(stars), stars });
    }
    return { notes, approach };
}

// Classic: the original MOSU — random arrows on the beat of the original loop,
// speeding up the longer you survive. phase = time of the loop's first beat.
export function classicChart(bpm, phase = 0, loops = 400) {
    const rand = mulberry32(20250718);
    const spb = 60 / bpm;
    const notes = [];
    let t = phase + spb * 2, prev = null, gapBeats = 2;
    while (notes.length < loops * 2) {
        const opts = DIRS.filter(d => d !== prev);
        const d = opts[Math.floor(rand() * opts.length)];
        notes.push({ t: +t.toFixed(4), d });
        prev = d;
        if (notes.length % 16 === 0 && gapBeats > 0.5) gapBeats = Math.max(0.5, gapBeats - 0.25);
        t += gapBeats * spb;
    }
    return notes;
}

// Convert any accepted level JSON (v1 editor format or v2) into {meta, notes}
export function normalizeCustomLevel(json) {
    const data = typeof json === 'string' ? JSON.parse(json) : json;
    const dirOk = (d) => ['up', 'down', 'left', 'right', 'any'].includes(d);
    if (Array.isArray(data.notes) && data.notes.length && data.notes[0].t == null && data.notes[0].time == null) {
        // v1: evenly spaced notes ({bpm, noteDuration, gapBetweenNotes, notes:[{direction}]})
        const gap = Math.max(0.05, (Number(data.gapBetweenNotes) || 500) / 1000);
        const lead = Math.max(1.5, (Number(data.noteDuration) || 1000) / 1000);
        return {
            meta: {
                title: data.title || 'Custom Level', artist: data.artist || '', bpm: Number(data.bpm) || 120,
                approach: Math.max(0.5, Math.min(3, (Number(data.noteDuration) || 1000) / 1000)), offset: 0,
            },
            notes: data.notes.map((n, i) => ({ t: lead + i * gap, d: dirOk(n.direction) ? n.direction : 'up' })),
        };
    }
    const notes = (data.notes || []).map(n => {
        const t = n.t != null ? Number(n.t) / 1000 : Number(n.time);
        const out = { t, d: dirOk(n.d) ? n.d : dirOk(n.direction) ? n.direction : 'up' };
        if (n.d2 && dirOk(n.d2)) out.d2 = n.d2;
        if (n.hold) out.hold = Number(n.hold) / 1000;
        if (n.flip) out.flip = true;
        return out;
    }).filter(n => Number.isFinite(n.t) && n.t >= 0).sort((a, b) => a.t - b.t);
    return {
        meta: {
            title: data.title || 'Custom Level', artist: data.artist || '', bpm: Number(data.bpm) || 120,
            approach: Math.max(0.5, Math.min(3, (Number(data.approach) || 1400) / 1000)),
            offset: (Number(data.offset) || 0) / 1000,
        },
        notes,
    };
}

export function exportLevelJson(meta, notes) {
    return JSON.stringify({
        format: 'mosu', version: 2,
        title: meta.title, artist: meta.artist || '', bpm: meta.bpm,
        approach: Math.round((meta.approach || 1.4) * 1000), offset: Math.round((meta.offset || 0) * 1000),
        notes: notes.map(n => {
            const o = { t: Math.round(n.t * 1000), d: n.d };
            if (n.d2) o.d2 = n.d2;
            if (n.hold) o.hold = Math.round(n.hold * 1000);
            if (n.flip) o.flip = true;
            return o;
        }),
    }, null, 1);
}
