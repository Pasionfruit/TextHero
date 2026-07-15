import type { AudioEngine } from './audio/AudioEngine';
import type { DB } from './store/db';
import type { Settings } from './store/settings';
import type { NetClient } from './net/NetClient';
import type { ChartData, ReplayData, SongData } from './types';

export type ScreenName = 'menu' | 'songselect' | 'play' | 'results' | 'editor' | 'settings' | 'lobby';

export interface AppCtx {
  db: DB;
  settings: Settings;
  audio: AudioEngine;
  net: NetClient;
  nav(screen: ScreenName, params?: any): void;
  saveSettings(): void;
}

export interface Screen {
  destroy(): void;
}

export type ScreenFactory = (root: HTMLElement, ctx: AppCtx, params: any) => Screen;

export interface PlayerSetup {
  name: string;
  /** five-key mode bindings for this local player */
  codes?: string[];
}

export interface PlayParams {
  song: SongData;
  chart: ChartData;
  players: PlayerSetup[];
  rate: number;
  noFail: boolean;
  practice: boolean;
  loopStartMs?: number | null;
  loopEndMs?: number | null;
  band: { sharedHealth: boolean; sharedCombo: boolean } | null;
  replay?: ReplayData | null;
  test?: { fromMs: number; resume: any } | null;
  online?: boolean;
}

export interface PlayerResult {
  name: string;
  score: number;
  accuracy: number;
  grade: string;
  maxCombo: number;
  failed: boolean;
  counts: Record<string, number>;
  notesHit: number;
  notesMissed: number;
}

export interface ResultsParams {
  song: SongData;
  chart: ChartData;
  players: PlayerResult[];
  band: { score: number; maxCombo: number; failed: boolean } | null;
  replaySavedId: string | null;
  /** local ScoreRecord id auto-saved after an eligible run; lets Results rename or discard it */
  scoreSavedId: string | null;
  online: boolean;
  practice: boolean;
  test: { fromMs: number; resume: any } | null;
  playParams: PlayParams;
}
