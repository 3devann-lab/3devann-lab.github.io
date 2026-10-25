# Setting up accounts and multiplayer (Firebase)

SABER//3D uses [Firebase](https://firebase.google.com) for sign-in and multiplayer. You make your own
free Firebase project, paste its settings into one file, and paste the database rules once. It takes about
15 minutes and needs no credit card.

Until you do this, the game works exactly as before: everyone plays as a guest and multiplayer says it
isn't set up yet.

You need:
- a Google account (to log in to Firebase)
- the ability to edit and push this repository (the site updates from it)

---

## Step 1 — Create a Firebase project

1. Go to <https://console.firebase.google.com> and sign in with your Google account.
2. Click **Create a project** (on some accounts: **Get started with a Firebase project**).
3. Give it a name, for example `saber3d`, accept the terms, and click **Continue**.
4. Google Analytics isn't needed. Switch it off and click **Create project**.
5. Wait until it says your project is ready, then click **Continue**.

## Step 2 — Register the website and copy its settings

1. On the project's home page (**Project Overview**), click the **Web** icon `</>`.
   If you don't see it, click **+ Add app** and choose **Web**.
2. Type a nickname such as `saber3d web`.
   Leave **Also set up Firebase Hosting** unticked (the game is already hosted on GitHub Pages).
3. Click **Register app**.
4. Firebase shows a code block containing `const firebaseConfig = { ... }`.
   Keep this page open, or copy the block somewhere — you need it in step 6.
5. Click **Continue to console**.

You can always find these settings again under ⚙ **Project settings** → **General** → **Your apps**.

## Step 3 — Turn on email and password sign-in

1. In the left menu open **Build** → **Authentication** and click **Get started**.
2. Open the **Sign-in method** tab and click **Email/Password**.
3. Switch on the **first** toggle (Email/Password).
   Leave **Email link (passwordless sign-in)** off.
4. Click **Save**.

Then, still in **Authentication**:

5. Open the **Settings** tab → **Authorized domains** → **Add domain**.
6. Add the domain your game runs on, for example `3devann-lab.github.io`, and click **Add**.
   (`localhost` is already listed, for testing on your own computer.)

## Step 4 — Create the Realtime Database

1. In the left menu open **Build** → **Realtime Database** and click **Create Database**.
2. Pick the location closest to your players, for example United States, Belgium or Singapore.
   Click **Next**.
3. Choose **Start in locked mode** and click **Enable**.
   Locked mode is fine: step 5 replaces the rules.
4. At the top of the **Data** tab you now see the database's address. It looks like
   `https://saber3d-1234-default-rtdb.firebaseio.com`, or
   `https://saber3d-1234-default-rtdb.europe-west1.firebasedatabase.app` for databases outside the US.
   Copy it — you need it in step 6.

## Step 5 — Publish the database rules

The rules decide who may read and write what.
- Your saved data is private to you.
- Only signed-in players can see lobbies.
- Only a lobby's host can pick its level or start a match.
- Players can only change their own entries.

1. In **Realtime Database**, open the **Rules** tab.
2. Delete everything in the editor.
3. Open [`firebase/database.rules.json`](firebase/database.rules.json) from this repository, copy **all** of
   it, and paste it into the editor.
4. Click **Publish**.

## Step 6 — Paste your settings into the game

1. Open [`js/firebase-config.js`](js/firebase-config.js) in this repository.
2. Fill in the values from the `firebaseConfig` block you copied in step 2. It ends up looking like this,
   with your own values:

   ```js
   export const firebaseConfig = {
       apiKey: 'AIzaSy…',
       authDomain: 'saber3d-1234.firebaseapp.com',
       databaseURL: 'https://saber3d-1234-default-rtdb.firebaseio.com',
       projectId: 'saber3d-1234',
       storageBucket: 'saber3d-1234.firebasestorage.app',
       messagingSenderId: '1234567890',
       appId: '1:1234567890:web:abc123',
   };
   ```

3. **Check that `databaseURL` is filled in.** Firebase leaves it out of the code block when the database is
   created after the app (as in this guide). If it's missing, paste the database address from step 4.
4. Save the file, then commit and push it.
   GitHub Pages updates the site within a minute or two.

These values are safe to publish. They only tell the game which project to use. The rules from step 5 are
what protect the data.

## Step 7 — Try it

1. Open the game. You now get a **Sign in** screen with **Create an account** and **Continue as Guest**.
   (If you chose Guest earlier in this browser, use the **Guest · Sign in** button at the top left of the
   main menu.)
2. Click **Create an account**, pick a player name, and enter an email and password.
3. Open **Settings**. **Account** at the top shows your name, with **Change Password** and **Log Out**.
4. Test multiplayer with a second account. Open the game in a private / incognito window (or another
   browser), sign up there with a different email, and open **Multiplayer** in both.
   - Each sees the other under **Online now**.
   - One clicks **+ Create Lobby**; the other joins from the list, or types the 5-letter code.
5. Test password reset: log out, click **Forgot password?**, and enter your email.
   The reset email can land in the spam folder.

---

## What gets saved where

| | Guest | Signed in |
|---|---|---|
| Settings | a browser cookie (and the browser's local storage as a backup) | your account |
| High scores | this browser | your account (a new account keeps the scores you set as a guest) |
| Downloaded maps | this browser | the maps stay in this browser, and the account remembers which ones you have. On another computer the song list offers **Download all**. |
| Editor maps | this browser | your account, except the song file, which is too big. On another computer you choose the song file once. |
| Multiplayer | not available | yes |

The database layout is described at the top of [`js/online/multiplayer.js`](js/online/multiplayer.js).

## Is it free?

Yes, for a game this size. Firebase's free **Spark** plan includes:
- email/password sign-in
- a Realtime Database with up to **100 players connected at once**, **1 GB** of storage and **10 GB** of
  downloads a month

In a lobby of 4–5 players, a match uses roughly 1–2 MB per player per song, so 10 GB covers thousands of matches a month.
You can watch the usage under **Realtime Database** → **Usage**.

Current limits are on <https://firebase.google.com/pricing>. Nothing is charged unless you upgrade to the
paid Blaze plan yourself.

## Optional extras

- **Nicer reset emails.** In **Authentication** → **Templates** → **Password reset**, change the sender
  name and subject (for example "SABER//3D").
- **Lock the API key to your site.** Open <https://console.cloud.google.com/apis/credentials> for the same
  project and edit the **Browser key**. Under **Application restrictions** choose **Websites**, then add
  `https://3devann-lab.github.io/*` (your domain) and `http://localhost/*`. If you get this wrong, sign-in
  stops working, so test right after.

## If something doesn't work

The game shows these messages:

| Message | What to do |
|---|---|
| "Email sign-in isn't turned on in this Firebase project" | Step 3: switch on Email/Password and click **Save**. |
| "The Firebase API key in js/firebase-config.js is wrong" | Copy the config again (Project settings → Your apps). Check for missing quotes. |
| "This website isn't on the Firebase project's list of authorized domains" | Step 3, points 5–6: add your site's domain. |
| "The database refused that. Are the database rules … published?" | Step 5: paste the rules again and click **Publish**. |
| Multiplayer says "isn't set up yet" | `apiKey` or `databaseURL` is empty in `js/firebase-config.js`, or the site hasn't updated yet. Reload with Ctrl+F5. |
| "Firebase couldn't be reached" | Check your internet connection, or whether a browser extension blocks `gstatic.com` / `firebaseio.com`. |
| No reset email arrives | Check the spam folder. In **Authentication** → **Users**, check that the account exists. |

## Testing on your own computer (advanced)

The game works from `http://localhost` with your real project (localhost is an authorized domain by
default):

```sh
python3 -m http.server 8000
# open http://localhost:8000/3dsaber/
```

To test without touching your real project, use the
[Firebase emulators](https://firebase.google.com/docs/emulator-suite):
1. Run `npx firebase-tools emulators:start --only auth,database --project demo-saber`.
   This needs Java 11 or newer, and a `firebase.json` pointing `database.rules` at
   `firebase/database.rules.json`.
2. In the browser console on `localhost`, run:

   ```js
   localStorage.saber3d_firebase = JSON.stringify({
       emulator: true,
       config: { apiKey: 'demo', authDomain: 'demo-saber.firebaseapp.com', projectId: 'demo-saber',
                 databaseURL: 'https://demo-saber-default-rtdb.firebaseio.com', appId: '1:1:web:1' },
   });
   ```

   This override only works on `localhost`. Remove it with `localStorage.removeItem('saber3d_firebase')`.
