# SABER//3D

A polished browser Beat Saber-style rhythm game, played with a gamepad.
The thumbsticks are your sabers.

## Run it

ES modules need a local server (opening `index.html` directly won't work):

```bash
npx serve .
# or
python -m http.server 8000
```

Then open the printed URL in **Chrome or Edge** (best audio codec support for custom maps).

## How to play

- Connect an Xbox or PlayStation controller (any standard-mapping gamepad works).
- **Menus**: right thumbstick moves the cursor, **A** (Xbox) / **✕** (PlayStation) clicks, **B/○** goes back, left stick scrolls. A real mouse works too.
- **In game**: left stick = left saber, right stick = right saber. The stick places the middle of the blade on the
  note grid: centred = your saber's inner lane, middle row; push to reach the other lanes and rows (diagonals reach
  the corners). Flick through a note in its arrow's direction for a PERFECT. Avoid bombs and walls.
- **Start/Options** (or Esc) pauses. **Settings** in the pause menu changes controls, camera, sound and look live.

### Controls (Settings → Controls)

Horizontal / vertical reach, rest height and spread, reach corners, deadzone, full-tilt point, response curve,
saber smoothing, blade tilt, swap sticks, invert vertical, aim assist (0% = off),
vibration strength. Hits are checked along the blade's whole path between frames, so fast flicks and low frame
rates never let a note slip through, and each cut is judged at its best moment while the blade touches the note.

### Modifiers and practice

On the difficulty screen open **Modifiers & Practice**: No Fail, Instant Fail, Strict Angles, No Arrows,
Ghost Notes, Disappearing Arrows, Small Notes, No Bombs, No Walls, song speed 0.5x–2x, and **Practice from**
any point in the song. Practice runs and speeds below 1x don't save high scores.

## Customize

**Customize** on the home screen (or in a multiplayer lobby) has a turning 3D preview of your character
holding your sabers.

- **Sabers**: left and right colours (they colour your notes too), blade (Classic, Beam, Katana, Pixel,
  Crystal), hilt (Standard, Long, Cross Guard, Ring) and glow. Only the look changes: every blade cuts the same.
- **Avatar**: head shape, skin, eyes, mouth, headwear (cap, beanie, crown, headphones, horns, halo, antenna,
  spiky hair, bun), glasses, body, body colour and accent colour, plus **Randomize**.
- It saves like every other setting (cookie for guests, your account when signed in). **Reset All** in
  Settings leaves it alone.

## Accounts & Multiplayer

Turn these on by following **[FIREBASE_SETUP.md](FIREBASE_SETUP.md)** (free, about 15 minutes). Until then
everyone plays as a guest and multiplayer stays off.

- **Sign in, create an account, or continue as a guest.**
  - Guests' settings are saved in a browser cookie.
  - Signed in, your settings, high scores, your list of downloaded maps and your editor maps save to your
    account and follow you to other computers.
  - **Forgot password?** emails a reset link.
  - **Settings → Account** changes your password or player name, and logs you out.
- **Multiplayer** (needs an account):
  - **Online now** lists everyone online and what they're doing.
  - Create a lobby (public or private, 2–10 players); others join from the list or with its 5-letter code.
  - The host picks the level from their maps or searches BeatSaver to download a custom level, then picks
    the difficulty and modifiers.
  - Everyone else can **suggest** levels, difficulties and modifiers; the host uses one with one click.
  - Players who don't have the host's level get it **downloaded automatically** (progress shows in the
    player list).
  - Ready-up and chat. Each player shows with their avatar's face; the host has a crown.
  - **Everyone needs a controller.** The host can't start while anyone (the host included) has none
    connected; the lobby says who. They connect one or leave, or the host removes them (✕).
  - If the host leaves, the player who's been there longest takes over.
- **Matches**: everyone starts on the same server clock.
  - The other players stand beside you as their avatars, swinging their sabers in their own colours and
    blade style, with their names and scores, plus a live scoreboard. You never see your own avatar.
  - Pausing doesn't stop the song (it's shared). At the end the standings update as the others finish.
  - **If the host leaves mid-match** (Leave Match, closing the game, or losing the connection), the match
    ends and everyone still playing goes back to the lobby. Anyone else leaving just drops out.

## Map Editor

**Map Editor** on the main menu makes Beat Saber maps from any song.

- **Start**: pick a song file (.ogg/.egg/.mp3/.wav). The BPM is detected for you (or tap it), a cover is made if you
  don't have one. You can also **import a map zip** or **edit any downloaded map** (v2, v3 and v4 maps, BPM changes
  included).
- **A full 3D editor**: the map sits on a track in front of you, in the real game engine with its lights and
  environment. The glowing 4×3 grid is the cursor; what's coming sits on the track ahead, the light lanes run down the
  right side, the song's waveform and beat numbers down the left.
  - **Click a cell** of the grid to place a note or bomb, **drag** while placing to aim it.
  - **Wall tool (4)**: drag along the track to draw a wall across lanes and beats.
  - **Lights**: click the light lanes; each lane glows the way that light is at the cursor.
  - **Wheel** moves through the song (Ctrl+wheel stretches the track). **Click the track ahead** to jump there.
    Drag the waveform strip to scroll, or click the song strip under the view to go anywhere.
  - **Right-click** deletes; a right-drag that starts on an object deletes everything it sweeps over. **Shift-drag** box-selects.
  - **Drag a note** to another lane / row; drag walls and lights to move them in time. **Double-click** jumps to an object.
  - **Camera**: right-drag on empty space to turn it, middle-drag to pan, right button + wheel to zoom.
    Presets: Default, Top (reads like a 2D timeline), Side (timing at a glance), Player. **R** resets.
  - **Game view (G)**: see the map exactly as the game draws it, then press G to keep editing.
- **Objects**: red/blue notes (9 directions + angle offset), bombs, full/crouch walls, arcs and chains, light events
  (blue/red/white, on/flash/fade/transition, brightness, laser speed, ring spin/zoom), Chroma colours, BPM changes,
  bookmarks.
- **Tools**: undo/redo, copy/cut/paste at the cursor, mirror, swap colours, snap to grid (1/1–1/64), playback
  at 0.25x–1x with hitsounds and a metronome, strobe generator, light show from your notes, a 4×3 grid view at the
  cursor, an inspector for exact values, stats with jump distance / reaction time, and a map checker (stacked notes,
  notes in walls, too-short walls, impossible doubles).
- **Difficulties**: Easy to Expert+ for Standard, One Saber, No Arrows, Lawless and Lightshow — start one empty or as a
  copy of another, with its own NJS, offset and label.
- **Test play** (T): jump into the game from the cursor with a controller; the pause menu and results take you back.
- **Saving**: everything saves automatically in the browser; your maps show up in **Play** with a "Your map" badge.
- **Export**: a zip with `Info.dat` (v2.1), v3.3 difficulty files, the song and a cover — ready for Beat Saber's
  CustomLevels folder or ChroMapper. (Beat Saber itself needs the song as .ogg/.egg.)

Press **?** in the editor for every shortcut.

## Replays

**Replays** on the main menu plays back real Beat Saber runs from [BeatLeader](https://beatleader.xyz)
inside the game, with the recorded sabers, head, cuts, misses and score.

- **● Live** — every replay set on BeatLeader shows up the moment it's set. Type a username or song to filter
  (e.g. wait for a friend's next score). Works on any site, no setup.
- **Players** — search a username, open their scores, search their levels, sort by recent / top PP / accuracy, hit **Watch**.
- **Levels** — search a song or mapper, pick a difficulty, watch any score on its leaderboard.
- **File / Link** — drop a `.bsor` file or paste a replay link (`cdn.replays.beatleader.xyz/….bsor`,
  `replay.beatleader.xyz/?scoreId=…`, or a score ID).

The map is downloaded from BeatSaver automatically (the exact version that was played).

### Watching a replay

A control bar appears at the bottom whenever you move the mouse, pause, or hover it:

- **Timeline**: click or drag to jump anywhere. Score, combo, energy, lights, Noodle animations and the notes on screen
  are rebuilt exactly as they were at that moment. Red/orange marks show misses and bad cuts (bombs and walls too).
- **Speed**: 0.25x–2x (pitch follows the speed). **Pause** keeps the picture so you can look around.
- **Cameras**: **First Person** (the player's own head), **Third Person** (the camera you play with), **Follow**
  (chases the player from behind), **Free** (drag to orbit, right-drag to pan, wheel to zoom, WASD/Q/E to fly, with
  Stage / Behind / Front / Side / Top presets).
- **⚙ Options** changes everything live while you watch (including turning off cut halves and hit sparks):
  - **First person**: field of view, movement and rotation smoothing, level horizon (no head tilt), pull back, raise.
  - **Follow**: distance, height, smoothing.
  - **Third person**: field of view, height, distance, tilt.
  - **Replay**: score HUD, cut scores (`115` or `70 · 15 · 30`), stats panel (per-hand average, pre/acc/post swing,
    mistakes), hit sounds, player head, saber trail length, timeline marks, skip intro, playback speed.

Everything is remembered for the next replay and can also be set in **Settings**.

| Keyboard | | Controller | |
|---|---|---|---|
| Space / K | play / pause | ≡ | pause (cursor works the bar) |
| ← → (Shift) | back / forward 5 s (15 s) | D-pad ← → | back / forward 5 s |
| , . | step one frame | D-pad ↑ ↓ | faster / slower |
| ↑ ↓ | faster / slower | Y / △ | next camera |
| 1–4, C | camera: first / third / follow / free, next | X / □ | score HUD |
| H / T / O | score HUD / stats panel / options | sticks | free camera: orbit / fly |
| R / F | back to start / fullscreen | LT RT, LB RB | free camera: zoom, down / up |

**Players** and **Levels** need BeatLeader's API, which only answers browsers on beatleader.xyz and `localhost`
dev ports. The game goes through the site's proxy worker (`shy-mud-5208.3devann.workers.dev`) by default, so search
works out of the box. **Settings → BeatLeader Proxy** takes your own worker URL instead (see [`proxy/`](proxy/README.md)),
or `off` to use only the free public relays. Live and File / Link never need it.

## Features

- Main menu, song select, results screens, pause menu — all controller-navigable
- **Custom Levels**: search BeatSaver, download maps (song + cover + all difficulties) straight into the browser; they're stored offline in IndexedDB
- Supports v2, v3 and v4 beatmaps, all difficulties and characteristics, BPM changes (incl. `BPMInfo.dat` / `AudioData.dat` regions), chains and angle offsets
- **360° / 90° levels**: rotation events (and v4 per-object rotations) turn where objects come from; since you
  can't turn around with a controller, the view turns with them
- **Chroma**:
  - note, bomb, wall and light colours; gradients; v3 transitions with easings and HSV lerp; legacy RGB events
  - `lightID` events, which light only the lights they name (the stock lights count 1, 2, 3… in each group)
  - environment geometry ("model maps"):
    - pieces with light shaders or `ILightWithId` are real lights that events turn on, colour and fade
    - zero-width light tubes still glow
    - `TubeBloomPrePassLight` glow, animatable with AnimateComponent
  - named materials, animated through their track; empty `shaderKeywords` / `Glowing` render full-bright
  - the environment's directional lights (picked by ID, duplicated, turned by tracks) light the scenery in event colours
  - fog: BloomFogEnvironment on the environment, AnimateComponent, AssignFogTrack
- **Noodle Extensions**:
  - coordinates (null entries keep the vanilla lane), world/local rotation, per-object NJS/offset, fake objects
  - `disableNoteGravity`, `link` (cutting one cuts them all), `flip`, `disableBadCut…` switches
  - tracks with AnimateTrack / AssignPathAnimation (with blend durations) / AssignTrackParent (incl.
    `worldPositionStays`) / AssignPlayerToTrack; player tracks follow their parents
  - point definitions with all easings, splines, HSV colour lerp, quaternion-slerped rotations, modifiers
    (`opAdd` / `opSub` / `opMul` / `opDiv`) and base values (`baseHeadPosition`, `baseNote0Color`, …)
  - Noodle maps play at the map's own note speed and spawn timing (the Note Speed setting would break their
    choreography)
- **Mapping Extensions**:
  - extra lanes and layers, precise placement (±1000 values)
  - any-angle notes (cut directions 1000–1360, rotated dots 2000–2360)
  - precise wall width / height / start height (v2 `_type` 1000–4005000, v3 `w`/`h`)
  - precise 360° rotation values
  - the sabers reach further on maps that go past the normal grid
- Not supported: Vivify (Unity asset bundles), and moving or copying the base game's own scenery by ID
- Full lighting-event playback (lasers, rings, flashes) with bloom post-processing
- Scoring with combo multiplier (x1–x8), accuracy, ranks (SS–D), per-map high scores
- Energy bar with fail — or turn on **No Fail** in settings
- Settings (70+): controls, modifiers, sound (hit sound style, miss sound, **audio offset** for Bluetooth delay),
  look (note size, hit text style, sparks, cut halves, light brightness, **reduce flashing**), HUD (size,
  opacity, song timer, FPS counter), graphics, camera, replays — each section has its own Reset, plus Reset All
- Results show Perfect / Good / OK / bad cuts / misses / bombs and hits per hand
- **Camera**: field of view, height, distance and tilt for the play camera, changeable from the pause menu while
  playing (the paused picture updates as you drag); separate first-person and follow cameras for replays

## Performance & stability

- Walls are drawn in two instanced batches (one draw call each, however many a wall-art map shows) with
  shader-drawn edges; the costly distortion effect is limited to real walls near you. Animated environment
  pieces on model maps are instanced too, and notes only get their own material when their track really
  animates colour or dissolve. Shaders are compiled while the level loads, not at the first wall
- **Overload Protection**: if a map pushes the GPU into very slow frames (the step before a driver reset can
  take the whole browser down), the level switches to lighter graphics instead of freezing
- Songs that can't be decoded into memory (long songs on low-memory devices) are decoded at a lower sample
  rate, or streamed, instead of failing with "Unable to decode audio data". Long songs, or any song on a
  device with 4 GB of memory or less, decode at 32 kHz from the start (a third less memory)
- The library keeps each map's summary apart from its song and difficulty files: lists and searches never load
  every downloaded song into memory at once (that could crash the tab with a big library). Older libraries
  are converted automatically

- Notes, bombs, walls and effects share geometry/materials (no per-object GPU buffers); sparks and
  cut halves are pooled; per-object materials are freed as soon as an object leaves
- **Graphics Quality → Auto** lowers render resolution when frames run long and raises it again when there's headroom
- Over-bright Chroma lights/geometry are tamed and the bloom input is clamped (NaN/Inf-safe), so a
  map can no longer turn the screen solid white; lighting, fog and scenery reset after every level
- A lost WebGL context pauses the game and recovers; a level that keeps erroring is stopped instead of freezing

## Files

- `js/main.js` — bootstrap + game loop
- `js/game.js` — 3D engine, environment, lighting, gameplay, replay playback
- `js/menu.js` — all UI screens (incl. the replay browser)
- `js/replayui.js` — replay viewer controls (timeline, speed, cameras, live options)
- `js/online/` — accounts and multiplayer: `firebase.js` (loads the SDK), `account.js` (sign in, what's saved where),
  `authui.js` (sign-in screens, Settings → Account), `multiplayer.js` (presence, lobbies, matches), `lobbyui.js` (screens),
  `match.js` (a running match), `remote.js` (the other players' avatars and sabers)
- `js/looks.js` — saber styles and avatars (options, 3D models, list portraits); `js/customize.js` — the Customize screen
- `js/firebase-config.js` — your Firebase project's settings; `firebase/database.rules.json` — the database rules
- `js/editor/` — map editor: `model.js` (project data, undo, import / export), `view3d.js` (the 3D editing view), `overview.js` (the song strip),
  `editor.js` (screens, tools, playback, 3D preview, saving)
- `js/ui.js` — shared UI pieces (toasts, setting rows, camera/replay option lists)
- `js/beatmap.js` — v2/v3/v4 map parser (Chroma + Noodle)
- `js/noodle.js` — Noodle/Heck animation + track system
- `js/beatsaver.js` — BeatSaver API, zip extraction, IndexedDB library
- `js/beatleader.js` — BeatLeader API (players, scores, leaderboards, replay files)
- `js/bsor.js` — `.bsor` replay decoder, note matching, Beat Saber scoring
- `js/builtin.js` — procedural beatmap for the bundled track
- `js/input.js` — gamepad + virtual cursor
- `js/audio.js` — song clock + SFX
- `js/settings.js` — persistent settings + high scores
- `proxy/` — optional Cloudflare Worker for BeatLeader API access
