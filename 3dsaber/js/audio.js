// ============ Audio engine: song playback with sample-accurate clock + SFX ============

// What kind of audio file is this? (from its first bytes)
export function sniffAudio(ab) {
    const b = new Uint8Array(ab, 0, Math.min(12, ab.byteLength));
    const str = (i, n) => String.fromCharCode(...b.slice(i, i + n));
    if (b.length < 4) return { kind: 'empty', mime: '' };
    if (str(0, 4) === 'OggS') return { kind: 'Ogg', mime: 'audio/ogg' };
    if (str(0, 3) === 'ID3' || (b[0] === 0xff && (b[1] & 0xe0) === 0xe0)) return { kind: 'MP3', mime: 'audio/mpeg' };
    if (str(0, 4) === 'RIFF') return { kind: 'WAV', mime: 'audio/wav' };
    if (str(0, 4) === 'fLaC') return { kind: 'FLAC', mime: 'audio/flac' };
    if (str(4, 4) === 'ftyp') return { kind: 'M4A', mime: 'audio/mp4' };
    if (b[0] === 0x1a && b[1] === 0x45 && b[2] === 0xdf && b[3] === 0xa3) return { kind: 'WebM', mime: 'audio/webm' };
    if (str(0, 1) === '<') return { kind: 'web page', mime: '' };
    return { kind: 'unknown', mime: '' };
}

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
            // a streamed song the browser refused to start without a click: try again now
            const sb = this.songBuffer;
            if (this._mediaBlocked && sb && sb.isMedia && this.playing && !this.userPaused) this._playMedia(sb.el);
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

    /**
     * Song audio, as robustly as the browser allows:
     * 1. decode it fully (sample-accurate clock),
     * 2. if that fails — often not enough memory for a long song — decode at a
     *    lower sample rate (about a third less memory),
     * 3. if that fails too, stream it through an <audio> element (almost no
     *    memory; the clock follows the element).
     * Returns an AudioBuffer or a streamed song ({isMedia, duration, ...}).
     */
    async decode(arrayBuffer, { allowStream = true } = {}) {
        this.init();
        const fmt = sniffAudio(arrayBuffer);
        if (fmt.kind === 'empty' || fmt.kind === 'web page') {
            throw new Error(`the song file is ${fmt.kind === 'empty' ? 'empty' : 'not audio (a web page)'} — try deleting and re-downloading the map`);
        }
        const errors = [];
        // A long song decoded at full rate is 150–250 MB, enough to crash a tab
        // on a device short on memory: decode those at 32 kHz straight away
        // (a third less memory, no audible difference in a game)
        const lowMem = arrayBuffer.byteLength > 12e6 || (navigator.deviceMemory && navigator.deviceMemory <= 4);
        const at32k = async () => new OfflineAudioContext(2, 1, 32000).decodeAudioData(arrayBuffer.slice(0));
        if (lowMem) { try { return await at32k(); } catch (e) { errors.push(e); } }
        // decodeAudioData detaches the buffer — pass a copy so callers keep theirs
        try { return await this.ctx.decodeAudioData(arrayBuffer.slice(0)); } catch (e) { errors.push(e); }
        if (!lowMem) { try { return await at32k(); } catch (e) { errors.push(e); } }
        if (allowStream) {
            try { return await this.streamSong(arrayBuffer, fmt.mime); } catch (e) { errors.push(e); }
        }
        console.error('Song decode failed', fmt.kind, errors);
        const hint = fmt.kind === 'Ogg'
            ? 'this browser can\'t play Ogg audio (most Beat Saber songs) — use Chrome, Edge or Firefox'
            : `the ${fmt.kind} song file may be damaged — try deleting and re-downloading the map`;
        throw new Error('Couldn\'t decode the song audio: ' + hint);
    }

    // Stream a song through an <audio> element (used when decoding isn't possible)
    async streamSong(arrayBuffer, mime) {
        const url = URL.createObjectURL(new Blob([arrayBuffer], mime ? { type: mime } : {}));
        const el = new Audio();
        el.preload = 'auto';
        el.preservesPitch = false;          // speed changes behave like the decoded path
        el.mozPreservesPitch = false;
        el.webkitPreservesPitch = false;
        try {
            await new Promise((resolve, reject) => {
                const timer = setTimeout(() => reject(new Error('timed out loading the song')), 20000);
                el.oncanplaythrough = () => { clearTimeout(timer); resolve(); };
                el.onerror = () => { clearTimeout(timer); reject(new Error('the browser can\'t play this audio file')); };
                el.src = url;
                el.load();
            });
        } catch (e) {
            URL.revokeObjectURL(url);
            throw e;
        }
        el.oncanplaythrough = null;
        const node = this.ctx.createMediaElementSource(el);
        node.connect(this.musicGain);
        return {
            isMedia: true, el, duration: el.duration,
            release() {
                el.pause();
                node.disconnect();
                el.removeAttribute('src');
                el.load();
                URL.revokeObjectURL(url);
            },
        };
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
        if (this.songBuffer.isMedia) { this._scheduleMedia(offset); return; }
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

    // Streamed song: the element plays from `offset`; a negative offset (the
    // lead-in) is counted on the context clock and the element starts at 0.
    _scheduleMedia(offset) {
        const el = this.songBuffer.el;
        el.playbackRate = this.songRate;
        el.onended = () => {
            if (this.playing && this.songBuffer && this.songBuffer.el === el) {
                this.playing = false;
                if (this.onSongEnd) this.onSongEnd();
            }
        };
        el.pause();
        el.currentTime = Math.max(0, Math.min(offset, (el.duration || 1) - 0.01));
        this._mediaWaiting = offset < 0;
        this._est = null;
        if (!this._mediaWaiting && !this.userPaused) this._playMedia(el);
    }

    // Jump to song time `t` (replay seeking); keeps the current rate. Works
    // while paused too: the clock stays at `t` until the context resumes.
    seek(t) {
        if (!this.ctx || !this.songBuffer) return;
        const end = this.songBuffer.duration;
        t = Math.min(t, end - 0.01);
        if (this.songBuffer.isMedia) {
            this.songStartCtxTime = this.ctx.currentTime;
            this.songStartOffset = t;
            this.playing = true;
            this._scheduleMedia(t);
            return;
        }
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
        if (this.songBuffer.isMedia && !this._mediaWaiting) {
            this.songBuffer.el.playbackRate = rate;
            this.songStartCtxTime = this.ctx.currentTime;
            this.songStartOffset = t;
            return;
        }
        this.seek(t);
    }

    get songTime() {
        const sb = this.songBuffer;
        if (sb && sb.isMedia && this.ctx) return this._mediaTime(sb.el);
        if (!this.ctx || !this.playing && this.songSource === null) return 0;
        return this.songStartOffset + (this.ctx.currentTime - this.songStartCtxTime) * (this.songRate || 1);
    }

    _mediaTime(el) {
        if (this._mediaWaiting) {
            const t = this.songStartOffset + (this.ctx.currentTime - this.songStartCtxTime) * (this.songRate || 1);
            if (t < 0 || !this.playing) return t;
            this._mediaWaiting = false;                 // lead-in over: start the music
            el.currentTime = 0;
            if (!this.userPaused) this._playMedia(el);
            return t;
        }
        // the element's clock moves in small steps; glide between them
        const now = performance.now() / 1000, raw = el.currentTime;
        if (el.paused || this._est == null) { this._est = raw; this._estAt = now; return raw; }
        let est = this._est + (now - this._estAt) * el.playbackRate;
        est = Math.abs(raw - est) > 0.08 ? raw : est + (raw - est) * 0.08;
        this._est = est; this._estAt = now;
        return est;
    }

    // drop the last song so its memory can be reclaimed
    forgetSong() {
        this.stopSong();
        this.songBuffer = null;
    }

    get songDuration() { return this.songBuffer ? this.songBuffer.duration : 0; }

    pause() {
        this.userPaused = true;
        if (this.ctx && this.ctx.state === 'running') this.ctx.suspend();
        const sb = this.songBuffer;
        if (sb && sb.isMedia) sb.el.pause();
    }

    resume() {
        this.userPaused = false;
        if (this.ctx && this.ctx.state === 'suspended') this.ctx.resume();
        const sb = this.songBuffer;
        if (sb && sb.isMedia && this.playing && !this._mediaWaiting && sb.el.paused) this._playMedia(sb.el);
    }

    // true when sound is blocked waiting for a click/key (browser autoplay rules)
    get blocked() {
        return (!!this.ctx && this.ctx.state !== 'running' && !this.userPaused) || !!this._mediaBlocked;
    }

    _playMedia(el) {
        el.play().then(() => { this._mediaBlocked = false; }).catch(() => { this._mediaBlocked = true; });
    }

    stopSong() {
        const sb = this.songBuffer;
        if (sb && sb.isMedia) { sb.el.onended = null; sb.el.pause(); this._mediaWaiting = false; }
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
