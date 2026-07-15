import type { AppCtx, ResultsParams, Screen } from '../app';
import { JUDGMENTS } from '../types';
import { el, fmtPct } from '../util';
import { judgeColor } from '../store/settings';
import { modeName } from '../charts/chart';

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
    btns.append(
      el('button', {
        class: 'btn',
        onclick: async () => {
          const rep = await ctx.db.replay(params.replaySavedId!);
          if (rep) {
            ctx.nav('play', { ...params.playParams, replay: rep, players: [{ name: rep.player }], online: false, band: null });
          }
        },
      }, 'Watch replay'),
    );
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
