/**
 * five     — 5 lanes, Guitar Hero style, bound keys from settings
 * keyboard — chart-defined key set, one labeled lane per key (osu!mania style)
 * letters  — any A–Z letter falls down the highway; press that letter (lane = letter index 0–25)
 */
export type GameMode = 'five' | 'keyboard' | 'letters';
export type Difficulty = 'easy' | 'medium' | 'hard' | 'expert';
export const DIFFICULTIES: Difficulty[] = ['easy', 'medium', 'hard', 'expert'];

export type JudgmentName = 'perfect' | 'great' | 'good' | 'bad' | 'miss';
export const JUDGMENTS: JudgmentName[] = ['perfect', 'great', 'good', 'bad', 'miss'];

export interface Windows {
  perfect: number;
  great: number;
  good: number;
  bad: number;
}

export const JUDGE_SCORE: Record<JudgmentName, number> = {
  perfect: 300,
  great: 200,
  good: 100,
  bad: 50,
  miss: 0,
};

export const JUDGE_HEALTH: Record<JudgmentName, number> = {
  perfect: 1,
  great: 0.6,
  good: 0.2,
  bad: -2,
  miss: -5,
};

export const GHOST_TAP_HEALTH = -1.5;
export const HOLD_DROP_HEALTH = -1;
export const HOLD_BONUS_SCORE = 50;
/** points per tap inside a spam section (× multiplier) */
export const SPAM_TAP_SCORE = 25;

/** streak → multiplier: <4 = 1x, 4–7 = 2x, 8–15 = 3x, 16+ = 4x (fever doubles on top) */
export const MULTIPLIER_TIERS: Array<[number, number]> = [
  [16, 4],
  [8, 3],
  [4, 2],
];

export function multiplierFor(combo: number): number {
  for (const [need, mult] of MULTIPLIER_TIERS) if (combo >= need) return mult;
  return 1;
}

/** Note position/duration are stored in beats so BPM/offset edits re-time everything. */
export interface NoteData {
  beat: number;
  lane: number;
  durBeats: number; // 0 = tap note
}

/** A window where every key press scores freely — no judging, no penalties. */
export interface SpamSection {
  beat: number;
  durBeats: number;
}

export interface ChartData {
  id: string;
  songId: string;
  mode: GameMode;
  difficulty: Difficulty;
  /** keyboard mode: which physical keys (uppercase e.key values) each lane uses. five mode: ignored (bindings come from settings). */
  keys: string[];
  notes: NoteData[];
  /** mash-for-points windows */
  spam?: SpamSection[];
  updatedIso?: string;
  /** set when this chart came from the server as the admin's published, canonical
   *  version — the one everyone plays and is ranked on */
  published?: boolean;
  publishedIso?: string;
}

export interface SongData {
  id: string;
  title: string;
  artist: string;
  bpm: number;
  offsetMs: number; // audio time of beat 0
  audioId: string | null; // IndexedDB blob key; null = built-in synthesized demo or bundled asset
  /** bundled songs: static asset URL fetched on demand instead of an IndexedDB blob */
  audioUrl?: string;
  /** bundled songs: auto-chart generator version used; bumping regenerates charts */
  chartGen?: number;
  genre?: string;
  artDataUrl?: string;
  durationMs: number;
}

export interface ScoreRecord {
  id: string;
  chartId: string;
  songId: string;
  mode: GameMode;
  difficulty: Difficulty;
  player: string;
  score: number;
  accuracy: number; // 0..1
  grade: string;
  maxCombo: number;
  counts: Record<JudgmentName, number>;
  dateIso: string;
  rate: number;
  noFail: boolean;
  failed: boolean;
  replayId?: string;
}

export interface ReplayEventRec {
  t: number; // song ms
  lane: number;
  down: boolean;
}

export interface ReplayData {
  id: string;
  chartId: string;
  songId: string;
  player: string;
  rate: number;
  windows: Windows;
  events: ReplayEventRec[];
  dateIso: string;
  score: number;
  accuracy: number;
  grade: string;
  maxCombo: number;
}

export type NoteState = 'pending' | 'hit' | 'holding' | 'completed' | 'dropped' | 'missed' | 'skipped';

export interface RuntimeNote {
  id: number;
  lane: number;
  tMs: number;
  endMs: number; // == tMs for taps
  state: NoteState;
  judgment?: JudgmentName;
  hitDeltaMs?: number;
}

export interface JudgeEvent {
  type: 'hit' | 'miss' | 'ghost' | 'holdDrop' | 'holdComplete' | 'spam';
  judgment?: JudgmentName;
  deltaMs?: number;
  lane: number;
  tMs: number;
  baseScore: number; // unmultiplied
  healthDelta: number;
  comboAfter: number;
}
