import type { AppCtx, PlayParams, PlayerResult, ResultsParams, Screen } from '../app';
import { Conductor } from '../engine/Conductor';
import { GameSession } from '../engine/GameSession';
import { InputRouter } from '../input/Keyboard';
import { Playfield } from '../render/Playfield';
import { compileNotes, laneCountOf, LETTERS } from '../charts/chart';
import { multiplierFor } from '../types';
import type { JudgeEvent, ReplayData, ReplayEventRec, ScoreRecord } from '../types';
import { COUNTDOWN_SFX, START_SFX } from '../audio/uiSounds';
import { applyTheme } from '../store/settings';
import { icon } from '../ui/icons';
import { clamp, codeLabel, el, fmtTime, isMobile, toast, uid } from '../util';
import { volumeRow } from './settings';

interface BandState {
  health: number;
  combo: number;
  maxCombo: number;
  score: number;
  failed: boolean;
}

export function playScreen(root: HTMLElement, ctx: AppCtx, params: PlayParams): Screen {
  const { song, chart, players, rate, band } = params;
  const replay = params.replay ?? null;
  const isReplay = !!replay;
  const noFail = params.noFail || params.practice || !!params.test || isReplay;
  const laneCount = laneCountOf(chart);
  const s = ctx.settings;

  // game-start fanfare for real runs (solo + multiplayer; not replays/test-play)
  if (!isReplay && !params.test && s.uiSounds) void ctx.audio.playUiSound(START_SFX, 0.8);
  // the count-in must last at least as long as the countdown sound — the song
  // only starts once the countdown has finished (resolved during boot)
  let countLeadMs = 2200;

  const conductor = new Conductor(ctx.audio);
  const input = new InputRouter();
  let sessions: GameSession[] = [];
  let playfields: Playfield[] = [];
  let bandState: BandState | null = band ? { health: 100, combo: 0, maxCombo: 0, score: 0, failed: false } : null;
  const recorded: ReplayEventRec[] = [];
  let replayCursor = 0;
  let rafId = 0;
  let lastFrame = 0;
  let ended = false;
  let destroyed = false;
  let paused = false;
  let startMs = params.test ? Math.max(0, params.test.fromMs) : params.practice && params.loopStartMs ? params.loopStartMs : 0;
  let loopStartMs = params.practice ? params.loopStartMs ?? null : null;
  let loopEndMs = params.practice ? params.loopEndMs ?? null : null;
  let lastProgressSent = 0;
  let sentEventCursor = 0;
  const onlineOthers = new Map<string, any>();

  // ---- fever: press Enter on a long streak for momentary double points.
  // The bonus rides OUTSIDE the deterministic engine: it accrues while fever
  // is active, is forfeited if the streak breaks, and banks when fever ends.
  const FEVER_MIN_COMBO = 25;
  const FEVER_MS = 10000;
  const FEVER_COOLDOWN_MS = 45000;
  let feverOn = false;
  let feverUntil = 0;
  let feverCooldownUntil = 0;
  let feverExtra = 0; // at-risk bonus during the active fever
  let feverBanked = 0; // bonus kept from completed fevers
  const feverEligible = players.length === 1 && !band && !isReplay;
  const displayScore = (): number => (sessions[0]?.score ?? 0) + feverBanked + feverExtra;

  function tryFever(): void {
    if (!feverEligible || feverOn || paused || ended) return;
    if (performance.now() < feverCooldownUntil) return; // once every 45s
    if ((sessions[0]?.combo ?? 0) < FEVER_MIN_COMBO) return;
    feverOn = true;
    feverUntil = performance.now() + FEVER_MS;
    feverCooldownUntil = performance.now() + FEVER_COOLDOWN_MS;
    wrap.classList.add('fever');
    document.body.classList.add('fever-bg'); // set the backdrop waves in motion
  }

  function endFever(forfeit: boolean): void {
    if (!feverOn && feverExtra === 0) return;
    if (forfeit) feverExtra = 0;
    else {
      feverBanked += feverExtra;
      feverExtra = 0;
    }
    feverOn = false;
    feverUntil = 0;
    wrap.classList.remove('fever');
    document.body.classList.remove('fever-bg');
  }
  let netOff: Array<() => void> = [];

  // ---- layout ----
  root.innerHTML = '';
  const wrap = el('div', { class: 'play-wrap' });
  const fieldRow = el('div', { class: 'play-fields' });
  wrap.append(fieldRow);
  const overlay = el('div', { class: 'play-overlay hide' });
  wrap.append(overlay);
  const topBar = el('div', { class: 'play-topbar' });
  wrap.append(topBar);
  const lbBox = el('div', { class: 'play-leaderboard hide' });
  wrap.append(lbBox);
  if (!isReplay) {
    wrap.append(
      el('button', {
        class: 'btn sm play-gear',
        title: 'Pause — resume, restart, volume (Esc)',
        onclick: () => (paused ? resumeGame() : pauseGame()),
      }, icon('gear', 16)),
    );
  }
  root.append(wrap);

  const labelsFor = (codes?: string[]): string[] =>
    chart.mode === 'keyboard' ? chart.keys : chart.mode === 'letters' ? [] : (codes ?? s.bindings[0]).map(codeLabel);

  const canvases: HTMLCanvasElement[] = [];
  for (let i = 0; i < players.length; i++) {
    const holder = el('div', { class: 'play-field' });
    const canvas = el('canvas');
    holder.append(canvas);
    fieldRow.append(holder);
    canvases.push(canvas);
    playfields.push(new Playfield(canvas, { mode: chart.mode, laneCount, labels: labelsFor(players[i].codes ?? s.bindings[i]) }, s));
  }

  const buildSessions = () => {
    sessions = players.map(
      (_, i) =>
        new GameSession({
          notes: compileNotes(song, chart),
          laneCount,
          windows: { ...s.windows },
          noFail,
          ownHealth: !band?.sharedHealth,
          onEvent: (ev) => onJudge(i, ev),
        }),
    );
  };
  buildSessions();

  const lastNoteEnd = sessions[0].notes.length
    ? Math.max(...sessions[0].notes.map((n) => n.endMs))
    : song.durationMs;
  const endMs = Math.min(song.durationMs + 500, lastNoteEnd + 3000);

  function onJudge(playerIdx: number, ev: JudgeEvent): void {
    if (playerIdx === 0 && feverEligible) {
      if (ev.type === 'hit' && feverOn) {
        feverExtra += ev.baseScore * multiplierFor(ev.comboAfter); // doubles the hit
      } else if (ev.comboAfter === 0 && ev.type !== 'hit' && ev.type !== 'holdComplete' && (feverOn || feverExtra > 0)) {
        endFever(true); // streak broken — the double points are lost
      }
    }
    const pf = playfields[playerIdx];
    if (ev.type === 'hit') {
      pf.setJudgment(ev.judgment!);
      pf.burst(ev.lane);
      if (s.hitSounds && !isReplay) ctx.audio.playHitSound(ev.judgment === 'perfect');
    } else if (ev.type === 'miss') {
      pf.setJudgment('miss');
      if (s.hitSounds && !isReplay && !s.reducedEffects) ctx.audio.playMissSound();
    } else if (ev.type === 'holdDrop') {
      pf.setJudgment('bad');
    }
    if (bandState) {
      if (band!.sharedCombo) {
        if (ev.type === 'hit') {
          bandState.combo++;
          bandState.maxCombo = Math.max(bandState.maxCombo, bandState.combo);
        } else if (ev.type === 'miss' || ev.type === 'holdDrop') {
          bandState.combo = 0;
        }
        bandState.score += ev.baseScore * multiplierFor(bandState.combo);
      }
      if (band!.sharedHealth) {
        bandState.health = clamp(bandState.health + ev.healthDelta, 0, 100);
        if (bandState.health <= 0 && !noFail) bandState.failed = true;
      }
    }
  }

  function hudFor(i: number) {
    const sess = sessions[i];
    if (bandState) {
      return {
        score: band!.sharedCombo ? bandState.score : sessions.reduce((a, x) => a + x.score, 0),
        combo: band!.sharedCombo ? bandState.combo : sess.combo,
        multiplier: multiplierFor(band!.sharedCombo ? bandState.combo : sess.combo),
        accuracy: sess.accuracy(),
        health: band!.sharedHealth ? bandState.health : sess.health,
        failed: bandState.failed || sess.failed,
        name: players[i].name,
      };
    }
    return {
      score: i === 0 ? displayScore() : sess.score,
      combo: sess.combo,
      multiplier: sess.multiplier(),
      accuracy: sess.accuracy(),
      health: sess.health,
      failed: sess.failed,
      name: players[i].name,
      fever: i === 0 && feverOn,
      feverReady:
        i === 0 && feverEligible && !feverOn && sess.combo >= FEVER_MIN_COMBO && performance.now() >= feverCooldownUntil,
      feverCooldownSec:
        i === 0 && feverEligible && !feverOn && sess.combo >= FEVER_MIN_COMBO && performance.now() < feverCooldownUntil
          ? Math.ceil((feverCooldownUntil - performance.now()) / 1000)
          : undefined,
    };
  }

  // ---- input (keyboard everywhere; lane taps on touch devices) ----
  const handleInput = (player: number, lane: number, down: boolean, ts: number): void => {
    if (paused || ended) return;
    const sess = sessions[player];
    if (!sess || sess.failed || bandState?.failed) return;
    const t = conductor.eventMs(ts);
    playfields[player].pressLane(lane, down);
    if (t < startMs - 400) return; // count-in: light up receptors but don't judge
    if (player === 0 && players.length === 1) recorded.push({ t, lane, down });
    if (down) sess.press(lane, t);
    else sess.release(lane, t);
  };

  if (!isReplay) {
    if (chart.mode === 'five') {
      players.forEach((p, i) => input.bindFive(i, p.codes ?? s.bindings[i] ?? s.bindings[0]));
    } else if (chart.mode === 'keyboard') {
      input.bindKeys(0, chart.keys);
    } else {
      input.bindKeys(0, LETTERS.split('')); // letters mode: lane index == letter index
    }
    input.attach(handleInput);

    // mobile: the field is split into equal tap columns, one per lane;
    // multi-touch works so chords and holds play naturally
    if (isMobile() && canvases[0]) {
      const cv = canvases[0];
      const touchLane = new Map<number, number>();
      const laneAt = (clientX: number): number => {
        const r = cv.getBoundingClientRect();
        return clamp(Math.floor(((clientX - r.left) / r.width) * laneCount), 0, laneCount - 1);
      };
      const onTouch = (e: TouchEvent): void => {
        e.preventDefault();
        const down = e.type === 'touchstart';
        for (const t of Array.from(e.changedTouches)) {
          if (down) {
            const lane = laneAt(t.clientX);
            touchLane.set(t.identifier, lane);
            (window as any).__lastTouchLane = lane; // debug/testing hook
            handleInput(0, lane, true, e.timeStamp);
          } else {
            const lane = touchLane.get(t.identifier);
            touchLane.delete(t.identifier);
            if (lane !== undefined) handleInput(0, lane, false, e.timeStamp);
          }
        }
      };
      cv.addEventListener('touchstart', onTouch, { passive: false });
      cv.addEventListener('touchend', onTouch, { passive: false });
      cv.addEventListener('touchcancel', onTouch, { passive: false });
    }
  }

  // ---- pause menu / hotkeys ----
  const onKey = (e: KeyboardEvent) => {
    if (e.code === 'Escape') {
      e.preventDefault();
      if (ended) return;
      if (isReplay) return finish();
      paused ? resumeGame() : pauseGame();
    }
    if (e.code === 'Semicolon') {
      // fever key — unless ';' is actually one of this chart's lanes
      const semiIsLane =
        (chart.mode === 'keyboard' && chart.keys.includes(';')) ||
        (chart.mode === 'five' && players.some((p, i) => (p.codes ?? s.bindings[i] ?? s.bindings[0])?.includes('Semicolon')));
      if (!semiIsLane) {
        e.preventDefault();
        tryFever();
      }
    }
    if (params.practice && !paused && !ended) {
      const now = conductor.nowMs();
      if (e.code === 'BracketLeft') {
        loopStartMs = Math.max(0, now);
        toast(`Loop start: ${fmtTime(loopStartMs)}`);
      } else if (e.code === 'BracketRight') {
        loopEndMs = now;
        toast(`Loop end: ${fmtTime(loopEndMs)}`);
      } else if (e.code === 'Backslash') {
        loopStartMs = loopEndMs = null;
        toast('Loop cleared');
      }
    }
  };
  window.addEventListener('keydown', onKey);

  let pausedAtWall = 0;
  function pauseGame(byName?: string, fromNet = false): void {
    if (ended || paused) return;
    paused = true;
    pausedAtWall = performance.now(); // fever timers freeze while paused
    void conductor.pause();
    if (!fromNet && params.online && ctx.net.isConnected()) ctx.net.send('pause', { paused: true });
    overlay.classList.remove('hide');
    overlay.innerHTML = '';
    overlay.append(
      el('div', { class: 'panel pause-panel' },
        el('h2', null, byName ? `Paused by ${byName}` : 'Paused'),
        params.online && el('div', { class: 'muted sm' }, 'The match is paused for everyone.'),
        el('button', { class: 'btn primary', onclick: () => resumeGame() }, 'Resume'),
        !params.online && el('button', { class: 'btn', onclick: () => restart() }, 'Restart'),
        el('div', { class: 'pause-settings' }, volumeRow(ctx), pauseThemeRow()),
        el('button', { class: 'btn danger', onclick: () => quit() }, 'Quit'),
      ),
    );
  }

  /** The fixed top-right theme toggle is hidden in-game; pause carries one instead. */
  function pauseThemeRow(): HTMLElement {
    const btn = el('button', {
      class: 'btn sm',
      title: 'Toggle light / dark mode',
      onclick: () => {
        s.theme = s.theme === 'light' ? 'dark' : 'light';
        applyTheme(s);
        ctx.saveSettings();
        btn.replaceChildren(icon(s.theme === 'light' ? 'moon' : 'sun'));
      },
    }, icon(s.theme === 'light' ? 'moon' : 'sun'));
    return el('div', { class: 'form-row' }, el('label', null, 'Theme'), btn);
  }

  let resuming = false;
  function resumeGame(fromNet = false): void {
    if (!paused || resuming) return;
    if (!fromNet && params.online && ctx.net.isConnected()) ctx.net.send('pause', { paused: false });
    const finish = (): void => {
      if (destroyed) return;
      // shift the fever clock forward by however long we sat paused
      if (pausedAtWall) {
        const frozen = performance.now() - pausedAtWall;
        if (feverCooldownUntil) feverCooldownUntil += frozen;
        if (feverOn) feverUntil += frozen;
        pausedAtWall = 0;
      }
      overlay.classList.add('hide');
      void conductor.resume().then(() => {
        paused = false;
        resuming = false;
      });
    };
    if (!isReplay && s.uiSounds) {
      // hold the game frozen until the countdown sound has finished
      resuming = true;
      overlay.innerHTML = '';
      overlay.append(el('div', { class: 'panel pause-panel' }, el('h2', null, 'Get ready…')));
      void ctx.audio.playUiSound(COUNTDOWN_SFX, 0.7);
      void ctx.audio.uiSoundDuration(COUNTDOWN_SFX).then((sec) => {
        setTimeout(finish, Math.max(0, sec * 1000 - 80));
      });
    } else {
      finish();
    }
  }

  function restart(): void {
    overlay.classList.add('hide');
    paused = false;
    ended = false;
    endFever(true);
    feverBanked = 0;
    feverCooldownUntil = 0;
    recorded.length = 0;
    replayCursor = 0;
    buildSessions();
    if (bandState) bandState = { health: 100, combo: 0, maxCombo: 0, score: 0, failed: false };
    startPlayback(startMs, Math.max(2000, countLeadMs));
  }

  function quit(): void {
    ended = true;
    conductor.stop();
    if (params.test) ctx.nav('editor', { resume: params.test.resume });
    else if (params.online) ctx.nav('lobby', {});
    else ctx.nav('songselect', { songId: song.id });
  }

  // ---- replay seek/controls ----
  if (isReplay) {
    const bar = el('div', { class: 'replay-bar' },
      el('span', { class: 'muted' }, `REPLAY — ${replay!.player}`),
      el('button', { class: 'btn sm', title: 'Play/pause', onclick: () => (paused ? resumeGame() : pauseGame2()) }, icon('pause')),
      el('button', { class: 'btn sm', onclick: () => seekReplay(-5000) }, '-5s'),
      el('button', { class: 'btn sm', onclick: () => seekReplay(5000) }, '+5s'),
      el('button', { class: 'btn sm', title: 'Back to start', onclick: () => seekReplayTo(0) }, icon('rewind')),
      el('button', { class: 'btn sm danger', onclick: () => finish() }, 'Exit'),
    );
    topBar.append(bar);
    function pauseGame2() {
      paused = true;
      void conductor.pause();
    }
  }

  function seekReplay(deltaMs: number): void {
    seekReplayTo(clamp(conductor.nowMs() + deltaMs, 0, endMs - 100));
  }

  function seekReplayTo(toMs: number): void {
    buildSessions();
    replayCursor = 0;
    while (replayCursor < replay!.events.length && replay!.events[replayCursor].t <= toMs) {
      const ev = replay!.events[replayCursor++];
      if (ev.down) sessions[0].press(ev.lane, ev.t);
      else sessions[0].release(ev.lane, ev.t);
      sessions[0].update(ev.t);
    }
    sessions[0].update(toMs);
    paused = false;
    conductor.seek(toMs, 350);
  }

  // ---- online: live view of the other players' gameplay ----
  // Their inputs stream in with the progress messages; the deterministic
  // judging engine replays them into a playfield rendered beside ours. The
  // remote view runs slightly behind real time to absorb network latency.
  const REMOTE_VIEW_DELAY = 500;
  interface RemoteView {
    name: string;
    session: GameSession;
    playfield: Playfield;
    queue: ReplayEventRec[];
    cursor: number;
  }
  const remotes = new Map<string, RemoteView>();

  function remoteFor(id: string, name: string): RemoteView {
    let r = remotes.get(id);
    if (r) return r;
    const holder = el('div', { class: 'play-field remote' });
    const canvas = el('canvas');
    holder.append(canvas, el('div', { class: 'remote-tag' }, name));
    fieldRow.append(holder);
    const playfield = new Playfield(canvas, { mode: chart.mode, laneCount, labels: labelsFor() }, s);
    const session = new GameSession({
      notes: compileNotes(song, chart),
      laneCount,
      windows: { ...s.windows },
      noFail: false,
      ownHealth: true,
      onEvent: (ev) => {
        if (ev.type === 'hit') {
          playfield.setJudgment(ev.judgment!);
          playfield.burst(ev.lane);
        } else if (ev.type === 'miss') {
          playfield.setJudgment('miss');
        } else if (ev.type === 'holdDrop') {
          playfield.setJudgment('bad');
        }
      },
    });
    r = { name, session, playfield, queue: [], cursor: 0 };
    remotes.set(id, r);
    return r;
  }

  if (params.online && ctx.net.isConnected()) {
    lbBox.classList.remove('hide');
    // every opponent gets a field from the start — all games side by side
    if (!isReplay) {
      for (const p of ctx.net.lobby?.players ?? []) {
        if (p.id !== ctx.net.lobby?.youId) remoteFor(p.id, p.name);
      }
    }
    // one player pausing pauses the match for everyone; anyone may resume
    netOff.push(
      ctx.net.on('pause', (m) => {
        if (ended || !buffer) return;
        if (m.paused) pauseGame(m.name, true);
        else resumeGame(true);
      }),
    );
    netOff.push(
      ctx.net.on('progress', (m) => {
        onlineOthers.set(m.playerId, m);
        if (!isReplay && m.name) {
          const r = remoteFor(m.playerId, m.name);
          if (Array.isArray(m.events)) {
            for (const e of m.events) {
              if (e && typeof e.t === 'number' && typeof e.lane === 'number') r.queue.push({ t: e.t, lane: e.lane | 0, down: !!e.down });
            }
          }
        }
        renderLeaderboard();
      }),
    );
  }

  function renderLeaderboard(): void {
    const rows = [
      {
        name: players[0].name + ' (you)',
        score: displayScore(),
        accuracy: sessions[0]?.accuracy() ?? 1,
        combo: sessions[0]?.combo ?? 0,
        health: sessions[0]?.health ?? 100,
        multiplier: sessions[0]?.multiplier() ?? 1,
      },
      ...[...onlineOthers.values()],
    ].sort((a, b) => b.score - a.score);
    lbBox.innerHTML = '';
    lbBox.append(el('div', { class: 'lb-title' }, 'LIVE'));
    for (const r of rows) {
      lbBox.append(
        el('div', { class: 'lb-row' },
          el('span', { class: 'lb-name' }, r.name),
          el('span', null, `${r.score}  ${(r.accuracy * 100).toFixed(1)}%  x${r.multiplier ?? 1}  ${r.combo}`),
        ),
      );
    }
  }

  // ---- main loop ----
  // Provisional value; re-sampled the instant playback begins (see startPlayback),
  // when the device's reported output latency is trustworthy.
  conductor.judgeOffsetMs = ctx.audio.outputLatencyMs() + s.audioOffsetMs;

  let buffer: AudioBuffer | null = null;

  function startPlayback(fromMs: number, leadInMs: number): void {
    if (!buffer) return;
    if (!isReplay && s.uiSounds) void ctx.audio.playUiSound(COUNTDOWN_SFX, 0.7);
    conductor.play(buffer, { fromMs, rate, leadInMs });
    // lock latency compensation now the context is running + source scheduled,
    // so the first note is judged exactly when it reaches the line
    conductor.setLatency(s.audioOffsetMs);
  }

  function frame(t: number): void {
    if (destroyed) return;
    rafId = requestAnimationFrame(frame);
    if (s.fpsCap > 0 && t - lastFrame < 1000 / s.fpsCap - 0.5) return;
    lastFrame = t;
    if (!buffer) return;

    const nowJ = conductor.nowMs();

    if (!paused && !ended) {
      // fever expiring naturally banks the earned double points
      if (feverOn && performance.now() >= feverUntil) endFever(false);

      // replay event feed
      if (isReplay) {
        while (replayCursor < replay!.events.length && replay!.events[replayCursor].t <= nowJ) {
          const ev = replay!.events[replayCursor++];
          playfields[0].pressLane(ev.lane, ev.down);
          if (ev.down) sessions[0].press(ev.lane, ev.t);
          else sessions[0].release(ev.lane, ev.t);
        }
      }
      for (const sess of sessions) if (!sess.failed && !bandState?.failed) sess.update(nowJ);

      // practice loop
      if (params.practice && loopEndMs != null && nowJ >= loopEndMs) {
        const to = loopStartMs ?? 0;
        for (const sess of sessions) sess.resetFrom(to);
        conductor.seek(to, 800);
      }

      // online progress + our new input events for the remote views
      if (params.online && ctx.net.isConnected() && t - lastProgressSent > 250) {
        lastProgressSent = t;
        const sess = sessions[0];
        ctx.net.send('progress', {
          score: displayScore(),
          accuracy: sess.accuracy(),
          combo: sess.combo,
          multiplier: sess.multiplier(),
          health: sess.health,
          done: false,
          events: recorded.slice(sentEventCursor),
        });
        sentEventCursor = recorded.length;
        renderLeaderboard();
      }

      // replay the other players' streamed inputs on a slightly delayed clock
      const remoteNow = nowJ - REMOTE_VIEW_DELAY;
      for (const r of remotes.values()) {
        while (r.cursor < r.queue.length && r.queue[r.cursor].t <= remoteNow) {
          const ev = r.queue[r.cursor++];
          r.playfield.pressLane(ev.lane, ev.down);
          if (ev.down) r.session.press(ev.lane, ev.t);
          else r.session.release(ev.lane, ev.t);
        }
        if (!r.session.failed && remoteNow > 0) r.session.update(remoteNow);
      }

      const soloFailed = players.length === 1 && sessions[0].failed;
      const bandFailed = !!bandState?.failed;
      const allFailed = players.length > 1 && !band && sessions.every((x) => x.failed);
      if (nowJ >= endMs || soloFailed || bandFailed || allFailed) {
        finish();
        return;
      }
    }

    const nowV = nowJ + s.visualOffsetMs;
    const countdown = nowJ < startMs ? (startMs - nowJ) / (1000 * rate) : null;
    for (let i = 0; i < playfields.length; i++) {
      playfields[i].draw(nowV, hudFor(i), countdown, sessions[i].notes);
    }
    for (const r of remotes.values()) {
      r.playfield.draw(nowJ - REMOTE_VIEW_DELAY + s.visualOffsetMs, {
        score: r.session.score,
        combo: r.session.combo,
        multiplier: r.session.multiplier(),
        accuracy: r.session.accuracy(),
        health: r.session.health,
        failed: r.session.failed,
        name: r.name,
      }, countdown, r.session.notes);
    }
  }

  async function finish(): Promise<void> {
    if (ended) return;
    ended = true;
    conductor.stop();

    if (params.test) {
      ctx.nav('editor', { resume: params.test.resume });
      return;
    }
    if (isReplay) {
      ctx.nav('songselect', { songId: song.id });
      return;
    }

    endFever(false); // a streak carried to the end keeps its double points

    const results: PlayerResult[] = sessions.map((sess, i) => ({
      name: players[i].name,
      score: i === 0 ? sess.score + feverBanked : sess.score,
      accuracy: sess.accuracy(),
      grade: sess.grade(),
      maxCombo: sess.maxCombo,
      failed: sess.failed || !!bandState?.failed,
      counts: { ...sess.counts },
      notesHit: sess.notesHit(),
      notesMissed: sess.counts.miss,
    }));

    let replaySavedId: string | null = null;
    let scoreSavedId: string | null = null;
    const eligible = players.length === 1 && !params.practice && !params.test;
    if (eligible) {
      const sess = sessions[0];
      const rep: ReplayData = {
        id: uid(),
        chartId: chart.id,
        songId: song.id,
        player: players[0].name,
        rate,
        windows: { ...s.windows },
        events: recorded.slice(),
        dateIso: new Date().toISOString(),
        score: sess.score,
        accuracy: sess.accuracy(),
        grade: sess.grade(),
        maxCombo: sess.maxCombo,
      };
      const score: ScoreRecord = {
        id: uid(),
        chartId: chart.id,
        songId: song.id,
        mode: chart.mode,
        difficulty: chart.difficulty,
        player: players[0].name,
        score: sess.score,
        accuracy: sess.accuracy(),
        grade: sess.grade(),
        maxCombo: sess.maxCombo,
        counts: { ...sess.counts },
        dateIso: rep.dateIso,
        rate,
        noFail: params.noFail,
        failed: sess.failed,
        replayId: rep.id,
      };
      try {
        await ctx.db.put('replays', rep);
        await ctx.db.put('scores', score);
        replaySavedId = rep.id;
        scoreSavedId = score.id;
      } catch {
        toast('Could not save score');
      }
    }

    if (params.online && ctx.net.isConnected()) {
      const sess = sessions[0];
      ctx.net.send('progress', { score: sess.score + feverBanked, accuracy: sess.accuracy(), combo: sess.combo, multiplier: sess.multiplier(), health: sess.health, done: true, events: recorded.slice(sentEventCursor) });
      sentEventCursor = recorded.length;
      ctx.net.send('finish', {
        result: { score: sess.score + feverBanked, accuracy: sess.accuracy(), grade: sess.grade(), maxCombo: sess.maxCombo, failed: sess.failed },
      });
    }

    const rp: ResultsParams = {
      song,
      chart,
      players: results,
      band: bandState ? { score: bandState.score, maxCombo: bandState.maxCombo, failed: bandState.failed } : null,
      replaySavedId,
      scoreSavedId,
      online: !!params.online,
      practice: params.practice,
      test: params.test ?? null,
      playParams: params,
    };
    ctx.nav('results', rp);
  }

  // ---- boot ----
  overlay.classList.remove('hide');
  overlay.append(el('div', { class: 'panel' }, el('h2', null, 'Loading…')));
  void (async () => {
    try {
      await ctx.audio.ensureRunning();
      buffer = await ctx.audio.bufferForSong(song, ctx.db);
    } catch (err) {
      toast(`Failed to load audio: ${(err as Error).message}`);
      ctx.nav('songselect', {});
      return;
    }
    if (destroyed) return;
    overlay.classList.add('hide');
    overlay.innerHTML = '';
    if (!isReplay && s.uiSounds) {
      countLeadMs = Math.max(countLeadMs, Math.ceil((await ctx.audio.uiSoundDuration(COUNTDOWN_SFX)) * 1000));
    }
    startPlayback(startMs, isReplay ? 800 : countLeadMs);
    rafId = requestAnimationFrame(frame);
  })();

  return {
    destroy() {
      destroyed = true;
      document.body.classList.remove('fever-bg');
      cancelAnimationFrame(rafId);
      input.detach();
      window.removeEventListener('keydown', onKey);
      conductor.stop();
      netOff.forEach((off) => off());
    },
  };
}
