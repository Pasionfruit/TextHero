import type { AppCtx, PlayParams, Screen } from '../app';
import type { ChartData, Difficulty, GameMode, NoteData, SongData } from '../types';
import { DIFFICULTIES } from '../types';
import { beatToMs, laneCountOf, LETTERS, makeEmptyChart, modeLabel, msToBeat } from '../charts/chart';
import { analyzeSong, generateNotes, type SongAnalysis } from '../charts/autochart';
import { clamp, codeLabel, download, el, fitCanvas, fmtTime, toast } from '../util';
import { Conductor } from '../engine/Conductor';
import { laneColor } from '../store/settings';
import { row, selectInput } from './songselect';

const SNAPS: Record<string, number> = {
  '1/1': 0.25,
  '1/2': 0.5,
  '1/4': 1,
  '1/8': 2,
  '1/16': 4,
  '1/24': 6,
  '1/32': 8,
};

interface EditorResume {
  song: SongData;
  charts: ChartData[];
  activeIdx: number;
  playheadMs: number;
}

type Drag =
  | { kind: 'place'; note: NoteData }
  | { kind: 'move'; startBeat: number; startLane: number; orig: Array<{ note: NoteData; beat: number; lane: number }> }
  | { kind: 'box'; x0: number; y0: number; x1: number; y1: number }
  | { kind: 'scrub' }
  | null;

export function editorScreen(root: HTMLElement, ctx: AppCtx, params: { songId?: string; resume?: EditorResume }): Screen {
  root.innerHTML = '';
  const s = ctx.settings;
  const conductor = new Conductor(ctx.audio);

  let song: SongData | null = null;
  let charts: ChartData[] = [];
  let activeIdx = 0;
  let notes: NoteData[] = [];
  let buffer: AudioBuffer | null = null;
  let analysis: SongAnalysis | null = null;
  let analyzing = false;
  let peaksMin: Float32Array | null = null;
  let peaksMax: Float32Array | null = null;
  const PEAK_CHUNK = 512;

  let snapKey = '1/4';
  let pxPerBeat = 56;
  let scrollPx = -40;
  let playheadBeat = 0;
  let playing = false;
  let selection = new Set<NoteData>();
  let clipboard: NoteData[] = [];
  const undoStack: string[] = [];
  const redoStack: string[] = [];
  let drag: Drag = null;
  let rafId = 0;
  let destroyed = false;
  let dirty = false;

  const TOP_PAD = 26;
  const WAVE_X = 8, WAVE_W = 84, RULER_X = 100, LANES_X = 148;

  // ---- DOM ----
  const toolbar = el('div', { class: 'editor-toolbar' });
  const toolbar2 = el('div', { class: 'editor-toolbar' });
  const canvas = el('canvas', { class: 'editor-canvas' });
  const status = el('div', { class: 'editor-status' });
  const wrap = el('div', { class: 'editor-wrap' }, toolbar, toolbar2, canvas, status);
  root.append(wrap);

  const active = (): ChartData | null => charts[activeIdx] ?? null;
  const laneCount = (): number => (active() ? laneCountOf(active()!) : 5);
  const snapPerBeat = (): number => SNAPS[snapKey];
  const snapBeat = (b: number): number => Math.round(b * snapPerBeat()) / snapPerBeat();
  const totalBeats = (): number => (song ? Math.max(16, msToBeat(song, song.durationMs)) : 64);
  const yOf = (beat: number): number => beat * pxPerBeat - scrollPx + TOP_PAD;
  const beatAtY = (y: number): number => (y - TOP_PAD + scrollPx) / pxPerBeat;
  const laneW = (): number => {
    const W = canvas.getBoundingClientRect().width;
    return clamp((W - LANES_X - 24) / laneCount() - 4, 18, 72);
  };
  const laneAtX = (x: number): number => {
    const lw = laneW();
    const idx = Math.floor((x - LANES_X) / (lw + 4));
    if (idx < 0 || idx >= laneCount()) return -1;
    return idx;
  };
  const laneX = (lane: number): number => LANES_X + lane * (laneW() + 4);

  function pushUndo(): void {
    undoStack.push(JSON.stringify(notes));
    if (undoStack.length > 200) undoStack.shift();
    redoStack.length = 0;
    dirty = true;
  }

  function undo(): void {
    if (!undoStack.length) return;
    redoStack.push(JSON.stringify(notes));
    notes = JSON.parse(undoStack.pop()!);
    active()!.notes = notes;
    selection.clear();
    dirty = true;
  }

  function redo(): void {
    if (!redoStack.length) return;
    undoStack.push(JSON.stringify(notes));
    notes = JSON.parse(redoStack.pop()!);
    active()!.notes = notes;
    selection.clear();
    dirty = true;
  }

  // ---- toolbar ----
  function renderToolbars(): void {
    if (!song) return;
    toolbar.innerHTML = '';
    toolbar2.innerHTML = '';
    const titleIn = el('input', { type: 'text', value: song.title, style: { width: '140px' }, onchange: (e: Event) => { song!.title = (e.target as HTMLInputElement).value; dirty = true; } });
    const artistIn = el('input', { type: 'text', value: song.artist, style: { width: '110px' }, onchange: (e: Event) => { song!.artist = (e.target as HTMLInputElement).value; dirty = true; } });
    const bpmIn = el('input', { type: 'number', value: String(song.bpm), step: '0.01', min: '20', max: '400', style: { width: '72px' }, onchange: (e: Event) => { song!.bpm = Number((e.target as HTMLInputElement).value) || song!.bpm; dirty = true; } });
    const offIn = el('input', { type: 'number', value: String(song.offsetMs), step: '1', style: { width: '72px' }, onchange: (e: Event) => { song!.offsetMs = Number((e.target as HTMLInputElement).value) || 0; dirty = true; } });

    // tap BPM
    let taps: number[] = [];
    const tapBtn = el('button', {
      class: 'btn sm',
      onclick: () => {
        const now = performance.now();
        taps = taps.filter((t) => now - t < 3000);
        taps.push(now);
        if (taps.length >= 4) {
          const iv = (taps[taps.length - 1] - taps[0]) / (taps.length - 1);
          const bpm = Math.round((60000 / iv) * 100) / 100;
          (bpmIn as HTMLInputElement).value = String(bpm);
          song!.bpm = bpm;
          dirty = true;
        }
        tapBtn.textContent = `Tap (${taps.length})`;
      },
    }, 'Tap');

    toolbar.append(
      el('button', { class: 'btn sm', onclick: () => exit() }, '← Back'),
      el('span', { class: 'sep' }),
      titleIn, artistIn,
      el('span', { class: 'muted sm' }, 'BPM'), bpmIn, tapBtn,
      el('span', { class: 'muted sm' }, 'Offset'), offIn,
      el('span', { class: 'sep' }),
      el('span', { class: 'muted sm' }, 'Snap'),
      selectInput(Object.keys(SNAPS), snapKey, (v) => (snapKey = v)),
      el('button', { class: 'btn sm', onclick: () => (pxPerBeat = clamp(pxPerBeat * 1.25, 12, 320)) }, '🔍+'),
      el('button', { class: 'btn sm', onclick: () => (pxPerBeat = clamp(pxPerBeat / 1.25, 12, 320)) }, '🔍−'),
      el('span', { class: 'sep' }),
      el('button', { class: 'btn sm', onclick: () => togglePlay() }, '⏯ Play'),
      el('button', { class: 'btn sm primary', onclick: () => testPlay() }, '▶ Test (F5)'),
      el('button', { class: 'btn sm', onclick: () => void save() }, '💾 Save'),
      el('button', { class: 'btn sm', onclick: () => exportChart() }, 'Export'),
    );

    // chart tabs
    const tabs = el('span', { class: 'chip-row inline' });
    charts.forEach((c, i) => {
      tabs.append(
        el('button', {
          class: 'chip' + (i === activeIdx ? ' active' : ''),
          onclick: () => {
            commitActive();
            activeIdx = i;
            notes = charts[i].notes;
            selection.clear();
            undoStack.length = redoStack.length = 0;
            renderToolbars();
          },
        }, `${modeLabel(c.mode)}·${c.difficulty}`),
      );
    });
    let newMode: GameMode = 'five';
    let newDiff: Difficulty = 'easy';
    toolbar2.append(
      tabs,
      el('span', { class: 'sep' }),
      selectInput(['five', 'keyboard', 'letters'], newMode, (v) => (newMode = v as GameMode)),
      selectInput(DIFFICULTIES, newDiff, (v) => (newDiff = v as Difficulty)),
      el('button', {
        class: 'btn sm',
        onclick: () => {
          const existing = charts.findIndex((c) => c.mode === newMode && c.difficulty === newDiff);
          if (existing >= 0) {
            activeIdx = existing;
          } else {
            commitActive();
            charts.push(makeEmptyChart(song!.id, newMode, newDiff));
            activeIdx = charts.length - 1;
            dirty = true;
          }
          notes = charts[activeIdx].notes;
          selection.clear();
          undoStack.length = redoStack.length = 0;
          renderToolbars();
        },
      }, '+ chart'),
      el('button', {
        class: 'btn sm',
        onclick: () => void autoFill(),
      }, '✨ Auto-fill'),
      el('button', {
        class: 'btn sm danger',
        onclick: () => {
          if (charts.length <= 1) return toast('Cannot delete the only chart');
          if (!confirm('Delete this chart?')) return;
          void ctx.db.del('charts', charts[activeIdx].id);
          charts.splice(activeIdx, 1);
          activeIdx = 0;
          notes = charts[0].notes;
          selection.clear();
          renderToolbars();
        },
      }, 'Delete chart'),
    );
    const c = active();
    if (c && c.mode === 'keyboard') {
      const keysIn = el('input', {
        type: 'text',
        value: c.keys.join(''),
        style: { width: '180px' },
        onchange: (e: Event) => {
          const raw = (e.target as HTMLInputElement).value.toUpperCase();
          const uniq = [...new Set(raw.split(''))].filter((ch) => ch.trim().length === 1);
          if (uniq.length < 1) return toast('Need at least 1 key');
          pushUndo();
          c.keys = uniq;
          notes = notes.filter((n) => n.lane < uniq.length);
          c.notes = notes;
          renderToolbars();
        },
      });
      toolbar2.append(el('span', { class: 'muted sm' }, 'Keys'), keysIn);
    }
  }

  function commitActive(): void {
    const c = active();
    if (c) c.notes = notes.slice().sort((a, b) => a.beat - b.beat || a.lane - b.lane);
  }

  /** Generate notes for the active chart from the song's audio (replaces current notes; undoable). */
  async function autoFill(): Promise<void> {
    const c = active();
    if (!song || !c) return;
    if (!buffer) return toast('Audio is still loading — try again in a moment');
    if (analyzing) return;
    if (c.notes.length && !confirm('Replace the current notes with an auto-generated chart? (Undo with Ctrl+Z)')) return;
    try {
      if (!analysis) {
        analyzing = true;
        toast('Analyzing audio…');
        analysis = await analyzeSong(buffer);
      }
      pushUndo();
      notes = generateNotes(song, analysis, c.mode, c.difficulty, laneCountOf(c));
      c.notes = notes;
      selection.clear();
      toast(`Generated ${notes.length} notes for ${modeLabel(c.mode)} · ${c.difficulty}`);
    } catch (err) {
      toast(`Auto-fill failed: ${(err as Error).message}`);
    } finally {
      analyzing = false;
    }
  }

  // ---- persistence ----
  async function save(): Promise<void> {
    if (!song) return;
    commitActive();
    await ctx.db.put('songs', song);
    for (const c of charts) {
      c.updatedIso = new Date().toISOString();
      await ctx.db.put('charts', c);
    }
    dirty = false;
    toast('Saved');
  }

  function exportChart(): void {
    if (!song || !active()) return;
    commitActive();
    download(
      `${song.title}-${active()!.difficulty}.texthero.json`,
      JSON.stringify({ song: { ...song, audioId: undefined, artDataUrl: undefined }, chart: active() }, null, 2),
    );
  }

  function exit(): void {
    if (dirty && !confirm('Leave without saving? Unsaved changes will be lost.')) return;
    conductor.stop();
    ctx.nav('songselect', { songId: song?.id });
  }

  function testPlay(): void {
    if (!song || !active()) return;
    commitActive();
    conductor.stop();
    const resume: EditorResume = { song, charts, activeIdx, playheadMs: beatToMs(song, playheadBeat) };
    const play: PlayParams = {
      song,
      chart: active()!,
      players: [{ name: s.playerName, codes: s.bindings[0] }],
      rate: 1,
      noFail: true,
      practice: false,
      band: null,
      test: { fromMs: Math.max(0, beatToMs(song, playheadBeat) - 1200), resume },
    };
    ctx.nav('play', play);
  }

  // ---- playback ----
  function togglePlay(): void {
    if (!buffer || !song) return;
    if (playing) {
      playheadBeat = msToBeat(song, conductor.nowMs());
      conductor.stop();
      playing = false;
    } else {
      void ctx.audio.ensureRunning().then(() => {
        conductor.play(buffer!, { fromMs: Math.max(0, beatToMs(song!, playheadBeat)), rate: 1, leadInMs: 200 });
        playing = true;
      });
    }
  }

  // ---- mouse ----
  function canvasPos(e: MouseEvent): { x: number; y: number } {
    const r = canvas.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  }

  function noteAt(x: number, y: number): NoteData | null {
    const lane = laneAtX(x);
    if (lane < 0) return null;
    for (let i = notes.length - 1; i >= 0; i--) {
      const n = notes[i];
      if (n.lane !== lane) continue;
      const hy = yOf(n.beat);
      const ty = yOf(n.beat + n.durBeats);
      if (y >= hy - 8 && y <= Math.max(hy + 8, ty + 8)) return n;
    }
    return null;
  }

  canvas.addEventListener('mousedown', (e) => {
    if (!song) return;
    const { x, y } = canvasPos(e);
    canvas.focus?.();
    if (e.button === 2) return; // handled in contextmenu
    if (x < LANES_X) {
      playheadBeat = clamp(snapBeat(beatAtY(y)), 0, totalBeats());
      if (playing) togglePlay();
      drag = { kind: 'scrub' };
      return;
    }
    if (e.shiftKey) {
      drag = { kind: 'box', x0: x, y0: y, x1: x, y1: y };
      return;
    }
    const hit = noteAt(x, y);
    if (hit) {
      if (e.ctrlKey || e.metaKey) {
        selection.has(hit) ? selection.delete(hit) : selection.add(hit);
        return;
      }
      if (!selection.has(hit)) {
        selection.clear();
        selection.add(hit);
      }
      pushUndo();
      drag = {
        kind: 'move',
        startBeat: beatAtY(y),
        startLane: laneAtX(x),
        orig: [...selection].map((n) => ({ note: n, beat: n.beat, lane: n.lane })),
      };
      return;
    }
    const lane = laneAtX(x);
    if (lane < 0) return;
    const beat = clamp(snapBeat(beatAtY(y)), 0, totalBeats());
    pushUndo();
    const note: NoteData = { beat, lane, durBeats: 0 };
    notes.push(note);
    selection.clear();
    selection.add(note);
    drag = { kind: 'place', note };
  });

  window.addEventListener('mousemove', onMove);
  function onMove(e: MouseEvent): void {
    if (!drag || !song) return;
    const { x, y } = canvasPos(e);
    if (drag.kind === 'scrub') {
      playheadBeat = clamp(snapBeat(beatAtY(y)), 0, totalBeats());
    } else if (drag.kind === 'place') {
      drag.note.durBeats = Math.max(0, snapBeat(beatAtY(y)) - drag.note.beat);
    } else if (drag.kind === 'move') {
      const dBeat = snapBeat(beatAtY(y) - drag.startBeat);
      const dLane = laneAtX(x) >= 0 ? laneAtX(x) - drag.startLane : 0;
      for (const o of drag.orig) {
        o.note.beat = clamp(o.beat + dBeat, 0, totalBeats());
        o.note.lane = clamp(o.lane + dLane, 0, laneCount() - 1);
      }
    } else if (drag.kind === 'box') {
      drag.x1 = x;
      drag.y1 = y;
    }
  }

  window.addEventListener('mouseup', onUp);
  function onUp(): void {
    if (!drag) return;
    if (drag.kind === 'box') {
      const [x0, x1] = [Math.min(drag.x0, drag.x1), Math.max(drag.x0, drag.x1)];
      const [y0, y1] = [Math.min(drag.y0, drag.y1), Math.max(drag.y0, drag.y1)];
      selection.clear();
      for (const n of notes) {
        const nx = laneX(n.lane) + laneW() / 2;
        const ny = yOf(n.beat);
        if (nx >= x0 && nx <= x1 && ny >= y0 - 6 && ny <= y1 + 6) selection.add(n);
      }
    }
    if (drag.kind === 'move' || drag.kind === 'place') dedupeNotes();
    drag = null;
  }

  function dedupeNotes(): void {
    const seen = new Map<string, NoteData>();
    notes = notes.filter((n) => {
      const k = `${n.lane}:${n.beat.toFixed(4)}`;
      if (seen.has(k)) {
        selection.delete(n);
        return false;
      }
      seen.set(k, n);
      return true;
    });
    if (active()) active()!.notes = notes;
  }

  canvas.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    const { x, y } = canvasPos(e);
    const hit = noteAt(x, y);
    if (hit) {
      pushUndo();
      notes.splice(notes.indexOf(hit), 1);
      selection.delete(hit);
    }
  });

  canvas.addEventListener('wheel', (e) => {
    e.preventDefault();
    if (e.ctrlKey) {
      pxPerBeat = clamp(pxPerBeat * (e.deltaY < 0 ? 1.15 : 1 / 1.15), 12, 320);
    } else {
      scrollPx = clamp(scrollPx + e.deltaY, -60, totalBeats() * pxPerBeat);
    }
  }, { passive: false });

  // ---- keyboard ----
  const onKey = (e: KeyboardEvent): void => {
    const tag = (e.target as HTMLElement).tagName;
    if (tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA') return;
    if (e.code === 'Space') {
      e.preventDefault();
      togglePlay();
    } else if (e.code === 'F5' || (e.code === 'KeyT' && !e.ctrlKey)) {
      e.preventDefault();
      testPlay();
    } else if ((e.ctrlKey || e.metaKey) && e.code === 'KeyZ' && !e.shiftKey) {
      e.preventDefault();
      undo();
    } else if ((e.ctrlKey || e.metaKey) && (e.code === 'KeyY' || (e.code === 'KeyZ' && e.shiftKey))) {
      e.preventDefault();
      redo();
    } else if ((e.ctrlKey || e.metaKey) && e.code === 'KeyC') {
      if (!selection.size) return;
      const minBeat = Math.min(...[...selection].map((n) => n.beat));
      clipboard = [...selection].map((n) => ({ beat: n.beat - minBeat, lane: n.lane, durBeats: n.durBeats }));
      toast(`Copied ${clipboard.length} notes`);
    } else if ((e.ctrlKey || e.metaKey) && e.code === 'KeyV') {
      if (!clipboard.length) return;
      pushUndo();
      selection.clear();
      for (const c of clipboard) {
        const n: NoteData = { beat: snapBeat(playheadBeat + c.beat), lane: clamp(c.lane, 0, laneCount() - 1), durBeats: c.durBeats };
        notes.push(n);
        selection.add(n);
      }
      dedupeNotes();
    } else if ((e.ctrlKey || e.metaKey) && e.code === 'KeyS') {
      e.preventDefault();
      void save();
    } else if ((e.ctrlKey || e.metaKey) && e.code === 'KeyA') {
      e.preventDefault();
      selection = new Set(notes);
    } else if (e.code === 'Delete' || e.code === 'Backspace') {
      if (!selection.size) return;
      pushUndo();
      notes = notes.filter((n) => !selection.has(n));
      if (active()) active()!.notes = notes;
      selection.clear();
    } else if (e.code === 'ArrowUp' || e.code === 'ArrowDown') {
      e.preventDefault();
      const step = 1 / snapPerBeat();
      playheadBeat = clamp(snapBeat(playheadBeat + (e.code === 'ArrowDown' ? step : -step)), 0, totalBeats());
      scrollToPlayhead();
    } else if (e.code === 'Escape') {
      if (playing) togglePlay();
      else if (selection.size) selection.clear();
      else exit();
    }
  };
  window.addEventListener('keydown', onKey);

  function scrollToPlayhead(): void {
    const H = canvas.getBoundingClientRect().height;
    const y = yOf(playheadBeat);
    if (y < 60 || y > H - 60) scrollPx = playheadBeat * pxPerBeat - H / 2;
  }

  // ---- drawing ----
  function draw(): void {
    if (destroyed) return;
    rafId = requestAnimationFrame(draw);
    const ctx2 = fitCanvas(canvas);
    const rect = canvas.getBoundingClientRect();
    const W = rect.width, H = rect.height;
    ctx2.clearRect(0, 0, W, H);
    ctx2.fillStyle = '#0b0d13';
    ctx2.fillRect(0, 0, W, H);
    if (!song) return;

    if (playing) {
      playheadBeat = msToBeat(song, conductor.nowMs());
      const y = yOf(playheadBeat);
      if (y > H * 0.72) scrollPx = playheadBeat * pxPerBeat - H * 0.35;
      if (conductor.nowMs() > song.durationMs) togglePlay();
    }

    const beat0 = Math.max(0, Math.floor(beatAtY(0)));
    const beat1 = Math.min(totalBeats(), Math.ceil(beatAtY(H)));
    const lw = laneW();
    const lanesEnd = laneX(laneCount() - 1) + lw;

    // waveform
    if (buffer && peaksMin && peaksMax) {
      ctx2.fillStyle = '#1b2230';
      ctx2.fillRect(WAVE_X, 0, WAVE_W, H);
      ctx2.strokeStyle = '#3f74a3';
      ctx2.beginPath();
      const sr = buffer.sampleRate;
      for (let y = 0; y < H; y += 2) {
        const ms = beatToMs(song, beatAtY(y));
        if (ms < 0 || ms > song.durationMs) continue;
        const idx = Math.floor((ms / 1000) * sr / PEAK_CHUNK);
        if (idx < 0 || idx >= peaksMin.length) continue;
        const mn = peaksMin[idx], mx = peaksMax[idx];
        const cx = WAVE_X + WAVE_W / 2;
        ctx2.moveTo(cx + mn * (WAVE_W / 2 - 2), y);
        ctx2.lineTo(cx + mx * (WAVE_W / 2 - 2), y);
      }
      ctx2.stroke();
    }

    // beat grid
    const spb = snapPerBeat();
    const subStep = 1 / spb;
    ctx2.textAlign = 'left';
    ctx2.font = '10px system-ui';
    for (let b = Math.floor(beat0 / subStep) * subStep; b <= beat1; b += subStep) {
      const y = yOf(b);
      const isBeat = Math.abs(b - Math.round(b)) < 1e-6;
      const isMeasure = isBeat && Math.round(b) % 4 === 0;
      ctx2.strokeStyle = isMeasure ? 'rgba(255,255,255,0.35)' : isBeat ? 'rgba(255,255,255,0.16)' : 'rgba(255,255,255,0.06)';
      ctx2.beginPath();
      ctx2.moveTo(RULER_X, y);
      ctx2.lineTo(lanesEnd, y);
      ctx2.stroke();
      if (isMeasure) {
        ctx2.fillStyle = 'rgba(255,255,255,0.5)';
        ctx2.fillText(`${Math.round(b) / 4 + 1}`, RULER_X + 2, y - 3);
      }
    }

    // lanes
    const c = active();
    for (let l = 0; l < laneCount(); l++) {
      const x = laneX(l);
      ctx2.fillStyle = 'rgba(255,255,255,0.03)';
      ctx2.fillRect(x, 0, lw, H);
      ctx2.fillStyle = 'rgba(255,255,255,0.55)';
      ctx2.textAlign = 'center';
      ctx2.font = 'bold 11px system-ui';
      const label =
        c?.mode === 'keyboard' ? c.keys[l] ?? '?'
        : c?.mode === 'letters' ? LETTERS[l]
        : codeLabel((s.bindings[0] ?? [])[l] ?? '');
      ctx2.fillText(label, x + lw / 2, 14);
    }

    // notes
    for (const n of notes) {
      const hy = yOf(n.beat);
      const ty = yOf(n.beat + n.durBeats);
      if (Math.max(hy, ty) < -20 || Math.min(hy, ty) > H + 20) continue;
      const x = laneX(n.lane);
      const color = laneColor(s, n.lane, laneCount());
      if (n.durBeats > 0) {
        ctx2.fillStyle = color + '66';
        ctx2.fillRect(x + lw * 0.3, hy, lw * 0.4, Math.max(2, ty - hy));
      }
      ctx2.fillStyle = color;
      ctx2.fillRect(x + 2, hy - 5, lw - 4, 10);
      if (selection.has(n)) {
        ctx2.strokeStyle = '#fff';
        ctx2.lineWidth = 2;
        ctx2.strokeRect(x + 1, hy - 6, lw - 2, n.durBeats > 0 ? ty - hy + 12 : 12);
      }
    }

    // box selection
    if (drag?.kind === 'box') {
      ctx2.strokeStyle = 'rgba(120,180,255,0.9)';
      ctx2.fillStyle = 'rgba(120,180,255,0.15)';
      const bx = Math.min(drag.x0, drag.x1), by = Math.min(drag.y0, drag.y1);
      const bw = Math.abs(drag.x1 - drag.x0), bh = Math.abs(drag.y1 - drag.y0);
      ctx2.fillRect(bx, by, bw, bh);
      ctx2.strokeRect(bx, by, bw, bh);
    }

    // playhead
    const py = yOf(playheadBeat);
    ctx2.strokeStyle = '#59e3ff';
    ctx2.lineWidth = 2;
    ctx2.beginPath();
    ctx2.moveTo(WAVE_X, py);
    ctx2.lineTo(lanesEnd + 10, py);
    ctx2.stroke();
    ctx2.fillStyle = '#59e3ff';
    ctx2.beginPath();
    ctx2.moveTo(WAVE_X, py - 5);
    ctx2.lineTo(WAVE_X + 8, py);
    ctx2.lineTo(WAVE_X, py + 5);
    ctx2.fill();

    status.textContent = `${fmtTime(beatToMs(song, playheadBeat))} · beat ${playheadBeat.toFixed(2)} · ${notes.length} notes · ${selection.size} selected — click: place · drag down: hold · right-click: delete · shift-drag: box select · ctrl+C/V copy/paste · ctrl+Z undo · space: play · F5: test`;
  }

  // ---- boot ----
  void (async () => {
    if (params.resume) {
      song = params.resume.song;
      charts = params.resume.charts;
      activeIdx = clamp(params.resume.activeIdx, 0, charts.length - 1);
      playheadBeat = msToBeat(song, params.resume.playheadMs);
      dirty = true;
    } else {
      const songId = params.songId;
      const all = await ctx.db.songs();
      song = (songId ? all.find((x) => x.id === songId) : all[0]) ?? null;
      if (!song) {
        toast('No song to edit — upload one first');
        ctx.nav('songselect', {});
        return;
      }
      song = structuredClone(song);
      charts = (await ctx.db.chartsForSong(song.id)).map((c) => structuredClone(c));
      if (!charts.length) charts = [makeEmptyChart(song.id, 'five', 'medium')];
      activeIdx = 0;
    }
    notes = charts[activeIdx].notes;
    renderToolbars();
    scrollToPlayhead();

    try {
      await ctx.audio.ensureRunning();
      buffer = await ctx.audio.bufferForSong(song, ctx.db);
      const data = buffer.getChannelData(0);
      const n = Math.ceil(data.length / PEAK_CHUNK);
      peaksMin = new Float32Array(n);
      peaksMax = new Float32Array(n);
      for (let i = 0; i < n; i++) {
        let mn = 0, mx = 0;
        const end = Math.min(data.length, (i + 1) * PEAK_CHUNK);
        for (let j = i * PEAK_CHUNK; j < end; j++) {
          const v = data[j];
          if (v < mn) mn = v;
          if (v > mx) mx = v;
        }
        peaksMin[i] = mn;
        peaksMax[i] = mx;
      }
    } catch {
      toast('Audio failed to load — you can still edit notes');
    }
  })();

  rafId = requestAnimationFrame(draw);

  return {
    destroy() {
      destroyed = true;
      cancelAnimationFrame(rafId);
      conductor.stop();
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    },
  };
}
