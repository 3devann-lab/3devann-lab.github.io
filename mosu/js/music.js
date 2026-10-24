// ============ MOSU procedural music: composer + offline renderer ============
// compose() writes a whole song as a list of note events (deterministic from a
// seed); renderSong() synthesizes those events into an AudioBuffer with an
// OfflineAudioContext. The chart generator reads the same events, so every
// arrow lands on something you can actually hear.

export function mulberry32(seed) {
    let a = seed >>> 0;
    return function () {
        a = (a + 0x6D2B79F5) | 0;
        let t = Math.imul(a ^ (a >>> 15), 1 | a);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

export function hashString(s) {
    let h = 2166136261;
    for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
    return h >>> 0;
}

export const SCALES = {
    major: [0, 2, 4, 5, 7, 9, 11],
    minor: [0, 2, 3, 5, 7, 8, 10],
    dorian: [0, 2, 3, 5, 7, 9, 10],
    phrygian: [0, 1, 3, 5, 7, 8, 10],
    mixolydian: [0, 2, 4, 5, 7, 9, 10],
    harmonicMinor: [0, 2, 3, 5, 7, 8, 11],
};

// chord progressions as scale degrees (0 = tonic), 4 bars each
const PROGRESSIONS = {
    major: [[0, 4, 5, 3], [0, 5, 3, 4], [5, 3, 0, 4], [0, 3, 0, 4], [3, 4, 2, 5], [0, 2, 3, 4]],
    minor: [[0, 5, 2, 6], [0, 3, 6, 5], [0, 6, 5, 6], [0, 5, 3, 4], [5, 6, 0, 0], [0, 3, 4, 0]],
};

// 16-step drum grids per bar: x = hit, o = accent-less ghost
const STYLES = {
    synthwave: {
        kick: 'x...x...x...x...', snare: '....x.......x...', hat: 'x.x.x.x.x.x.x.x.', ohat: '',
        bass: 'octave16', bassWave: 'sawtooth', leadWave: 'sawtooth', arpWave: 'square', arpRate: 16,
        padWave: 'sawtooth', swing: 0, leadDensity: 0.5, clap: false,
    },
    house: {
        kick: 'x...x...x...x...', snare: '....x.......x...', hat: 'xxxxxxxxxxxxxxxx', ohat: '..x...x...x...x.',
        bass: 'offbeat', bassWave: 'square', leadWave: 'square', arpWave: 'triangle', arpRate: 8,
        padWave: 'sawtooth', swing: 0, leadDensity: 0.45, clap: true, stabs: true,
    },
    techno: {
        kick: 'x...x...x...x...', snare: '....x.......x...', hat: 'xxxxxxxxxxxxxxxx', ohat: '..x...x...x...x.',
        bass: 'rumble', bassWave: 'sawtooth', leadWave: 'square', arpWave: 'sawtooth', arpRate: 16,
        padWave: 'sawtooth', swing: 0, leadDensity: 0.35, clap: true,
    },
    trance: {
        kick: 'x...x...x...x...', snare: '....x.......x...', hat: '', ohat: '..x...x...x...x.',
        bass: 'rolling', bassWave: 'sawtooth', leadWave: 'sawtooth', arpWave: 'sawtooth', arpRate: 16,
        padWave: 'sawtooth', swing: 0, leadDensity: 0.55, clap: true, gate: true,
    },
    dnb: {
        kick: 'x.........x.....', snare: '....x.......x...', hat: 'x.x.x.x.x.x.x.x.', ohat: '',
        bass: 'reese', bassWave: 'sawtooth', leadWave: 'square', arpWave: 'triangle', arpRate: 16,
        padWave: 'sawtooth', swing: 0, leadDensity: 0.5, clap: false,
    },
    chiptune: {
        kick: 'x.......x.x.....', snare: '....x.......x...', hat: 'x.x.x.x.x.x.x.x.', ohat: '',
        bass: 'chip', bassWave: 'square', leadWave: 'square', arpWave: 'square', arpRate: 16,
        padWave: 'square', swing: 0, leadDensity: 0.6, clap: false, noPad: true,
    },
    trap: {
        kick: 'x......x..x.....', snare: '........x.......', hat: 'x.x.x.x.x.x.xxxx', ohat: '',
        bass: '808', bassWave: 'sine', leadWave: 'triangle', arpWave: 'square', arpRate: 8,
        padWave: 'triangle', swing: 0, leadDensity: 0.4, clap: true,
    },
    futurebass: {
        kick: 'x.....x...x.....', snare: '........x.......', hat: 'x.x.x.x.x.x.x.x.', ohat: '',
        bass: 'long', bassWave: 'sawtooth', leadWave: 'square', arpWave: 'triangle', arpRate: 8,
        padWave: 'sawtooth', swing: 0, leadDensity: 0.5, clap: true, chop: true,
    },
    lofi: {
        kick: 'x.....x...x.....', snare: '....x.......x...', hat: 'x.x.x.x.x.x.x.x.', ohat: '',
        bass: 'root8', bassWave: 'sine', leadWave: 'triangle', arpWave: 'triangle', arpRate: 8,
        padWave: 'triangle', swing: 0.14, leadDensity: 0.4, clap: false, vinyl: true,
    },
};
export const STYLE_NAMES = Object.keys(STYLES);

// Section plan scaled to ~80 s. energy: 0 calm … 4 peak
function planSections(bpm, targetSec, loop) {
    if (loop) {
        return [
            { name: 'verse', bars: 8, energy: 2 },
            { name: 'build', bars: 4, energy: 3 },
            { name: 'drop', bars: 8, energy: 4 },
            { name: 'break', bars: 4, energy: 1 },
            { name: 'drop2', bars: 8, energy: 4 },
        ];
    }
    const barSec = 240 / bpm;
    const base = [
        { name: 'intro', bars: 4, energy: 1 },
        { name: 'verse', bars: 8, energy: 2 },
        { name: 'build', bars: 4, energy: 3 },
        { name: 'drop', bars: 8, energy: 4 },
        { name: 'break', bars: 4, energy: 1 },
        { name: 'build2', bars: 4, energy: 3 },
        { name: 'drop2', bars: 8, energy: 4 },
        { name: 'outro', bars: 4, energy: 1 },
    ];
    let total = base.reduce((s, x) => s + x.bars, 0) * barSec;
    if (total < targetSec * 0.8) {
        // fast songs: longer verse/drops (multiples of 4 bars keep phrasing)
        const extra = Math.round((targetSec - total) / barSec / 4) * 4;
        const verse = base.find(s => s.name === 'verse');
        const drop2 = base.find(s => s.name === 'drop2');
        drop2.bars += Math.min(8, Math.max(0, extra - 4));
        verse.bars += Math.min(8, Math.max(0, extra - (drop2.bars - 8)));
    } else if (total > targetSec * 1.25) {
        base.find(s => s.name === 'verse').bars = 4;
        base.find(s => s.name === 'drop2').bars = 4;
    }
    return base;
}

/**
 * spec: {seed, bpm, root (MIDI), scale, style, targetSec?, loop?}
 * returns {bpm, spb, barSec, duration, sections, events, beats}
 */
export function compose(spec) {
    const rand = mulberry32(spec.seed >>> 0);
    const pick = (arr) => arr[Math.floor(rand() * arr.length)];
    const st = STYLES[spec.style] || STYLES.synthwave;
    const bpm = spec.bpm;
    const spb = 60 / bpm;
    const step = spb / 4;                  // 16th
    const barSec = spb * 4;
    const scaleName = spec.scale || 'minor';
    const scale = SCALES[scaleName] || SCALES.minor;
    const minorish = /minor|dorian|phrygian/.test(scaleName);
    const prog = pick(PROGRESSIONS[minorish ? 'minor' : 'major']);
    const prog2 = pick(PROGRESSIONS[minorish ? 'minor' : 'major']);
    const root = spec.root ?? 57;          // A3
    const sections = planSections(bpm, spec.targetSec || 80, !!spec.loop);
    let bar = 0;
    for (const s of sections) { s.startBar = bar; s.start = bar * barSec; bar += s.bars; }
    const totalBars = bar;
    const duration = totalBars * barSec + (spec.loop ? 0 : barSec * 0.75);

    // scale degree → MIDI note (degree may exceed the scale length)
    const deg = (d, octave = 0) => {
        const n = scale.length;
        const o = Math.floor(d / n);
        const i = ((d % n) + n) % n;
        return root + scale[i] + 12 * (o + octave);
    };
    const chordDegrees = (d) => [d, d + 2, d + 4];
    // closest chord tone (any octave) to scale degree d
    const nearestChordTone = (d, chord) => {
        let best = d, bestDist = Infinity;
        for (const c of chord) {
            for (let o = -3; o <= 3; o++) {
                const cand = c + scale.length * o;
                const dist = Math.abs(cand - d);
                if (dist < bestDist) { bestDist = dist; best = cand; }
            }
        }
        return best;
    };

    const events = [];
    const ev = (t, inst, extra = {}) => events.push({ t, inst, midi: 0, dur: 0, vel: 1, pan: 0, ...extra });
    const swingT = (s) => (st.swing && s % 2 === 1 ? st.swing * step * 2 : 0);

    // melody motif: rhythm (8th grid) + scale-degree contour, reused across phrases
    const makeMotif = (density) => {
        const slots = [];
        for (let i = 0; i < 16; i++) {           // 2 bars of 8ths
            const strong = i % 2 === 0;
            if (rand() < (strong ? density + 0.2 : density - 0.15)) slots.push(i);
        }
        if (!slots.includes(0)) slots.unshift(0);
        const contour = [];
        let d = pick([0, 2, 4, 7]);
        for (let i = 0; i < slots.length; i++) {
            contour.push(d);
            d += pick([-2, -1, -1, 1, 1, 2, 0, 3, -3]);
            d = Math.max(-2, Math.min(9, d));
        }
        return { slots, contour };
    };
    const motifA = makeMotif(st.leadDensity);
    const motifB = makeMotif(st.leadDensity + 0.1);

    for (const sec of sections) {
        const progression = sec.name === 'drop2' || sec.name === 'break' ? prog2 : prog;
        for (let b = 0; b < sec.bars; b++) {
            const absBar = sec.startBar + b;
            const t0 = absBar * barSec;
            const chordDeg = progression[b % 4];
            const chord = chordDegrees(chordDeg);
            const isLastBar = b === sec.bars - 1;
            const E = sec.energy;

            // ---- drums ----
            const drumsOn = E >= 2 || sec.name === 'outro' || (sec.name === 'intro' && b >= 2);
            for (let s = 0; s < 16; s++) {
                const t = t0 + s * step + swingT(s);
                const k = st.kick[s] === 'x';
                if (drumsOn && k && !(sec.name.startsWith('build') && isLastBar && s >= 8)) {
                    ev(t, 'kick', { vel: s % 4 === 0 ? 1 : 0.85 });
                }
                if (E >= 2 && !sec.name.startsWith('build') && st.snare[s] === 'x') {
                    ev(t, st.clap ? 'clap' : 'snare', { vel: 1 });
                }
                if (drumsOn && st.hat && st.hat[s] === 'x' && (E >= 2 || s % 4 === 2)) {
                    // trap: little 32nd rolls at bar ends
                    if (spec.style === 'trap' && s >= 12 && E >= 3 && rand() < 0.5) {
                        ev(t, 'hat', { vel: 0.5 }); ev(t + step / 2, 'hat', { vel: 0.45 });
                    } else {
                        ev(t, 'hat', { vel: s % 4 === 0 ? 0.75 : 0.5 });
                    }
                }
                if (E >= 3 && st.ohat && st.ohat[s] === 'x') ev(t, 'ohat', { vel: 0.6 });
            }
            // build: snare roll that doubles in rate every bar
            if (sec.name.startsWith('build')) {
                const rate = [4, 8, 16, 16][Math.min(3, b)] || 16;
                const per = 16 / rate;
                for (let s = 0; s < 16; s += per) {
                    ev(t0 + s * step, 'snare', { vel: 0.4 + 0.6 * ((b * 16 + s) / (sec.bars * 16)) });
                }
                if (b === 0) ev(t0, 'riser', { dur: sec.bars * barSec });
            }
            if ((sec.name === 'drop' || sec.name === 'drop2') && b === 0) ev(t0, 'crash', { vel: 1 });
            if (sec.name === 'drop' && b === 4 && sec.bars >= 8) ev(t0, 'crash', { vel: 0.7 });

            // ---- bass ----
            const bassOn = E >= 2 && !(sec.name.startsWith('build') && isLastBar);
            if (bassOn) {
                const bm = deg(chordDeg, -2);
                const pat = st.bass;
                if (pat === 'octave16') {
                    for (let s = 0; s < 16; s += 2) ev(t0 + s * step, 'bass', { midi: bm + (s % 4 === 2 ? 12 : 0), dur: step * 1.6, vel: 0.8, wave: st.bassWave });
                } else if (pat === 'offbeat') {
                    for (let s = 2; s < 16; s += 4) ev(t0 + s * step, 'bass', { midi: bm, dur: step * 1.8, vel: 0.9, wave: st.bassWave });
                } else if (pat === 'rumble') {
                    for (let s = 0; s < 16; s++) if (s % 4 !== 0) ev(t0 + s * step, 'bass', { midi: bm, dur: step * 0.8, vel: 0.55, wave: st.bassWave });
                } else if (pat === 'rolling') {
                    for (let s = 0; s < 16; s++) if (s % 4 !== 0) ev(t0 + s * step, 'bass', { midi: bm, dur: step * 0.85, vel: 0.65, wave: st.bassWave });
                } else if (pat === 'reese') {
                    ev(t0, 'bass', { midi: bm, dur: barSec * 0.48, vel: 0.85, wave: st.bassWave, reese: true });
                    ev(t0 + barSec * 0.5, 'bass', { midi: deg(chord[rand() < 0.5 ? 0 : 2], -2), dur: barSec * 0.45, vel: 0.8, wave: st.bassWave, reese: true });
                } else if (pat === 'chip') {
                    for (let s = 0; s < 16; s += 2) ev(t0 + s * step, 'bass', { midi: s % 8 === 4 ? deg(chord[2], -2) : bm, dur: step * 1.4, vel: 0.6, wave: 'square' });
                } else if (pat === '808') {
                    for (let s = 0; s < 16; s++) if (st.kick[s] === 'x') ev(t0 + s * step, 'bass', { midi: bm, dur: step * 5, vel: 0.95, wave: 'sine', glide: true });
                } else if (pat === 'long') {
                    ev(t0, 'bass', { midi: bm, dur: barSec * 0.9, vel: 0.8, wave: st.bassWave });
                } else {                                   // root8
                    for (let s = 0; s < 16; s += 2) ev(t0 + s * step + swingT(s), 'bass', { midi: bm, dur: step * 1.5, vel: 0.7, wave: st.bassWave });
                }
            }

            // ---- pads / chords ----
            const padNotes = chord.map((d, i) => deg(d, i === 0 ? -1 : -1));
            if (!st.noPad && (E <= 1 || E === 4 || sec.name === 'verse')) {
                if (st.chop && E >= 3) {
                    for (const s of [0, 3, 6, 8, 11, 14]) ev(t0 + s * step, 'pad', { notes: padNotes, dur: step * 1.6, vel: 0.55, wave: st.padWave, short: true });
                } else if (st.gate && E >= 3) {
                    for (let s = 0; s < 16; s += 2) ev(t0 + s * step, 'pad', { notes: padNotes, dur: step * 1.1, vel: 0.4, wave: st.padWave, short: true });
                } else if (st.stabs && E >= 2) {
                    for (const s of [2, 6, 10, 14]) ev(t0 + s * step, 'pad', { notes: padNotes, dur: step * 1.2, vel: 0.45, wave: st.padWave, short: true });
                } else {
                    ev(t0, 'pad', { notes: padNotes, dur: barSec, vel: E <= 1 ? 0.5 : 0.35, wave: st.padWave });
                }
            }

            // ---- arpeggio ----
            const arpOn = (E === 2 || E === 3 || (E === 1 && sec.name === 'intro' && b >= 2) || (sec.name === 'drop2' && st.arpRate === 16));
            if (arpOn) {
                const per = 16 / st.arpRate;
                const tones = [...chord, chord[0] + 7, chord[1] + 7];
                let idx = 0;
                for (let s = 0; s < 16; s += per) {
                    const d = tones[idx % tones.length]; idx++;
                    ev(t0 + s * step + swingT(s), 'arp', { midi: deg(d, 1), dur: step * per * 0.8, vel: sec.name === 'drop2' ? 0.3 : 0.45, wave: st.arpWave });
                }
            }

            // ---- lead melody (drops + break) ----
            const leadOn = E === 4 || sec.name === 'break';
            if (leadOn) {
                // 8-bar phrase: motif A for 4 bars, then B for 2, then A again
                const motif = (b % 8) >= 4 && (b % 8) < 6 ? motifB : motifA;
                const half = b % 2;                      // which bar of the 2-bar motif
                motif.slots.forEach((slot, i) => {
                    if (Math.floor(slot / 8) !== half) return;
                    const s16 = (slot % 8) * 2;
                    const next = motif.slots[i + 1];
                    const lenSlots = next != null && Math.floor(next / 8) === half ? next - slot : 8 - (slot % 8);
                    // follow the harmony: move the motif with the chord root,
                    // and land on chord tones on strong beats
                    let d = motif.contour[i] + chordDeg;
                    if (d > 9) d -= scale.length;
                    if (s16 % 8 === 0) d = nearestChordTone(d, chord);
                    ev(t0 + s16 * step + swingT(s16), 'lead', {
                        midi: deg(d, 1), dur: Math.max(step, lenSlots * 2 * step * 0.9),
                        vel: sec.name === 'break' ? 0.45 : 0.6, wave: st.leadWave,
                    });
                });
            }
            if (st.vinyl && b === 0) ev(t0, 'vinyl', { dur: sec.bars * barSec });
        }
    }
    events.sort((a, b) => a.t - b.t);

    const beats = [];
    for (let b = 0; b < totalBars * 4; b++) beats.push({ t: b * spb, down: b % 4 === 0 });
    return { bpm, spb, barSec, duration, sections, events, beats, loop: !!spec.loop, style: spec.style };
}

// ---------- synthesis ----------
const mtof = (m) => 440 * Math.pow(2, (m - 69) / 12);

function makeNoise(ctx, seconds) {
    const len = Math.floor(ctx.sampleRate * seconds);
    const buf = ctx.createBuffer(1, len, ctx.sampleRate);
    const d = buf.getChannelData(0);
    let s = 12345;
    for (let i = 0; i < len; i++) { s = (s * 1103515245 + 12345) & 0x7fffffff; d[i] = (s / 0x3fffffff) - 1; }
    return buf;
}

function makeImpulse(ctx, seconds, decay) {
    const len = Math.floor(ctx.sampleRate * seconds);
    const buf = ctx.createBuffer(2, len, ctx.sampleRate);
    for (let c = 0; c < 2; c++) {
        const d = buf.getChannelData(c);
        let s = 777 + c * 31;
        for (let i = 0; i < len; i++) {
            s = (s * 1103515245 + 12345) & 0x7fffffff;
            d[i] = ((s / 0x3fffffff) - 1) * Math.pow(1 - i / len, decay);
        }
    }
    return buf;
}

const DRUMS = { kick: 0.5, snare: 0.3, clap: 0.32, hat: 0.08, ohat: 0.36, crash: 1.9 };
const REVERB_SEND = { snare: true, clap: true, crash: true };

class Voices {
    // raw: no master chain / reverb (used to bake one-shot drum samples)
    constructor(ctx, { raw = false, noiseOffset = null, kit = null } = {}) {
        this.ctx = ctx;
        this.raw = raw;
        this.noiseOffset = noiseOffset;
        this.kit = kit;
        this.variant = 0;
        this.noise = makeNoise(ctx, 2);
        this.master = ctx.createGain();
        this.reverbIn = ctx.createGain();
        this.drums = ctx.createGain();
        this.music = ctx.createGain();
        if (raw) {
            this.master.connect(ctx.destination);
            this.drums.connect(ctx.destination);
            this.music.connect(ctx.destination);
            return;
        }
        this.master.gain.value = 0.8;
        const comp = ctx.createDynamicsCompressor();
        comp.threshold.value = -16; comp.ratio.value = 4; comp.attack.value = 0.004; comp.release.value = 0.2;
        this.master.connect(comp);
        comp.connect(ctx.destination);
        this.reverb = ctx.createConvolver();
        this.reverb.buffer = makeImpulse(ctx, 2.2, 3);
        this.reverbIn.gain.value = 0.22;
        this.reverbIn.connect(this.reverb);
        this.reverb.connect(this.master);
        this.drums.gain.value = 0.9; this.drums.connect(this.master);
        this.music.gain.value = 0.55; this.music.connect(this.master);
        this.music.connect(this.reverbIn);
        // shared stereo positions for hats (one panner each, not one per hit)
        this.hatBus = this.out(-0.12, this.drums, true);
        this.ohatBus = this.out(0.15, this.drums, true);
    }

    // a baked drum hit: just a buffer source and a velocity gain
    sample(e) {
        const shots = this.kit[e.inst];
        const src = this.ctx.createBufferSource();
        src.buffer = shots[(this.variant++) % shots.length];
        const g = this.ctx.createGain();
        g.gain.value = e.vel;
        src.connect(g);
        g.connect(e.inst === 'hat' ? this.hatBus : e.inst === 'ohat' ? this.ohatBus : this.drums);
        if (REVERB_SEND[e.inst]) g.connect(this.reverbIn);
        src.start(e.t);
    }

    out(pan, bus, force = false) {
        if (!pan || (this.raw && !force)) return bus;
        const p = this.ctx.createStereoPanner();
        p.pan.value = pan;
        p.connect(bus);
        return p;
    }

    noiseSrc(t, dur) {
        const src = this.ctx.createBufferSource();
        src.buffer = this.noise;
        src.start(t, this.noiseOffset ?? Math.random() * 1.0);
        src.stop(t + dur);
        return src;
    }

    env(g, t, peak, attack, decay, sustain = 0, hold = 0, release = 0.05) {
        const p = g.gain;
        p.setValueAtTime(0.0001, t);
        p.linearRampToValueAtTime(peak, t + attack);
        if (hold > 0) {
            p.setTargetAtTime(peak * sustain || 0.0001, t + attack, decay / 3);
            p.setValueAtTime(Math.max(0.0001, peak * sustain), t + attack + hold);
            p.exponentialRampToValueAtTime(0.0001, t + attack + hold + release);
            return t + attack + hold + release;
        }
        p.exponentialRampToValueAtTime(0.0001, t + attack + decay);
        return t + attack + decay;
    }

    kick(e) {
        const c = this.ctx, t = e.t;
        const o = c.createOscillator();
        o.frequency.setValueAtTime(155, t);
        o.frequency.exponentialRampToValueAtTime(46, t + 0.11);
        const g = c.createGain();
        const end = this.env(g, t, 1.0 * e.vel, 0.002, 0.42);
        o.connect(g); g.connect(this.drums);
        o.start(t); o.stop(end);
        const n = this.noiseSrc(t, 0.02), hp = c.createBiquadFilter(), ng = c.createGain();
        hp.type = 'highpass'; hp.frequency.value = 3000;
        this.env(ng, t, 0.25 * e.vel, 0.001, 0.015);
        n.connect(hp); hp.connect(ng); ng.connect(this.drums);
    }

    snare(e) {
        const c = this.ctx, t = e.t;
        const n = this.noiseSrc(t, 0.25), bp = c.createBiquadFilter(), g = c.createGain();
        bp.type = 'bandpass'; bp.frequency.value = 1900; bp.Q.value = 0.7;
        this.env(g, t, 0.55 * e.vel, 0.002, 0.19);
        n.connect(bp); bp.connect(g); g.connect(this.drums); g.connect(this.reverbIn);
        const o = c.createOscillator(), og = c.createGain();
        o.type = 'triangle'; o.frequency.setValueAtTime(220, t); o.frequency.exponentialRampToValueAtTime(160, t + 0.08);
        this.env(og, t, 0.35 * e.vel, 0.002, 0.09);
        o.connect(og); og.connect(this.drums); o.start(t); o.stop(t + 0.12);
    }

    clap(e) {
        const c = this.ctx, t = e.t;
        const n = this.noiseSrc(t, 0.3), bp = c.createBiquadFilter(), g = c.createGain();
        bp.type = 'bandpass'; bp.frequency.value = 1300; bp.Q.value = 1.1;
        const p = g.gain, v = 0.6 * e.vel;
        p.setValueAtTime(0.0001, t);
        for (let i = 0; i < 3; i++) { p.linearRampToValueAtTime(v, t + i * 0.011 + 0.001); p.linearRampToValueAtTime(v * 0.2, t + i * 0.011 + 0.009); }
        p.linearRampToValueAtTime(v, t + 0.035);
        p.exponentialRampToValueAtTime(0.0001, t + 0.25);
        n.connect(bp); bp.connect(g); g.connect(this.drums); g.connect(this.reverbIn);
    }

    hat(e, open = false) {
        const c = this.ctx, t = e.t;
        const dur = open ? 0.28 : 0.05;
        const n = this.noiseSrc(t, dur + 0.02), hp = c.createBiquadFilter(), g = c.createGain();
        hp.type = 'highpass'; hp.frequency.value = open ? 6500 : 8000;
        this.env(g, t, (open ? 0.22 : 0.18) * e.vel, 0.001, dur);
        n.connect(hp); hp.connect(g); g.connect(this.out(open ? 0.15 : -0.12, this.drums));
    }

    crash(e) {
        const c = this.ctx, t = e.t;
        const n = this.noiseSrc(t, 1.8), hp = c.createBiquadFilter(), g = c.createGain();
        hp.type = 'highpass'; hp.frequency.value = 3800;
        this.env(g, t, 0.28 * e.vel, 0.003, 1.6);
        n.connect(hp); hp.connect(g); g.connect(this.drums); g.connect(this.reverbIn);
    }

    riser(e) {
        const c = this.ctx, t = e.t, d = e.dur;
        const n = this.noiseSrc(t, d), bp = c.createBiquadFilter(), g = c.createGain();
        bp.type = 'bandpass'; bp.Q.value = 2;
        bp.frequency.setValueAtTime(300, t);
        bp.frequency.exponentialRampToValueAtTime(7000, t + d);
        g.gain.setValueAtTime(0.0001, t);
        g.gain.exponentialRampToValueAtTime(0.16, t + d * 0.98);
        g.gain.linearRampToValueAtTime(0.0001, t + d);
        n.connect(bp); bp.connect(g); g.connect(this.master);
    }

    vinyl(e) {
        const c = this.ctx, t = e.t;
        const n = this.noiseSrc(t, e.dur), lp = c.createBiquadFilter(), g = c.createGain();
        lp.type = 'bandpass'; lp.frequency.value = 3000; lp.Q.value = 0.3;
        g.gain.value = 0.012;
        n.connect(lp); lp.connect(g); g.connect(this.master);
        // the noise buffer is 2 s long; loop it for the section
        n.loop = true;
    }

    bass(e) {
        const c = this.ctx, t = e.t, f = mtof(e.midi);
        const lp = c.createBiquadFilter(), g = c.createGain();
        lp.type = 'lowpass'; lp.Q.value = 4;
        lp.frequency.setValueAtTime(e.wave === 'sine' ? 900 : 220, t);
        if (e.wave !== 'sine') {
            lp.frequency.linearRampToValueAtTime(1100 * e.vel + 300, t + 0.02);
            lp.frequency.exponentialRampToValueAtTime(260, t + Math.min(0.3, e.dur));
        }
        const end = this.env(g, t, 0.55 * e.vel, 0.004, 0.1, 0.7, Math.max(0.01, e.dur - 0.05), 0.06);
        const oscs = e.reese ? [-9, 9] : [0];
        for (const det of oscs) {
            const o = c.createOscillator();
            o.type = e.wave || 'sawtooth';
            o.frequency.setValueAtTime(e.glide ? f * 1.5 : f, t);
            if (e.glide) o.frequency.exponentialRampToValueAtTime(f, t + 0.06);
            o.detune.value = det;
            o.connect(lp); o.start(t); o.stop(end + 0.02);
        }
        lp.connect(g); g.connect(this.music);
    }

    pad(e) {
        const c = this.ctx, t = e.t;
        const lp = c.createBiquadFilter(), g = c.createGain();
        lp.type = 'lowpass'; lp.frequency.value = e.short ? 2600 : 1500; lp.Q.value = 0.6;
        const attack = e.short ? 0.008 : 0.25;
        const end = e.short
            ? this.env(g, t, 0.28 * e.vel, attack, e.dur * 0.9)
            : this.env(g, t, 0.22 * e.vel, attack, 0.5, 0.8, Math.max(0.05, e.dur - attack), 0.5);
        for (const m of e.notes) {
            for (const det of e.short ? [-12, 12] : [-8, 8]) {
                const o = c.createOscillator();
                o.type = e.wave || 'sawtooth';
                o.frequency.value = mtof(m + 12);
                o.detune.value = det;
                o.connect(lp); o.start(t); o.stop(end + 0.02);
            }
        }
        lp.connect(g); g.connect(this.music);
    }

    lead(e) {
        const c = this.ctx, t = e.t;
        const o = c.createOscillator(), lp = c.createBiquadFilter(), g = c.createGain();
        o.type = e.wave || 'square';
        o.frequency.value = mtof(e.midi);
        lp.type = 'lowpass'; lp.frequency.value = 3200; lp.Q.value = 1;
        const end = this.env(g, t, 0.24 * e.vel, 0.008, 0.2, 0.6, Math.max(0.03, e.dur - 0.05), 0.09);
        o.connect(lp); lp.connect(g); g.connect(this.out(0.08, this.music));
        o.start(t); o.stop(end + 0.02);
    }

    arp(e) {
        const c = this.ctx, t = e.t;
        const o = c.createOscillator(), g = c.createGain(), lp = c.createBiquadFilter();
        o.type = e.wave || 'square';
        o.frequency.value = mtof(e.midi);
        lp.type = 'lowpass'; lp.frequency.value = 2400;
        const end = this.env(g, t, 0.15 * e.vel, 0.003, Math.min(0.18, e.dur + 0.05));
        o.connect(lp); lp.connect(g); g.connect(this.out(-0.1, this.music));
        o.start(t); o.stop(end + 0.02);
    }

    play(e) {
        if (this.kit && this.kit[e.inst]) return this.sample(e);
        switch (e.inst) {
            case 'kick': return this.kick(e);
            case 'snare': return this.snare(e);
            case 'clap': return this.clap(e);
            case 'hat': return this.hat(e, false);
            case 'ohat': return this.hat(e, true);
            case 'crash': return this.crash(e);
            case 'riser': return this.riser(e);
            case 'vinyl': return this.vinyl(e);
            case 'bass': return this.bass(e);
            case 'pad': return this.pad(e);
            case 'lead': return this.lead(e);
            case 'arp': return this.arp(e);
        }
    }
}

const Offline = () => window.OfflineAudioContext || window.webkitOfflineAudioContext;

// Bake each drum sound once per sample rate (a few variants so hats don't sound
// machine-gunned); every hit in a song is then a cheap buffer playback.
const kitCache = new Map();
function drumKit(sampleRate) {
    if (kitCache.has(sampleRate)) return kitCache.get(sampleRate);
    const p = (async () => {
        const OAC = Offline();
        const kit = {};
        for (const [name, len] of Object.entries(DRUMS)) {
            kit[name] = [];
            const variants = name === 'kick' ? 1 : 3;
            for (let i = 0; i < variants; i++) {
                const ctx = new OAC(1, Math.ceil(len * sampleRate), sampleRate);
                const v = new Voices(ctx, { raw: true, noiseOffset: 0.11 + i * 0.37 });
                v.play({ t: 0, inst: name, vel: 1 });
                kit[name].push(await ctx.startRendering());
            }
        }
        return kit;
    })();
    kitCache.set(sampleRate, p);
    return p;
}

// Render events starting in [from, to) into a buffer that starts at `from`
// (plus `tail` seconds so notes ringing past `to` aren't cut off).
// Nodes are created just in time: the render suspends every second and only
// the next window of notes is scheduled. Scheduling everything up front kept
// thousands of idle nodes in the graph for the whole song, which made a
// 90-second track take about a minute to render.
async function renderRange(song, sampleRate, from, to, tail) {
    const kit = await drumKit(sampleRate);
    const OAC = Offline();
    const dur = Math.max(0.1, to - from + tail);
    const ctx = new OAC(2, Math.ceil(dur * sampleRate), sampleRate);
    const v = new Voices(ctx, { kit });
    const events = song.events.filter(e => e.t >= from && e.t < to);
    let idx = 0;
    const scheduleUntil = (tEnd) => {
        while (idx < events.length && events[idx].t - from < tEnd) {
            const e = events[idx++];
            v.play({ ...e, t: e.t - from });
        }
    };
    const CHUNK = 1.0, AHEAD = 0.3;
    scheduleUntil(CHUNK + AHEAD);
    if (ctx.suspend) {
        const quantum = 128 / sampleRate;
        for (let t = CHUNK; t < dur - 0.05; t += CHUNK) {
            const at = Math.floor(t / quantum) * quantum;      // suspend points snap to render quanta
            ctx.suspend(at).then(() => { scheduleUntil(at + CHUNK + AHEAD); ctx.resume(); });
        }
    } else {
        scheduleUntil(Infinity);                               // very old browsers
    }
    return await ctx.startRendering();
}

export function renderSong(song, sampleRate = 32000) {
    return renderRange(song, sampleRate, 0, song.duration, 0);
}

// Render the opening first so play can start right away; the rest renders in
// the background and is scheduled to follow sample-accurately.
// Returns {first: Promise<AudioBuffer>, rest: Promise<AudioBuffer>|null, split}
export function renderSongProgressive(song, sampleRate = 32000) {
    const sec = song.loop ? null : song.sections.find(s => s.name.startsWith('build') && s.start >= 8);
    if (!sec) return { first: renderSong(song, sampleRate), rest: null, split: null };
    const split = sec.start;
    const first = renderRange(song, sampleRate, 0, split, 4);
    const rest = first.then(() => renderRange(song, sampleRate, split, song.duration, 0));
    return { first, rest, split };
}
