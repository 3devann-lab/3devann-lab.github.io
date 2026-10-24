// ============ Audio engine: song playback with sample-accurate clock + SFX ============

class AudioEngine {
    constructor() {
        this.ctx = null;
        this.sfxGain = null;
        this.musicGain = null;
        this.buffers = {};       // sfx name -> AudioBuffer
        this.songSource = null;
        this.songBuffer = null;
        this.songStartCtxTime = 0;
        this.songStartOffset = 0; // negative during countdown
        this.playing = false;
        this.onSongEnd = null;
        this._pendingStartTimer = null;
    }

    init() {
        // A context created without a user gesture (e.g. from a gamepad press)
        // starts suspended and its clock never moves — resume it on any later
        // gesture, unless the game paused it on purpose.
        if (this.ctx) {
            if (this.ctx.state === 'suspended' && !this.userPaused) this.ctx.resume();
            return;
        }
        this.ctx = new (window.AudioContext || window.webkitAudioContext)();
        this.musicGain = this.ctx.createGain();
        this.sfxGain = this.ctx.createGain();
        this.musicGain.connect(this.ctx.destination);
        this.sfxGain.connect(this.ctx.destination);
    }

    setVolumes(music, sfx) {
        if (!this.ctx) return;
        this.musicGain.gain.value = music;
        this.sfxGain.gain.value = sfx;
    }

    async loadSfx(name, url) {
        this.init();
        try {
            const res = await fetch(url);
            const ab = await res.arrayBuffer();
            this.buffers[name] = await this.ctx.decodeAudioData(ab);
        } catch (e) {
            console.warn('Failed to load sfx', name, e);
        }
    }

    playSfx(name, volume = 1.0, rate = 1.0) {
        const buf = this.buffers[name];
        if (!buf || !this.ctx) return;
        const src = this.ctx.createBufferSource();
        src.buffer = buf;
        src.playbackRate.value = rate;
        const g = this.ctx.createGain();
        g.gain.value = volume;
        src.connect(g);
        g.connect(this.sfxGain);
        src.start();
    }

    // Soft synthesized note-hit: gentle "tok" thump + airy tick.
    // Much smoother than the old sample and randomized so it never drones.
    playHit(strength = 1.0) {
        if (!this.ctx) return;
        const t = this.ctx.currentTime;
        const out = this.ctx.createGain();
        out.gain.value = 0.5 * strength;
        out.connect(this.sfxGain);

        // body thump: quick pitch-dropping sine
        const detune = 0.94 + Math.random() * 0.12;
        const osc = this.ctx.createOscillator();
        osc.type = 'sine';
        osc.frequency.setValueAtTime(210 * detune, t);
        osc.frequency.exponentialRampToValueAtTime(95 * detune, t + 0.07);
        const og = this.ctx.createGain();
        og.gain.setValueAtTime(0.5, t);
        og.gain.exponentialRampToValueAtTime(0.001, t + 0.09);
        osc.connect(og); og.connect(out);
        osc.start(t); osc.stop(t + 0.1);

        // airy tick: bandpassed noise, very short
        if (!this._noiseBuf) {
            const len = Math.floor(this.ctx.sampleRate * 0.1);
            this._noiseBuf = this.ctx.createBuffer(1, len, this.ctx.sampleRate);
            const d = this._noiseBuf.getChannelData(0);
            for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
        }
        const noise = this.ctx.createBufferSource();
        noise.buffer = this._noiseBuf;
        const bp = this.ctx.createBiquadFilter();
        bp.type = 'bandpass';
        bp.frequency.value = 2600 * detune;
        bp.Q.value = 1.1;
        const ng = this.ctx.createGain();
        ng.gain.setValueAtTime(0.28, t);
        ng.gain.exponentialRampToValueAtTime(0.001, t + 0.055);
        noise.connect(bp); bp.connect(ng); ng.connect(out);
        noise.start(t); noise.stop(t + 0.06);
    }

    // Small synth blip for UI clicks (no asset needed)
    playClick(freq = 660) {
        if (!this.ctx) return;
        const t = this.ctx.currentTime;
        const osc = this.ctx.createOscillator();
        const g = this.ctx.createGain();
        osc.type = 'sine';
        osc.frequency.setValueAtTime(freq, t);
        osc.frequency.exponentialRampToValueAtTime(freq * 0.6, t + 0.08);
        g.gain.setValueAtTime(0.12, t);
        g.gain.exponentialRampToValueAtTime(0.001, t + 0.1);
        osc.connect(g);
        g.connect(this.sfxGain);
        osc.start(t);
        osc.stop(t + 0.12);
    }

    async decode(arrayBuffer) {
        this.init();
        // decodeAudioData detaches the buffer — pass a copy so callers keep theirs
        return await this.ctx.decodeAudioData(arrayBuffer.slice(0));
    }

    // Starts the song clock immediately at `offset` (negative = countdown lead-in).
    // `rate` speeds the song up/down (replays with speed modifiers); the clock
    // stays in song seconds.
    startSong(buffer, offset = -2.0, rate = 1) {
        this.init();
        this.stopSong();
        this.songBuffer = buffer;
        this.songRate = rate > 0 ? rate : 1;
        this.songStartCtxTime = this.ctx.currentTime;
        this.songStartOffset = offset;
        this.playing = true;
        this._scheduleSource(offset);
    }

    _scheduleSource(offset) {
        const src = this.ctx.createBufferSource();
        src.buffer = this.songBuffer;
        src.playbackRate.value = this.songRate;
        src.connect(this.musicGain);
        this.songSource = src;
        src.onended = () => {
            if (this.playing && this.songSource === src) {
                this.playing = false;
                if (this.onSongEnd) this.onSongEnd();
            }
        };
        if (offset < 0) {
            src.start(this.ctx.currentTime - offset / this.songRate, 0);
        } else {
            src.start(this.ctx.currentTime, Math.min(offset, this.songBuffer.duration));
        }
    }

    // Jump to song time `t` (replay seeking); keeps the current rate. Works
    // while paused too: the clock stays at `t` until the context resumes.
    seek(t) {
        if (!this.ctx || !this.songBuffer) return;
        const end = this.songBuffer.duration;
        t = Math.min(t, end - 0.01);
        if (this.songSource) {
            const src = this.songSource;
            this.songSource = null;
            try { src.onended = null; src.stop(); } catch (e) { /* not started yet */ }
        }
        this.songStartCtxTime = this.ctx.currentTime;
        this.songStartOffset = t;
        this.playing = true;
        this._scheduleSource(t);
    }

    // Change playback speed without moving the song clock
    setRate(rate) {
        if (!(rate > 0) || !this.ctx || !this.songBuffer || Math.abs(rate - (this.songRate || 1)) < 1e-4) return;
        const t = this.songTime;
        this.songRate = rate;
        this.seek(t);
    }

    get songTime() {
        if (!this.ctx || !this.playing && this.songSource === null) return 0;
        return this.songStartOffset + (this.ctx.currentTime - this.songStartCtxTime) * (this.songRate || 1);
    }

    get songDuration() { return this.songBuffer ? this.songBuffer.duration : 0; }

    pause() {
        this.userPaused = true;
        if (this.ctx && this.ctx.state === 'running') this.ctx.suspend();
    }

    resume() {
        this.userPaused = false;
        if (this.ctx && this.ctx.state === 'suspended') this.ctx.resume();
    }

    // true when sound is blocked waiting for a click/key (browser autoplay rules)
    get blocked() {
        return !!this.ctx && this.ctx.state !== 'running' && !this.userPaused;
    }

    stopSong() {
        if (this.songSource) {
            const src = this.songSource;
            this.songSource = null;
            this.playing = false;
            try { src.onended = null; src.stop(); } catch (e) { /* not started yet */ }
        }
        this.playing = false;
        this.resume(); // never leave the context suspended
    }
}

export const audio = new AudioEngine();
