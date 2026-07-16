import type { Settings } from '../store/settings';
import type { ChartData, Difficulty, GameMode, SongData } from '../types';

/** REST client for the server-side (SQLite) global leaderboard. */

export interface LeaderboardEntry {
  id: number;
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

// ---- published charts (admin-authored canonical version, shared by everyone) ----

export interface PublishedChart {
  chartId: string;
  songId: string;
  title: string;
  artist: string;
  bpm: number;
  offsetMs: number;
  mode: GameMode;
  difficulty: Difficulty;
  keys: string[];
  notes: { beat: number; lane: number; durBeats: number }[];
  updatedIso: string;
}

export async function fetchPublishedCharts(s: Settings, songId: string): Promise<PublishedChart[]> {
  const res = await fetch(`${apiBase(s)}/api/charts?songId=${encodeURIComponent(songId)}`, {
    signal: AbortSignal.timeout(6000),
  });
  if (!res.ok) throw new Error(`Chart fetch failed (${res.status})`);
  return (await res.json()).charts as PublishedChart[];
}

/** Publish a song's charts as the version all players will play (admin only). */
export async function publishCharts(s: Settings, song: SongData, charts: ChartData[]): Promise<number> {
  const token = adminToken();
  if (!token) throw new Error('Not logged in as admin');
  const payload = {
    charts: charts.map((c) => ({
      id: c.id,
      songId: c.songId,
      title: song.title,
      artist: song.artist,
      bpm: song.bpm,
      offsetMs: song.offsetMs,
      mode: c.mode,
      difficulty: c.difficulty,
      keys: c.keys,
      notes: c.notes,
    })),
  };
  const res = await fetch(`${apiBase(s)}/api/charts`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(12000),
  });
  const data = await res.json().catch(() => null);
  if (res.status === 401) clearAdminToken();
  if (!res.ok || !data?.ok) throw new Error(data?.error || `Publish failed (${res.status})`);
  return data.published as number;
}

// ---- admin ----
// The session token comes from the server on login and is kept in localStorage;
// credentials themselves never live in client code.

const ADMIN_TOKEN_KEY = 'texthero.admin.token.v1';

export const adminToken = (): string | null => localStorage.getItem(ADMIN_TOKEN_KEY);
export const clearAdminToken = (): void => localStorage.removeItem(ADMIN_TOKEN_KEY);

export async function adminLogin(s: Settings, username: string, password: string): Promise<void> {
  const res = await fetch(`${apiBase(s)}/api/admin/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username, password }),
    signal: AbortSignal.timeout(8000),
  });
  const data = await res.json().catch(() => null);
  if (!res.ok || !data?.token) throw new Error(data?.error || `Login failed (${res.status})`);
  localStorage.setItem(ADMIN_TOKEN_KEY, data.token);
}

async function adminRequest(s: Settings, method: 'DELETE' | 'PATCH', id: number, body?: unknown): Promise<void> {
  const token = adminToken();
  if (!token) throw new Error('Not logged in as admin');
  const res = await fetch(`${apiBase(s)}/api/admin/scores?id=${id}`, {
    method,
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(8000),
  });
  const data = await res.json().catch(() => null);
  if (res.status === 401) clearAdminToken(); // session expired or server restarted
  if (!res.ok || !data?.ok) throw new Error(data?.error || `Admin request failed (${res.status})`);
}

export const adminDeleteScore = (s: Settings, id: number): Promise<void> => adminRequest(s, 'DELETE', id);

export const adminUpdateScore = (
  s: Settings,
  id: number,
  patch: Partial<Pick<LeaderboardEntry, 'player' | 'score' | 'accuracy' | 'grade' | 'maxCombo'>>,
): Promise<void> => adminRequest(s, 'PATCH', id, patch);
