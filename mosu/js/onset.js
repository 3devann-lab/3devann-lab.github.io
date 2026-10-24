// ============ MOSU auto-charting: onset + tempo detection for any song ============
// Spectral flux in three bands → onsets; autocorrelation → tempo; then a chart
// is built from the strongest onsets, snapped to the beat grid when confident.
import { mulberry32 } from './music.js';
import { DIRS, OPPOSITE } from './levels.js';

// in-place radix-2 FFT (re, im: Float32Array of length n, n power of 2)
function makeFFT(n) {
    const rev = new Uint32Array(n);
    const bits = Math.log2(n);
    for (let i = 0; i < n; i++) {
        let r = 0;
        for (let b = 0; b < bits; b++) r = (r << 1) | ((i >> b) & 1);
        rev[i] = r;
    }
    const cos = new Float32Array(n / 2), sin = new Float32Array(n / 2);
    for (let i = 0; i < n / 2; i++) { cos[i] = Math.cos(-2 * Math.PI * i / n); sin[i] = Math.sin(-2 * Math.PI * i / n); }
    return (re, im) => {
        for (let i = 0; i < n; i++) {
            const j = rev[i];
            if (j > i) { let t = re[i]; re[i] = re[j]; re[j] = t; t = im[i]; im[i] = im[j]; im[j] = t; }
        }
        for (let size = 2; size <= n; size <<= 1) {
            const half = size >> 1, step = n / size;
            for (let i = 0; i < n; i += size) {
                for (let j = 0, k = 0; j < half; j++, k += step) {
                    const a = i + j, b = a + half;
                    const tr = re[b] * cos[k] - im[b] * sin[k];
                    const ti = re[b] * sin[k] + im[b] * cos[k];
                    re[b] = re[a] - tr; im[b] = im[a] - ti;
                    re[a] += tr; im[a] += ti;
                }
            }
        }
    };
}

const tick = () => new Promise(r => setTimeout(r, 0));

export async function analyzeAudio(buffer, onProgress = () => {}) {
    // mono, ~22 kHz
    const sr0 = buffer.sampleRate;
    const dec = sr0 >= 40000 ? 2 : 1;
    const sr = sr0 / dec;
    const ch = [];
    for (let c = 0; c < buffer.numberOfChannels; c++) ch.push(buffer.getChannelData(c));
    const len = Math.floor(buffer.length / dec);
    const x = new Float32Array(len);
    for (let i = 0; i < len; i++) {
        let s = 0;
        for (const d of ch) s += d[i * dec];
        x[i] = s / ch.length;
    }

    const N = 1024, hop = 512;
    const fft = makeFFT(N);
    const win = new Float32Array(N);
    for (let i = 0; i < N; i++) win[i] = 0.5 - 0.5 * Math.cos(2 * Math.PI * i / (N - 1));
    const frames = Math.max(0, Math.floor((len - N) / hop));
    const bandEdges = [0, Math.round(200 / sr * N), Math.round(2000 / sr * N), N / 2];
    const flux = [new Float32Array(frames), new Float32Array(frames), new Float32Array(frames)];
    const re = new Float32Array(N), im = new Float32Array(N);
    let prev = new Float32Array(N / 2), cur = new Float32Array(N / 2);
    for (let f = 0; f < frames; f++) {
        const o = f * hop;
        for (let i = 0; i < N; i++) { re[i] = x[o + i] * win[i]; im[i] = 0; }
        fft(re, im);
        for (let i = 0; i < N / 2; i++) cur[i] = Math.log1p(Math.hypot(re[i], im[i]) * 10);
        for (let b = 0; b < 3; b++) {
            let s = 0;
            for (let i = Math.max(1, bandEdges[b]); i < bandEdges[b + 1]; i++) {
                const d = cur[i] - prev[i];
                if (d > 0) s += d;
            }
            flux[b][f] = s;
        }
        const t = prev; prev = cur; cur = t;
        if (f % 800 === 0) { onProgress(f / frames); await tick(); }
    }

    // normalize bands and combine (weight transients: low end = kicks)
    const total = new Float32Array(frames);
    for (let b = 0; b < 3; b++) {
        let m = 0; for (let i = 0; i < frames; i++) m += flux[b][i];
        m = m / Math.max(1, frames) || 1;
        for (let i = 0; i < frames; i++) { flux[b][i] /= m; total[i] += flux[b][i] * [1.2, 1, 0.8][b]; }
    }

    // adaptive threshold peak picking
    const fps = sr / hop;
    const onsets = [];
    const W = 10, minDist = Math.round(0.06 * fps);
    let last = -1e9;
    for (let i = 1; i < frames - 1; i++) {
        let mean = 0, cnt = 0;
        for (let j = Math.max(0, i - W); j <= Math.min(frames - 1, i + W); j++) { mean += total[j]; cnt++; }
        mean /= cnt;
        const v = total[i];
        if (v > total[i - 1] && v >= total[i + 1] && v > mean * 1.35 + 0.15 && i - last >= minDist) {
            const band = flux[0][i] > flux[2][i] ? (flux[0][i] > flux[1][i] ? 'low' : 'mid') : (flux[2][i] > flux[1][i] ? 'high' : 'mid');
            onsets.push({ t: (i * hop + N / 2) / sr, strength: v - mean, band });
            last = i;
        }
    }

    // tempo by autocorrelation (70–190 BPM, gently preferring ~120)
    let bestLag = 0, bestScore = -1;
    const minLag = Math.floor(fps * 60 / 190), maxLag = Math.ceil(fps * 60 / 70);
    for (let lag = minLag; lag <= maxLag; lag++) {
        let s = 0;
        for (let i = 0; i + lag < frames; i++) s += total[i] * total[i + lag];
        const bpm = 60 * fps / lag;
        s *= Math.exp(-0.5 * Math.pow(Math.log2(bpm / 120) / 0.9, 2));
        if (s > bestScore) { bestScore = s; bestLag = lag; }
    }
    // The lag search only resolves whole frames (±1.5% at 43 fps), so refine
    // with a comb over the whole song: the tempo + phase whose beat grid lands
    // on the most onset energy.
    const env = (t) => {
        const f = t * fps - 0.5;
        const i = Math.floor(f);
        if (i < 0 || i + 1 >= frames) return 0;
        const k = f - i;
        return total[i] * (1 - k) + total[i + 1] * k;
    };
    const coarse = bestLag ? 60 * fps / bestLag : 120;
    let bpm = coarse, phase = 0, bestComb = -1;
    const dur = frames / fps;
    for (let cand = coarse * 0.96; cand <= coarse * 1.04; cand += 0.05) {
        const spb = 60 / cand;
        for (let p = 0; p < 24; p++) {
            const ph = (p / 24) * spb;
            let sc = 0;
            for (let t = ph; t < dur; t += spb) sc += env(t) + 0.5 * env(t + spb / 2);
            sc /= Math.max(1, dur / spb);
            if (sc > bestComb) { bestComb = sc; bpm = cand; phase = ph; }
        }
    }
    bpm = Math.round(bpm * 10) / 10;
    onProgress(1);
    return { onsets, bpm, phase, duration: buffer.duration };
}

// density 1..10 → notes, snapped to 1/4 beats when they're close to the grid
export function autoChart(analysis, density = 5, opts = {}) {
    const rand = mulberry32(opts.seed ?? 99);
    const k = (Math.max(1, Math.min(10, density)) - 1) / 9;
    const bpm = opts.bpm || analysis.bpm;
    const phase = opts.phase ?? analysis.phase;
    const spb = 60 / bpm;
    const minGap = Math.max(spb / 4 * 0.95, 0.6 - k * 0.48);
    const sorted = [...analysis.onsets].sort((a, b) => b.strength - a.strength);
    const keep = sorted.slice(0, Math.max(8, Math.round(sorted.length * (0.18 + k * 0.7))));
    keep.sort((a, b) => a.t - b.t);
    const snap = (t) => {
        const grid = spb / 4;
        const g = Math.round((t - phase) / grid) * grid + phase;
        return Math.abs(g - t) < 0.04 ? g : t;
    };
    const out = [];
    let prev = null, prevPrev = null;
    for (const o of keep) {
        const t = snap(o.t);
        if (t < 1.0) continue;
        if (out.length && t - out[out.length - 1].t < minGap) continue;
        let d;
        if (o.band === 'low' && prev && rand() < 0.4) d = OPPOSITE[prev];
        else {
            const opts2 = DIRS.filter(x => x !== prev || k > 0.6);
            d = opts2[Math.floor(rand() * opts2.length)];
        }
        if (d === prev && prev === prevPrev) d = DIRS[(DIRS.indexOf(d) + 1) % 4];
        out.push({ t: +t.toFixed(4), d });
        prevPrev = prev; prev = d;
    }
    return out;
}
