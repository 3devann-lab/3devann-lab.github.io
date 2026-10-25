// ============ A multiplayer match: shared start, live scores, the other players ============
import { mp } from './multiplayer.js';
import { RemotePlayers, saberPose } from './remote.js';
import { settings } from '../settings.js';
import { audio } from '../audio.js';
import { esc } from '../ui.js';

const POSE_EVERY = 100;      // ms (10 per second)
const LIVE_EVERY = 500;

export class Match {
    constructor(menu, game) {
        this.menu = menu;
        this.game = game;
        this.round = game.round;
        this.live = {};
        this.subs = [];
        this.gp = null;
        this.remote = null;
        this.board = null;
        this.finished = false;
        this.result = null;
        this._pose = 0;
        this._live = 0;
        this.onLiveChange = null;     // results screen listens here
        this.names = {};
        for (const uid of game.players || []) {
            const m = mp.lobby && mp.lobby.members && mp.lobby.members[uid];
            this.names[uid] = (m && m.name) || 'Player';
        }
    }

    // song time right now on the shared clock (seconds; negative = countdown)
    songTimeNow() {
        const speed = Math.max(0.5, Math.min(2, Number(this.game.mods && this.game.mods.speed) || 1));
        return ((mp.serverNow() - this.game.startAt) / 1000) * speed;
    }

    // the level is running: show the others and start sending ours
    attach(gp) {
        this.gp = gp;
        const others = (this.game.players || []).filter(u => u !== mp.uid).map(uid => ({ uid, name: this.names[uid] }));
        this.remote = new RemotePlayers(this.menu.engine.scene, [settings.get('leftColor') || '#ff2d55', settings.get('rightColor') || '#2d7dff']);
        this.remote.setPlayers(others);
        this.subs.push(mp.watchLive((v) => this.onLive(v)));
        this.subs.push(mp.watchPoses((v) => {
            const cur = {};
            for (const [uid, p] of Object.entries(v)) if (p && p.round === this.round && uid !== mp.uid) cur[uid] = p;
            if (this.remote) this.remote.pushPoses(cur);
        }));
        this.board = document.createElement('div');
        this.board.id = 'mp-board';
        document.body.appendChild(this.board);
        this.renderBoard();
    }

    onLive(v) {
        this.live = {};
        for (const [uid, e] of Object.entries(v || {})) if (e && e.round === this.round) this.live[uid] = e;
        this.renderBoard();
        if (this.remote) {
            const scores = {};
            for (const [uid, e] of Object.entries(this.live)) scores[uid] = e.left ? 'left' : e.failed ? 'failed' : (e.score || 0).toLocaleString();
            this.remote.setScores(scores);
        }
        if (this.onLiveChange) this.onLiveChange(this.ranking());
    }

    // everyone in the match, best first (finished scores, then live ones)
    ranking() {
        const rows = (this.game.players || []).map((uid) => {
            const e = this.live[uid] || {};
            const mine = uid === mp.uid;
            const r = mine && this.result ? { ...e, ...this.result, done: true } : e;
            return {
                uid, me: mine, name: this.names[uid] || r.name || 'Player',
                score: r.score || 0, acc: r.acc ?? 1, combo: r.combo || 0, maxCombo: r.maxCombo || 0, misses: r.misses || 0,
                rank: r.rank || '', done: !!r.done, failed: !!r.failed, left: !!r.left, fullCombo: !!r.fullCombo,
                progress: r.progress || 0, started: !!this.live[uid] || (mine && !!this.gp),
            };
        });
        return rows.sort((a, b) => (b.left ? -1 : 0) - (a.left ? -1 : 0) || b.score - a.score);
    }

    renderBoard() {
        if (!this.board) return;
        const rows = this.ranking();
        const html = `<div class="mp-board-title">MATCH · ${rows.length} PLAYER${rows.length > 1 ? 'S' : ''}</div>` + rows.map((r, i) => `
            <div class="mp-board-row ${r.me ? 'me' : ''} ${r.failed || r.left ? 'out' : ''}">
                <span class="mp-pos">${i + 1}</span><span class="mp-name">${esc(r.name)}</span>
                <span class="mp-score">${r.left ? 'left' : r.failed ? 'failed' : r.score.toLocaleString()}</span>
                <span class="mp-acc">${r.started ? (r.acc * 100).toFixed(1) + '%' : '—'}</span>
            </div>`).join('');
        if (html !== this._boardHtml) { this._boardHtml = html; this.board.innerHTML = html; }
    }

    // per frame while the level runs
    update() {
        const gp = this.gp;
        if (!gp) return;
        const now = performance.now();
        if (!gp.finished && !this.finished) {
            if (now - this._pose >= POSE_EVERY) {
                this._pose = now;
                mp.pushPose({ round: this.round, t: mp.serverNow(), l: saberPose(gp.saberLeft), r: saberPose(gp.saberRight) });
            }
            if (now - this._live >= LIVE_EVERY) {
                this._live = now;
                const dur = audio.songDuration || 1;
                mp.pushLive({
                    round: this.round, score: gp.score, combo: gp.combo, acc: Math.round(gp.accuracy * 10000) / 10000,
                    misses: gp.misses, failed: !!gp.failed, done: false,
                    progress: Math.max(0, Math.min(1, Math.round(((audio.songTime || 0) / dur) * 1000) / 1000)),
                }).catch(() => {});
                // keep my own row fresh between server round trips
                this.live[mp.uid] = { ...(this.live[mp.uid] || {}), score: gp.score, acc: gp.accuracy, combo: gp.combo, round: this.round };
                this.renderBoard();
            }
        }
        if (this.remote) this.remote.update(mp.serverNow());
    }

    // my song ended (or I failed)
    finish(results) {
        this.finished = true;
        this.result = {
            score: results.score, acc: Math.round(results.accuracy * 10000) / 10000, rank: results.failed ? 'F' : results.rank,
            maxCombo: results.maxCombo, misses: results.misses, failed: !!results.failed, fullCombo: !!results.fullCombo, done: true,
        };
        mp.pushLive({ round: this.round, ...this.result, combo: 0, progress: 1 }).catch(() => {});
        this.endGameplayBits();
    }

    // left before the end
    leave() {
        if (!this.finished) mp.pushLive({ round: this.round, score: this.gp ? this.gp.score : 0, acc: this.gp ? this.gp.accuracy : 0, done: true, left: true }).catch(() => {});
        this.finished = true;
        this.stop();
    }

    endGameplayBits() {
        if (this.remote) { this.remote.dispose(); this.remote = null; }
        if (this.board) { this.board.remove(); this.board = null; }
        this.gp = null;
    }

    stop() {
        this.endGameplayBits();
        for (const u of this.subs) { try { u(); } catch (e) { /* gone */ } }
        this.subs = [];
        this.onLiveChange = null;
    }
}
