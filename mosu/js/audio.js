// ============ MOSU audio: song clock + synthesized SFX ============

class AudioEngine {
    constructor() {
        this.ctx = null;
        this.music = null;
        this.sfx = null;
        this.src = null;
        this.sources = [];
        this.songDuration = 0;
        this.startCtx = 0;
        this.startOffset = 0;
        this.playing = false;
        this.loop = false;
        this.userOffset = 0;        // seconds; positive = notes later (audio arrives late)
        this.onEnded = null;
    }

    init() {
        if (this.ctx) { if (this.ctx.state === 'suspended' && !this.paused) this.ctx.resume(); return; }
        this.ctx = new (window.AudioContext || window.webkitAudioContext)({ latencyHint: 'interactive' });
        this.music = this.ctx.createGain();
        this.sfx = this.ctx.createGain();
        this.music.connect(this.ctx.destination);
        this.sfx.connect(this.ctx.destination);
    }

    setVolumes(music, sfx) {
        this.init();
        this.music.gain.value = music;
        this.sfx.gain.value = sfx;
    }

    async decode(arrayBuffer) {
        this.init();
        return await this.ctx.decodeAudioData(arrayBuffer.slice(0));
    }

    // src: an AudioBuffer, or {parts: [{buffer, at}], duration, pending} for a song
    // whose later parts are still rendering (add them with addPart).
    // offset < 0 = lead-in seconds before the song starts.
    start(src, offset = -1.5, loop = false) {
        this.init();
        this.stop();
        const parts = src.parts ? src.parts : [{ buffer: src, at: 0 }];
        this.songDuration = src.duration ?? parts[0].buffer.duration;
        this.loop = loop;
        this.paused = false;
        if (this.ctx.state === 'suspended') this.ctx.resume();
        this.startCtx = this.ctx.currentTime + 0.05;      // tiny scheduling margin
        this.startOffset = offset;
        this.sources = [];
        this.playing = true;
        parts.forEach((p, i) => this._schedule(p.buffer, p.at, !src.pending && i === parts.length - 1));
    }

    // schedule a buffer so it plays when song time reaches `at`
    _schedule(buffer, at, last) {
        const src = this.ctx.createBufferSource();
        src.buffer = buffer;
        src.loop = this.loop;
        src.connect(this.music);
        const when = this.startCtx + (at - this.startOffset);
        const now = this.ctx.currentTime;
        if (when >= now) src.start(when, 0);
        else {
            const into = now - when;                       // arrived late: join in sync
            if (!this.loop && into >= buffer.duration) return;
            src.start(now, this.loop ? into % buffer.duration : into);
        }
        if (last) {
            src.onended = () => {
                if (this.sources.includes(src) && this.playing) {
                    this.playing = false;
                    if (this.onEnded) this.onEnded();
                }
            };
        }
        this.sources.push(src);
        this.src = src;
    }

    addPart(buffer, at) {
        if (!this.playing || !this.sources.length) return;
        this._schedule(buffer, at, true);
    }

    // Output latency: what you HEAR lags ctx.currentTime by this much
    get latency() {
        if (!this.ctx) return 0;
        return (this.ctx.outputLatency || 0) + (this.ctx.baseLatency || 0);
    }

    // Song time as heard, in seconds
    get time() {
        if (!this.ctx || !this.sources || !this.sources.length) return 0;
        return this.startOffset + (this.ctx.currentTime - this.startCtx) - this.latency - this.userOffset;
    }

    // Song time at a DOM event timestamp (performance.now() ms) — judging presses
    // by when they happened, not when the next frame ran
    timeAt(eventMs) {
        const lag = (performance.now() - eventMs) / 1000;
        return this.time - Math.max(0, Math.min(0.25, lag));
    }

    get duration() { return this.songDuration || 0; }

    pause() {
        this.paused = true;
        if (this.ctx && this.ctx.state === 'running') this.ctx.suspend();
    }

    resume() {
        this.paused = false;
        if (this.ctx && this.ctx.state === 'suspended') this.ctx.resume();
    }

    stop() {
        for (const s of (this.sources || [])) {
            try { s.onended = null; s.stop(); } catch (e) { /* not started */ }
        }
        this.sources = [];
        this.src = null;
        this.playing = false;
        this.paused = false;
        if (this.ctx && this.ctx.state === 'suspended') this.ctx.resume();
    }

    // ---------- synthesized SFX ----------
    _blip(freq, endFreq, dur, vol, type = 'sine', when = 0) {
        if (!this.ctx) return;
        const t = this.ctx.currentTime + when;
        const o = this.ctx.createOscillator(), g = this.ctx.createGain();
        o.type = type;
        o.frequency.setValueAtTime(freq, t);
        o.frequency.exponentialRampToValueAtTime(Math.max(30, endFreq), t + dur);
        g.gain.setValueAtTime(vol, t);
        g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
        o.connect(g); g.connect(this.sfx);
        o.start(t); o.stop(t + dur + 0.02);
    }

    hit(kind) {
        if (!this.ctx) return;
        if (kind === 'perfect') { this._blip(1320, 990, 0.07, 0.16, 'triangle'); this._blip(2640, 2000, 0.04, 0.05, 'sine'); }
        else if (kind === 'great') this._blip(1100, 880, 0.07, 0.14, 'triangle');
        else this._blip(880, 660, 0.07, 0.12, 'triangle');
    }

    holdTick() { this._blip(1760, 1500, 0.03, 0.04, 'sine'); }

    miss() { this._blip(180, 70, 0.18, 0.22, 'sawtooth'); }

    click(freq = 660) { this._blip(freq, freq * 0.6, 0.09, 0.12, 'sine'); }

    tick(accent = false, when = 0) { this._blip(accent ? 1500 : 1000, accent ? 1200 : 800, 0.05, 0.3, 'square', when); }
}

export const audio = new AudioEngine();
