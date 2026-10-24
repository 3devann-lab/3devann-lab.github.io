// ============ Menu system: screens, BeatSaver browser, replays, pause/results ============
import { audio } from './audio.js';
import { gamepad, cursor } from './input.js';
import { settings, getHighScore, setHighScore, getBestScores, CAMERA_KEYS } from './settings.js';
import {
    searchMaps, downloadMap, getSavedMaps, getSavedMap, deleteSavedMap,
    getSavedIds, findSavedByHash, getMapByHash, mapAvailable, isDownloadableHash,
} from './beatsaver.js';
import { parseDifficulty } from './beatmap.js';
import { generateBuiltinBeatmap, BUILTIN_SONG } from './builtin.js';
import { Gameplay } from './game.js';
import { decodeBsor, matchReplay, replaySpeed, replayModifiers } from './bsor.js';
import {
    searchPlayers, getPlayerScores, searchLevels, getLeaderboard, getReplayUrl,
    getScoreById, fetchReplay, parseReplayLink, countryFlag,
    BeatLeaderUnreachable, liveScores, scoreMatches, testProxy, normalizeProxyUrl,
} from './beatleader.js';
import { ReplayControls } from './replayui.js';
import {
    toast, esc, fmt, settingBuilders, PLAY_CAMERA_ROWS, FIRST_PERSON_ROWS, FOLLOW_ROWS, REPLAY_VIEW_ROWS,
} from './ui.js';

export { toast };

const $ = (id) => document.getElementById(id);

function fmtDuration(sec) {
    if (!sec) return '';
    const m = Math.floor(sec / 60), s = Math.floor(sec % 60);
    return `${m}:${String(s).padStart(2, '0')}`;
}

function fmtDate(unix) {
    if (!unix) return '';
    const d = new Date(unix * 1000);
    const days = Math.floor((Date.now() - d.getTime()) / 86400000);
    if (days < 1) return 'today';
    if (days < 2) return 'yesterday';
    if (days < 30) return `${days} days ago`;
    return d.toLocaleDateString();
}

const DIFF_LABEL = { Easy: 'Easy', Normal: 'Normal', Hard: 'Hard', Expert: 'Expert', ExpertPlus: 'Expert+' };
const MODE_ALIASES = {
    Standard: ['Standard'], OneSaber: ['OneSaber'], NoArrows: ['NoArrows'],
    '90Degree': ['90Degree'], '360Degree': ['360Degree'], Lawless: ['Lawless'], Lightshow: ['Lightshow'],
};

export class Menu {
    constructor(engine) {
        this.engine = engine;
        this.root = $('ui-root');
        this.gameplay = null;
        this.currentLevel = null;   // remembered for retry
        this.builtinBuffer = null;
        this.audioCache = null;     // { id, buffer } — last decoded song (retries are instant)
        this.browseState = { query: '', sort: 'Rating', page: 0 };
        this.replayUi = {
            // without a proxy, search depends on flaky public relays; the live feed always works
            tab: settings.get('blProxy') ? 'players' : 'live', playerQuery: '', players: null, player: null,
            scoreQuery: '', scoreSort: 'date', scorePage: 1,
            levelQuery: '', levels: null, level: null, lb: null, lbPage: 1,
            liveFilter: '',
        };
        this.objectUrls = [];

        gamepad.on('connect', () => {
            this.updateControllerChip();
            const ps = gamepad.isPlayStation;
            $('hint-confirm').textContent = ps ? '✕' : 'A';
            $('hint-back').textContent = ps ? '○' : 'B';
            toast(`Controller connected${ps ? ' (PlayStation)' : ''}`, 'success');
        });
        gamepad.on('disconnect', () => {
            this.updateControllerChip();
            toast('Controller disconnected', 'error');
            if (this.gameplay && !this.gameplay.replay && !this.gameplay.paused && !this.gameplay.finished) this.pauseGame();
        });

        window.addEventListener('keydown', (e) => {
            if (e.target && e.target.matches && e.target.matches('input[type="text"], input[type="search"], input[type="url"]')) return;
            const gp = this.gameplay;
            if (!gp || gp.finished || gp.replay) return;      // replays: ReplayControls has the keys
            if (e.key === 'Escape') {
                e.preventDefault();
                gp.paused ? this.resumeGame() : this.pauseGame();
            }
        });

        // pause automatically when the tab is hidden (audio clock keeps running otherwise)
        document.addEventListener('visibilitychange', () => {
            if (document.hidden && this.gameplay && !this.gameplay.paused && !this.gameplay.finished) this.pauseGame();
        });

        // click sounds for all UI buttons
        this.root.addEventListener('click', (e) => {
            if (e.target.closest('button, .btn, .song-row, .toggle, .diff-btn')) audio.playClick();
        });
    }

    // free cover-image blob URLs (and live-feed listeners) from the previous screen
    setScreen(html) {
        if (this._cleanup) { this._cleanup(); this._cleanup = null; }
        for (const u of this.objectUrls) URL.revokeObjectURL(u);
        this.objectUrls = [];
        this.root.innerHTML = html;
    }

    updateControllerChip() {
        const chip = $('controller-chip');
        if (!chip) return;
        chip.classList.toggle('connected', gamepad.connected);
        chip.querySelector('span:last-child').textContent =
            gamepad.connected ? (gamepad.isPlayStation ? 'PlayStation controller' : 'Controller ready') : 'Connect a controller';
    }

    enterMenuMode(backFn = null) {
        cursor.speed = settings.get('cursorSpeed');
        cursor.enable();
        cursor.onBack = backFn;
        $('hint-bar').classList.toggle('hidden', !gamepad.connected);
    }

    // ============ HOME ============
    showHome() {
        this.setScreen(`
        <div class="screen">
            <div id="controller-chip"><span class="dot"></span><span>Connect a controller</span></div>
            <h1 id="title">SABER//3D</h1>
            <div id="subtitle">Rhythm · Slash · Flow</div>
            <div class="menu-buttons">
                <button class="btn primary" id="btn-play">Play</button>
                <button class="btn" id="btn-custom">Custom Levels</button>
                <button class="btn" id="btn-replays">Replays</button>
                <button class="btn" id="btn-settings">Settings</button>
            </div>
        </div>`);
        this.updateControllerChip();
        this.enterMenuMode(null);
        $('btn-play').onclick = () => this.showSongs();
        $('btn-custom').onclick = () => this.showBrowse();
        $('btn-replays').onclick = () => this.showReplays();
        $('btn-settings').onclick = () => this.showSettings();
    }

    // ============ SONG LIST (Play) ============
    async showSongs() {
        this.setScreen(`
        <div class="screen panel-screen">
            <div class="panel">
                <div class="panel-header">
                    <div class="panel-title">SELECT SONG</div>
                    <button class="btn small" id="btn-back">← Back</button>
                </div>
                <div class="panel-body" id="song-list"><div class="loading-spinner"></div></div>
            </div>
        </div>`);
        this.enterMenuMode(() => this.showHome());
        $('btn-back').onclick = () => this.showHome();

        const list = $('song-list');
        const saved = await getSavedMaps().catch(() => []);
        if (!list.isConnected) return;
        list.innerHTML = '';
        const best = getBestScores();

        // Built-in track
        list.appendChild(this.songRow({
            cover: null,
            name: BUILTIN_SONG.songName,
            artist: BUILTIN_SONG.songAuthor,
            mapper: BUILTIN_SONG.mapper,
            badges: '<span class="badge builtin">Built-in</span>',
            best: best.get(BUILTIN_SONG.id),
            onClick: () => this.showDifficultyModal(BUILTIN_SONG, null),
        }));

        for (const rec of saved) {
            let coverUrl = rec.meta?.coverURL || null;
            if (rec.coverBlob) { coverUrl = URL.createObjectURL(rec.coverBlob); this.objectUrls.push(coverUrl); }
            const badges =
                (rec.meta?.hasChroma ? '<span class="badge chroma">Chroma</span>' : '') +
                (rec.meta?.hasNoodle ? '<span class="badge noodle">Noodle</span>' : '');
            list.appendChild(this.songRow({
                cover: coverUrl,
                name: rec.info.songName,
                artist: rec.info.songAuthor,
                mapper: rec.info.levelAuthor || rec.meta?.mapper || '',
                badges,
                best: best.get(rec.id),
                onClick: () => this.showDifficultyModal(null, rec),
                onDelete: async () => {
                    await deleteSavedMap(rec.id);
                    if (this.audioCache && this.audioCache.id === rec.id) this.audioCache = null;
                    toast('Map deleted');
                    this.showSongs();
                },
            }));
        }

        if (saved.length === 0) {
            const hint = document.createElement('div');
            hint.className = 'browse-msg';
            hint.innerHTML = 'Download more songs in <b>Custom Levels</b> — thousands of community maps from BeatSaver.';
            list.appendChild(hint);
        }
    }

    songRow({ cover, name, artist, mapper, badges, best, onClick, onDelete }) {
        const row = document.createElement('div');
        row.className = 'song-row';
        row.innerHTML = `
            ${cover ? `<img class="song-cover" src="${esc(cover)}" alt="" loading="lazy">` : '<div class="song-cover"></div>'}
            <div class="song-meta">
                <div class="song-name">${esc(name)}</div>
                <div class="song-artist">${esc(artist)}</div>
                <div class="song-mapper">${esc(mapper)}</div>
            </div>
            <div class="song-right">
                <div class="badges">${badges || ''}</div>
                ${best ? `<div class="song-hs">Best <b>${best.score.toLocaleString()}</b> · ${esc(best.rank)}</div>` : ''}
                ${onDelete ? '<button class="btn small danger row-delete">Delete</button>' : ''}
            </div>`;
        row.onclick = (e) => {
            if (e.target.closest('.row-delete')) return;
            onClick();
        };
        if (onDelete) row.querySelector('.row-delete').onclick = (e) => { e.stopPropagation(); onDelete(); };
        return row;
    }

    // ============ DIFFICULTY MODAL ============
    showDifficultyModal(builtinSong, record) {
        const info = builtinSong || record.info;
        const diffs = info.difficulties;
        const chars = [...new Set(diffs.map(d => d.characteristic))];
        let activeChar = chars.includes('Standard') ? 'Standard' : chars[0];

        const backdrop = document.createElement('div');
        backdrop.className = 'modal-backdrop';
        const render = () => {
            const list = diffs.filter(d => d.characteristic === activeChar);
            backdrop.innerHTML = `
            <div class="modal">
                <h2>${esc(info.songName)}</h2>
                <div class="sub">${esc(info.songAuthor)}${info.levelAuthor ? ' · mapped by ' + esc(info.levelAuthor) : ''}</div>
                ${chars.length > 1 ? `<div class="char-tabs">${chars.map(c =>
                    `<button class="sort-btn ${c === activeChar ? 'active' : ''}" data-char="${esc(c)}">${esc(c)}</button>`).join('')}</div>` : ''}
                <div class="diff-list">
                    ${list.map((d, i) => {
                        const hs = getHighScore(builtinSong ? builtinSong.id : record.id, d.characteristic, d.difficulty);
                        return `<button class="diff-btn diff-${esc(d.difficulty)}" data-i="${i}">
                            <span>${esc(d.label || d.difficulty)}</span>
                            <span class="diff-stats">NJS ${esc(d.njs)}${hs ? ` · Best ${hs.score.toLocaleString()} (${esc(hs.rank)})` : ''}</span>
                        </button>`;
                    }).join('')}
                </div>
                <button class="btn small modal-close">Cancel</button>
            </div>`;
            backdrop.querySelectorAll('[data-char]').forEach(b => {
                b.onclick = () => { activeChar = b.dataset.char; render(); };
            });
            backdrop.querySelectorAll('.diff-btn').forEach(b => {
                b.onclick = () => {
                    const d = list[Number(b.dataset.i)];
                    backdrop.remove();
                    audio.playClick(880);
                    this.startLevel(builtinSong, record, d);
                };
            });
        };
        render();
        const prevBack = cursor.onBack;
        const close = () => { backdrop.remove(); cursor.onBack = prevBack; };
        backdrop.addEventListener('click', (e) => {
            if (e.target === backdrop || e.target.closest('.modal-close')) close();
        });
        document.body.appendChild(backdrop);
        cursor.onBack = close;
    }

    async decodeSong(record) {
        if (this.audioCache && this.audioCache.id === record.id) return this.audioCache.buffer;
        const buffer = await audio.decode(record.songBuf);
        this.audioCache = { id: record.id, buffer };
        return buffer;
    }

    // ============ START / END LEVEL ============
    async startLevel(builtinSong, record, diff, replayCtx = null) {
        if (!replayCtx && !gamepad.connected) {
            toast('Connect a controller to play — sabers are the thumbsticks', 'error');
            return;
        }
        this.setScreen('<div class="screen"><div class="loading-spinner"></div></div>');
        try {
            let mapData, songBuffer, songName, bpm, mapId;

            if (builtinSong) {
                if (!this.builtinBuffer) {
                    const res = await fetch('background_music.mp3');
                    this.builtinBuffer = await audio.decode(await res.arrayBuffer());
                }
                songBuffer = this.builtinBuffer;
                mapData = generateBuiltinBeatmap(songBuffer.duration, diff.difficulty);
                mapData.customEvents = []; mapData.environment = [];
                songName = `${BUILTIN_SONG.songName} — ${BUILTIN_SONG.songAuthor}`;
                bpm = BUILTIN_SONG.bpm;
                mapId = BUILTIN_SONG.id;
            } else {
                songBuffer = await this.decodeSong(record);
                const raw = record.diffFiles[diff.filename];
                if (!raw) throw new Error('Difficulty file missing from download');
                const lightshow = diff.lightshowFilename ? record.diffFiles[diff.lightshowFilename] : null;
                mapData = parseDifficulty(raw, record.info.bpm, lightshow, record.diffFiles.__bpm || null);
                songName = `${record.info.songName} — ${record.info.songAuthor}`;
                bpm = record.info.bpm;
                mapId = record.id;
            }

            let replay = null;
            if (replayCtx) {
                const data = replayCtx.data;
                const match = matchReplay(data, mapData);
                if (match.noteEvents.size === 0 && data.notes.length > 0) {
                    throw new Error('Replay does not match this map version');
                }
                replay = {
                    data, match,
                    playerName: replayCtx.playerName || data.info.playerName,
                    speed: replaySpeed(data.info),
                    mods: replayModifiers(data.info),
                };
            }

            this.currentLevel = { builtinSong, record, diff, replayCtx };
            this.setScreen('');
            cursor.disable();
            $('hint-bar').classList.add('hidden');
            $('hud').classList.remove('hidden');

            this.gameplay = new Gameplay(this.engine, mapData, songBuffer, {
                songName,
                njs: diff.njs,
                offsetBeats: diff.offset,
                bpm,
                mapId,
                replay,
                onEnd: (results) => this.endLevel(results, mapId, diff),
            });
            this.engine.gameplay = this.gameplay;
            if (replay) this.replayControls = new ReplayControls(this, this.gameplay);
            this.checkAudioUnlocked();
        } catch (err) {
            console.error(err);
            toast('Failed to start level: ' + err.message, 'error');
            this.abortGameplay();
            if (replayCtx) this.showReplays(); else this.showSongs();
        }
    }

    // Browsers only allow sound after a click/key/touch — a gamepad press
    // doesn't count. The song clock is the audio clock, so without this the
    // level sat on "READY" forever. Ask for one click if needed.
    checkAudioUnlocked() {
        setTimeout(() => {
            if (!this.gameplay || !audio.blocked) return;
            const el = document.createElement('div');
            el.className = 'modal-backdrop';
            el.innerHTML = `<div class="modal" style="text-align:center"><h2>Click or press any key</h2>
                <div class="sub" style="margin:8px 0 0">Your browser needs one click or key press before it can play sound.</div></div>`;
            document.body.appendChild(el);
            const go = () => {
                window.removeEventListener('pointerdown', go, true);
                window.removeEventListener('keydown', go, true);
                audio.resume();
                el.remove();
            };
            window.addEventListener('pointerdown', go, true);
            window.addEventListener('keydown', go, true);
        }, 400);
    }

    endLevel(results, mapId, diff) {
        const isReplay = !!results.replay;
        const isNewBest = !isReplay && !results.failed && setHighScore(mapId, diff.characteristic, diff.difficulty, results);
        this.engine.gameplay = null;
        this.closeReplayControls();
        if (this.gameplay) { this.gameplay.destroy(); this.gameplay = null; }
        $('hud').classList.add('hidden');
        this.showResults(results, isNewBest);
    }

    showResults(r, isNewBest) {
        const rc = this.currentLevel && this.currentLevel.replayCtx;
        const who = rc ? esc(rc.playerName || rc.data.info.playerName || 'Player') : '';
        this.setScreen(`
        <div class="screen">
            <div class="modal" style="width:min(520px,92vw)">
                ${rc ? `<div class="result-kicker">REPLAY · ${who}</div>` : ''}
                ${r.failed
                    ? '<div class="result-title failed">LEVEL FAILED</div>'
                    : `<div class="result-rank">${esc(r.rank)}</div>
                       <div class="result-title">${r.fullCombo ? 'FULL COMBO!' : 'LEVEL CLEARED'}</div>`}
                <div class="result-grid">
                    <div class="result-stat"><div class="val ${isNewBest ? 'new-hs' : ''}">${r.score.toLocaleString()}</div><div class="lbl">${isNewBest ? 'New Best!' : 'Score'}</div></div>
                    <div class="result-stat"><div class="val">${(r.accuracy * 100).toFixed(rc ? 2 : 1)}%</div><div class="lbl">Accuracy</div></div>
                    <div class="result-stat"><div class="val">${r.maxCombo}</div><div class="lbl">Max Combo</div></div>
                    <div class="result-stat"><div class="val">${r.hits} / ${r.hits + r.misses}</div><div class="lbl">Notes Hit</div></div>
                </div>
                <div class="menu-buttons" style="width:100%">
                    <button class="btn primary" id="btn-retry">${rc ? 'Watch Again' : 'Retry'}</button>
                    <button class="btn" id="btn-continue">${rc ? 'Back to Replays' : 'Song Select'}</button>
                    <button class="btn" id="btn-home">Main Menu</button>
                </div>
            </div>
        </div>`);
        this.enterMenuMode(() => (rc ? this.showReplays() : this.showSongs()));
        $('btn-retry').onclick = () => {
            const { builtinSong, record, diff, replayCtx } = this.currentLevel;
            this.startLevel(builtinSong, record, diff, replayCtx);
        };
        $('btn-continue').onclick = () => (rc ? this.showReplays() : this.showSongs());
        $('btn-home').onclick = () => this.showHome();
    }

    // ============ PAUSE ============
    pauseGame() {
        if (!this.gameplay || this.gameplay.finished) return;
        const gp = this.gameplay;
        gp.pause();
        if (gp.replay && this.replayControls) {
            // replays pause in place: the picture stays, the bar and free camera still work
            this.replayControls.setPaused(true);
            cursor.speed = settings.get('cursorSpeed');
            cursor.enable();
            cursor.onBack = () => this.resumeGame();
            return;
        }
        this.setScreen(`
        <div class="screen">
            <div class="modal" style="width:min(400px,90vw)">
                <div class="result-title">PAUSED</div>
                <div class="menu-buttons" style="width:100%">
                    <button class="btn primary" id="btn-resume">Resume</button>
                    <button class="btn" id="btn-camera">Camera</button>
                    <button class="btn" id="btn-restart">Restart</button>
                    <button class="btn danger" id="btn-quit">Quit to Menu</button>
                </div>
            </div>
        </div>`);
        this.enterMenuMode(() => this.resumeGame());
        $('btn-resume').onclick = () => this.resumeGame();
        $('btn-camera').onclick = () => this.showPauseCamera();
        $('btn-restart').onclick = () => {
            this.abortGameplay();
            const { builtinSong, record, diff, replayCtx } = this.currentLevel;
            this.startLevel(builtinSong, record, diff, replayCtx);
        };
        $('btn-quit').onclick = () => {
            this.abortGameplay();
            this.showHome();
        };
    }

    // camera options from the pause menu — the paused frame updates as you drag
    showPauseCamera() {
        this.setScreen(`
        <div class="screen pause-camera">
            <div class="panel" style="max-width:560px;max-height:min(640px,90vh)">
                <div class="panel-header">
                    <div class="panel-title">CAMERA</div>
                    <button class="btn small" id="btn-back">← Back</button>
                </div>
                <div class="panel-body" id="cam-body"></div>
            </div>
        </div>`);
        this.enterMenuMode(() => this.pauseGame());
        $('btn-back').onclick = () => this.pauseGame();
        const b = settingBuilders($('cam-body'), (k) => this.applySettingChange(k));
        b.section('Play camera', 'Where you watch your sabers from', () => {
            settings.reset(['camFov', 'camHeight', 'camDistance', 'camTilt']);
            this.engine.applyCameraSettings();
            this.showPauseCamera();
        });
        b.rows(PLAY_CAMERA_ROWS);
        b.rows(REPLAY_VIEW_ROWS.filter(r => r[1] === 'trailLength'));
    }

    // live effects of a settings change (Settings screen and pause menu)
    applySettingChange(key) {
        const v = settings.get(key);
        if (CAMERA_KEYS.includes(key)) this.engine.applyCameraSettings();
        else if (key === 'trailLength' || key.startsWith('replay')) { if (this.gameplay) this.gameplay.applyReplaySettings(); }
        else if (key === 'musicVolume' || key === 'sfxVolume') audio.setVolumes(settings.get('musicVolume'), settings.get('sfxVolume'));
        else if (key === 'cursorSpeed') cursor.speed = v;
        else if (key === 'bloomStrength') this.engine.setBloomStrength(v);
        else if (key === 'bloom') this.engine.setBloom(v);
        else if (key === 'quality') this.engine.setQuality(v);
    }

    resumeGame() {
        if (!this.gameplay) return;
        if (this.replayControls) this.replayControls.setPaused(false);
        else this.setScreen('');
        cursor.disable();
        $('hint-bar').classList.add('hidden');
        this.gameplay.resume();
    }

    quitReplay() {
        this.abortGameplay();
        this.showReplays();
    }

    closeReplayControls() {
        if (this.replayControls) { this.replayControls.destroy(); this.replayControls = null; }
    }

    abortGameplay() {
        this.closeReplayControls();
        if (this.gameplay) {
            audio.resume();
            this.gameplay.destroy();
            this.gameplay = null;
        }
        this.engine.gameplay = null;
        $('hud').classList.add('hidden');
        $('countdown').classList.add('hidden');
    }

    // ============ CUSTOM LEVELS (BeatSaver) ============
    showBrowse() {
        const st = this.browseState;
        this.setScreen(`
        <div class="screen panel-screen">
            <div class="panel">
                <div class="panel-header">
                    <div class="panel-title">CUSTOM LEVELS</div>
                    <div class="browse-controls">
                        <input class="search-box" id="search-input" type="text"
                               placeholder="Search BeatSaver… (song, artist, mapper)" value="${esc(st.query)}">
                        <button class="sort-btn ${st.sort === 'Rating' ? 'active' : ''}" data-sort="Rating">Top Rated</button>
                        <button class="sort-btn ${st.sort === 'Latest' ? 'active' : ''}" data-sort="Latest">Latest</button>
                        <button class="sort-btn ${st.sort === 'Relevance' ? 'active' : ''}" data-sort="Relevance">Relevance</button>
                    </div>
                    <button class="btn small" id="btn-back">← Back</button>
                </div>
                <div class="panel-body" id="browse-results"><div class="loading-spinner"></div></div>
            </div>
        </div>`);
        this.enterMenuMode(() => this.showHome());
        $('btn-back').onclick = () => this.showHome();

        const input = $('search-input');
        input.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') {
                st.query = input.value;
                st.page = 0;
                this.loadBrowseResults();
            }
        });
        this.root.querySelectorAll('[data-sort]').forEach(b => {
            b.onclick = () => {
                st.sort = b.dataset.sort;
                st.page = 0;
                this.root.querySelectorAll('[data-sort]').forEach(x => x.classList.toggle('active', x === b));
                this.loadBrowseResults();
            };
        });

        this.loadBrowseResults();
    }

    async loadBrowseResults() {
        const st = this.browseState;
        const box = $('browse-results');
        if (!box) return;
        box.innerHTML = '<div class="loading-spinner"></div>';
        try {
            const [maps, savedIds] = await Promise.all([
                searchMaps({ query: st.query, page: st.page, sort: st.sort }),
                getSavedIds().catch(() => new Set()),
            ]);
            if (!box.isConnected) return;
            if (maps.length === 0) {
                box.innerHTML = '<div class="browse-msg">No maps found. Try a different search.</div>';
                return;
            }
            box.innerHTML = '<div class="map-grid"></div>' + `
                <div class="pager">
                    ${st.page > 0 ? '<button class="btn small" id="pg-prev">← Prev</button>' : ''}
                    <button class="btn small" id="pg-next">Next →</button>
                </div>`;
            const grid = box.querySelector('.map-grid');
            for (const m of maps) grid.appendChild(this.mapCard(m, savedIds.has(m.id)));
            const prev = $('pg-prev'), next = $('pg-next');
            if (prev) prev.onclick = () => { st.page--; this.loadBrowseResults(); box.scrollTop = 0; };
            if (next) next.onclick = () => { st.page++; this.loadBrowseResults(); box.scrollTop = 0; };
        } catch (err) {
            console.error(err);
            box.innerHTML = `<div class="browse-msg">Couldn't reach BeatSaver.<br><small>${esc(err.message)}</small></div>`;
        }
    }

    mapCard(m, saved) {
        const card = document.createElement('div');
        card.className = 'map-card';
        const diffNames = [...new Set(m.diffs.map(d => d.difficulty))];
        card.innerHTML = `
            <div class="map-card-top">
                <img class="song-cover" src="${esc(m.coverURL || '')}" loading="lazy" alt="">
                <div class="map-card-info">
                    <div class="map-card-name" title="${esc(m.name)}">${esc(m.songName)}</div>
                    <div class="map-card-author">${esc(m.songAuthor)}</div>
                    <div class="map-card-mapper">${esc(m.mapper)}</div>
                    <div class="map-card-stats">
                        <span class="up">▲ ${m.upvotes}</span>
                        <span>${fmtDuration(m.duration)}</span>
                        <span>${diffNames.length} diff${diffNames.length !== 1 ? 's' : ''}</span>
                    </div>
                </div>
            </div>
            <div class="map-card-bottom">
                <div class="badges">
                    ${m.hasChroma ? '<span class="badge chroma">Chroma</span>' : ''}
                    ${m.hasNoodle ? '<span class="badge noodle">Noodle</span>' : ''}
                </div>
                <button class="dl-btn">Download</button>
            </div>`;

        const btn = card.querySelector('.dl-btn');
        if (saved) this.markDownloaded(btn, m.id);
        else {
            btn.onclick = async () => {
                btn.disabled = true;
                const bottom = card.querySelector('.map-card-bottom');
                const bar = document.createElement('div');
                bar.className = 'dl-progress';
                bar.innerHTML = '<div class="dl-progress-fill"></div>';
                bottom.insertBefore(bar, btn);
                const fill = bar.querySelector('.dl-progress-fill');
                try {
                    await downloadMap(m, (p, label) => {
                        fill.style.width = (p * 100) + '%';
                        btn.textContent = label;
                    });
                    bar.remove();
                    this.markDownloaded(btn, m.id);
                    toast(`"${m.songName}" downloaded`, 'success');
                    audio.playClick(990);
                } catch (err) {
                    console.error(err);
                    bar.remove();
                    btn.disabled = false;
                    btn.textContent = 'Retry';
                    toast('Download failed: ' + err.message, 'error');
                }
            };
        }
        return card;
    }

    markDownloaded(btn, mapId) {
        btn.disabled = false;
        btn.textContent = 'Play ▶';
        btn.classList.add('downloaded');
        btn.onclick = async () => {
            const rec = await getSavedMap(mapId);
            if (rec) this.showDifficultyModal(null, rec);
        };
    }

    // ============ REPLAYS (BeatLeader) ============
    showReplays(tab = null) {
        const ui = this.replayUi;
        if (tab) ui.tab = tab;
        const tabBtn = (id, label) => `<button class="sort-btn ${ui.tab === id ? 'active' : ''}" data-tab="${id}">${label}</button>`;
        this.setScreen(`
        <div class="screen panel-screen">
            <div class="panel">
                <div class="panel-header">
                    <div class="panel-title">REPLAYS</div>
                    <div class="browse-controls tabs">
                        ${tabBtn('live', '● Live')}
                        ${tabBtn('players', 'Players')}
                        ${tabBtn('levels', 'Levels')}
                        ${tabBtn('file', 'File / Link')}
                    </div>
                    <button class="btn small" id="btn-back">← Back</button>
                </div>
                <div class="panel-subheader" id="replay-controls"></div>
                <div class="panel-body" id="replay-body"></div>
            </div>
        </div>`);
        $('btn-back').onclick = () => this.replayBack();
        this.enterMenuMode(() => this.replayBack());
        this.root.querySelectorAll('[data-tab]').forEach(b => {
            b.onclick = () => {
                ui.tab = b.dataset.tab;
                ui.player = null; ui.lb = null;
                this.showReplays();
            };
        });
        if (ui.tab === 'live') this.renderLive();
        else if (ui.tab === 'players') ui.player ? this.renderPlayerScores() : this.renderPlayerSearch();
        else if (ui.tab === 'levels') ui.lb ? this.renderLeaderboard() : this.renderLevelSearch();
        else this.renderReplayFile();
    }

    replayBack() {
        const ui = this.replayUi;
        if (ui.tab === 'players' && ui.player) { ui.player = null; this.showReplays(); }
        else if (ui.tab === 'levels' && ui.lb) { ui.lb = null; this.showReplays(); }
        else this.showHome();
    }

    searchBar(id, placeholder, value, onSearch, extra = '') {
        const box = $('replay-controls');
        box.innerHTML = `
            <input class="search-box" id="${id}" type="text" placeholder="${esc(placeholder)}" value="${esc(value)}">
            <button class="sort-btn" id="${id}-go">Search</button>
            ${extra}`;
        const input = $(id);
        const go = () => onSearch(input.value);
        input.addEventListener('keydown', (e) => { if (e.key === 'Enter') go(); });
        $(`${id}-go`).onclick = go;
        return input;
    }

    // spinner that explains the wait when requests go through a public relay
    loadingInto(box) {
        box.innerHTML = `<div class="loading-spinner"></div><div class="browse-msg small-msg" id="slow-hint"></div>`;
        clearTimeout(this._slowTimer);
        this._slowTimer = setTimeout(() => {
            const h = $('slow-hint');
            if (h) h.textContent = settings.get('blProxy')
                ? 'Waiting for your proxy…'
                : 'Going through a public relay — this can take up to ~15 seconds. (Set up the free proxy in Settings to make it instant.)';
        }, 2500);
    }

    // query: what the person searched for, so we can offer to watch for it live
    blError(box, err, { query = '', retry = null } = {}) {
        console.error(err, err.details || '');
        clearTimeout(this._slowTimer);
        if (!(err instanceof BeatLeaderUnreachable)) {
            box.innerHTML = `<div class="browse-msg">${esc(err.message)}
                ${retry ? '<br><br><button class="btn small" id="err-retry">Try again</button>' : ''}</div>`;
            if (retry) $('err-retry').onclick = retry;
            return;
        }
        const details = err.details && err.details.length
            ? `<details class="err-details"><summary>What was tried</summary>${err.details.map(esc).join('<br>')}</details>` : '';
        box.innerHTML = `<div class="browse-msg">${esc(err.message)}${details}
            <div class="err-actions">
                <button class="btn small primary" id="err-live">Watch live replays</button>
                ${query ? `<button class="btn small" id="err-follow">Wait for “${esc(query)}” in the live feed</button>` : ''}
                ${retry ? '<button class="btn small" id="err-retry">Try again</button>' : ''}
                <button class="btn small" id="err-file">Open a replay file / link</button>
                <button class="btn small" id="err-settings">Set up the free proxy</button>
            </div>
            <small>The live feed and replay files always work, no setup needed.</small></div>`;
        $('err-live').onclick = () => { this.replayUi.liveFilter = ''; this.showReplays('live'); };
        if (query) $('err-follow').onclick = () => { this.replayUi.liveFilter = query; this.showReplays('live'); };
        if (retry) $('err-retry').onclick = retry;
        $('err-file').onclick = () => this.showReplays('file');
        $('err-settings').onclick = () => this.showSettings();
    }

    // --- players ---
    renderPlayerSearch() {
        const ui = this.replayUi;
        const body = $('replay-body');
        const run = async (q) => {
            ui.playerQuery = q;
            if (!q.trim()) { ui.players = null; return this.renderPlayerList(); }
            this.loadingInto(body);
            try {
                const r = await searchPlayers(q);
                ui.players = r.players;
                if (body.isConnected) this.renderPlayerList();
            } catch (err) { if (body.isConnected) this.blError(body, err, { query: q, retry: () => run(q) }); }
        };
        const input = this.searchBar('player-search', 'Search a BeatLeader username…', ui.playerQuery, run);
        this.renderPlayerList();
        if (!ui.playerQuery) setTimeout(() => input.focus(), 50);
    }

    renderPlayerList() {
        const ui = this.replayUi;
        const body = $('replay-body');
        if (!ui.players) {
            body.innerHTML = `<div class="browse-msg">Search for a player to browse their scores and watch their replays.<br>
                <small>Replays come from BeatLeader. Every score with a replay can be watched right here, played back with the real swings.</small></div>`;
            return;
        }
        if (!ui.players.length) { body.innerHTML = '<div class="browse-msg">No players found.</div>'; return; }
        body.innerHTML = '<div class="player-grid"></div>';
        const grid = body.firstChild;
        for (const p of ui.players) {
            const card = document.createElement('div');
            card.className = 'map-card player-card';
            card.innerHTML = `
                ${p.avatar ? `<img class="avatar" src="${esc(p.avatar)}" alt="" loading="lazy">` : '<div class="avatar"></div>'}
                <div class="player-info">
                    <div class="map-card-name">${esc(p.name)}</div>
                    <div class="map-card-author">${countryFlag(p.country)} ${esc(p.country)} · #${p.rank.toLocaleString()}</div>
                    <div class="map-card-mapper">${Math.round(p.pp).toLocaleString()} pp</div>
                </div>`;
            card.onclick = () => {
                ui.player = p; ui.scoreQuery = ''; ui.scorePage = 1;
                this.showReplays();
            };
            grid.appendChild(card);
        }
    }

    renderPlayerScores() {
        const ui = this.replayUi;
        const p = ui.player;
        const sorts = [['date', 'Recent'], ['pp', 'Top PP'], ['acc', 'Accuracy']];
        const extra = sorts.map(([id, label]) =>
            `<button class="sort-btn ${ui.scoreSort === id ? 'active' : ''}" data-ssort="${id}">${label}</button>`).join('');
        this.searchBar('score-search', `Search ${p.name}'s levels…`, ui.scoreQuery, (q) => {
            ui.scoreQuery = q; ui.scorePage = 1; this.loadPlayerScores();
        }, extra);
        $('replay-controls').insertAdjacentHTML('afterbegin', `
            <div class="player-chip">${p.avatar ? `<img src="${esc(p.avatar)}" alt="">` : ''}<span>${esc(p.name)}</span></div>`);
        this.root.querySelectorAll('[data-ssort]').forEach(b => {
            b.onclick = () => {
                ui.scoreSort = b.dataset.ssort; ui.scorePage = 1;
                this.root.querySelectorAll('[data-ssort]').forEach(x => x.classList.toggle('active', x === b));
                this.loadPlayerScores();
            };
        });
        this.loadPlayerScores();
    }

    async loadPlayerScores() {
        const ui = this.replayUi;
        const body = $('replay-body');
        if (!body) return;
        this.loadingInto(body);
        try {
            const r = await getPlayerScores(ui.player, { search: ui.scoreQuery, sortBy: ui.scoreSort, page: ui.scorePage });
            if (!body.isConnected) return;
            if (!r.scores.length) {
                body.innerHTML = `<div class="browse-msg">${ui.scoreQuery ? 'No scores match that search.' : 'This player has no scores yet.'}</div>`;
                return;
            }
            this.renderScoreList(body, r.scores, { showSong: true }, r.total, ui.scorePage, (pg) => { ui.scorePage = pg; this.loadPlayerScores(); });
        } catch (err) { if (body.isConnected) this.blError(body, err, { query: ui.player.name, retry: () => this.loadPlayerScores() }); }
    }

    // --- levels ---
    renderLevelSearch() {
        const ui = this.replayUi;
        const body = $('replay-body');
        const run = async (q) => {
            ui.levelQuery = q;
            if (!q.trim()) { ui.levels = null; return this.renderLevelList(); }
            this.loadingInto(body);
            try {
                const r = await searchLevels(q);
                ui.levels = r.levels;
                if (body.isConnected) this.renderLevelList();
            } catch (err) { if (body.isConnected) this.blError(body, err, { query: q, retry: () => run(q) }); }
        };
        const input = this.searchBar('level-search', 'Search levels (song, artist, mapper)…', ui.levelQuery, run);
        this.renderLevelList();
        if (!ui.levelQuery) setTimeout(() => input.focus(), 50);
    }

    renderLevelList() {
        const ui = this.replayUi;
        const body = $('replay-body');
        if (!ui.levels) {
            body.innerHTML = '<div class="browse-msg">Search for a level, pick a difficulty and watch the top players\' replays.</div>';
            return;
        }
        if (!ui.levels.length) { body.innerHTML = '<div class="browse-msg">No levels found.</div>'; return; }
        body.innerHTML = '<div class="map-grid"></div>';
        const grid = body.firstChild;
        for (const lv of ui.levels) {
            const card = document.createElement('div');
            card.className = 'map-card level-card';
            card.innerHTML = `
                <div class="map-card-top">
                    <img class="song-cover" src="${esc(lv.song.cover)}" loading="lazy" alt="">
                    <div class="map-card-info">
                        <div class="map-card-name">${esc(lv.song.name)}</div>
                        <div class="map-card-author">${esc(lv.song.author)}</div>
                        <div class="map-card-mapper">${esc(lv.song.mapper)}</div>
                    </div>
                </div>
                <div class="diff-chips">${lv.diffs.map((d, i) => `
                    <button class="diff-chip diff-${esc(d.name)}" data-d="${i}" title="${d.plays} plays">
                        ${d.mode !== 'Standard' ? esc(d.mode) + ' ' : ''}${esc(DIFF_LABEL[d.name] || d.name)}${d.stars ? ` ★${d.stars.toFixed(1)}` : ''}
                    </button>`).join('')}</div>`;
            card.querySelectorAll('[data-d]').forEach(b => {
                b.onclick = () => {
                    ui.level = lv; ui.lb = lv.diffs[Number(b.dataset.d)]; ui.lbPage = 1;
                    this.showReplays();
                };
            });
            grid.appendChild(card);
        }
    }

    renderLeaderboard() {
        const ui = this.replayUi;
        const ctl = $('replay-controls');
        ctl.innerHTML = `<div class="player-chip">${ui.level.song.cover ? `<img src="${esc(ui.level.song.cover)}" alt="">` : ''}
            <span>${esc(ui.level.song.name)} · <b class="diff-${esc(ui.lb.name)}">${esc(DIFF_LABEL[ui.lb.name] || ui.lb.name)}</b></span></div>`;
        this.loadLeaderboard();
    }

    async loadLeaderboard() {
        const ui = this.replayUi;
        const body = $('replay-body');
        if (!body) return;
        this.loadingInto(body);
        try {
            const r = await getLeaderboard(ui.lb.id, ui.lbPage);
            if (!body.isConnected) return;
            if (!r.scores.length) { body.innerHTML = '<div class="browse-msg">No scores on this difficulty yet.</div>'; return; }
            this.renderScoreList(body, r.scores, { showPlayer: true }, r.total, ui.lbPage, (pg) => { ui.lbPage = pg; this.loadLeaderboard(); });
        } catch (err) { if (body.isConnected) this.blError(body, err, { query: ui.level.song.name, retry: () => this.loadLeaderboard() }); }
    }

    // one score row; live rows show both who played and what they played
    scoreRow(s, { showSong = false, showPlayer = false, live = false } = {}) {
        const row = document.createElement('div');
        row.className = 'song-row score-row' + (live ? ' live-in' : '');
        const diff = `<span class="diff-chip static diff-${esc(s.diff.name)}">${s.diff.mode !== 'Standard' ? esc(s.diff.mode) + ' ' : ''}${esc(DIFF_LABEL[s.diff.name] || s.diff.name)}</span>`;
        const avatar = s.playerAvatar ? `<img class="avatar small" src="${esc(s.playerAvatar)}" alt="" loading="lazy">` : '<div class="avatar small"></div>';
        let left, title, line2, line3;
        if (live) {
            left = avatar;
            title = `${esc(s.playerName)} <span class="live-song">· ${esc(s.song.name)}</span>`;
            line2 = `${diff} ${[s.song.author && esc(s.song.author), s.modifiers && `<span class="mods">${esc(s.modifiers)}</span>`].filter(Boolean).join(' · ')}`;
            line3 = 'just now';
        } else {
            left = showPlayer ? `<div class="score-rank">#${s.rank}</div>${avatar}` : `<img class="song-cover" src="${esc(s.song.cover)}" alt="" loading="lazy">`;
            title = showPlayer ? esc(s.playerName) : esc(s.song.name);
            line2 = `${showSong ? esc(s.song.author) + ' · ' : ''}${diff} ${s.modifiers ? `<span class="mods">${esc(s.modifiers)}</span>` : ''}`;
            line3 = `${showSong ? 'mapped by ' + esc(s.song.mapper) + ' · ' : ''}${esc(fmtDate(s.timeset))}`;
        }
        row.innerHTML = `
            ${left}
            <div class="song-meta">
                <div class="song-name">${title}</div>
                <div class="song-artist">${line2}</div>
                <div class="song-mapper">${line3}</div>
            </div>
            <div class="song-right">
                <div class="score-acc">${(s.accuracy * 100).toFixed(2)}%</div>
                <div class="song-hs">${s.score.toLocaleString()} ${s.pp ? `· ${s.pp.toFixed(1)}pp` : ''}</div>
                <div class="badges">${s.fullCombo ? '<span class="badge fc">FC</span>' : `<span class="badge miss">${s.misses} miss${s.misses === 1 ? '' : 'es'}</span>`}</div>
            </div>
            <button class="dl-btn watch-btn">Watch ▶</button>`;
        row.onclick = () => this.watchReplay({ score: s });
        const unavailable = () => {
            row.classList.add('unavailable');
            const b = row.querySelector('.watch-btn');
            b.textContent = isDownloadableHash(s.song.hash) ? 'Map not public' : 'Official level';
            b.title = 'This map isn\'t on BeatSaver, so it can\'t be downloaded to replay';
            row.onclick = () => toast('That map isn\'t on BeatSaver (official or unpublished level), so its replay can\'t be shown', 'error');
        };
        // official levels can never be downloaded; live scores are often on unpublished maps
        if (!isDownloadableHash(s.song.hash)) unavailable();
        else if (live) mapAvailable(s.song.hash).then(ok => { if (!ok) unavailable(); });
        return row;
    }

    renderScoreList(body, scores, opts, total, page, onPage) {
        clearTimeout(this._slowTimer);
        body.innerHTML = '<div class="score-list"></div>';
        const list = body.firstChild;
        for (const s of scores) list.appendChild(this.scoreRow(s, opts));
        const pages = Math.max(1, Math.ceil((total || 0) / 20));
        const pager = document.createElement('div');
        pager.className = 'pager';
        pager.innerHTML = `
            ${page > 1 ? '<button class="btn small" data-pg="-1">← Prev</button>' : ''}
            <span class="pager-info">Page ${page}${total ? ` of ${pages}` : ''}</span>
            ${scores.length >= 20 && page < pages ? '<button class="btn small" data-pg="1">Next →</button>' : ''}`;
        pager.querySelectorAll('[data-pg]').forEach(b => { b.onclick = () => { onPage(page + Number(b.dataset.pg)); body.scrollTop = 0; }; });
        body.appendChild(pager);
    }

    // --- live feed (works anywhere — BeatLeader's score socket needs no relay) ---
    renderLive() {
        const ui = this.replayUi;
        $('replay-controls').innerHTML = `
            <span class="live-chip" id="live-state"><span class="dot"></span><span>Connecting…</span></span>
            <input class="search-box" id="live-filter" type="text" placeholder="Filter by player or song — e.g. a username to watch for" value="${esc(ui.liveFilter)}">`;
        const body = $('replay-body');
        body.innerHTML = `<div class="live-new hidden" id="live-new"></div><div class="score-list" id="live-list"></div><div class="browse-msg" id="live-empty"></div>`;
        const list = $('live-list');
        let hovering = false, pending = 0;
        const render = () => {
            pending = 0;
            $('live-new').classList.add('hidden');
            const shown = liveScores.scores.filter(x => scoreMatches(x, ui.liveFilter)).slice(0, 40);
            list.innerHTML = '';
            for (const x of shown) list.appendChild(this.scoreRow(x, { live: true }));
            $('live-empty').innerHTML = shown.length ? '' : ui.liveFilter
                ? `Waiting for a score from a player or song matching <b>“${esc(ui.liveFilter)}”</b>…<br><small>Leave this open — it shows up the moment they finish a map.</small>`
                : 'Waiting for the next score…<br><small>Every replay set on BeatLeader appears here live.</small>';
        };
        const input = $('live-filter');
        input.addEventListener('input', () => { ui.liveFilter = input.value; render(); });
        // don't shuffle rows under the pointer; collect new ones instead
        list.addEventListener('pointerenter', () => { hovering = true; });
        list.addEventListener('pointerleave', () => { hovering = false; if (pending) render(); });
        $('live-new').onclick = render;
        const labels = { idle: 'Offline', connecting: 'Connecting…', live: 'Live', reconnecting: 'Reconnecting…' };
        this._cleanup = liveScores.subscribe((ev) => {
            if (!list.isConnected) return;
            if (ev.type === 'state') {
                const chip = $('live-state');
                chip.className = 'live-chip ' + ev.state;
                chip.lastElementChild.textContent = labels[ev.state] || ev.state;
            } else if (ev.type === 'score' && scoreMatches(ev.score, ui.liveFilter)) {
                if (ui.liveFilter && ev.score.playerName && scoreMatches({ ...ev.score, song: {} }, ui.liveFilter)) {
                    toast(`${ev.score.playerName} just set a score — ready to watch`, 'success');
                }
                if (hovering) {
                    pending++;
                    const nb = $('live-new');
                    nb.textContent = `${pending} new score${pending === 1 ? '' : 's'} — show`;
                    nb.classList.remove('hidden');
                } else render();
            }
        });
        render();
    }

    // --- file / link ---
    renderReplayFile() {
        $('replay-controls').innerHTML = '';
        const body = $('replay-body');
        body.innerHTML = `
            <div class="file-drop" id="file-drop">
                <div class="file-drop-icon">⤓</div>
                <div><b>Drop a .bsor replay here</b> or</div>
                <button class="btn small" id="file-pick">Choose File…</button>
                <input type="file" id="file-input" accept=".bsor" hidden>
            </div>
            <div class="link-row">
                <input class="search-box" id="link-input" type="text" placeholder="…or paste a BeatLeader replay link / score ID">
                <button class="btn small primary" id="link-go">Watch ▶</button>
            </div>
            <div class="browse-msg small-msg">Replay files and links work without the BeatLeader API. The map is downloaded from BeatSaver automatically.</div>`;
        const input = $('file-input');
        $('file-pick').onclick = () => input.click();
        input.onchange = async () => {
            const f = input.files && input.files[0];
            if (f) this.watchReplay({ buffer: await f.arrayBuffer() });
        };
        const drop = $('file-drop');
        drop.addEventListener('dragover', (e) => { e.preventDefault(); drop.classList.add('over'); });
        drop.addEventListener('dragleave', () => drop.classList.remove('over'));
        drop.addEventListener('drop', async (e) => {
            e.preventDefault();
            drop.classList.remove('over');
            const f = e.dataTransfer.files && e.dataTransfer.files[0];
            if (f) this.watchReplay({ buffer: await f.arrayBuffer() });
        });
        const link = $('link-input');
        const go = () => {
            const parsed = parseReplayLink(link.value);
            if (!parsed) { toast('That doesn\'t look like a replay link or score ID', 'error'); return; }
            this.watchReplay(parsed);
        };
        link.addEventListener('keydown', (e) => { if (e.key === 'Enter') go(); });
        $('link-go').onclick = go;
    }

    // ============ WATCH A REPLAY ============
    // source: {score} from a list, {url}, {scoreId}, or {buffer} (local file)
    async watchReplay(source) {
        const backdrop = document.createElement('div');
        backdrop.className = 'modal-backdrop';
        backdrop.innerHTML = `
            <div class="modal">
                <h2>Loading replay</h2>
                <div class="sub" id="rl-step">Preparing…</div>
                <div class="dl-progress big"><div class="dl-progress-fill" id="rl-fill"></div></div>
                <button class="btn small modal-close" id="rl-cancel">Cancel</button>
            </div>`;
        document.body.appendChild(backdrop);
        let cancelled = false;
        const prevBack = cursor.onBack;
        const close = () => { backdrop.remove(); cursor.onBack = prevBack; };
        backdrop.querySelector('#rl-cancel').onclick = () => { cancelled = true; close(); };
        cursor.onBack = () => { cancelled = true; close(); };
        const step = (label, p) => {
            backdrop.querySelector('#rl-step').textContent = label;
            if (p != null) backdrop.querySelector('#rl-fill').style.width = Math.round(p * 100) + '%';
        };

        try {
            // 1. the replay file
            let buffer = source.buffer || null;
            let playerName = source.score ? source.score.playerName : '';
            if (!buffer) {
                let url = source.url || null;
                let score = source.score || null;
                if (!url && source.scoreId) {
                    step('Looking up score…', 0.02);
                    score = await getScoreById(source.scoreId);
                    playerName = score.playerName;
                }
                if (!url) url = await getReplayUrl(score);
                step('Downloading replay…', 0.05);
                try {
                    buffer = await fetchReplay(url, (p) => step('Downloading replay…', 0.05 + p * 0.25));
                } catch (err) {
                    // a constructed CDN name can miss — ask the API for the exact one
                    if (err.status !== 404 || !score || score.replay) throw err;
                    const full = await getScoreById(score.id);
                    if (!full.replay) throw new Error('This score has no replay');
                    buffer = await fetchReplay(full.replay, (p) => step('Downloading replay…', 0.05 + p * 0.25));
                }
            }
            if (cancelled) return;
            step('Reading replay…', 0.32);
            const data = decodeBsor(buffer);
            const info = data.info;
            if (!playerName) playerName = info.playerName;

            // 2. the map (by hash, from the library or BeatSaver)
            step('Finding the map…', 0.35);
            let record = await findSavedByHash(info.hash).catch(() => null);
            if (!record) {
                const meta = await getMapByHash(info.hash);
                if (!meta) throw new Error('That map isn\'t on BeatSaver (it may have been deleted)');
                if (cancelled) return;
                record = await downloadMap(meta, (p, label) => step(label === 'Done' ? 'Map ready' : label + ' (map)', 0.35 + p * 0.55));
            }
            if (cancelled) return;

            // 3. the difficulty that was played
            const want = (info.mode || 'Standard').replace(/^Generated/, '');
            const diffs = record.info.difficulties;
            const modes = MODE_ALIASES[want] || [want];
            const diff = diffs.find(d => modes.includes(d.characteristic) && d.difficulty === info.difficulty)
                || diffs.find(d => d.difficulty === info.difficulty)
                || null;
            if (!diff) throw new Error(`The map has no ${info.difficulty} ${want} difficulty`);

            step('Starting…', 1);
            close();
            this.startLevel(null, record, diff, { data, playerName });
        } catch (err) {
            console.error(err);
            close();
            if (!cancelled) toast('Couldn\'t load replay: ' + err.message, 'error');
        }
    }

    // ============ SETTINGS ============
    showSettings() {
        const s = settings;
        this.setScreen(`
        <div class="screen panel-screen">
            <div class="panel" style="max-width:720px">
                <div class="panel-header">
                    <div class="panel-title">SETTINGS</div>
                    <div class="seg settings-jump">
                        <button class="sort-btn" data-jump="sec-game">Gameplay</button>
                        <button class="sort-btn" data-jump="sec-camera">Camera</button>
                        <button class="sort-btn" data-jump="sec-replays">Replays</button>
                        <button class="sort-btn" data-jump="sec-graphics">Graphics</button>
                    </div>
                    <button class="btn small" id="btn-back">← Back</button>
                </div>
                <div class="panel-body" id="settings-body"></div>
            </div>
        </div>`);
        this.enterMenuMode(() => this.showHome());
        $('btn-back').onclick = () => this.showHome();

        const body = $('settings-body');
        const b = settingBuilders(body, (k) => this.applySettingChange(k));
        const resetAndRedraw = (keys, msg) => () => {
            s.reset(keys);
            this.engine.applyCameraSettings();
            const top = body.scrollTop;
            this.showSettings();
            $('settings-body').scrollTop = top;
            toast(msg);
        };
        this.root.querySelectorAll('[data-jump]').forEach(btn => {
            btn.onclick = () => { const el = $(btn.dataset.jump); if (el) body.scrollTop = el.offsetTop - body.offsetTop - 8; };
        });

        b.section('Gameplay').id = 'sec-game';
        b.slider('musicVolume', 'Music Volume', 'Song playback level', 0, 1, 0.05, fmt.pct);
        b.slider('sfxVolume', 'Effects Volume', 'Hit sounds and UI', 0, 1, 0.05, fmt.pct);
        b.slider('noteSpeed', 'Note Speed', 'Multiplier on map note-jump speed', 0.7, 1.5, 0.05, fmt.x);
        b.slider('aimAssist', 'Aim Assist', 'Sabers magnetize toward matching notes', 0, 1, 0.1, fmt.pct);
        b.slider('cursorSpeed', 'Cursor Speed', 'Right-stick menu cursor sensitivity', 0.5, 2, 0.1, (v) => v.toFixed(1) + 'x');
        b.color('leftColor', 'Left Saber Color', 'Also tints left-hand notes');
        b.color('rightColor', 'Right Saber Color', 'Also tints right-hand notes');
        b.rows(REPLAY_VIEW_ROWS.filter(r => r[1] === 'trailLength'));
        b.toggle('noFail', 'No Fail', 'Never fail a song — chill mode');

        b.section('Play camera', 'Where you watch your sabers from (also the replay third-person view)',
            resetAndRedraw(['camFov', 'camHeight', 'camDistance', 'camTilt'], 'Play camera reset')).id = 'sec-camera';
        b.rows(PLAY_CAMERA_ROWS);
        b.section('Replay first-person camera', 'The player\'s own view (C / Y while watching)',
            resetAndRedraw(CAMERA_KEYS.filter(k => k.startsWith('fp')), 'First-person camera reset'));
        b.rows(FIRST_PERSON_ROWS);
        b.section('Replay follow camera', 'Chases the player\'s head from behind',
            resetAndRedraw(CAMERA_KEYS.filter(k => k.startsWith('follow')), 'Follow camera reset'));
        b.rows(FOLLOW_ROWS);

        b.section('Replays', 'Everything here can also be changed while watching (⚙ Options)',
            resetAndRedraw(['replayCamera', 'replayHud', 'replayCutText', 'replayHitSounds', 'replayStats',
                'replayHead', 'replaySkipIntro', 'replayShowMisses'], 'Replay options reset')).id = 'sec-replays';
        b.rows(REPLAY_VIEW_ROWS.filter(r => r[1] !== 'trailLength'));

        b.section('Graphics').id = 'sec-graphics';
        b.choice('quality', 'Graphics Quality', 'Auto lowers resolution when frames run slow',
            [['auto', 'Auto'], ['high', 'High'], ['medium', 'Medium'], ['low', 'Low']]);
        b.toggle('bloom', 'Glow / Bloom', 'Fancy graphics. Turn off on slow devices');
        b.toggle('wallDistortion', 'Wall Distortion', 'Real-time energy-field effect on walls');
        b.slider('bloomStrength', 'Glow Intensity', 'How strong the bloom glow is', 0, 1.2, 0.05, (v) => v.toFixed(2));

        b.section('Online');
        const proxyRow = b.text('blProxy', 'BeatLeader Proxy', 'Optional — makes player/level search fast and reliable (see proxy/README.md)', 'your-worker.workers.dev');
        const pin = proxyRow.querySelector('input');
        pin.onchange = () => {
            const v = normalizeProxyUrl(pin.value);
            pin.value = v;
            s.set('blProxy', v);
            toast(v ? 'Proxy saved — press Test to check it' : 'Proxy removed');
        };
        const testBtn = document.createElement('button');
        testBtn.className = 'btn small';
        testBtn.textContent = 'Test';
        const testOut = document.createElement('div');
        testOut.className = 'setting-value proxy-result';
        testBtn.onclick = async () => {
            pin.onchange();
            testBtn.disabled = true;
            testOut.textContent = 'Testing…';
            const r = await testProxy();
            testBtn.disabled = false;
            testOut.textContent = r.ok ? `Works ✓ (${r.ms} ms)` : `Not working: ${r.error}`;
            testOut.classList.toggle('ok', r.ok);
        };
        proxyRow.querySelector('.setting-control').append(testBtn, testOut);
    }
}
