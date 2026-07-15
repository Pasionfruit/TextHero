import type { Settings } from '../store/settings';
import type { Difficulty, GameMode } from '../types';

/** REST client for the server-side (SQLite) global leaderboard. */

export interface LeaderboardEntry {
  player: string;
  score: number;
  accuracy: number;
  grade: string;
  maxCombo: number;
  noFail: boolean;
  failed: boolean;
  dateIso: string;
}

export interface ScoreSubmission {
  chartId: string;
  songId: string;
  title: string;
  artist: string;
  mode: GameMode;
  difficulty: Difficulty;
  player: string;
  score: number;
  accuracy: number;
  grade: string;
  maxCombo: number;
  rate: number;
  noFail: boolean;
  failed: boolean;
}

export interface SubmitResult {
  ok: boolean;
  /** false when the player already had an equal-or-better run on this chart */
  improved: boolean;
  rank: number;
  total: number;
}

/** The lobby URL doubles as the API host: ws(s):// → http(s)://. */
export function apiBase(s: Settings): string {
  return s.serverUrl.trim().replace(/\/+$/, '').replace(/^wss:/i, 'https:').replace(/^ws:/i, 'http:');
}

export async function fetchLeaderboard(s: Settings, chartId: string, limit = 10): Promise<LeaderboardEntry[]> {
  const res = await fetch(`${apiBase(s)}/api/leaderboard?chartId=${encodeURIComponent(chartId)}&limit=${limit}`, {
    signal: AbortSignal.timeout(6000),
  });
  if (!res.ok) throw new Error(`Leaderboard request failed (${res.status})`);
  return (await res.json()).scores as LeaderboardEntry[];
}

export async function submitScore(s: Settings, sub: ScoreSubmission): Promise<SubmitResult> {
  const res = await fetch(`${apiBase(s)}/api/scores`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(sub),
    signal: AbortSignal.timeout(8000),
  });
  const data = await res.json().catch(() => null);
  if (!res.ok || !data?.ok) throw new Error(data?.error || `Score submission failed (${res.status})`);
  return data as SubmitResult;
}
