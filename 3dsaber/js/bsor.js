// ============ BeatLeader open replay (.bsor) decoder ============
// Format spec: https://github.com/BeatLeader/BS-Open-Replay
// Pure JS (no DOM) so it can be tested headlessly.

const MAGIC = 0x442d3d69;

export const NOTE_EVENT = { GOOD: 0, BAD: 1, MISS: 2, BOMB: 3 };

class Reader {
    constructor(buffer) {
        this.view = new DataView(buffer);
        this.bytes = new Uint8Array(buffer);
        this.p = 0;
        this.utf8 = new TextDecoder('utf-8');
    }
    get left() { return this.view.byteLength - this.p; }
    byte() { return this.view.getUint8(this.p++); }
    bool() { return this.view.getUint8(this.p++) !== 0; }
    int() { const v = this.view.getInt32(this.p, true); this.p += 4; return v; }
    long() {
        const lo = this.view.getUint32(this.p, true), hi = this.view.getInt32(this.p + 4, true);
        this.p += 8;
        return hi * 4294967296 + lo;
    }
    float() { const v = this.view.getFloat32(this.p, true); this.p += 4; return v; }
    vec3() { return [this.float(), this.float(), this.float()]; }
    quat() { return [this.float(), this.float(), this.float(), this.float()]; }
    raw(len) {
        const s = this.utf8.decode(this.bytes.subarray(this.p, this.p + len));
        this.p += len;
        return s;
    }
    string() {
        // Some old replays have a stray byte before a string; skip forward
        // until the length prefix is sane, like BeatLeader's own decoder.
        for (let tries = 0; tries < 16; tries++) {
            const len = this.view.getInt32(this.p, true);
            if (len >= 0 && len <= 300 && len + 4 <= this.left) {
                this.p += 4;
                return this.raw(len);
            }
            this.p++;
        }
        throw new Error('bad string');
    }
    // Player names were sometimes written with a UTF-16 length instead of a
    // byte length; the next field (platform) has length 5, 6 or 8, so extend
    // the name until that lines up.
    name() {
        const len = this.int();
        let extra = 0;
        if (len > 0) {
            const at = (k) => (this.p + len + k + 4 <= this.view.byteLength ? this.view.getInt32(this.p + len + k, true) : -1);
            let found = false;
            for (let k = 0; k < 64; k++) {
                const v = at(k);
                if (v === 5 || v === 6 || v === 8) { extra = k; found = true; break; }
            }
            if (!found) extra = 0;
        }
        return this.raw(Math.max(0, Math.min(len + extra, this.left)));
    }
}

function readInfo(r) {
    const info = {
        modVersion: r.string(),
        gameVersion: r.string(),
        timestamp: r.string(),
        playerID: r.string(),
        playerName: r.name(),
        platform: r.string(),
        trackingSystem: r.string(),
        hmd: r.string(),
        controller: r.string(),
        hash: r.string(),
        songName: r.string(),
        mapper: r.string(),
        difficulty: r.string(),
        score: r.int(),
        mode: r.string(),
        environment: r.string(),
        modifiers: r.string(),
        jumpDistance: r.float(),
        leftHanded: r.bool(),
        height: r.float(),
        startTime: r.float(),
        failTime: r.float(),
        speed: r.float(),
    };
    return info;
}

// Frames are stored as one flat Float32Array (time, headPos, headRot, leftPos,
// leftRot, rightPos, rightRot) = 22 floats per frame — compact and cache friendly.
export const FRAME_STRIDE = 22;

function readFrames(r) {
    const count = r.int();
    const data = new Float32Array(count * FRAME_STRIDE);
    for (let i = 0; i < count; i++) {
        const o = i * FRAME_STRIDE;
        data[o] = r.float();
        r.int();                                  // fps (unused)
        for (let k = 1; k < FRAME_STRIDE; k++) data[o + k] = r.float();
    }
    return { count, data };
}

function readNotes(r) {
    const count = r.int();
    const notes = new Array(count);
    for (let i = 0; i < count; i++) {
        const ev = {
            noteID: r.int(),
            eventTime: r.float(),
            spawnTime: r.float(),
            eventType: r.int(),
            cut: null,
        };
        if (ev.eventType === NOTE_EVENT.GOOD || ev.eventType === NOTE_EVENT.BAD) {
            ev.cut = {
                speedOK: r.bool(),
                directionOK: r.bool(),
                saberTypeOK: r.bool(),
                wasCutTooSoon: r.bool(),
                saberSpeed: r.float(),
                saberDir: r.vec3(),
                saberType: r.int(),
                timeDeviation: r.float(),
                cutDirDeviation: r.float(),
                cutPoint: r.vec3(),
                cutNormal: r.vec3(),
                cutDistanceToCenter: r.float(),
                cutAngle: r.float(),
                beforeCutRating: r.float(),
                afterCutRating: r.float(),
            };
        }
        notes[i] = ev;
    }
    return notes;
}

function readWalls(r) {
    const count = r.int();
    const walls = new Array(count);
    for (let i = 0; i < count; i++) {
        walls[i] = { wallID: r.int(), energy: r.float(), time: r.float(), spawnTime: r.float() };
    }
    return walls;
}

function readHeights(r) {
    const count = r.int();
    const out = new Array(count);
    for (let i = 0; i < count; i++) out[i] = { height: r.float(), time: r.float() };
    return out;
}

function readPauses(r) {
    const count = r.int();
    const out = new Array(count);
    for (let i = 0; i < count; i++) out[i] = { duration: r.long(), time: r.float() };
    return out;
}

export function decodeBsor(buffer) {
    const r = new Reader(buffer);
    if (r.view.byteLength < 6 || r.int() !== MAGIC) throw new Error('Not a BeatLeader replay (.bsor)');
    const version = r.byte();
    const replay = { version, info: null, frames: null, notes: [], walls: [], heights: [], pauses: [] };

    // Sections are tagged by a type byte; stop gracefully on unknown/truncated data
    while (r.left > 0) {
        const type = r.byte();
        try {
            if (type === 0) replay.info = readInfo(r);
            else if (type === 1) replay.frames = readFrames(r);
            else if (type === 2) replay.notes = readNotes(r);
            else if (type === 3) replay.walls = readWalls(r);
            else if (type === 4) replay.heights = readHeights(r);
            else if (type === 5) replay.pauses = readPauses(r);
            else break;    // controller offsets / user data — not needed for playback
        } catch (e) {
            if (type <= 2) throw new Error('Replay file is truncated or corrupted');
            break;
        }
    }
    if (!replay.info || !replay.frames || !replay.frames.count) throw new Error('Replay has no movement data');
    return replay;
}

// ---------- Note identity ----------
// BeatLeader noteID = (scoringType+2)*10000 + lineIndex*1000 + lineLayer*100 + colorType*10 + cutDirection
// (bombs use colorType -1 and cutDirection 9; old replays have no scoringType part).
// scoringType: 1 normal, 2 arc head, 3 arc tail, 4 chain head, 5 chain link,
// 6 arc head+tail, 7 chain head+arc tail, 8 chain link+arc head.
export function splitNoteId(id) {
    if (id >= 10000) {
        const hi = Math.floor(id / 10000);
        return { scoringType: hi - 2, local: id - hi * 10000 };
    }
    return { scoringType: 1, local: id };
}

export function noteLocalId(x, y, color, dir) {
    return x * 1000 + y * 100 + color * 10 + dir;
}

// Score for a good cut using the game's rating values (Beat Saber scoring)
// Unity's Mathf.RoundToInt rounds halves to even
function roundToInt(v) {
    const f = Math.floor(v), d = v - f;
    if (d > 0.5) return f + 1;
    if (d < 0.5) return f;
    return f % 2 === 0 ? f : f + 1;
}

// A good cut's points split the Beat Saber way: pre-swing (70), accuracy (15),
// post-swing (30). Arcs grant swing parts; chain links are a flat 20.
export function cutParts(cut, scoringType) {
    const clamp01 = (v) => Math.max(0, Math.min(1, v || 0));
    if (scoringType === 5 || scoringType === 8) return { pre: 0, acc: 0, post: 0, total: 20, fixed: true };
    let pre = roundToInt(70 * clamp01(cut.beforeCutRating));
    let post = roundToInt(30 * clamp01(cut.afterCutRating));
    const acc = roundToInt(15 * (1 - clamp01(cut.cutDistanceToCenter / 0.3)));
    switch (scoringType) {
        case 2: post = 30; break;               // arc head: post-swing granted
        case 3: pre = 70; break;                // arc tail: pre-swing granted
        case 4: case 7: post = 0; break;        // chain head (max 85)
        case 6: pre = 70; post = 30; break;     // arc head + tail
    }
    return { pre, acc, post, total: pre + acc + post, fixed: false };
}

export function cutScore(cut, scoringType) {
    return cutParts(cut, scoringType).total;
}

export function maxCutScore(scoringType) {
    if (scoringType === 4 || scoringType === 7) return 85;
    if (scoringType === 5 || scoringType === 8) return 20;
    return 115;
}

// Song speed from modifiers / practice speed
export function replaySpeed(info) {
    if (info.speed && info.speed > 0.01 && Math.abs(info.speed - 1) > 0.001) return info.speed;
    const mods = (info.modifiers || '').split(',').map(s => s.trim().toUpperCase());
    if (mods.includes('SF')) return 1.5;
    if (mods.includes('FS')) return 1.2;
    if (mods.includes('SS')) return 0.85;
    return 1;
}

export function replayModifiers(info) {
    return (info.modifiers || '').split(',').map(s => s.trim().toUpperCase()).filter(Boolean);
}

// ---------- Match replay note events to parsed map objects ----------
// Events carry the note's song time (spawnTime) and its base lane/layer/color/
// direction; greedily pair each event with the closest unclaimed map object.
// Returns { noteEvents: Map(noteObj -> event), bombEvents: Map(bombObj -> event), unmatched }
export function matchReplay(replay, mapData) {
    const noteEvents = new Map();
    const bombEvents = new Map();
    let unmatched = 0;

    const real = (arr) => arr.filter(o => !o.decorative).sort((a, b) => a.time - b.time);
    const notes = real(mapData.notes);
    const bombs = real(mapData.bombs);

    const pair = (events, objs, out, scoreFn) => {
        const used = new Uint8Array(objs.length);
        let lo = 0;
        const sorted = [...events].sort((a, b) => a.spawnTime - b.spawnTime);
        for (const ev of sorted) {
            const t = ev.spawnTime;
            while (lo < objs.length && objs[lo].time < t - 0.25) lo++;
            let best = -1, bestCost = Infinity;
            for (let i = lo; i < objs.length && objs[i].time <= t + 0.25; i++) {
                if (used[i]) continue;
                const dt = Math.abs(objs[i].time - t);
                const cost = dt * 1000 + scoreFn(objs[i], ev);
                if (cost < bestCost) { bestCost = cost; best = i; }
            }
            if (best >= 0 && bestCost < 400) {
                used[best] = 1;
                out.set(objs[best], ev);
            } else {
                unmatched++;
            }
        }
    };

    const noteEvs = replay.notes.filter(e => e.eventType !== NOTE_EVENT.BOMB);
    const bombEvs = replay.notes.filter(e => e.eventType === NOTE_EVENT.BOMB);

    pair(noteEvs, notes, noteEvents, (n, ev) => {
        const { local } = splitNoteId(ev.noteID);
        const color = Math.floor(((local % 100) + 100) % 100 / 10);
        const x = Math.floor(local / 1000), y = Math.floor((local % 1000) / 100);
        let cost = 0;
        if (n.color !== color) cost += 300;            // wrong color is almost never right
        if (!n.chainLink) {
            if (Math.round(n.lx ?? n.x) !== x) cost += 40;
            if (Math.round(n.ly ?? n.y) !== y) cost += 40;
            if (n.dir !== local % 10) cost += 10;
        }
        return cost;
    });
    pair(bombEvs, bombs, bombEvents, (b, ev) => {
        // bomb ids are x*1000 + y*100 - 1 (colorType -1, cutDirection 9)
        const local = splitNoteId(ev.noteID).local + 1;
        const x = Math.floor(local / 1000), y = Math.floor((local % 1000) / 100);
        return (Math.round(b.lx ?? b.x) !== x ? 40 : 0) + (Math.round(b.ly ?? b.y) !== y ? 40 : 0);
    });

    return { noteEvents, bombEvents, unmatched };
}
