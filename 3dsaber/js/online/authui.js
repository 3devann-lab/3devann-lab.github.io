// ============ Sign in / sign up / forgot password, and Settings → Account ============
import { account, authMessage, cleanName } from './account.js';
import { toast, esc } from '../ui.js';

const $ = (id) => document.getElementById(id);

// mode: signin | signup | reset. done() runs after signing in (default: main menu)
export function showAuth(menu, mode = 'signin', { done = null, email = '' } = {}) {
    const finish = done || (() => menu.showHome());
    const titles = { signin: 'SIGN IN', signup: 'CREATE ACCOUNT', reset: 'RESET PASSWORD' };
    const field = (id, label, type, extra = '') => `<label class="auth-field"><span>${label}</span><input class="search-box" id="${id}" type="${type}" ${extra}></label>`;
    let form = '';
    if (mode === 'signup') {
        form = field('au-name', 'Player name <small>other players see this</small>', 'text', 'maxlength="24" autocomplete="nickname"')
            + field('au-email', 'Email', 'email', `autocomplete="email" value="${esc(email)}"`)
            + field('au-pass', 'Password <small>at least 6 characters</small>', 'password', 'autocomplete="new-password"')
            + field('au-pass2', 'Password again', 'password', 'autocomplete="new-password"');
    } else if (mode === 'reset') {
        form = `<div class="auth-note">Enter your account's email and we'll send you a link to choose a new password.</div>`
            + field('au-email', 'Email', 'email', `autocomplete="email" value="${esc(email)}"`);
    } else {
        form = field('au-email', 'Email', 'email', `autocomplete="email" value="${esc(email)}"`)
            + field('au-pass', 'Password', 'password', 'autocomplete="current-password"');
    }
    menu.setScreen(`
    <div class="screen panel-screen auth-screen">
        <div class="panel auth-panel">
            <div class="auth-brand">SABER//3D</div>
            <div class="panel-title auth-title">${titles[mode]}</div>
            <form class="auth-form" id="au-form" novalidate>
                ${form}
                <div class="auth-error hidden" id="au-err"></div>
                <div class="auth-ok hidden" id="au-ok"></div>
                <button class="btn primary" type="submit" id="au-go">${mode === 'signup' ? 'Create Account' : mode === 'reset' ? 'Send Reset Link' : 'Sign In'}</button>
            </form>
            <div class="auth-links">
                ${mode === 'signin' ? '<button class="link-btn" id="au-forgot">Forgot password?</button><button class="link-btn" id="au-to-signup">Create an account</button>' : ''}
                ${mode === 'signup' ? '<button class="link-btn" id="au-to-signin">Already have an account? Sign in</button>' : ''}
                ${mode === 'reset' ? '<button class="link-btn" id="au-to-signin">Back to sign in</button>' : ''}
            </div>
            <div class="auth-guest">
                <button class="btn" id="au-guest">${account.state === 'guest' ? 'Back' : 'Continue as Guest'}</button>
                <small>Guests' settings are saved in this browser's cookies. Multiplayer needs an account.</small>
            </div>
        </div>
    </div>`);
    menu.enterMenuMode(null);
    const err = $('au-err'), okBox = $('au-ok'), go = $('au-go');
    const showErr = (msg) => { okBox.classList.add('hidden'); err.textContent = msg; err.classList.remove('hidden'); };
    const showOk = (msg) => { err.classList.add('hidden'); okBox.textContent = msg; okBox.classList.remove('hidden'); };
    const emailVal = () => ($('au-email') ? $('au-email').value.trim() : '');
    const link = (id, fn) => { const b = $(id); if (b) b.onclick = (e) => { e.preventDefault(); fn(); }; };
    link('au-forgot', () => showAuth(menu, 'reset', { done, email: emailVal() }));
    link('au-to-signup', () => showAuth(menu, 'signup', { done, email: emailVal() }));
    link('au-to-signin', () => showAuth(menu, 'signin', { done, email: emailVal() }));
    $('au-guest').onclick = () => {
        if (account.state !== 'guest') account.continueAsGuest();
        menu.showHome();
    };
    const focus = $(mode === 'signup' ? 'au-name' : emailVal() && $('au-pass') ? 'au-pass' : 'au-email');
    if (focus) setTimeout(() => focus.focus(), 50);

    $('au-form').onsubmit = async (e) => {
        e.preventDefault();
        const email = emailVal();
        if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) { showErr('Enter a valid email address.'); return; }
        let pass = '';
        if (mode !== 'reset') {
            pass = $('au-pass').value;
            if (!pass) { showErr('Enter your password.'); return; }
        }
        if (mode === 'signup') {
            if (!cleanName($('au-name').value)) { showErr('Pick a player name.'); return; }
            if (pass.length < 6) { showErr('Pick a longer password (at least 6 characters).'); return; }
            if (pass !== $('au-pass2').value) { showErr('The two passwords don\'t match.'); return; }
        }
        go.disabled = true;
        const label = go.textContent;
        go.textContent = 'Please wait…';
        try {
            if (mode === 'reset') {
                await account.resetPassword(email);
                showOk(`If ${email} has an account, a reset link is on its way. Check your inbox (and spam folder).`);
            } else if (mode === 'signup') {
                await account.signUp($('au-name').value, email, pass);
                toast(`Welcome, ${account.user.name}! Your settings and scores now save to your account.`, 'success');
                finish();
                return;
            } else {
                await account.signIn(email, pass);
                toast(`Signed in as ${account.user.name}`, 'success');
                finish();
                return;
            }
        } catch (ex) {
            if (!String(ex && ex.code).startsWith('auth/')) console.error(ex);     // wrong password etc. are just shown
            showErr(authMessage(ex));
        }
        go.disabled = false;
        go.textContent = label;
    };
}

// Settings → Account
export function accountSection(menu, body) {
    const head = document.createElement('div');
    head.className = 'setting-section';
    head.id = 'sec-account';
    head.innerHTML = '<div><div class="setting-section-title">Account</div></div>';
    body.appendChild(head);
    const box = document.createElement('div');
    box.className = 'account-box';
    body.appendChild(box);

    if (account.state === 'off') {
        box.innerHTML = `<div class="account-note">Accounts and multiplayer aren't set up on this copy of the game.
            ${account.loadError ? 'Firebase couldn\'t be reached.' : 'The owner can turn them on by following FIREBASE_SETUP.md.'}
            Settings are saved in this browser.</div>`;
        return;
    }
    if (!account.signedIn) {
        box.innerHTML = `<div class="account-note">You're playing as a <b>guest</b>: your settings are saved in this browser's cookies
            and your scores in this browser. Sign in to save them to an account and to play multiplayer.</div>
            <div class="account-actions"><button class="btn small primary" id="ac-signin">Sign In</button>
            <button class="btn small" id="ac-signup">Create Account</button></div>`;
        $('ac-signin').onclick = () => showAuth(menu, 'signin', { done: () => menu.showSettings() });
        $('ac-signup').onclick = () => showAuth(menu, 'signup', { done: () => menu.showSettings() });
        return;
    }
    const u = account.user;
    box.innerHTML = `
        <div class="account-who"><div class="account-avatar">${esc((u.name || '?')[0].toUpperCase())}</div>
            <div><b id="ac-who-name">${esc(u.name)}</b><small>${esc(u.email)} · settings, scores, downloaded maps and editor maps save to this account</small></div></div>
        <form class="account-form" id="ac-name-form" novalidate>
            <div class="account-form-title">Player name</div>
            <div class="account-row"><input class="search-box" id="ac-name" maxlength="24" value="${esc(u.name)}">
            <button class="btn small" type="submit">Save</button></div>
        </form>
        <form class="account-form" id="ac-pass-form" novalidate>
            <div class="account-form-title">Change password</div>
            <input class="search-box" id="ac-cur" type="password" placeholder="Current password" autocomplete="current-password">
            <input class="search-box" id="ac-new" type="password" placeholder="New password (at least 6 characters)" autocomplete="new-password">
            <input class="search-box" id="ac-new2" type="password" placeholder="New password again" autocomplete="new-password">
            <div class="auth-error hidden" id="ac-err"></div>
            <div class="auth-ok hidden" id="ac-ok"></div>
            <button class="btn small primary" type="submit" id="ac-pass-go">Change Password</button>
        </form>
        <div class="account-actions"><button class="btn small danger" id="ac-logout">Log Out</button></div>`;
    const err = $('ac-err'), ok = $('ac-ok');
    const showErr = (m) => { ok.classList.add('hidden'); err.textContent = m; err.classList.remove('hidden'); };
    const showOk = (m) => { err.classList.add('hidden'); ok.textContent = m; ok.classList.remove('hidden'); };
    $('ac-name-form').onsubmit = async (e) => {
        e.preventDefault();
        try {
            await account.changeName($('ac-name').value);
            $('ac-who-name').textContent = account.user.name;
            toast('Player name saved', 'success');
        } catch (ex) { toast(authMessage(ex), 'error'); }
    };
    $('ac-pass-form').onsubmit = async (e) => {
        e.preventDefault();
        const cur = $('ac-cur').value, next = $('ac-new').value;
        if (!cur) { showErr('Enter your current password.'); return; }
        if (next.length < 6) { showErr('Pick a longer new password (at least 6 characters).'); return; }
        if (next !== $('ac-new2').value) { showErr('The new passwords don\'t match.'); return; }
        const btn = $('ac-pass-go');
        btn.disabled = true;
        try {
            await account.changePassword(cur, next);
            for (const id of ['ac-cur', 'ac-new', 'ac-new2']) $(id).value = '';
            showOk('Password changed.');
        } catch (ex) {
            showErr(ex && (ex.code === 'auth/invalid-credential' || ex.code === 'auth/wrong-password') ? 'Your current password is wrong.' : authMessage(ex));
        }
        btn.disabled = false;
    };
    $('ac-logout').onclick = async () => {
        const b = $('ac-logout');
        if (b.dataset.armed !== '1') { b.dataset.armed = '1'; b.textContent = 'Click again to log out'; return; }
        b.disabled = true;
        try {
            await account.signOut();
            toast('Logged out');
            showAuth(menu, 'signin');
        } catch (ex) { toast(authMessage(ex), 'error'); b.disabled = false; }
    };
}
