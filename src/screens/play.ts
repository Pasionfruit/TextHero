import type { AppCtx, PlayParams, PlayerResult, ResultsParams, Screen } from '../app';
import { Conductor } from '../engine/Conductor';
import { GameSession } from '../engine/GameSession';
import { InputRouter } from '../input/Keyboard';
import { Playfield } from '../render/Playfield';
import { compileNotes, laneCountOf, LETTERS } from '../charts/chart';
import { multiplierFor } from '../types';
import type { JudgeEvent, ReplayData, ReplayEventRec, ScoreRecord } from '../types';
import { clamp, codeLabel, el, fmtTime, toast, uid } from '../util';

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
  const onlineOthers = new Map<string, any>();
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
  root.append(wrap);

  for (let i = 0; i < players.length; i++) {
    const holder = el('div', { class: 'play-field' });
    const canvas = el('canvas');
    holder.append(canvas);
    fieldRow.append(holder);
    const pLabels =
      chart.mode === 'keyboard'
        ? chart.keys
        : chart.mode === 'letters'
          ? []
          : (players[i].codes ?? s.bindings[i] ?? s.bindings[0]).map(codeLabel);
    playfields.push(new Playfield(canvas, { mode: chart.mode, laneCount, labels: pLabels }, s));
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
      score: sess.score,
      combo: sess.combo,
      multiplier: sess.multiplier(),
      accuracy: sess.accuracy(),
      health: sess.health,
      failed: sess.failed,
      name: players[i].name,
    };
  }

  // ---- input ----
  if (!isReplay) {
    if (chart.mode === 'five') {
      players.forEach((p, i) => input.bindFive(i, p.codes ?? s.bindings[i] ?? s.bindings[0]));
    } else if (chart.mode === 'keyboard') {
      input.bindKeys(0, chart.keys);
    } else {
      input.bindKeys(0, LETTERS.split('')); // letters mode: lane index == letter index
    }
    input.attach((player, lane, down, ts) => {
      if (paused || ended) return;
      const sess = sessions[player];
      if (!sess || sess.failed || bandState?.failed) return;
      const t = conductor.eventMs(ts);
      playfields[player].pressLane(lane, down);
      if (t < startMs - 400) return; // count-in: light up receptors but don't judge
      if (player === 0 && players.length === 1) recorded.push({ t, lane, down });
      if (down) sess.press(lane, t);
      else sess.release(lane, t);
    });
  }

  // ---- pause menu / hotkeys ----
  const onKey = (e: KeyboardEvent) => {
    if (e.code === 'Escape') {
      e.preventDefault();
      if (ended) return;
      if (isReplay) return finish();
      paused ? resumeGame() : pauseGame();
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

  function pauseGame(): void {
    paused = true;
    void conductor.pause();
    overlay.classList.remove('hide');
    overlay.innerHTML = '';
    overlay.append(
      el('div', { class: 'panel pause-panel' },
        el('h2', null, 'Paused'),
        el('button', { class: 'btn primary', onclick: () => resumeGame() }, 'Resume'),
        el('button', { class: 'btn', onclick: () => restart() }, 'Restart'),
        el('button', { class: 'btn danger', onclick: () => quit() }, 'Quit'),
      ),
    );
  }

  function resumeGame(): void {
    overlay.classList.add('hide');
    void conductor.resume().then(() => {
      paused = false;
    });
  }

  function restart(): void {
    overlay.classList.add('hide');
    paused = false;
    ended = false;
    recorded.length = 0;
    replayCursor = 0;
    buildSessions();
    if (bandState) bandState = { health: 100, combo: 0, maxCombo: 0, score: 0, failed: false };
    startPlayback(startMs, 2000);
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
      el('button', { class: 'btn sm', onclick: () => (paused ? resumeGame() : pauseGame2()) }, '⏯'),
      el('button', { class: 'btn sm', onclick: () => seekReplay(-5000) }, '-5s'),
      el('button', { class: 'btn sm', onclick: () => seekReplay(5000) }, '+5s'),
      el('button', { class: 'btn sm', onclick: () => seekReplayTo(0) }, '⏮'),
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

  // ---- online ----
  if (params.online && ctx.net.isConnected()) {
    lbBox.classList.remove('hide');
    netOff.push(
      ctx.net.on('progress', (m) => {
        onlineOthers.set(m.playerId, m);
        renderLeaderboard();
      }),
    );
  }

  function renderLeaderboard(): void {
    const rows = [
      {
        name: players[0].name + ' (you)',
        score: sessions[0]?.score ?? 0,
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
          el('span', null, `${r.score}  ${(r.accuracy * 100).toFixed(1)}%  x${r.multiplier ?? 1}  ${r.combo}⛓`),
        ),
      );
    }
  }

  // ---- main loop ----
  conductor.judgeOffsetMs = ctx.audio.outputLatencyMs() + s.audioOffsetMs;

  let buffer: AudioBuffer | null = null;

  function startPlayback(fromMs: number, leadInMs: number): void {
    if (!buffer) return;
    conductor.play(buffer, { fromMs, rate, leadInMs });
  }

  function frame(t: number): void {
    if (destroyed) return;
    rafId = requestAnimationFrame(frame);
    if (s.fpsCap > 0 && t - lastFrame < 1000 / s.fpsCap - 0.5) return;
    lastFrame = t;
    if (!buffer) return;

    const nowJ = conductor.nowMs();

    if (!paused && !ended) {
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

      // online progress
      if (params.online && ctx.net.isConnected() && t - lastProgressSent > 250) {
        lastProgressSent = t;
        const sess = sessions[0];
        ctx.net.send('progress', {
          score: sess.score,
          accuracy: sess.accuracy(),
          combo: sess.combo,
          multiplier: sess.multiplier(),
          health: sess.health,
          done: false,
        });
        renderLeaderboard();
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

    const results: PlayerResult[] = sessions.map((sess, i) => ({
      name: players[i].name,
      score: sess.score,
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
      ctx.net.send('progress', { score: sess.score, accuracy: sess.accuracy(), combo: sess.combo, multiplier: sess.multiplier(), health: sess.health, done: true });
      ctx.net.send('finish', {
        result: { score: sess.score, accuracy: sess.accuracy(), grade: sess.grade(), maxCombo: sess.maxCombo, failed: sess.failed },
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
    startPlayback(startMs, isReplay ? 800 : 2200);
    rafId = requestAnimationFrame(frame);
  })();

  return {
    destroy() {
      destroyed = true;
      cancelAnimationFrame(rafId);
      input.detach();
      window.removeEventListener('keydown', onKey);
      conductor.stop();
      netOff.forEach((off) => off());
    },
  };
}
