import type { AppCtx, ResultsParams, Screen } from '../app';
import type { ScoreRecord } from '../types';
import { JUDGMENTS } from '../types';
import { el, fmtPct } from '../util';
import { judgeColor } from '../store/settings';
import { modeName } from '../charts/chart';
import { submitScore } from '../net/api';

const GRADE_COLORS: Record<string, string> = {
  SS: '#ffd700',
  S: '#59e3ff',
  A: '#63e56b',
  B: '#3b82f6',
  C: '#f5d90a',
  D: '#f59a4a',
  F: '#f25555',
};

export function resultsScreen(root: HTMLElement, ctx: AppCtx, params: ResultsParams): Screen {
  root.innerHTML = '';
  const offs: Array<() => void> = [];
  const page = el('div', { class: 'page' });
  root.append(page);

  page.append(
    el('h1', { class: 'page-title' }, params.players.some((p) => p.failed) && params.players.length === 1 ? 'Failed…' : 'Results'),
    el('div', { class: 'muted' }, `${params.song.title} — ${params.song.artist} · ${modeName(params.chart.mode)} · ${params.chart.difficulty.toUpperCase()}${params.playParams.rate !== 1 ? ` · ${params.playParams.rate}x` : ''}${params.practice ? ' · practice (not saved)' : ''}`),
  );

  if (params.band) {
    page.append(
      el('div', { class: 'panel band-summary' },
        el('h2', null, params.band.failed ? 'Band failed' : 'Band clear!'),
        el('div', { class: 'big-num' }, String(params.band.score)),
        el('div', { class: 'muted' }, `Best shared combo ${params.band.maxCombo}`),
      ),
    );
  }

  const row = el('div', { class: 'results-row' });
  page.append(row);

  for (const p of params.players) {
    const counts = el('div', { class: 'counts' });
    for (const j of JUDGMENTS) {
      counts.append(
        el('div', { class: 'count-row' },
          el('span', { style: { color: judgeColor(ctx.settings, j) } }, j.toUpperCase()),
          el('span', null, String(p.counts[j] ?? 0)),
        ),
      );
    }
    row.append(
      el('div', { class: 'panel result-card' },
        el('div', { class: 'grade', style: { color: GRADE_COLORS[p.grade] ?? '#fff' } }, p.grade),
        el('h3', null, p.name + (p.failed ? ' (failed)' : '')),
        el('div', { class: 'big-num' }, String(p.score)),
        el('div', { class: 'muted' }, `Accuracy ${fmtPct(p.accuracy)} · Max combo ${p.maxCombo}`),
        el('div', { class: 'muted' }, `Hit ${p.notesHit} · Missed ${p.notesMissed}`),
        counts,
      ),
    );
  }

  // save run to the global leaderboard with a chosen name, or discard it
  let discarded = false;
  let watchBtn: HTMLButtonElement | null = null;
  if (params.scoreSavedId) {
    // failed and non-1x runs never reach the global board; nothing is ever
    // uploaded unless the player explicitly saves
    const canGlobal = params.playParams.rate === 1 && !params.players[0].failed;
    const nameIn = el('input', { type: 'text', value: params.players[0].name, maxlength: '24', placeholder: 'Name for this run' });
    const saveBtn = el('button', { class: 'btn primary' }, canGlobal ? 'Save run' : 'Save locally') as HTMLButtonElement;
    const discardBtn = el('button', { class: 'btn danger' }, 'Discard run') as HTMLButtonElement;
    const statusEl = el('div', { class: 'muted' },
      canGlobal
        ? 'Save this run to the global leaderboard under a name of your choice, or discard it. Nothing is uploaded unless you save.'
        : params.players[0].failed
          ? 'Failed runs are not ranked globally — saving keeps this run on this device only.'
          : 'Only 1x-rate runs are ranked globally — saving keeps this run on this device only.');
    const panel = el('div', { class: 'panel' },
      el('h2', null, 'Save this run?'),
      el('div', { class: 'form-row' }, el('label', null, 'Player name'), nameIn),
      el('div', { class: 'btn-row' }, saveBtn, discardBtn),
      statusEl,
    );
    page.append(panel);

    const finish = (msg: string) => {
      nameIn.disabled = true;
      saveBtn.remove();
      discardBtn.remove();
      statusEl.textContent = msg;
    };

    saveBtn.onclick = async () => {
      const name = (nameIn.value.trim() || ctx.settings.playerName || 'Player').slice(0, 24);
      saveBtn.disabled = discardBtn.disabled = true;
      saveBtn.textContent = 'Saving…';
      try {
        // stamp the chosen name onto the locally saved score + replay
        const sc = await ctx.db.get<ScoreRecord>('scores', params.scoreSavedId!);
        if (sc && sc.player !== name) {
          sc.player = name;
          await ctx.db.put('scores', sc);
        }
        if (params.replaySavedId) {
          const rep = await ctx.db.replay(params.replaySavedId);
          if (rep && rep.player !== name) {
            rep.player = name;
            await ctx.db.put('replays', rep);
          }
        }
      } catch {
        /* local rename is best-effort */
      }
      if (!canGlobal) {
        finish(`Saved on this device as “${name}”${params.players[0].failed ? ' — failed runs are not ranked globally' : ''}.`);
        return;
      }
      try {
        const p = params.players[0];
        const r = await submitScore(ctx.settings, {
          chartId: params.chart.id,
          songId: params.song.id,
          title: params.song.title,
          artist: params.song.artist,
          mode: params.chart.mode,
          difficulty: params.chart.difficulty,
          player: name,
          score: p.score,
          accuracy: p.accuracy,
          grade: p.grade,
          maxCombo: p.maxCombo,
          rate: params.playParams.rate,
          noFail: params.playParams.noFail,
          failed: p.failed,
        });
        finish(r.improved
          ? `Saved as “${name}” — global rank #${r.rank} of ${r.total}!`
          : `Saved — “${name}” already has a better run on this chart (global rank #${r.rank} of ${r.total}).`);
      } catch (err) {
        statusEl.textContent = `Saved on this device, but the global leaderboard could not be reached (${(err as Error).message}). Try again?`;
        saveBtn.disabled = discardBtn.disabled = false;
        saveBtn.textContent = 'Retry save';
      }
    };

    discardBtn.onclick = async () => {
      saveBtn.disabled = discardBtn.disabled = true;
      try {
        await ctx.db.del('scores', params.scoreSavedId!);
        if (params.replaySavedId) await ctx.db.del('replays', params.replaySavedId);
      } catch {
        /* already gone */
      }
      discarded = true;
      watchBtn?.remove();
      finish('Run discarded — nothing was saved.');
    };
  }

  // online rankings
  if (params.online) {
    const box = el('div', { class: 'panel' }, el('h2', null, 'Match rankings'), el('div', { class: 'muted' }, 'Waiting for all players to finish…'));
    page.append(box);
    const render = (results: any[]) => {
      box.innerHTML = '';
      box.append(el('h2', null, 'Match rankings'));
      const table = el('table', { class: 'table' },
        el('tr', null, el('th', null, '#'), el('th', null, 'Player'), el('th', null, 'Score'), el('th', null, 'Acc'), el('th', null, 'Grade'), el('th', null, 'Combo')),
      );
      results.forEach((r, i) => {
        table.append(
          el('tr', { class: i === 0 ? 'winner' : '' },
            el('td', null, String(i + 1)),
            el('td', null, r.name + (r.failed ? ' ✗' : '')),
            el('td', null, String(r.score)),
            el('td', null, fmtPct(r.accuracy)),
            el('td', null, r.grade),
            el('td', null, String(r.maxCombo)),
          ),
        );
      });
      box.append(table);
    };
    if (ctx.net.lastResults) render(ctx.net.lastResults);
    offs.push(ctx.net.on('results', (m) => render(m.results)));
  }

  const btns = el('div', { class: 'btn-row' });
  if (!params.online) {
    btns.append(el('button', { class: 'btn primary', onclick: () => ctx.nav('play', params.playParams) }, 'Retry'));
  }
  if (params.replaySavedId) {
    watchBtn = el('button', {
      class: 'btn',
      onclick: async () => {
        if (discarded) return;
        const rep = await ctx.db.replay(params.replaySavedId!);
        if (rep) {
          ctx.nav('play', { ...params.playParams, replay: rep, players: [{ name: rep.player }], online: false, band: null });
        }
      },
    }, 'Watch replay') as HTMLButtonElement;
    btns.append(watchBtn);
  }
  btns.append(
    el('button', { class: 'btn', onclick: () => ctx.nav(params.online ? 'lobby' : 'songselect', params.online ? {} : { songId: params.song.id }) },
      params.online ? 'Back to lobby' : 'Song select'),
    el('button', { class: 'btn', onclick: () => ctx.nav('menu') }, 'Main menu'),
  );
  page.append(btns);

  return {
    destroy() {
      offs.forEach((f) => f());
    },
  };
}
