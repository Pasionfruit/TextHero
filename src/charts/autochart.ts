import type { ChartData, Difficulty, GameMode, NoteData, SongData } from '../types';
import { LETTERS, letterColumn, msToBeat } from './chart';
import { clamp, mulberry32, uid } from '../util';

/**
 * Automatic sample-chart generation from audio.
 *
 * Pipeline: the song is rendered once through three parallel filters
 * (lows ≈ kick, mids ≈ melody/vocals, highs ≈ hats/snare) with an
 * OfflineAudioContext; per-band RMS envelopes give onset times via positive
 * energy flux + adaptive peak picking; BPM comes from autocorrelation of the
 * combined flux and the grid phase (offset) from aligning strong onsets to it.
 * Notes are then quantized to a difficulty-dependent grid.
 */

const ANALYSIS_SR = 22050;
const FRAME = 1024;
const HOP = 256;

export interface Onset {
  t: number; // seconds
  strength: number; // 0..1, normalized per band
  band: 0 | 1 | 2; // low / mid / high
  frame: number;
}

export interface SongAnalysis {
  hopSec: number;
  env: Float32Array[]; // 3 band RMS envelopes
  onsets: Onset[]; // sorted by time
  duration: number; // seconds
}

export async function analyzeSong(buffer: AudioBuffer): Promise<SongAnalysis> {
  const len = Math.max(FRAME * 4, Math.ceil(buffer.duration * ANALYSIS_SR));
  const ctx = new OfflineAudioContext(3, len, ANALYSIS_SR);
  const src = ctx.createBufferSource();
  src.buffer = buffer;
  const merger = ctx.createChannelMerger(3);

  const lo = ctx.createBiquadFilter();
  lo.type = 'lowpass';
  lo.frequency.value = 150;
  const mid = ctx.createBiquadFilter();
  mid.type = 'bandpass';
  mid.frequency.value = 900;
  mid.Q.value = 0.5;
  const hi = ctx.createBiquadFilter();
  hi.type = 'highpass';
  hi.frequency.value = 4200;

  src.connect(lo);
  src.connect(mid);
  src.connect(hi);
  lo.connect(merger, 0, 0);
  mid.connect(merger, 0, 1);
  hi.connect(merger, 0, 2);
  merger.connect(ctx.destination);
  src.start();
  const rendered = await ctx.startRendering();

  const env: Float32Array[] = [];
  for (let ch = 0; ch < 3; ch++) {
    const data = rendered.getChannelData(ch);
    const n = Math.max(1, Math.floor((data.length - FRAME) / HOP));
    const e = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      let sum = 0;
      const start = i * HOP;
      for (let j = start; j < start + FRAME; j++) sum += data[j] * data[j];
      e[i] = Math.sqrt(sum / FRAME);
    }
    env.push(e);
  }

  return {
    hopSec: HOP / ANALYSIS_SR,
    env,
    onsets: detectOnsets(env, HOP / ANALYSIS_SR),
    duration: buffer.duration,
  };
}

/** Positive energy flux + adaptive local-median threshold + local-max picking. */
export function detectOnsets(env: Float32Array[], hopSec: number): Onset[] {
  const onsets: Onset[] = [];
  for (let band = 0; band < env.length; band++) {
    const e = env[band];
    const n = e.length;
    const flux = new Float32Array(n);
    let maxFlux = 0;
    for (let i = 1; i < n; i++) {
      flux[i] = Math.max(0, e[i] - e[i - 1]);
      if (flux[i] > maxFlux) maxFlux = flux[i];
    }
    if (maxFlux <= 0) continue;
    for (let i = 0; i < n; i++) flux[i] /= maxFlux;

    const W = 10;
    for (let i = 3; i < n - 3; i++) {
      const v = flux[i];
      if (v < 0.03) continue;
      let isMax = true;
      for (let j = i - 3; j <= i + 3; j++) {
        if (flux[j] > v) {
          isMax = false;
          break;
        }
      }
      if (!isMax) continue;
      let mean = 0;
      let cnt = 0;
      for (let j = Math.max(0, i - W); j < Math.min(n, i + W); j++) {
        mean += flux[j];
        cnt++;
      }
      mean /= cnt;
      if (v > mean * 1.5 + 0.02) {
        onsets.push({ t: i * hopSec, strength: v, band: band as 0 | 1 | 2, frame: i });
      }
    }
  }
  return onsets.sort((a, b) => a.t - b.t);
}

/**
 * Estimate BPM (folded into 80–160) via autocorrelation of the combined flux,
 * then the grid phase by aligning the strongest onsets to a candidate offset.
 * Pass fixedBpm to only fit the phase. Falls back to 120/0 on silence.
 */
export function estimateGrid(a: SongAnalysis, fixedBpm?: number): { bpm: number; offsetMs: number } {
  const n = a.env[0]?.length ?? 0;
  const flux = new Float32Array(n);
  for (const e of a.env) {
    for (let i = 1; i < n && i < e.length; i++) flux[i] += Math.max(0, e[i] - e[i - 1]);
  }
  const maxF = Math.max(...flux, 0);
  if (maxF <= 0 || !a.onsets.length) return { bpm: fixedBpm ?? 120, offsetMs: 0 };
  for (let i = 0; i < n; i++) flux[i] /= maxF;

  let bpm = fixedBpm ?? 120;
  if (!fixedBpm) {
    const minLag = Math.max(2, Math.floor(60 / 200 / a.hopSec));
    const maxLag = Math.min(n - 1, Math.ceil(60 / 60 / a.hopSec));
    let bestLag = minLag;
    let bestScore = -1;
    for (let lag = minLag; lag <= maxLag; lag++) {
      let s = 0;
      for (let i = 0; i + lag < n; i++) s += flux[i] * flux[i + lag];
      let s2 = 0;
      if (lag * 2 < n) for (let i = 0; i + lag * 2 < n; i += 2) s2 += flux[i] * flux[i + lag * 2];
      const score = s + 0.5 * s2;
      if (score > bestScore) {
        bestScore = score;
        bestLag = lag;
      }
    }
    bpm = 60 / (bestLag * a.hopSec);
    while (bpm < 80) bpm *= 2;
    while (bpm >= 160) bpm /= 2;
    bpm = Math.round(bpm * 100) / 100;
  }
  bpm = clamp(bpm, 40, 300);

  // phase fit: strongest onsets vote for the offset that puts them on the grid
  const T = 60 / bpm;
  const strong = [...a.onsets].sort((x, y) => y.strength - x.strength).slice(0, 150);
  let bestPhi = 0;
  let bestScore = -1;
  const SIGMA = 0.03;
  for (let phi = 0; phi < T; phi += 0.005) {
    let score = 0;
    for (const o of strong) {
      let d = (o.t - phi) % T;
      if (d < 0) d += T;
      d = Math.min(d, T - d);
      score += o.strength * (o.band === 0 ? 1.5 : 1) * Math.exp(-(d * d) / (2 * SIGMA * SIGMA));
    }
    if (score > bestScore) {
      bestScore = score;
      bestPhi = phi;
    }
  }
  return { bpm, offsetMs: Math.round(bestPhi * 1000) };
}

// ---------------------------------------------------------------------------
// note generation
// ---------------------------------------------------------------------------

const hashStr = (s: string): number => {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
  return h >>> 0;
};

const quantile = (sorted: number[], q: number): number =>
  sorted.length ? sorted[clamp(Math.floor(q * sorted.length), 0, sorted.length - 1)] : 0;

/** How long the mid band stays energized after an onset (for hold notes), in beats. */
function sustainBeats(a: SongAnalysis, o: Onset, song: SongData): number {
  const e = a.env[1];
  if (!e || o.band !== 1) return 0;
  const v0 = e[Math.min(e.length - 1, o.frame + 2)];
  if (v0 <= 0) return 0;
  let j = o.frame + 4;
  const nextMid = a.onsets.find((x) => x.band === 1 && x.frame > o.frame + 6);
  const stopFrame = nextMid ? nextMid.frame - 2 : e.length;
  while (j < e.length && j < stopFrame && e[j] > v0 * 0.35) j++;
  const sec = (j - o.frame) * a.hopSec;
  return (sec / 60) * song.bpm;
}

export function generateNotes(
  song: SongData,
  a: SongAnalysis,
  mode: GameMode,
  difficulty: Difficulty,
  laneCount: number,
): NoteData[] {
  const quantum = difficulty === 'easy' ? 1 : difficulty === 'medium' ? 0.5 : 0.25;
  const dropQ = difficulty === 'easy' ? 0.55 : difficulty === 'medium' ? 0.3 : 0.08;
  const strengths = a.onsets.map((o) => o.strength).sort((x, y) => x - y);
  const cut = quantile(strengths, dropQ);
  const maxBeat = msToBeat(song, a.duration * 1000 - 200);
  const rng = mulberry32(hashStr(song.id + mode + difficulty));

  // bucket onsets by quantized beat, keeping the strongest onset per band
  const ticks = new Map<number, Onset[]>();
  for (const o of a.onsets) {
    if (o.strength < cut) continue;
    const beat = Math.round(msToBeat(song, o.t * 1000) / quantum) * quantum;
    if (beat < 0 || beat > maxBeat) continue;
    const key = Math.round(beat * 1000);
    const arr = ticks.get(key) ?? [];
    const existing = arr.find((x) => x.band === o.band);
    if (existing) {
      if (o.strength > existing.strength) arr[arr.indexOf(existing)] = o;
    } else {
      arr.push(o);
    }
    ticks.set(key, arr);
  }

  const keys = [...ticks.keys()].sort((x, y) => x - y);
  const notes: NoteData[] = [];
  const laneEnd = new Map<number, number>(); // lane -> beat where it frees up
  const free = (lane: number, beat: number, dur: number): boolean =>
    beat >= (laneEnd.get(lane) ?? -9) + 0.24;
  const put = (beat: number, lane: number, dur: number): boolean => {
    if (!free(lane, beat, dur)) return false;
    notes.push({ beat, lane, durBeats: dur });
    laneEnd.set(lane, beat + dur);
    return true;
  };

  if (mode === 'letters') {
    const pool = difficulty === 'easy' || difficulty === 'medium' ? 'ASDFGHJKLERTUIO' : LETTERS;
    const lastByLetter = new Map<number, number>();
    const lastByCol = new Map<number, number>();
    let lastBeat = -9;
    for (const key of keys) {
      const beat = key / 1000;
      if (beat - lastBeat < quantum * 0.99) continue;
      const group = ticks.get(key)!;
      const strongest = group.reduce((m, o) => (o.strength > m.strength ? o : m));
      const dur = difficulty !== 'easy' ? clamp(Math.round(sustainBeats(a, strongest, song) / quantum) * quantum, 0, 4) : 0;
      const durBeats = dur >= 1 ? dur : 0;
      for (let attempt = 0; attempt < 14; attempt++) {
        const ch = pool[Math.floor(rng() * pool.length)];
        const lane = LETTERS.indexOf(ch);
        const col = letterColumn(lane, 5);
        if (beat - (lastByLetter.get(lane) ?? -9) >= 0.9 && beat - (lastByCol.get(col) ?? -9) >= 0.45) {
          notes.push({ beat, lane, durBeats });
          lastByLetter.set(lane, beat + durBeats);
          lastByCol.set(col, beat + durBeats);
          lastBeat = beat;
          break;
        }
      }
    }
    return notes.sort((x, y) => x.beat - y.beat || x.lane - y.lane);
  }

  // five / keyboard: lows anchor the outer lanes, highs the inner off-lanes,
  // mids walk melodically across the middle
  const lanes = mode === 'five' ? 5 : Math.max(1, laneCount);
  const lowLanes = lanes >= 5 ? [0, lanes - 1] : [0];
  const highLanes = lanes >= 4 ? [1, lanes - 2] : [Math.min(1, lanes - 1)];
  let lowIdx = 0;
  let highIdx = 0;
  let walkLane = Math.floor(lanes / 2);
  let lastBeat = -9;

  for (const key of keys) {
    const beat = key / 1000;
    if (beat - lastBeat < quantum * 0.99) continue;
    const group = ticks.get(key)!.sort((x, y) => y.strength - x.strength);
    const chordCap = difficulty === 'expert' || difficulty === 'hard' ? 2 : group.every((o) => o.strength > 0.8) && difficulty === 'medium' ? 2 : 1;
    let placed = 0;
    for (const o of group) {
      if (placed >= chordCap) break;
      let lane: number;
      let dur = 0;
      if (o.band === 0) {
        lane = lowLanes[lowIdx++ % lowLanes.length];
      } else if (o.band === 2) {
        lane = highLanes[highIdx++ % highLanes.length];
      } else {
        const step = rng() < 0.55 ? (rng() < 0.5 ? -1 : 1) : 0;
        walkLane = clamp(walkLane + step, lanes >= 5 && difficulty !== 'hard' && difficulty !== 'expert' ? 1 : 0, lanes >= 5 && difficulty !== 'hard' && difficulty !== 'expert' ? lanes - 2 : lanes - 1);
        lane = walkLane;
        if (difficulty !== 'easy') {
          const s = sustainBeats(a, o, song);
          const q = Math.round(s / quantum) * quantum;
          if (q >= 1.2) dur = clamp(q, 1, 4);
        }
      }
      if (put(beat, lane, dur)) placed++;
    }
    if (placed > 0) lastBeat = beat;
  }
  return notes.sort((x, y) => x.beat - y.beat || x.lane - y.lane);
}

/** The sample-level set generated on upload: three five-key difficulties + letters. */
export function generateSampleCharts(song: SongData, a: SongAnalysis): ChartData[] {
  const mk = (mode: GameMode, difficulty: Difficulty): ChartData => ({
    id: uid(),
    songId: song.id,
    mode,
    difficulty,
    keys: [],
    notes: generateNotes(song, a, mode, difficulty, mode === 'letters' ? 26 : 5),
  });
  return [mk('five', 'easy'), mk('five', 'medium'), mk('five', 'hard'), mk('letters', 'medium')].filter(
    (c) => c.notes.length >= 8,
  );
}
