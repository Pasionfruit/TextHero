import type { Windows } from '../types';

export interface Settings {
  playerName: string;
  /** five-key bindings per local player slot (KeyboardEvent.code). */
  bindings: string[][];
  scrollDirection: 'up' | 'down';
  scrollSpeed: number;
  reverse: boolean;
  hidden: boolean;
  sudden: boolean;
  audioOffsetMs: number;
  visualOffsetMs: number;
  judgmentLinePos: number; // fraction of playfield height from the target edge
  noteSkin: 'gems' | 'bars' | 'circles' | 'arrows';
  laneColors: string[];
  colorblind: boolean;
  highContrast: boolean;
  noteScale: number;
  laneSpacingPx: number;
  fontFamily: string;
  hitSounds: boolean;
  bgDim: number;
  particles: boolean;
  reducedEffects: boolean;
  fpsCap: number; // 0 = uncapped
  windows: Windows;
  serverUrl: string;
}

export const DEFAULT_SETTINGS: Settings = {
  playerName: 'Player',
  bindings: [
    ['KeyD', 'KeyF', 'Space', 'KeyJ', 'KeyK'],
    ['ArrowLeft', 'ArrowDown', 'ShiftRight', 'ArrowUp', 'ArrowRight'],
    ['Numpad4', 'Numpad5', 'Numpad0', 'Numpad8', 'Numpad9'],
    ['KeyZ', 'KeyX', 'KeyC', 'KeyV', 'KeyB'],
  ],
  scrollDirection: 'down',
  scrollSpeed: 1,
  reverse: false,
  hidden: false,
  sudden: false,
  audioOffsetMs: 0,
  visualOffsetMs: 0,
  judgmentLinePos: 0.13,
  noteSkin: 'gems',
  laneColors: ['#43d675', '#e5484d', '#f5d90a', '#3b82f6', '#f97316'],
  colorblind: false,
  highContrast: false,
  noteScale: 1,
  laneSpacingPx: 4,
  fontFamily: 'system-ui',
  hitSounds: true,
  bgDim: 0.5,
  particles: true,
  reducedEffects: false,
  fpsCap: 0,
  windows: { perfect: 25, great: 60, good: 100, bad: 150 },
  serverUrl: 'ws://localhost:8137',
};

const KEY = 'texthero.settings.v1';

export function loadSettings(): Settings {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return structuredClone(DEFAULT_SETTINGS);
    const parsed = JSON.parse(raw);
    return {
      ...structuredClone(DEFAULT_SETTINGS),
      ...parsed,
      windows: { ...DEFAULT_SETTINGS.windows, ...(parsed.windows ?? {}) },
    };
  } catch {
    return structuredClone(DEFAULT_SETTINGS);
  }
}

export function saveSettings(s: Settings): void {
  localStorage.setItem(KEY, JSON.stringify(s));
}

/** Okabe–Ito colorblind-safe palette used when settings.colorblind is on. */
export const COLORBLIND_LANE_COLORS = ['#0072b2', '#e69f00', '#009e73', '#cc79a7', '#f0e442'];

export function laneColor(s: Settings, lane: number, laneCount: number): string {
  const pal = s.colorblind ? COLORBLIND_LANE_COLORS : s.laneColors;
  return pal[lane % pal.length];
}

export const JUDGE_COLORS: Record<string, string> = {
  perfect: '#59e3ff',
  great: '#63e56b',
  good: '#f2e14c',
  bad: '#f59a4a',
  miss: '#f25555',
};

export const JUDGE_COLORS_CB: Record<string, string> = {
  perfect: '#0072b2',
  great: '#009e73',
  good: '#f0e442',
  bad: '#e69f00',
  miss: '#d55e00',
};

export function judgeColor(s: Settings, j: string): string {
  return (s.colorblind ? JUDGE_COLORS_CB : JUDGE_COLORS)[j] ?? '#fff';
}
