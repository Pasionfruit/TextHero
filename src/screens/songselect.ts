import type { AppCtx, PlayParams, Screen } from '../app';
import type { ChartData, ScoreRecord, SongData } from '../types';
import { DEMO_SONG_ID, makeEmptyChart, modeLabel } from '../charts/chart';
import { analyzeSong, estimateGrid, generateSampleCharts } from '../charts/autochart';
import { adminDeleteScore, adminToken, adminUpdateScore, fetchLeaderboard, type LeaderboardEntry } from '../net/api';
import { isBundledSong, LIBRARY_CHANGED_EVENT } from '../store/bundled';
import { syncPublishedCharts } from '../store/publish';
import { clamp, el, fmtDur, fmtPct, toast, uid } from '../util';

export function songSelectScreen(root: HTMLElement, ctx: AppCtx, params: { songId?: string }): Screen {
  root.innerHTML = '';
  const page = el('div', { class: 'page wide' });
  root.append(page);

  let songs: SongData[] = [];
  let charts: ChartData[] = [];
  let selectedSong: SongData | null = null;
  let selectedChart: ChartData | null = null;

  const header = el('div', { class: 'row spread' },
    el('h1', { class: 'page-title' }, 'Song Select'),
    el('div', { class: 'btn-row' },
      el('button', { class: 'btn', onclick: () => uploadDialog() }, '+ Upload song'),
      el('button', { class: 'btn', onclick: () => ctx.nav('menu') }, 'Back'),
    ),
  );
  let filterText = '';
  const filterIn = el('input', {
    type: 'search',
    class: 'song-filter',
    placeholder: '🔎 Filter by title or artist…',
    oninput: (e: Event) => {
      filterText = (e.target as HTMLInputElement).value.trim().toLowerCase();
      renderList();
    },
  });
  const listBox = el('div', { class: 'song-list' });
  const detailBox = el('div', { class: 'song-detail' });
  page.append(header, el('div', { class: 'select-cols' },
    el('div', null, filterIn, listBox, el('div', { class: 'muted sm wheel-hint' }, 'Scroll / ↑ ↓ to browse · Enter to play')),
    detailBox,
  ));

  const visibleSongs = (): SongData[] =>
    filterText
      ? songs.filter((x) => `${x.title} ${x.artist}`.toLowerCase().includes(filterText))
      : songs;

  const s = ctx.settings;

  async function refresh(keepSongId?: string): Promise<void> {
    songs = (await ctx.db.songs()).sort((a, b) => a.title.localeCompare(b.title));
    const want = keepSongId ?? params.songId ?? selectedSong?.id;
    selectedSong = songs.find((x) => x.id === want) ?? songs[0] ?? null;
    renderList();
    await selectSong(selectedSong);
  }

  // song whose preview snippet is currently playing (art button shows ■)
  let previewingId: string | null = null;

  async function toggleCardPreview(song: SongData): Promise<void> {
    if (previewingId === song.id) {
      ctx.audio.stopPreview();
      previewingId = null;
      renderList();
      return;
    }
    void selectSong(song); // also stops any other song's preview
    previewingId = song.id;
    renderList();
    try {
      await ctx.audio.ensureRunning();
      const buf = await ctx.audio.bufferForSong(song, ctx.db);
      if (previewingId !== song.id) return; // switched away while decoding
      ctx.audio.startPreview(buf, 12, () => {
        if (previewingId === song.id) {
          previewingId = null;
          renderList();
        }
      });
    } catch (err) {
      toast(`Preview failed: ${(err as Error).message}`);
      if (previewingId === song.id) previewingId = null;
      renderList();
    }
  }

  function renderList(): void {
    listBox.innerHTML = '';
    const visible = visibleSongs();
    let activeCard: HTMLElement | null = null;
    for (const song of visible) {
      const previewing = previewingId === song.id;
      const art = el('div', {
        class: 'song-art-wrap',
        title: previewing ? 'Stop preview' : 'Preview',
        onclick: (e: Event) => {
          e.stopPropagation();
          void toggleCardPreview(song);
        },
      },
        song.artDataUrl ? el('img', { src: song.artDataUrl, class: 'song-art' }) : el('div', { class: 'song-art placeholder' }, '♪'),
        el('div', { class: 'art-play' + (previewing ? ' on' : '') }, previewing ? '■' : '▶'),
      );
      const card = el('div', { class: 'song-card' + (song.id === selectedSong?.id ? ' active' : ''), onclick: () => void selectSong(song) },
        art,
        el('div', null,
          el('div', { class: 'song-title' }, song.title),
          el('div', { class: 'muted' }, song.artist),
          el('div', { class: 'muted sm' }, `${song.genre ? `${song.genre} · ` : ''}${fmtDur(song.durationMs)} · ${song.bpm} BPM`),
        ),
      );
      if (song.id === selectedSong?.id) activeCard = card;
      listBox.append(card);
    }
    if (!songs.length) listBox.append(el('div', { class: 'muted pad' }, 'No songs. Upload one!'));
    else if (!visible.length) listBox.append(el('div', { class: 'muted pad' }, 'No songs match the filter.'));
    activeCard?.scrollIntoView({ block: 'nearest' });
  }

  // GH-style browsing: the wheel steps the selection instead of the scrollbar,
  // and arrow keys / Enter work anywhere on the screen
  function stepSelection(dir: number): void {
    const visible = visibleSongs();
    if (!visible.length) return;
    const idx = visible.findIndex((x) => x.id === selectedSong?.id);
    const next = idx < 0 ? 0 : clamp(idx + dir, 0, visible.length - 1);
    if (next !== idx) void selectSong(visible[next]);
  }

  let wheelAcc = 0;
  listBox.addEventListener('wheel', (e) => {
    e.preventDefault();
    wheelAcc += e.deltaY;
    const STEP = 80; // one song per notch, smooth for trackpads
    while (Math.abs(wheelAcc) >= STEP) {
      const dir = wheelAcc > 0 ? 1 : -1;
      wheelAcc -= dir * STEP;
      stepSelection(dir);
    }
  }, { passive: false });

  const onNavKey = (e: KeyboardEvent): void => {
    const tag = (e.target as HTMLElement).tagName;
    if (tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA') return;
    if (document.querySelector('.modal-back')) return;
    if (e.code === 'ArrowDown' || e.code === 'ArrowUp') {
      e.preventDefault();
      stepSelection(e.code === 'ArrowDown' ? 1 : -1);
    } else if (e.code === 'Enter') {
      (detailBox.querySelector('.btn.primary.big') as HTMLButtonElement | null)?.click();
    } else if (e.code === 'Escape') {
      ctx.nav('menu');
    }
  };
  window.addEventListener('keydown', onNavKey);

  async function selectSong(song: SongData | null): Promise<void> {
    if (song?.id !== selectedSong?.id && previewingId !== song?.id) {
      ctx.audio.stopPreview();
      previewingId = null;
    }
    selectedSong = song;
    renderList();
    if (!song) {
      detailBox.innerHTML = '';
      return;
    }
    charts = (await ctx.db.chartsForSong(song.id)).sort(
      (a, b) => a.mode.localeCompare(b.mode) || diffOrder(a.difficulty) - diffOrder(b.difficulty),
    );
    selectedChart = charts.find((c) => c.id === selectedChart?.id) ?? charts[0] ?? null;
    await renderDetail();

    // pull the admin's published (canonical) charts for this song in the
    // background; if anything changed, reload so you play the shared version
    const syncId = song.id;
    void syncPublishedCharts(ctx.db, ctx.settings, syncId).then(async (changed) => {
      if (changed && selectedSong?.id === syncId) {
        const fresh = await ctx.db.get<SongData>('songs', syncId);
        if (fresh) selectedSong = fresh;
        charts = (await ctx.db.chartsForSong(syncId)).sort(
          (a, b) => a.mode.localeCompare(b.mode) || diffOrder(a.difficulty) - diffOrder(b.difficulty),
        );
        selectedChart = charts.find((c) => c.id === selectedChart?.id) ?? charts[0] ?? null;
        await renderDetail();
      }
    });
  }

  const diffOrder = (d: string) => ['easy', 'medium', 'hard', 'expert'].indexOf(d);

  async function renderDetail(): Promise<void> {
    const song = selectedSong;
    detailBox.innerHTML = '';
    if (!song) return;

    detailBox.append(
      el('h2', null, song.title),
      el('div', { class: 'muted' }, `${song.artist} · ${song.genre ? `${song.genre} · ` : ''}${song.bpm} BPM · ${fmtDur(song.durationMs)}`),
    );

    // chart chips
    const chips = el('div', { class: 'chip-row' });
    for (const c of charts) {
      chips.append(
        el('button', {
          class: 'chip' + (c.id === selectedChart?.id ? ' active' : ''),
          onclick: () => {
            selectedChart = c;
            void renderDetail();
          },
        }, `${modeLabel(c.mode)} · ${c.difficulty} (${c.notes.length})`),
      );
    }
    chips.append(el('button', { class: 'chip', onclick: () => ctx.nav('editor', { songId: song.id }) }, '+ edit / new chart'));
    detailBox.append(chips);

    // modifiers
    const mods = el('details', { class: 'panel' },
      el('summary', null, 'Modifiers'),
      row('Scroll speed', numInput(s.scrollSpeed, 0.25, 4, 0.25, (v) => (s.scrollSpeed = v))),
      row('Direction', selectInput(['down', 'up'], s.scrollDirection, (v) => (s.scrollDirection = v as any))),
      row('Reverse', checkbox(s.reverse, (v) => (s.reverse = v))),
      row('Hidden', checkbox(s.hidden, (v) => (s.hidden = v))),
      row('Sudden', checkbox(s.sudden, (v) => (s.sudden = v))),
      row('No Fail', checkbox(noFail, (v) => (noFail = v))),
    );
    detailBox.append(mods);

    // practice
    const practicePanel = el('details', { class: 'panel', open: practice },
      el('summary', null, 'Practice'),
      row('Practice mode', checkbox(practice, (v) => (practice = v))),
      row('Speed', selectInput(['0.5', '0.75', '1', '1.25', '1.5'], String(practiceRate), (v) => (practiceRate = Number(v)))),
      row('Loop start (s)', numInput(loopStart ?? 0, 0, song.durationMs / 1000, 1, (v) => (loopStart = v))),
      row('Loop end (s, 0=off)', numInput(loopEnd ?? 0, 0, song.durationMs / 1000, 1, (v) => (loopEnd = v))),
      el('div', { class: 'muted sm' }, 'In practice: [ sets loop start, ] sets loop end, \\ clears. Scores are not saved.'),
    );
    detailBox.append(practicePanel);

    // actions
    detailBox.append(
      el('div', { class: 'btn-row' },
        el('button', {
          class: 'btn primary big',
          disabled: !selectedChart,
          onclick: () => {
            ctx.saveSettings();
            ctx.audio.stopPreview();
            if (!selectedChart) return;
            const play: PlayParams = {
              song,
              chart: selectedChart,
              players: [{ name: s.playerName, codes: s.bindings[0] }],
              rate: practice ? practiceRate : 1,
              noFail,
              practice,
              loopStartMs: practice && loopStart ? loopStart * 1000 : null,
              loopEndMs: practice && loopEnd ? loopEnd * 1000 : null,
              band: null,
            };
            ctx.nav('play', play);
          },
        }, practice ? 'Practice' : 'Play'),
        song.id !== DEMO_SONG_ID && !isBundledSong(song.id) &&
          el('button', {
            class: 'btn danger',
            onclick: async () => {
              if (!confirm(`Delete "${song.title}" and all its charts/scores?`)) return;
              await ctx.db.deleteSong(song.id);
              selectedChart = null;
              await refresh();
              toast('Song deleted');
            },
          }, 'Delete song'),
      ),
    );

    // global leaderboard (server-side, shared by everyone)
    if (selectedChart) {
      const globalLb = el('div', { class: 'panel' }, el('h3', null, 'Global Leaderboard'), el('div', { class: 'muted' }, 'Loading…'));
      detailBox.append(globalLb);
      // if the selection changes mid-fetch, renderDetail() rebuilt detailBox and
      // this panel is detached — updating it is then a harmless no-op
      const isAdmin = !!adminToken();
      void fetchLeaderboard(ctx.settings, selectedChart.id)
        .then((scores) => {
          globalLb.innerHTML = '';
          globalLb.append(el('h3', null, isAdmin ? 'Global Leaderboard (admin)' : 'Global Leaderboard'));
          if (!scores.length) {
            globalLb.append(el('div', { class: 'muted' }, 'No global scores yet — save a run to set the first record!'));
            return;
          }
          const table = el('table', { class: 'table' },
            el('tr', null, el('th', null, '#'), el('th', null, 'Player'), el('th', null, 'Score'), el('th', null, 'Acc'), el('th', null, 'Grade'), el('th', null, 'Combo'), el('th', null, 'Date'), isAdmin && el('th', null, '')),
          );
          scores.forEach((sc, i) => {
            table.append(
              el('tr', null,
                el('td', null, String(i + 1)),
                el('td', null, sc.player + (sc.noFail ? ' (NF)' : '') + (sc.failed ? ' ✗' : '')),
                el('td', null, String(sc.score)),
                el('td', null, fmtPct(sc.accuracy)),
                el('td', null, sc.grade),
                el('td', null, String(sc.maxCombo)),
                el('td', { class: 'muted' }, new Date(sc.dateIso).toLocaleDateString()),
                isAdmin && el('td', null,
                  el('button', { class: 'btn sm', title: 'Edit entry', onclick: () => adminEditDialog(sc) }, '✎'),
                  ' ',
                  el('button', {
                    class: 'btn sm danger',
                    title: 'Delete entry',
                    onclick: async () => {
                      if (!confirm(`Delete ${sc.player}'s ${sc.score} on this chart?`)) return;
                      try {
                        await adminDeleteScore(ctx.settings, sc.id);
                        toast('Entry deleted');
                        await renderDetail();
                      } catch (err) {
                        toast(`Delete failed: ${(err as Error).message}`);
                      }
                    },
                  }, '✕'),
                ),
              ),
            );
          });
          globalLb.append(table);
        })
        .catch(() => {
          globalLb.innerHTML = '';
          globalLb.append(
            el('h3', null, 'Global Leaderboard'),
            el('div', { class: 'muted' }, 'Server unreachable — global scores are unavailable right now.'),
          );
        });
    }

    // local scores (this device — keeps replays)
    if (selectedChart) {
      const scores = (await ctx.db.scoresForChart(selectedChart.id))
        .filter((x) => x.rate === 1)
        .sort((a, b) => b.score - a.score || b.accuracy - a.accuracy || b.maxCombo - a.maxCombo)
        .slice(0, 10);
      const lb = el('div', { class: 'panel' }, el('h3', null, 'Your Scores (this device)'));
      if (!scores.length) lb.append(el('div', { class: 'muted' }, 'No scores yet — set the first one!'));
      else {
        const table = el('table', { class: 'table' },
          el('tr', null, el('th', null, '#'), el('th', null, 'Player'), el('th', null, 'Score'), el('th', null, 'Acc'), el('th', null, 'Grade'), el('th', null, 'Combo'), el('th', null, 'Date'), el('th', null, '')),
        );
        scores.forEach((sc: ScoreRecord, i) => {
          table.append(
            el('tr', null,
              el('td', null, String(i + 1)),
              el('td', null, sc.player + (sc.noFail ? ' (NF)' : '') + (sc.failed ? ' ✗' : '')),
              el('td', null, String(sc.score)),
              el('td', null, fmtPct(sc.accuracy)),
              el('td', null, sc.grade),
              el('td', null, String(sc.maxCombo)),
              el('td', { class: 'muted' }, new Date(sc.dateIso).toLocaleDateString()),
              el('td', null,
                sc.replayId
                  ? el('button', {
                      class: 'btn sm',
                      onclick: async () => {
                        const rep = await ctx.db.replay(sc.replayId!);
                        if (!rep) return toast('Replay missing');
                        const play: PlayParams = {
                          song,
                          chart: selectedChart!,
                          players: [{ name: rep.player }],
                          rate: rep.rate,
                          noFail: true,
                          practice: false,
                          band: null,
                          replay: rep,
                        };
                        ctx.nav('play', play);
                      },
                    }, '▶ watch')
                  : '',
              ),
            ),
          );
        });
        lb.append(table);
      }
      detailBox.append(lb);
    }
  }

  let noFail = false;
  let practice = false;
  let practiceRate = 1;
  let loopStart: number | null = null;
  let loopEnd: number | null = null;

  // ---- admin: edit a global leaderboard entry ----
  function adminEditDialog(sc: LeaderboardEntry): void {
    const playerIn = el('input', { type: 'text', value: sc.player, maxlength: '24' });
    const scoreIn = el('input', { type: 'number', value: String(sc.score), min: '0', step: '1' });
    const accIn = el('input', { type: 'number', value: (sc.accuracy * 100).toFixed(2), min: '0', max: '100', step: '0.01' });
    const gradeIn = selectInput(['SS', 'S', 'A', 'B', 'C', 'D', 'F'], sc.grade, () => {});
    const comboIn = el('input', { type: 'number', value: String(sc.maxCombo), min: '0', step: '1' });
    const saveBtn = el('button', { class: 'btn primary' }, 'Save') as HTMLButtonElement;
    const dlg = el('div', { class: 'modal-back' },
      el('div', { class: 'panel modal' },
        el('h2', null, 'Edit leaderboard entry'),
        row('Player', playerIn),
        row('Score', scoreIn),
        row('Accuracy (%)', accIn),
        row('Grade', gradeIn),
        row('Max combo', comboIn),
        el('div', { class: 'btn-row' }, saveBtn, el('button', { class: 'btn', onclick: () => dlg.remove() }, 'Cancel')),
      ),
    );
    saveBtn.onclick = async () => {
      saveBtn.disabled = true;
      try {
        await adminUpdateScore(ctx.settings, sc.id, {
          player: playerIn.value.trim() || sc.player,
          score: Math.max(0, Math.round(Number(scoreIn.value) || 0)),
          accuracy: Math.min(1, Math.max(0, Number(accIn.value) / 100 || 0)),
          grade: (gradeIn as HTMLSelectElement).value,
          maxCombo: Math.max(0, Math.round(Number(comboIn.value) || 0)),
        });
        dlg.remove();
        toast('Entry updated');
        await renderDetail();
      } catch (err) {
        toast(`Update failed: ${(err as Error).message}`);
        saveBtn.disabled = false;
      }
    };
    document.body.append(dlg);
  }

  // ---- upload dialog ----
  function uploadDialog(): void {
    const dlg = el('div', { class: 'modal-back' });
    const fileIn = el('input', { type: 'file', accept: '.mp3,.wav,.ogg,audio/*' });
    const artIn = el('input', { type: 'file', accept: 'image/*' });
    const titleIn = el('input', { type: 'text', placeholder: 'Title' });
    const artistIn = el('input', { type: 'text', placeholder: 'Artist' });
    const genreIn = el('input', { type: 'text', placeholder: 'e.g. Pop Rock (optional)' });
    const bpmIn = el('input', { type: 'number', placeholder: 'auto-detect', min: '40', max: '300', step: '0.01' });
    const offsetIn = el('input', { type: 'number', placeholder: 'auto-detect', step: '1' });
    const saveBtn = el('button', { class: 'btn primary' }, 'Add song');

    fileIn.onchange = () => {
      const f = fileIn.files?.[0];
      if (f && !titleIn.value) titleIn.value = f.name.replace(/\.[^.]+$/, '');
    };

    saveBtn.onclick = async () => {
      const f = fileIn.files?.[0];
      if (!f) return toast('Choose an audio file');
      if (!/\.(mp3|wav|ogg)$/i.test(f.name) && !f.type.startsWith('audio/')) return toast('MP3, WAV or OGG only');
      saveBtn.textContent = 'Analyzing…';
      (saveBtn as HTMLButtonElement).disabled = true;
      try {
        await ctx.audio.ensureRunning();
        const buf = await ctx.audio.decodeBlob(f);
        const audioId = uid();
        await ctx.db.put('audio', f, audioId);
        let artDataUrl: string | undefined;
        const art = artIn.files?.[0];
        if (art) {
          artDataUrl = await new Promise<string>((res, rej) => {
            const r = new FileReader();
            r.onload = () => res(String(r.result));
            r.onerror = () => rej(r.error);
            r.readAsDataURL(art);
          });
        }
        const song: SongData = {
          id: uid(),
          title: titleIn.value.trim() || f.name,
          artist: artistIn.value.trim() || 'Unknown',
          genre: genreIn.value.trim() || undefined,
          bpm: Number(bpmIn.value) || 120,
          offsetMs: Number(offsetIn.value) || 0,
          audioId,
          artDataUrl,
          durationMs: Math.round(buf.duration * 1000),
        };

        // analyze the audio and generate sample charts; BPM/offset left blank → auto-detect
        let chartCount = 0;
        try {
          const analysis = await analyzeSong(buf);
          const userBpm = Number(bpmIn.value);
          const grid = estimateGrid(analysis, userBpm > 0 ? userBpm : undefined);
          song.bpm = userBpm > 0 ? userBpm : grid.bpm;
          song.offsetMs = offsetIn.value !== '' ? Number(offsetIn.value) || 0 : grid.offsetMs;
          const charts = generateSampleCharts(song, analysis);
          await ctx.db.put('songs', song);
          for (const c of charts) await ctx.db.put('charts', c);
          chartCount = charts.length;
        } catch {
          await ctx.db.put('songs', song);
        }
        if (chartCount === 0) {
          await ctx.db.put('charts', makeEmptyChart(song.id, 'five', 'medium'));
          toast('Song added — auto-charting found too few beats, open the editor to chart it');
        } else {
          toast(`Song added — ${chartCount} sample charts generated (BPM ${song.bpm}). Refine them in the editor!`);
        }
        dlg.remove();
        await refresh(song.id);
      } catch (err) {
        toast(`Could not decode audio: ${(err as Error).message}`);
        saveBtn.textContent = 'Add song';
        (saveBtn as HTMLButtonElement).disabled = false;
      }
    };

    dlg.append(
      el('div', { class: 'panel modal' },
        el('h2', null, 'Upload song'),
        row('Audio (MP3/WAV/OGG)', fileIn),
        row('Title', titleIn),
        row('Artist', artistIn),
        row('Genre', genreIn),
        row('BPM', bpmIn),
        row('Offset (ms of beat 0)', offsetIn),
        row('Album art (optional)', artIn),
        el('div', { class: 'btn-row' }, saveBtn, el('button', { class: 'btn', onclick: () => dlg.remove() }, 'Cancel')),
      ),
    );
    document.body.append(dlg);
  }

  void refresh();

  // bundled songs land in the library one by one on first boot — refresh the
  // list as they arrive, debounced so bulk imports don't thrash the UI
  let libTimer = 0;
  const onLibraryChanged = () => {
    clearTimeout(libTimer);
    libTimer = window.setTimeout(() => void refresh(selectedSong?.id), 400);
  };
  window.addEventListener(LIBRARY_CHANGED_EVENT, onLibraryChanged);

  return {
    destroy() {
      ctx.audio.stopPreview();
      clearTimeout(libTimer);
      window.removeEventListener(LIBRARY_CHANGED_EVENT, onLibraryChanged);
      window.removeEventListener('keydown', onNavKey);
      ctx.saveSettings();
      document.querySelectorAll('.modal-back').forEach((n) => n.remove());
    },
  };
}

// small form helpers shared by screens
export function row(label: string, control: Node): HTMLElement {
  return el('div', { class: 'form-row' }, el('label', null, label), control);
}

export function numInput(value: number, min: number, max: number, step: number, onchange: (v: number) => void): HTMLElement {
  return el('input', {
    type: 'number',
    value: String(value),
    min: String(min),
    max: String(max),
    step: String(step),
    onchange: (e: Event) => onchange(Number((e.target as HTMLInputElement).value)),
  });
}

export function selectInput(options: string[], value: string, onchange: (v: string) => void): HTMLElement {
  const sel = el('select', { onchange: (e: Event) => onchange((e.target as HTMLSelectElement).value) });
  for (const o of options) sel.append(el('option', { value: o, selected: o === value }, o));
  return sel;
}

export function checkbox(value: boolean, onchange: (v: boolean) => void): HTMLElement {
  return el('input', {
    type: 'checkbox',
    checked: value,
    onchange: (e: Event) => onchange((e.target as HTMLInputElement).checked),
  });
}
