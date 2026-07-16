# TextHero

A highly customizable keyboard rhythm game inspired by **DDR**, **Guitar Hero / Clone Hero**, and **osu!mania** — built with TypeScript, Canvas, and the Web Audio API. Runs in any modern browser on Windows, macOS, and Linux.

It ships with **Neon Circuit**, a built-in demo song that is *synthesized at runtime* (no audio assets), with five-key charts in all four difficulties, a full-keyboard chart, and two Letters-mode charts — so the game is playable the moment you start it.

The playfield is a **Guitar Hero-style 3D highway**: lanes converge to a vanishing point and notes are colored gems that grow as they approach the judgment line, with a deliberately minimal HUD.

## Quick start

```bash
npm install
npm run dev          # game at http://localhost:5173
npm run server       # multiplayer lobby + global leaderboard API (http://localhost:8137)
npm run build        # typecheck + production build to dist/
```

Requires **Node ≥ 22.13** (the leaderboard uses the built-in `node:sqlite` module). Run the server alongside `npm run dev` if you want the global leaderboard while developing; without it the game still works, showing local scores only.

## Deploying (Render)

`node server/server.mjs` serves the **built game and the WebSocket lobby on one port**, so a single Render Web Service runs everything — no separate static site needed. The repo includes a [render.yaml](render.yaml) blueprint.

1. Push the repo to GitHub.
2. On [render.com](https://render.com): **New → Blueprint**, select this repo, **Apply**. (Or **New → Web Service** manually: build command `npm install --include=dev && npm run build`, start command `node server/server.mjs`.)
3. Open the service URL. Done — the client automatically connects multiplayer to its own host over `wss://`, so online lobbies work out of the box.

### Making the global leaderboard durable

The server stores global scores in SQLite on local disk by default — but **Render's free tier has an ephemeral filesystem**, so that file is wiped on every deploy and every idle spin-down, and the leaderboard silently resets. To make scores permanent, point the server at any Postgres database via a single env var:

1. Create a free Postgres database — [neon.tech](https://neon.tech) has a durable free tier (no card required). Copy its connection string (`postgres://user:pass@host/db?sslmode=require`).
2. In the Render dashboard: your service → **Environment** → add `DATABASE_URL` = that connection string → save (Render redeploys automatically).
3. Check the deploy logs for `Leaderboard store: Postgres (durable)` — from then on scores survive deploys, restarts, and spin-downs, and every machine sees the same board.

Also set `ADMIN_USER` / `ADMIN_PASS` env vars there to override the admin-login defaults, which are visible to anyone reading this public repo.

Notes:
- The **free plan spins down** after ~15 min of inactivity; the first visit afterwards takes up to a minute to wake.
- Songs, charts, and replays live in each player's **browser (IndexedDB)**; uploaded songs are shared to lobby members over the WebSocket at play time.
- The **global leaderboard** lives in a SQLite file on the server (`DATA_DIR/leaderboard.db`, default `./data`). Render's free-tier disk is **ephemeral** — scores reset on every deploy. To keep them, attach a persistent disk (paid instance) and set `DATA_DIR` to its mount path; see the comments in [render.yaml](render.yaml).

## Features

### Gameplay
- **Five-Key mode** — Guitar Hero style, default bindings `D F SPACE J K`, fully rebindable per player (4 local binding sets).
- **Letters mode** — any letter A–Z can come down the highway as a lettered gem; press *that letter* on the beat. Gems are spread across five columns by physical keyboard position (left-hand letters fall on the left), and judging is per-letter.
- **Full Keyboard mode** — osu!mania/typing hybrid; the chart decides which keys appear (letters, digits, symbols), each with its own labeled lane.
- Tap notes, **sustain (hold) notes**, and **chords** (simultaneous notes are just multiple notes on one beat).
- Timing judgments **Perfect/Great/Good/Bad/Miss** (300/200/100/50/0) with colorful judgment popups. Judgment windows are **fixed for everyone** so leaderboard scores stay comparable.
- **Combo & multiplier** (10→2x, 25→3x, 50→4x, 100→5x), multiplier resets on miss; live accuracy %, max combo.
- **Health/fail system** — accurate hits heal, misses/ghost taps/early-late (Bad) hits drain; zero health fails the song unless **No Fail** is on.
- Final **grade** SS/S/A/B/C/D/F with full per-judgment statistics.

### Modifiers & options
- Scroll **up or down**, plus **Reverse**, **Hidden** (notes fade near the line), **Sudden** (notes appear late), scroll-speed multiplier.
- Judgment-line position, note skins (**gems / bars / circles / arrows**), lane colors, note size, lane spacing, background dim, particles, FPS limit, fullscreen, hit sounds, custom font, **master volume** (also adjustable from the in-game pause menu via ⚙ Settings).
- **Dark / light theme** — toggle from the main menu or Settings → Visuals; the chart editor's timeline follows the theme (the gameplay highway stays dark by design).
- **Accessibility**: colorblind-safe palette (Okabe–Ito), high-contrast mode, reduced effects, adjustable note size/spacing, one-handed play via rebinding.

### Songs & charts
- **Bundled library**: every `Title - Artist.mp3` dropped into `src/audio/` ships with the build. On first boot each one is decoded, analyzed, and auto-charted in the background — songs appear in Song Select one by one. Bundled songs get deterministic IDs derived from the filename, so every player shares the same global leaderboard per chart.
- **Song select browsing**: filter box (search by title/artist), scroll-wheel/arrow-key selection, and cards showing **genre, duration, and BPM**. The **album art doubles as a preview button** — click it to hear a faded 12-second snippet from the hook of the song. Bundled songs ship with curated genres; uploads can set one in the upload dialog.
- Upload **MP3 / WAV / OGG**; stored locally in IndexedDB with title, artist, BPM, offset, and optional album art.
- **Automatic sample levels**: every upload is analyzed (3-band onset detection via an offline filter pass) and playable charts are generated instantly — five-key Easy/Medium/Hard plus a Letters chart. **BPM and offset are auto-detected** (autocorrelation tempo + grid-phase fit) when left blank; enter a BPM to lock it and only fit the phase. **Notes sit on the actual audio hits** — onsets within ~80 ms merge into one event anchored on the loudest, soft-snapping to the beat grid only when already close, so an imperfect BPM estimate can't drag notes off the sound; when hits crowd tighter than the difficulty allows, the loudest wins. Kicks anchor the outer lanes, hats the inner ones, melodic onsets walk the middle lanes, and sustained mid-band energy becomes **hold notes** (envelope-decay tracked, spaced out with a cooldown so they punctuate rather than dominate). The editor's **✨ Auto-fill** button regenerates any chart (any mode/difficulty) from the audio, undoable with Ctrl+Z. Bundled songs regenerate their charts automatically when the generator improves (hand-edited charts are never touched).
- **Chart editor**: vertical timeline with **waveform**, a **transport scrubber** (play/pause + draggable seek bar with live timecode) to jump anywhere in the song while placing notes, BPM editor + tap-BPM, offset adjustment, snap divisions **1/1 – 1/32 incl. 1/24**, click-to-place, drag-to-move, drag-down for holds, right-click delete, box select, copy/paste, undo/redo, multiple difficulty charts per song (Easy/Medium/Hard/Expert × mode), instant **test play (F5)** that returns to the editor, JSON export.

### Practice, replays, leaderboards
- **Practice mode**: 0.5×/0.75×/1×/1.25×/1.5× rates and A–B section looping (`[` `]` `\` in-game). Practice never touches leaderboards.
- **Replays**: every solo performance records all inputs with timing; watch any leaderboard entry with pause/seek controls. Playback is deterministic — the replay re-runs the real judging engine.
- **Global leaderboard** (server-side SQLite): after a solo run you can **save it under any name** — it's submitted to the shared board and your global rank comes back — or **discard it**, which also deletes the local score and replay. The server keeps each player name's best run per chart; only 1×-rate runs are ranked. API: `GET /api/leaderboard?chartId=…` and `POST /api/scores`.
- **Admin moderation**: log in under Settings → Admin to get edit/delete buttons on every global leaderboard. Credentials are verified server-side (`POST /api/admin/login` issues a 12-hour bearer token held in memory); defaults are set in `server/server.mjs` and should be overridden with the `ADMIN_USER` / `ADMIN_PASS` env vars in production. Admin endpoints: `PATCH`/`DELETE /api/admin/scores?id=…`.
- **Local scores** per song/difficulty/mode (score, accuracy, grade, max combo, date, No-Fail flag) stay on-device and keep their watchable replays.

### Multiplayer (1–4 players)
- **Local** (one keyboard): each player gets their own lanes and binding set.
  - **Band (co-op)** — optional shared health and shared combo/score pools; the run fails only when shared health empties.
  - **Competitive** — individual scores; winner by score → accuracy → max combo.
- **Online**: bundled Node WebSocket server (`npm run server`). Public/private lobbies with 4-letter codes, player limit, ready-up, host-controlled song/chart (chart + audio are pushed to all players automatically), synchronized start, **live leaderboard overlay** during play, final match rankings.
- **Live opponent playfields**: during an online match, every player's game renders side by side at equal size — your field plus one per opponent, present from the countdown. Their raw inputs stream over the WebSocket and are replayed through the same deterministic judging engine locally (on a clock ~0.5 s behind to absorb network latency), so you see their actual notes, hits, misses, holds, and health — not just a score ticker.
- **Synced pause**: any player pausing (gear icon or Esc) pauses the match for everyone — the panel shows who paused — and any player can resume. Restart is disabled during online matches to keep clients in sync.

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
  charts/autochart.ts   onset detection, BPM/offset estimation, auto chart generation
  engine/Conductor.ts   audio-clock song timing, count-in, pause/seek
  engine/GameSession.ts deterministic judging/score/combo/health engine
  input/Keyboard.ts     input router (code- and key-based bindings)
  render/Playfield.ts   canvas note renderer, skins, modifiers, HUD, particles
  net/NetClient.ts      WebSocket lobby client
  net/api.ts            REST client for the global leaderboard
  screens/              menu, song select, gameplay, results, editor, settings, lobby
  store/db.ts           IndexedDB (songs, charts, audio blobs, scores, replays)
  store/bundled.ts      background importer for the mp3s bundled from src/audio
  store/settings.ts     settings model + persistence
server/server.mjs       lobby/relay server (ws) + global leaderboard (SQLite)
```

Charts store note positions in **beats** (plus per-song BPM/offset), so re-timing a song re-times every chart. At play time notes are compiled to milliseconds and judged against the audio clock.

## Not yet implemented (future work)

Background videos, tempo-change (variable BPM) support in auto-charting, chart import UI, community chart sharing, ranked matchmaking, seasonal events/daily challenges, tournament/spectator modes, ghost replays, controller/MIDI/dance-pad input, VR, achievements, themes. Online band mode (shared pools over the network) — band is currently local-only; online is competitive.
