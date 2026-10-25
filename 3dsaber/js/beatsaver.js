// ============ BeatSaver API, map download/extract, IndexedDB library ============
import { parseInfo } from './beatmap.js';

const API = 'https://api.beatsaver.com';

// Look a map up by its version hash (replays reference maps this way)
export async function getMapByHash(hash) {
    const res = await fetch(`${API}/maps/hash/${encodeURIComponent(hash.toLowerCase())}`);
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(`BeatSaver lookup failed (${res.status})`);
    const doc = await res.json();
    const meta = simplifyDoc(doc);
    // an older version of the map may be the one that was played
    const h = hash.toLowerCase();
    // saving an old version under the map's key would overwrite the current one
    if ((meta.hash || '').toLowerCase() !== h) meta.id = `${doc.id}@${h.slice(0, 8)}`;
    const ver = (doc.versions || []).find(v => (v.hash || '').toLowerCase() === h);
    if (ver) {
        meta.hash = h;
        meta.downloadURL = ver.downloadURL;
        meta.coverURL = ver.coverURL || meta.coverURL;
    } else {
        meta.hash = h;
        meta.downloadURL = `https://r2cdn.beatsaver.com/${h}.zip`;
    }
    return meta;
}

// Can a map be downloaded? Official (OST/DLC) levels have no BeatSaver hash and
// people often play unpublished test maps, so replays of those can't be watched.
const availability = new Map();   // hash -> Promise<boolean>
export function isDownloadableHash(hash) {
    return /^[0-9a-f]{40}$/i.test(String(hash || ''));
}
export function mapAvailable(hash) {
    const h = String(hash || '').toLowerCase();
    if (!isDownloadableHash(h)) return Promise.resolve(false);
    if (!availability.has(h)) {
        availability.set(h, fetch(`${API}/maps/hash/${h}`)
            .then(res => res.status !== 404)          // other errors: don't block the button
            .catch(() => true));
    }
    return availability.get(h);
}

export async function searchMaps({ query = '', page = 0, sort = 'Relevance' } = {}) {
    let url;
    if (query.trim()) {
        url = `${API}/search/text/${page}?q=${encodeURIComponent(query)}&sortOrder=${sort}`;
    } else {
        url = `${API}/search/text/${page}?sortOrder=${sort}`;
    }
    const res = await fetch(url);
    if (!res.ok) throw new Error(`BeatSaver search failed (${res.status})`);
    const data = await res.json();
    return (data.docs || []).map(simplifyDoc);
}

function simplifyDoc(doc) {
    const v = doc.versions && doc.versions[doc.versions.length - 1];
    return {
        id: doc.id,
        name: doc.name,
        songName: doc.metadata?.songName || doc.name,
        songAuthor: doc.metadata?.songAuthorName || '',
        mapper: doc.metadata?.levelAuthorName || doc.uploader?.name || '',
        bpm: doc.metadata?.bpm || 120,
        duration: doc.metadata?.duration || 0,
        upvotes: doc.stats?.upvotes || 0,
        score: doc.stats?.score || 0,
        downloadURL: v?.downloadURL,
        coverURL: v?.coverURL,
        previewURL: v?.previewURL,
        hash: v?.hash,
        diffs: (v?.diffs || []).map(d => ({
            characteristic: d.characteristic,
            difficulty: d.difficulty,
            nps: d.nps,
            njs: d.njs,
            chroma: !!d.chroma,
            noodle: !!d.ne,
            mappingExt: !!d.me,
        })),
        hasChroma: (v?.diffs || []).some(d => d.chroma),
        hasNoodle: (v?.diffs || []).some(d => d.ne),
    };
}

// account.js listens here so downloads are remembered in your account
export const libraryHooks = { onSaved: null, onDeleted: null };

// ---------- Download + extract a map zip ----------
export async function downloadMap(mapMeta, onProgress = () => {}) {
    if (!mapMeta.downloadURL) throw new Error('No download URL');
    onProgress(0.02, 'Downloading…');

    const res = await fetch(mapMeta.downloadURL);
    if (!res.ok) throw new Error(`Download failed (${res.status})`);

    // Stream with progress when possible
    let zipData;
    const total = Number(res.headers.get('content-length')) || 0;
    if (res.body && total) {
        const reader = res.body.getReader();
        const chunks = [];
        let received = 0;
        for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            chunks.push(value);
            received += value.length;
            onProgress(0.02 + 0.55 * (received / total), 'Downloading…');
        }
        zipData = new Blob(chunks);
    } else {
        zipData = await res.blob();
    }

    onProgress(0.6, 'Extracting…');
    const zip = await JSZip.loadAsync(zipData);

    // Locate Info.dat (case-insensitive, may be nested one level)
    let infoFile = null;
    zip.forEach((path, file) => {
        if (!infoFile && /(^|\/)info\.dat$/i.test(path)) infoFile = file;
    });
    if (!infoFile) throw new Error('Map zip has no Info.dat');
    const dir = infoFile.name.includes('/') ? infoFile.name.slice(0, infoFile.name.lastIndexOf('/') + 1) : '';

    const infoRaw = await infoFile.async('string');
    const info = parseInfo(infoRaw);

    const getFile = (name) => {
        if (!name) return null;
        return zip.file(dir + name) || zip.file(name) ||
            zip.file(Object.keys(zip.files).find(k => k.toLowerCase() === (dir + name).toLowerCase()) || '__none__');
    };

    // Song audio
    onProgress(0.7, 'Extracting song…');
    let songFile = getFile(info.songFilename);
    if (!songFile) { // fall back to any audio file in the zip
        zip.forEach((path, file) => {
            if (!songFile && /\.(egg|ogg|mp3|wav)$/i.test(path)) songFile = file;
        });
    }
    if (!songFile) throw new Error('No audio file in map zip');
    const songBuf = await songFile.async('arraybuffer');

    // Cover image
    let coverBlob = null;
    const coverFile = getFile(info.coverFilename);
    if (coverFile) {
        const cb = await coverFile.async('blob');
        const ext = (info.coverFilename || '').split('.').pop().toLowerCase();
        coverBlob = cb.slice(0, cb.size, ext === 'png' ? 'image/png' : 'image/jpeg');
    }

    // Difficulty files (+ BPM region file used by some v2/v4 maps)
    onProgress(0.82, 'Parsing difficulties…');
    const diffFiles = {};
    if (info.audioDataFilename) {
        const af = getFile(info.audioDataFilename);
        if (af) diffFiles.__bpm = await af.async('string');
    }
    for (const d of info.difficulties) {
        const f = getFile(d.filename);
        if (f) diffFiles[d.filename] = await f.async('string');
        if (d.lightshowFilename) {
            const lf = getFile(d.lightshowFilename);
            if (lf) diffFiles[d.lightshowFilename] = await lf.async('string');
        }
    }

    onProgress(0.95, 'Saving…');
    const record = {
        id: mapMeta.id,
        meta: { ...mapMeta, downloadURL: undefined },
        info,
        infoRaw,
        diffFiles,
        songBuf,
        coverBlob,
        savedAt: Date.now(),
    };
    await dbPut(record);
    if (libraryHooks.onSaved) try { libraryHooks.onSaved(record); } catch (e) { console.error(e); }
    onProgress(1, 'Done');
    return record;
}

// ---------- IndexedDB ----------
const DB_NAME = 'saber3d';
const STORE = 'maps';
// the heavy part of each map (song audio + difficulty files, often 5–40 MB) lives
// apart from its summary, so listing the library never loads every song at once
const FILE_STORE = 'mapFiles';
const HEAVY = ['songBuf', 'diffFiles'];
// editor: project data (small, saved on every edit) and its audio/cover (saved once)
export const PROJECT_STORE = 'projects';
export const PROJECT_FILES = 'projectFiles';

function splitRecord(record) {
    const light = { ...record }, files = { id: record.id };
    let heavy = false;
    for (const k of HEAVY) {
        if (k in light) { files[k] = light[k]; delete light[k]; heavy = true; }
    }
    return { light, files: heavy ? files : null };
}

let dbPromise = null;        // one shared connection (opening per call was slow)
export function openDB() {
    if (dbPromise) return dbPromise;
    dbPromise = new Promise((resolve, reject) => {
        const req = indexedDB.open(DB_NAME, 3);
        req.onupgradeneeded = (e) => {
            const db = req.result;
            for (const name of [STORE, PROJECT_STORE, PROJECT_FILES, FILE_STORE]) {
                if (!db.objectStoreNames.contains(name)) db.createObjectStore(name, { keyPath: 'id' });
            }
            // maps used to be stored whole: move each one's song and difficulty files out
            if (e.oldVersion >= 1 && e.oldVersion < 3) {
                const maps = req.transaction.objectStore(STORE), files = req.transaction.objectStore(FILE_STORE);
                maps.openCursor().onsuccess = (ev) => {
                    const cur = ev.target.result;
                    if (!cur) return;
                    const { light, files: f } = splitRecord(cur.value || {});
                    if (f) { files.put(f); cur.update(light); }
                    cur.continue();
                };
            }
        };
        req.onsuccess = () => {
            const db = req.result;
            db.onversionchange = () => { db.close(); dbPromise = null; };
            db.onclose = () => { dbPromise = null; };
            resolve(db);
        };
        req.onerror = () => { dbPromise = null; reject(req.error); };
    });
    return dbPromise;
}

// generic helpers for any store
export async function idb(storeName, mode, fn) {
    const db = await openDB();
    return new Promise((resolve, reject) => {
        const tx = db.transaction(storeName, mode);
        const req = fn(tx.objectStore(storeName));
        tx.oncomplete = () => resolve(req ? req.result : undefined);
        tx.onerror = () => reject(tx.error);
        tx.onabort = () => reject(tx.error || new Error('storage transaction aborted'));
    });
}

export async function saveLibraryRecord(record) { return dbPut(record); }

async function dbPut(record) {
    const { light, files } = splitRecord(record);
    const db = await openDB();
    return new Promise((resolve, reject) => {
        const tx = db.transaction([STORE, FILE_STORE], 'readwrite');
        tx.objectStore(STORE).put(light);
        if (files) tx.objectStore(FILE_STORE).put(files);
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
        tx.onabort = () => reject(tx.error || new Error('storage transaction aborted'));
    });
}

// Summaries of every saved map (info, meta, cover) — no songs or difficulty
// files; getSavedMap / loadFullMap fetch those for the one you play.
export async function getSavedMaps() {
    const db = await openDB();
    return new Promise((resolve, reject) => {
        const req = db.transaction(STORE, 'readonly').objectStore(STORE).getAll();
        req.onsuccess = () => resolve(req.result.sort((a, b) => b.savedAt - a.savedAt));
        req.onerror = () => reject(req.error);
    });
}

// One map with everything needed to play it
export async function getSavedMap(id) {
    const db = await openDB();
    return new Promise((resolve, reject) => {
        const tx = db.transaction([STORE, FILE_STORE], 'readonly');
        const a = tx.objectStore(STORE).get(id), b = tx.objectStore(FILE_STORE).get(id);
        tx.oncomplete = () => resolve(a.result ? { ...a.result, ...(b.result || {}) } : null);
        tx.onerror = () => reject(tx.error);
    });
}

// A summary from getSavedMaps → the whole map (already whole: returned as is)
export async function loadFullMap(rec) {
    if (!rec || (rec.songBuf && rec.diffFiles)) return rec;
    return (await getSavedMap(rec.id)) || rec;
}

export async function deleteSavedMap(id) {
    const db = await openDB();
    await new Promise((resolve, reject) => {
        const tx = db.transaction([STORE, FILE_STORE], 'readwrite');
        tx.objectStore(STORE).delete(id);
        tx.objectStore(FILE_STORE).delete(id);
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
    });
    if (libraryHooks.onDeleted) try { libraryHooks.onDeleted(id); } catch (e) { console.error(e); }
}

export async function isMapSaved(id) {
    return (await getSavedIds()).has(id);
}

// All saved map ids in one request (no song/cover blobs loaded)
export async function getSavedIds() {
    const db = await openDB();
    return new Promise((resolve, reject) => {
        const req = db.transaction(STORE, 'readonly').objectStore(STORE).getAllKeys();
        req.onsuccess = () => resolve(new Set(req.result));
        req.onerror = () => reject(req.error);
    });
}

// Find a downloaded map by version hash (cursor walk; stops at the first match)
export async function findSavedByHash(hash) {
    const h = String(hash || '').toLowerCase();
    if (!h) return null;
    const db = await openDB();
    return new Promise((resolve, reject) => {
        const req = db.transaction(STORE, 'readonly').objectStore(STORE).openCursor();
        req.onsuccess = () => {
            const cur = req.result;
            if (!cur) return resolve(null);
            const v = cur.value;
            if (v && v.meta && String(v.meta.hash || '').toLowerCase() === h) return resolve(v.id);
            cur.continue();
        };
        req.onerror = () => reject(req.error);
    }).then(id => (id == null ? null : getSavedMap(id)));
}
