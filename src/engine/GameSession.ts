import {
  GHOST_TAP_HEALTH,
  HOLD_BONUS_SCORE,
  HOLD_DROP_HEALTH,
  JUDGE_HEALTH,
  JUDGE_SCORE,
  multiplierFor,
} from '../types';
import type { JudgeEvent, JudgmentName, RuntimeNote, Windows } from '../types';
import { clamp, gradeFor } from '../util';

export interface SessionConfig {
  notes: RuntimeNote[];
  laneCount: number;
  windows: Windows;
  noFail: boolean;
  /** when false the session tracks health deltas in events but never fails itself (band shared-health mode) */
  ownHealth: boolean;
  onEvent?: (ev: JudgeEvent) => void;
}

/**
 * Deterministic per-player gameplay state. All inputs are (lane, songMs) pairs,
 * so a replay of recorded events reproduces the exact same run — this is also
 * what keeps online clients in agreement about scoring.
 */
export class GameSession {
  notes: RuntimeNote[];
  laneCount: number;
  windows: Windows;
  noFail: boolean;
  ownHealth: boolean;
  onEvent?: (ev: JudgeEvent) => void;

  score = 0;
  combo = 0;
  maxCombo = 0;
  health = 100;
  failed = false;
  failedAtMs: number | null = null;
  counts: Record<JudgmentName, number> = { perfect: 0, great: 0, good: 0, bad: 0, miss: 0 };
  holdsCompleted = 0;
  holdsDropped = 0;
  ghostTaps = 0;

  private byLane: RuntimeNote[][];
  private laneCursor: number[];
  private holding: (RuntimeNote | null)[];
  private scanCursor = 0;

  constructor(cfg: SessionConfig) {
    this.notes = cfg.notes;
    this.laneCount = cfg.laneCount;
    this.windows = cfg.windows;
    this.noFail = cfg.noFail;
    this.ownHealth = cfg.ownHealth;
    this.onEvent = cfg.onEvent;
    this.byLane = Array.from({ length: cfg.laneCount }, () => []);
    for (const n of this.notes) if (n.lane >= 0 && n.lane < cfg.laneCount) this.byLane[n.lane].push(n);
    this.laneCursor = new Array(cfg.laneCount).fill(0);
    this.holding = new Array(cfg.laneCount).fill(null);
  }

  private emit(ev: JudgeEvent): JudgeEvent {
    this.onEvent?.(ev);
    return ev;
  }

  private applyHealth(delta: number, tMs: number): void {
    if (!this.ownHealth) return;
    this.health = clamp(this.health + delta, 0, 100);
    if (this.health <= 0 && !this.noFail && !this.failed) {
      this.failed = true;
      this.failedAtMs = tMs;
    }
  }

  private judgmentFor(absDelta: number): JudgmentName | null {
    const w = this.windows;
    if (absDelta <= w.perfect) return 'perfect';
    if (absDelta <= w.great) return 'great';
    if (absDelta <= w.good) return 'good';
    if (absDelta <= w.bad) return 'bad';
    return null;
  }

  press(lane: number, tMs: number): JudgeEvent | null {
    if (this.failed || lane < 0 || lane >= this.laneCount) return null;
    const laneNotes = this.byLane[lane];
    // find the closest judgeable pending note in this lane
    let best: RuntimeNote | null = null;
    let bestAbs = Infinity;
    for (let i = this.laneCursor[lane]; i < laneNotes.length; i++) {
      const n = laneNotes[i];
      if (n.state !== 'pending') continue;
      const d = tMs - n.tMs;
      if (d < -this.windows.bad) break; // sorted: everything further is in the future
      const abs = Math.abs(d);
      if (abs < bestAbs) {
        best = n;
        bestAbs = abs;
      }
    }
    if (!best) {
      // ghost tap: pressing with nothing to hit costs health (spec: incorrect keys)
      this.ghostTaps++;
      const ev: JudgeEvent = {
        type: 'ghost',
        lane,
        tMs,
        baseScore: 0,
        healthDelta: GHOST_TAP_HEALTH,
        comboAfter: this.combo,
      };
      this.applyHealth(GHOST_TAP_HEALTH, tMs);
      return this.emit(ev);
    }

    const delta = tMs - best.tMs;
    const judgment = this.judgmentFor(Math.abs(delta))!;
    best.judgment = judgment;
    best.hitDeltaMs = delta;
    const isHold = best.endMs > best.tMs;
    best.state = isHold ? 'holding' : 'hit';
    if (isHold) this.holding[lane] = best;

    this.combo++;
    this.maxCombo = Math.max(this.maxCombo, this.combo);
    this.counts[judgment]++;
    const base = JUDGE_SCORE[judgment];
    this.score += base * multiplierFor(this.combo);
    const hd = JUDGE_HEALTH[judgment];
    this.applyHealth(hd, tMs);
    return this.emit({
      type: 'hit',
      judgment,
      deltaMs: delta,
      lane,
      tMs,
      baseScore: base,
      healthDelta: hd,
      comboAfter: this.combo,
    });
  }

  release(lane: number, tMs: number): JudgeEvent | null {
    const note = this.holding[lane];
    if (!note) return null;
    this.holding[lane] = null;
    const grace = Math.max(120, this.windows.good);
    if (tMs < note.endMs - grace) {
      note.state = 'dropped';
      this.holdsDropped++;
      this.combo = 0;
      this.applyHealth(HOLD_DROP_HEALTH, tMs);
      return this.emit({
        type: 'holdDrop',
        lane,
        tMs,
        baseScore: 0,
        healthDelta: HOLD_DROP_HEALTH,
        comboAfter: 0,
      });
    }
    return this.completeHold(note, tMs);
  }

  private completeHold(note: RuntimeNote, tMs: number): JudgeEvent {
    note.state = 'completed';
    this.holdsCompleted++;
    this.score += HOLD_BONUS_SCORE * multiplierFor(this.combo);
    this.applyHealth(0.5, tMs);
    return this.emit({
      type: 'holdComplete',
      lane: note.lane,
      tMs,
      baseScore: HOLD_BONUS_SCORE,
      healthDelta: 0.5,
      comboAfter: this.combo,
    });
  }

  /** Advance time: mark misses, auto-complete holds still held past their tail. */
  update(tMs: number): void {
    if (this.failed) return;
    for (let lane = 0; lane < this.laneCount; lane++) {
      const held = this.holding[lane];
      if (held && tMs >= held.endMs) {
        this.holding[lane] = null;
        this.completeHold(held, tMs);
      }
    }
    for (let i = this.scanCursor; i < this.notes.length; i++) {
      const n = this.notes[i];
      if (n.tMs > tMs - this.windows.bad) break;
      if (i === this.scanCursor && n.state !== 'pending') this.scanCursor++;
      if (n.state !== 'pending') continue;
      n.state = 'missed';
      n.judgment = 'miss';
      this.counts.miss++;
      this.combo = 0;
      this.applyHealth(JUDGE_HEALTH.miss, tMs);
      this.emit({
        type: 'miss',
        judgment: 'miss',
        lane: n.lane,
        tMs,
        baseScore: 0,
        healthDelta: JUDGE_HEALTH.miss,
        comboAfter: 0,
      });
      if (this.failed) return;
    }
    // advance per-lane cursors past settled notes
    for (let lane = 0; lane < this.laneCount; lane++) {
      const laneNotes = this.byLane[lane];
      let c = this.laneCursor[lane];
      while (c < laneNotes.length && laneNotes[c].state !== 'pending' && laneNotes[c].state !== 'holding') c++;
      this.laneCursor[lane] = c;
    }
  }

  judgedCount(): number {
    return this.counts.perfect + this.counts.great + this.counts.good + this.counts.bad + this.counts.miss;
  }

  accuracy(): number {
    const n = this.judgedCount();
    if (n === 0) return 1;
    const sum =
      this.counts.perfect * 300 + this.counts.great * 200 + this.counts.good * 100 + this.counts.bad * 50;
    return sum / (300 * n);
  }

  grade(): string {
    return gradeFor(this.accuracy(), this.failed, this.counts.miss);
  }

  multiplier(): number {
    return multiplierFor(this.combo);
  }

  notesHit(): number {
    return this.counts.perfect + this.counts.great + this.counts.good + this.counts.bad;
  }

  allSettled(): boolean {
    return this.notes.every((n) => n.state !== 'pending' && n.state !== 'holding');
  }

  /** Practice-loop support: re-arm notes at/after fromMs, mark earlier ones inert. */
  resetFrom(fromMs: number): void {
    this.failed = false;
    this.failedAtMs = null;
    this.health = Math.max(this.health, 50);
    for (const n of this.notes) {
      if (n.tMs >= fromMs - 100) {
        n.state = 'pending';
        n.judgment = undefined;
        n.hitDeltaMs = undefined;
      } else if (n.state === 'pending' || n.state === 'holding') {
        n.state = 'skipped';
      }
    }
    this.holding.fill(null);
    this.laneCursor.fill(0);
    this.scanCursor = 0;
  }
}
