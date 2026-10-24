# MOSU Guide

MOSU is a rhythm game: arrows fly down a neon tunnel toward the ring, and you press the
matching direction the moment each one reaches it.

## Controls

| Input | Up | Down | Left | Right | Pause |
|---|---|---|---|---|---|
| Keyboard | `W` / `↑` / `I` | `S` / `↓` / `K` | `A` / `←` / `J` | `D` / `→` / `L` | `Esc` / `P` |
| Controller | D-pad ↑ / `Y` | D-pad ↓ / `A` | D-pad ← / `X` | D-pad → / `B` | Start |
| Phone / tablet | swipe up | swipe down | swipe left | swipe right | ❚❚ button |

A controller's left stick also works (flick it), and the D-pad + `A`/`B` navigate the menus.

## Notes

- **Tap** — press the arrow's direction. Each direction has its own color.
- **Star** — any direction counts (a tap counts on phones).
- **Hold** — press, then keep holding until the trail behind the arrow ends.
- **Flip** (purple, crossed-out arrow) — press the **opposite** direction.
- **Diagonal** (white outline) — press **both** directions at once (↘ = down + right).

Timing windows: **Perfect** ±45 ms, **Great** ±90 ms, **Good** ±135 ms (Settings → *Relaxed* widens them by 40%).
Every 10 combo raises your multiplier by 0.5, up to x3. Misses drain the health bar; run out and the level fails
(unless *No fail* is on). Grades: SS (98% and no misses), S 94%, A 88%, B 80%, C 70%, D.

If your hits feel consistently early or late, use **Settings → Audio offset → Calibrate**, or press
**Adjust offset** on the results screen — it measures your average timing for you.

## Levels

30 levels in five packs, from one star to ten:

| Pack | Stars | What's new |
|---|---|---|
| First Light | ★1–2 | the basics, star notes |
| City Pulse | ★3–4 | holds |
| Overclock | ★5–6 | streams, flips |
| Hyperspace | ★7–8 | diagonals |
| Singularity | ★9–10 | everything, fast |

Clear 3 levels in a pack to unlock the next (or turn on *Unlock all packs* in Settings).
Every level's song is composed and synthesized right in your browser (synthwave, house, techno, trance,
drum & bass, chiptune, trap, future bass, lo-fi), and the arrows are charted from that music,
so they always land on something you can hear.

**Endless** has two modes:
- *Endless Remix* — a new track every day that loops forever, getting denser and faster each loop.
- *Endless Classic* — the original MOSU loop with random arrows that keep speeding up.

## Making your own levels

Open **Level Editor** from the main menu.

1. **Pick a song** — *Upload…* any MP3/OGG/WAV, or choose a *MOSU track* to remix one of the built-in songs.
2. **Set the tempo** — type the BPM, use **Tap** (tap along 4+ times), or let **Auto-chart** detect it.
   *Beat offset* moves the grid so the lines sit on the beats.
3. **Add notes**, any mix of:
   - **✨ Auto-chart** — MOSU listens to the song and places arrows on its beats and hits. The density slider goes from relaxed (1) to intense (10).
   - **● Record** — the song plays and every key you press becomes a note at that moment. Hold a key to make a hold note.
   - **Click the timeline** to drop the selected arrow (pick it from ↑ → ↓ ← ★). The snap buttons (1/1 … 1/8) lock notes to the beat grid.
4. **Edit** — click a note to select it, then `W A S D` changes its direction, `F` makes it a flip, `H` toggles a hold
   (`[` / `]` shortens/lengthens it), `Delete` removes it. `Space` plays/pauses; the mouse wheel scrolls, `Ctrl` + wheel zooms.
5. **Test Play** to try it, **Save** to keep it in *My Levels*, **Export .zip** to share it.

### Sharing and importing

*My Levels → Import .zip* (or *Import .zip* in the editor) loads a level someone sent you. A level zip contains
a `.json` level file and the song (`.mp3`, `.ogg` or `.wav`) — the files can be in any folder inside the zip.

### Level file format

```json
{
  "format": "mosu",
  "version": 2,
  "title": "My Level",
  "artist": "Someone",
  "bpm": 128,
  "offset": 0,
  "approach": 1400,
  "notes": [
    { "t": 1875, "d": "up" },
    { "t": 2344, "d": "right", "hold": 469 },
    { "t": 2813, "d": "left", "flip": true },
    { "t": 3281, "d": "down", "d2": "right" },
    { "t": 3750, "d": "any" }
  ]
}
```

- `t` — when the note reaches the ring, in milliseconds from the start of the song.
- `d` — `up`, `down`, `left`, `right` or `any`; `d2` adds a second direction (diagonal).
- `hold` — hold length in ms. `flip: true` — press the opposite direction.
- `approach` — how long (ms) each arrow is visible before it hits; `offset` — beat-grid offset in ms; `bpm` — for the grid.

Levels made with the old editor (`bpm`, `noteDuration`, `gapBetweenNotes`, `notes: [{ "direction": "up" }]`)
still import and play — their notes are spaced `gapBetweenNotes` ms apart.
