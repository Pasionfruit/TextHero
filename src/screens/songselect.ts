import type { AppCtx, PlayParams, Screen } from '../app';
import type { ChartData, ScoreRecord, SongData } from '../types';
import { DEMO_SONG_ID, makeEmptyChart, modeLabel } from '../charts/chart';
import { analyzeSong, estimateGrid, generateSampleCharts } from '../charts/autochart';
import { el, fmtPct, toast, uid } from '../util';

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
  const listBox = el('div', { class: 'song-list' });
  const detailBox = el('div', { class: 'song-detail' });
  page.append(header, el('div', { class: 'select-cols' }, listBox, detailBox));

  const s = ctx.settings;

  async function refresh(keepSongId?: string): Promise<void> {
    songs = (await ctx.db.songs()).sort((a, b) => a.title.localeCompare(b.title));
    const want = keepSongId ?? params.songId ?? selectedSong?.id;
    selectedSong = songs.find((x) => x.id === want) ?? songs[0] ?? null;
    renderList();
    await selectSong(selectedSong);
  }

  function renderList(): void {
    listBox.innerHTML = '';
    for (const song of songs) {
      const card = el('div', { class: 'song-card' + (song.id === selectedSong?.id ? ' active' : ''), onclick: () => void selectSong(song) },
        song.artDataUrl ? el('img', { src: song.artDataUrl, class: 'song-art' }) : el('div', { class: 'song-art placeholder' }, '♪'),
        el('div', null,
          el('div', { class: 'song-title' }, song.title),
          el('div', { class: 'muted' }, `${song.artist} · ${song.bpm} BPM`),
        ),
      );
      listBox.append(card);
    }
    if (!songs.length) listBox.append(el('div', { class: 'muted pad' }, 'No songs. Upload one!'));
  }

  async function selectSong(song: SongData | null): Promise<void> {
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
  }

  const diffOrder = (d: string) => ['easy', 'medium', 'hard', 'expert'].indexOf(d);

  async function renderDetail(): Promise<void> {
    const song = selectedSong;
    detailBox.innerHTML = '';
    if (!song) return;

    detailBox.append(
      el('h2', null, song.title),
      el('div', { class: 'muted' }, `${song.artist} · ${song.bpm} BPM · ${(song.durationMs / 1000).toFixed(0)}s`),
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
        song.id !== DEMO_SONG_ID &&
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

    // leaderboard
    if (selectedChart) {
      const scores = (await ctx.db.scoresForChart(selectedChart.id))
        .filter((x) => x.rate === 1)
        .sort((a, b) => b.score - a.score || b.accuracy - a.accuracy || b.maxCombo - a.maxCombo)
        .slice(0, 10);
      const lb = el('div', { class: 'panel' }, el('h3', null, 'Leaderboard'));
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

  // ---- upload dialog ----
  function uploadDialog(): void {
    const dlg = el('div', { class: 'modal-back' });
    const fileIn = el('input', { type: 'file', accept: '.mp3,.wav,.ogg,audio/*' });
    const artIn = el('input', { type: 'file', accept: 'image/*' });
    const titleIn = el('input', { type: 'text', placeholder: 'Title' });
    const artistIn = el('input', { type: 'text', placeholder: 'Artist' });
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
        row('BPM', bpmIn),
        row('Offset (ms of beat 0)', offsetIn),
        row('Album art (optional)', artIn),
        el('div', { class: 'btn-row' }, saveBtn, el('button', { class: 'btn', onclick: () => dlg.remove() }, 'Cancel')),
      ),
    );
    document.body.append(dlg);
  }

  void refresh();

  return {
    destroy() {
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
