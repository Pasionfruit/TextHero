import type { ChartData, Difficulty, GameMode, NoteData, RuntimeNote, SongData } from '../types';
import { DEMO_BEATS, DEMO_BPM, DEMO_OFFSET_MS, DEMO_TAIL_SEC, demoEvents } from '../audio/demoSong';
import { clamp, mulberry32, uid } from '../util';

export const beatToMs = (song: SongData, beat: number): number => song.offsetMs + (beat * 60000) / song.bpm;
export const msToBeat = (song: SongData, ms: number): number => ((ms - song.offsetMs) * song.bpm) / 60000;

export function compileNotes(song: SongData, chart: ChartData): RuntimeNote[] {
  return chart.notes
    .slice()
    .sort((a, b) => a.beat - b.beat || a.lane - b.lane)
    .map((n, i) => ({
      id: i,
      lane: n.lane,
      tMs: beatToMs(song, n.beat),
      endMs: beatToMs(song, n.beat + n.durBeats),
      state: 'pending' as const,
    }));
}

export const LETTERS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';

const QWERTY_ROWS = ['QWERTYUIOP', 'ASDFGHJKL', 'ZXCVBNM'];

/** Map a letter lane (0–25) to a display column, spread by physical keyboard position. */
export function letterColumn(letterLane: number, cols: number): number {
  const ch = LETTERS[letterLane] ?? 'A';
  for (const row of QWERTY_ROWS) {
    const i = row.indexOf(ch);
    if (i >= 0) return clamp(Math.round((i / (row.length - 1)) * (cols - 1)), 0, cols - 1);
  }
  return 0;
}

export function laneCountOf(chart: ChartData): number {
  if (chart.mode === 'five') return 5;
  if (chart.mode === 'letters') return 26;
  return Math.max(1, chart.keys.length);
}

export const modeLabel = (m: GameMode): string => (m === 'five' ? '5K' : m === 'keyboard' ? 'KB' : 'ABC');
export const modeName = (m: GameMode): string => (m === 'five' ? 'Five-Key' : m === 'keyboard' ? 'Keyboard' : 'Letters');

export function makeEmptyChart(songId: string, mode: GameMode, difficulty: Difficulty): ChartData {
  return {
    id: uid(),
    songId,
    mode,
    difficulty,
    keys: mode === 'keyboard' ? ['A', 'S', 'D', 'F', 'J', 'K', 'L', ';'] : [],
    notes: [],
  };
}

export const DEMO_SONG_ID = 'demo-song';

export function demoSongData(): SongData {
  return {
    id: DEMO_SONG_ID,
    title: 'Neon Circuit',
    artist: 'Type-to-Beat (built-in)',
    genre: 'Synthwave',
    bpm: DEMO_BPM,
    offsetMs: DEMO_OFFSET_MS,
    audioId: null,
    durationMs: DEMO_OFFSET_MS + (DEMO_BEATS * 60000) / DEMO_BPM + DEMO_TAIL_SEC * 1000,
  };
}

/** midi pitch → lane, spreading the pentatonic run across the lanes. */
function melodyLane(midi: number, laneCount: number): number {
  return clamp(Math.round(((midi - 57) / 15) * (laneCount - 1)), 0, laneCount - 1);
}

interface Placer {
  notes: NoteData[];
}

function makePlacer(_laneCount: number): Placer {
  return { notes: [] };
}

const MIN_GAP_BEATS = 0.24;

/** Insertion-order independent: rejects anything overlapping an existing note (incl. hold spans) in the lane. */
function place(p: Placer, beat: number, lane: number, durBeats = 0): boolean {
  for (const n of p.notes) {
    if (n.lane !== lane) continue;
    if (beat + durBeats + MIN_GAP_BEATS > n.beat && n.beat + n.durBeats + MIN_GAP_BEATS > beat) return false;
  }
  p.notes.push({ beat, lane, durBeats });
  return true;
}

export function buildDemoCharts(): ChartData[] {
  const ev = demoEvents();
  const charts: ChartData[] = [];

  const build = (difficulty: Difficulty): ChartData => {
    const p = makePlacer(5);
    const dense = difficulty === 'hard' || difficulty === 'expert';

    for (const b of ev.kicks) {
      if (difficulty === 'easy' && b % 1 !== 0) continue;
      place(p, b, b % 2 === 0 ? 0 : 4);
    }
    for (const b of ev.snares) {
      place(p, b, 2);
      if (dense && b % 4 === 3) place(p, b, 1); // chord accent on bar-end snare
      if (difficulty === 'expert' && b % 4 === 1) place(p, b, 3);
    }
    if (difficulty !== 'easy') {
      for (const m of ev.melody) {
        const lane = melodyLane(m.midi, 5);
        const dur = m.len >= 1.5 ? m.len : 0; // long melody notes become holds
        place(p, m.beat, lane, dur);
      }
    }
    if (dense) {
      for (const b of ev.hats) {
        if (difficulty === 'hard' && b % 1 === 0) continue; // hard: offbeat hats only
        place(p, b, b % 2 < 1 ? 1 : 3);
      }
    }
    return {
      id: `demo-five-${difficulty}`,
      songId: DEMO_SONG_ID,
      mode: 'five',
      difficulty,
      keys: [],
      notes: p.notes.sort((a, b) => a.beat - b.beat || a.lane - b.lane),
    };
  };

  charts.push(build('easy'), build('medium'), build('hard'), build('expert'));

  // Full-keyboard chart: melody spread across home-row letters, kicks anchored on A.
  const keys = ['A', 'S', 'D', 'F', 'J', 'K', 'L', ';'];
  const kp = makePlacer(keys.length);
  for (const b of ev.kicks) if (b % 1 === 0) place(kp, b, 0);
  for (const m of ev.melody) {
    const lane = 1 + clamp(Math.round(((m.midi - 57) / 15) * (keys.length - 2)), 0, keys.length - 2);
    place(kp, m.beat, lane, m.len >= 1.5 ? m.len : 0);
  }
  charts.push({
    id: 'demo-kb-medium',
    songId: DEMO_SONG_ID,
    mode: 'keyboard',
    difficulty: 'medium',
    keys,
    notes: kp.notes.sort((a, b) => a.beat - b.beat || a.lane - b.lane),
  });

  charts.push(
    buildLetterChart('medium', 'ASDFGHJKLERTUIO', 'demo-letters-medium', 0xfeed),
    buildLetterChart('hard', LETTERS, 'demo-letters-hard', 0xbeef),
  );

  return charts;
}

/** Letters mode: pick which letter falls for each musical event, keeping letters
 *  and display columns from repeating too quickly so charts stay readable. */
function buildLetterChart(difficulty: Difficulty, pool: string, id: string, seed: number): ChartData {
  const ev = demoEvents();
  const rng = mulberry32(seed);
  const notes: NoteData[] = [];
  const lastByLetter = new Map<number, number>();
  const lastByCol = new Map<number, number>();

  const events: Array<{ beat: number; dur: number }> = [];
  for (const b of ev.kicks) if (b % 1 === 0) events.push({ beat: b, dur: 0 });
  for (const m of ev.melody) events.push({ beat: m.beat, dur: m.len >= 1.5 ? m.len : 0 });
  if (difficulty === 'hard' || difficulty === 'expert') for (const b of ev.snares) events.push({ beat: b, dur: 0 });
  events.sort((a, b) => a.beat - b.beat);

  for (const e of events) {
    for (let attempt = 0; attempt < 14; attempt++) {
      const ch = pool[Math.floor(rng() * pool.length)];
      const lane = LETTERS.indexOf(ch);
      const col = letterColumn(lane, 5);
      if (e.beat - (lastByLetter.get(lane) ?? -9) >= 0.9 && e.beat - (lastByCol.get(col) ?? -9) >= 0.45) {
        notes.push({ beat: e.beat, lane, durBeats: e.dur });
        lastByLetter.set(lane, e.beat + e.dur);
        lastByCol.set(col, e.beat + e.dur);
        break;
      }
    }
  }

  return {
    id,
    songId: DEMO_SONG_ID,
    mode: 'letters',
    difficulty,
    keys: [],
    notes: notes.sort((a, b) => a.beat - b.beat || a.lane - b.lane),
  };
}
