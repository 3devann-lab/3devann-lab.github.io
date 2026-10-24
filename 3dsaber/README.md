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
- **In game**: left stick = left saber, right stick = right saber. Flick the stick in the arrow's direction as the note reaches you. Avoid bombs and walls.
- **Start/Options** (or Esc) pauses.

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
While watching: **Esc / Start** pauses, **C / Y** switches between third-person and the player's first-person view.

**Players** and **Levels** need BeatLeader's API, which only answers browsers on beatleader.xyz and `localhost`
dev ports (`npx serve` on port 3000 works for local testing). On your own site, deploy the tiny free worker in
[`proxy/`](proxy/README.md) and paste its URL into **Settings → BeatLeader Proxy** (press **Test** to check it).
Without it the game falls back to free public relays, which are often down. Live and File / Link never need it.

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
- Settings: volumes, saber colors, note speed, cursor sensitivity, graphics quality, bloom toggle

## Performance & stability

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
