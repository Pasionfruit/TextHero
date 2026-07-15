# TextHero

A highly customizable keyboard rhythm game inspired by **DDR**, **Guitar Hero / Clone Hero**, and **osu!mania** — built with TypeScript, Canvas, and the Web Audio API. Runs in any modern browser on Windows, macOS, and Linux.

It ships with **Neon Circuit**, a built-in demo song that is *synthesized at runtime* (no audio assets), with five-key charts in all four difficulties, a full-keyboard chart, and two Letters-mode charts — so the game is playable the moment you start it.

The playfield is a **Guitar Hero-style 3D highway**: lanes converge to a vanishing point and notes are colored gems that grow as they approach the judgment line, with a deliberately minimal HUD.

## Quick start

```bash
npm install
npm run dev          # game at http://localhost:5173
npm run server       # optional: online-multiplayer lobby server (ws://localhost:8137)
npm run build        # typecheck + production build to dist/
```

## Features

### Gameplay
- **Five-Key mode** — Guitar Hero style, default bindings `D F SPACE J K`, fully rebindable per player (4 local binding sets).
- **Letters mode** — any letter A–Z can come down the highway as a lettered gem; press *that letter* on the beat. Gems are spread across five columns by physical keyboard position (left-hand letters fall on the left), and judging is per-letter.
- **Full Keyboard mode** — osu!mania/typing hybrid; the chart decides which keys appear (letters, digits, symbols), each with its own labeled lane.
- Tap notes, **sustain (hold) notes**, and **chords** (simultaneous notes are just multiple notes on one beat).
- Timing judgments **Perfect/Great/Good/Bad/Miss** (300/200/100/50/0), windows globally configurable in Settings, colorful judgment popups.
- **Combo & multiplier** (10→2x, 25→3x, 50→4x, 100→5x), multiplier resets on miss; live accuracy %, max combo.
- **Health/fail system** — accurate hits heal, misses/ghost taps/early-late (Bad) hits drain; zero health fails the song unless **No Fail** is on.
- Final **grade** SS/S/A/B/C/D/F with full per-judgment statistics.

### Modifiers & options
- Scroll **up or down**, plus **Reverse**, **Hidden** (notes fade near the line), **Sudden** (notes appear late), scroll-speed multiplier.
- Judgment-line position, note skins (**gems / bars / circles / arrows**), lane colors, note size, lane spacing, background dim, particles, FPS limit, fullscreen, hit sounds, custom font.
- **Accessibility**: colorblind-safe palette (Okabe–Ito), high-contrast mode, reduced effects, adjustable note size/spacing, one-handed play via rebinding.

### Songs & charts
- Upload **MP3 / WAV / OGG**; stored locally in IndexedDB with title, artist, BPM, offset, and optional album art.
- **Chart editor**: vertical timeline with **waveform**, BPM editor + tap-BPM, offset adjustment, snap divisions **1/1 – 1/32 incl. 1/24**, click-to-place, drag-to-move, drag-down for holds, right-click delete, box select, copy/paste, undo/redo, multiple difficulty charts per song (Easy/Medium/Hard/Expert × mode), instant **test play (F5)** that returns to the editor, JSON export.

### Practice, replays, leaderboards
- **Practice mode**: 0.5×/0.75×/1×/1.25×/1.5× rates and A–B section looping (`[` `]` `\` in-game). Practice never touches leaderboards.
- **Replays**: every solo performance records all inputs with timing; watch any leaderboard entry with pause/seek controls. Playback is deterministic — the replay re-runs the real judging engine.
- **Local leaderboards** per song/difficulty/mode: score, accuracy, grade, max combo, date, No-Fail flag.

### Multiplayer (1–4 players)
- **Local** (one keyboard): each player gets their own lanes and binding set.
  - **Band (co-op)** — optional shared health and shared combo/score pools; the run fails only when shared health empties.
  - **Competitive** — individual scores; winner by score → accuracy → max combo.
- **Online**: bundled Node WebSocket server (`npm run server`). Public/private lobbies with 4-letter codes, player limit, ready-up, host-controlled song/chart (chart + audio are pushed to all players automatically), synchronized start, **live leaderboard overlay** during play, final match rankings.

## Latency & sync design

- Song time derives from the **AudioContext clock**, not wall-clock or frame timing — note movement is frame-rate independent and stays locked to the audio.
- Reported device output latency (`AudioContext.outputLatency`) is compensated automatically; a manual **audio offset** and separate **visual offset** are in Settings for fine calibration.
- Key events are timestamped with `event.timeStamp` and mapped back through the audio clock, giving **sub-frame input timing** even at low FPS. Pause uses `AudioContext.suspend()`, which freezes the audio clock — resuming introduces zero drift.
- The judging engine is fully deterministic over (chart, input timestamps), which is what makes replays exact and online play fair without server-side simulation.
- NKRO: the game listens to raw per-key `keydown`/`keyup` events, so rollover is limited only by your keyboard hardware.

## Architecture

```
src/
  main.ts               app boot, screen router, demo-song seeding
  app.ts                shared types for screens/params
  types.ts              chart/score/replay data model, scoring constants
  audio/AudioEngine.ts  AudioContext, decoding, latency, hit sounds
  audio/demoSong.ts     procedural demo track + event tables for demo charts
  charts/chart.ts       beat↔ms conversion, chart compilation, demo charts
  engine/Conductor.ts   audio-clock song timing, count-in, pause/seek
  engine/GameSession.ts deterministic judging/score/combo/health engine
  input/Keyboard.ts     input router (code- and key-based bindings)
  render/Playfield.ts   canvas note renderer, skins, modifiers, HUD, particles
  net/NetClient.ts      WebSocket lobby client
  screens/              menu, song select, gameplay, results, editor, settings, lobby
  store/db.ts           IndexedDB (songs, charts, audio blobs, scores, replays)
  store/settings.ts     settings model + persistence
server/server.mjs       lobby/relay server (ws)
```

Charts store note positions in **beats** (plus per-song BPM/offset), so re-timing a song re-times every chart. At play time notes are compiled to milliseconds and judged against the audio clock.

## Not yet implemented (future work)

Background videos, auto-charting from onset detection, chart import UI, community chart sharing, ranked matchmaking, seasonal events/daily challenges, tournament/spectator modes, ghost replays, controller/MIDI/dance-pad input, VR, achievements, themes. Online band mode (shared pools over the network) — band is currently local-only; online is competitive.
