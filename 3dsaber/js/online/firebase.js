// ============ Firebase: the SDK loads only when the game is set up for it ============
import { firebaseConfig } from '../firebase-config.js';

const SDK = 'https://www.gstatic.com/firebasejs/10.12.2/';
let loading = null;

// On localhost only, development and tests can point the game at a different
// project or the Firebase emulators:
// localStorage.saber3d_firebase = {"config": {...}, "emulator": true}
function devOverride() {
    if (!/^(localhost|127\.0\.0\.1)$/.test(location.hostname)) return null;
    try { return JSON.parse(localStorage.getItem('saber3d_firebase') || 'null'); } catch (e) { return null; }
}

export function firebaseSettings() {
    const dev = devOverride();
    return { config: (dev && dev.config) || firebaseConfig, emulator: !!(dev && dev.emulator) };
}

export function isConfigured() {
    const { config } = firebaseSettings();
    return !!(config && config.apiKey && config.databaseURL);
}

// { app, auth, db, A: auth functions, D: database functions }
export function loadFirebase() {
    if (loading) return loading;
    loading = (async () => {
        const { config, emulator } = firebaseSettings();
        const [appMod, A, D] = await Promise.all([
            import(SDK + 'firebase-app.js'),
            import(SDK + 'firebase-auth.js'),
            import(SDK + 'firebase-database.js'),
        ]);
        const app = appMod.initializeApp(config);
        const auth = A.getAuth(app);
        const db = D.getDatabase(app);
        if (emulator) {
            A.connectAuthEmulator(auth, 'http://127.0.0.1:9099', { disableWarnings: true });
            D.connectDatabaseEmulator(db, '127.0.0.1', 9000);
        }
        return { app, auth, db, A, D };
    })();
    loading.catch(() => { loading = null; });
    return loading;
}

// RTDB keys can't contain . $ # [ ] / — encode those (and %) so any id fits
export function encodeKey(s) {
    return String(s).replace(/[.$#[\]/%]/g, (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase().padStart(2, '0'));
}
export function decodeKey(s) {
    return String(s).replace(/%([0-9A-F]{2})/g, (_, h) => String.fromCharCode(parseInt(h, 16)));
}

export function withTimeout(promise, ms, what = 'request') {
    let t;
    return Promise.race([
        promise.finally(() => clearTimeout(t)),
        new Promise((_, rej) => { t = setTimeout(() => rej(new Error(`${what} timed out`)), ms); }),
    ]);
}

// readable messages for Firebase auth errors
export function authMessage(err) {
    const code = (err && err.code) || '';
    const map = {
        'auth/invalid-email': 'That email address doesn\'t look right.',
        'auth/missing-email': 'Enter your email address.',
        'auth/missing-password': 'Enter your password.',
        'auth/invalid-credential': 'Wrong email or password.',
        'auth/wrong-password': 'Wrong email or password.',
        'auth/user-not-found': 'Wrong email or password.',
        'auth/email-already-in-use': 'There\'s already an account with that email — sign in instead.',
        'auth/weak-password': 'Pick a longer password (at least 6 characters).',
        'auth/too-many-requests': 'Too many tries. Wait a minute and try again.',
        'auth/network-request-failed': 'Couldn\'t reach the server. Check your connection.',
        'auth/user-disabled': 'This account has been disabled.',
        'auth/requires-recent-login': 'Please sign in again, then retry.',
        'auth/operation-not-allowed': 'Email sign-in isn\'t turned on in this Firebase project (see FIREBASE_SETUP.md).',
        'auth/configuration-not-found': 'Email sign-in isn\'t turned on in this Firebase project (see FIREBASE_SETUP.md).',
        'auth/api-key-not-valid.-please-pass-a-valid-api-key.': 'The Firebase API key in js/firebase-config.js is wrong.',
        'auth/unauthorized-domain': 'This website isn\'t on the Firebase project\'s list of authorized domains (see FIREBASE_SETUP.md).',
        'PERMISSION_DENIED': 'The database refused that. Are the database rules from FIREBASE_SETUP.md published?',
    };
    if (map[code]) return map[code];
    if (/permission[_ ]denied/i.test(String(err && err.message))) return map.PERMISSION_DENIED;
    return (err && err.message ? err.message.replace(/^Firebase:\s*/, '').replace(/\s*\(auth\/[^)]+\)\.?$/, '') : String(err)) || 'Something went wrong.';
}
