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
- **⚙ Options** changes everything live while you watch:
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
- **Chroma** note/light/wall colors, gradients, legacy RGB events, environment geometry ("model maps"), fog
- **Noodle Extensions**: coordinates, world/local rotation, per-object NJS/offset, fake objects, `disableNoteGravity`,
  tracks with AnimateTrack / AssignPathAnimation (with blend durations) / AssignTrackParent / AssignPlayerToTrack,
  point definitions, all easings, splines, HSV color lerp, quaternion-slerped rotations
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
  rate, or streamed, instead of failing with "Unable to decode audio data"

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
