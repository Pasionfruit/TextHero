import type { GameMode, RuntimeNote } from '../types';
import type { Settings } from '../store/settings';
import { judgeColor, laneColor } from '../store/settings';
import { LETTERS, letterColumn } from '../charts/chart';
import { clamp, fitCanvas } from '../util';

export interface HudState {
  score: number;
  combo: number;
  multiplier: number;
  accuracy: number;
  health: number;
  failed: boolean;
  name: string;
}

export interface PlayfieldOpts {
  mode: GameMode;
  laneCount: number; // session lanes (26 for letters mode)
  labels: string[]; // receptor labels for five/keyboard; unused for letters
}

interface Particle {
  x: number;
  y: number;
  vx: number;
  vy: number;
  born: number;
  color: string;
}

const PPS_BASE = 420; // px per second at the judgment line, 1.0 scroll speed
const PERSP = 0.38; // <1 compresses the far half toward the horizon (GH foreshortening)
const HORIZON_W = 0.3; // highway width at the horizon as a fraction of its width at the line

/** time-fraction (0 at line, 1 at horizon) → screen-fraction with perspective */
const persp = (x: number): number => x / (x + PERSP * (1 - x));

/**
 * Guitar Hero-style highway: lanes converge to a vanishing point, notes are
 * colored gems that grow as they approach the judgment line. In letters mode
 * the 26 letter lanes are projected onto 5 display columns (by physical
 * keyboard position) and each gem carries its letter.
 */
export class Playfield {
  private judgment: { name: string; at: number } | null = null;
  private comboPulseAt = 0;
  private lastCombo = 0;
  private particles: Particle[] = [];
  private downLanes = new Set<number>();
  private colGlow: number[];
  private colLabel: string[];
  private cols: number;

  constructor(
    private canvas: HTMLCanvasElement,
    private opts: PlayfieldOpts,
    private s: Settings,
  ) {
    this.cols = opts.mode === 'letters' ? 5 : opts.laneCount;
    this.colGlow = new Array(this.cols).fill(0);
    this.colLabel = new Array(this.cols).fill('');
  }

  private colOf(lane: number): number {
    return this.opts.mode === 'letters' ? letterColumn(lane, this.cols) : lane;
  }

  setJudgment(name: string): void {
    this.judgment = { name, at: performance.now() };
  }

  pressLane(lane: number, down: boolean): void {
    if (lane < 0 || lane >= this.opts.laneCount) return;
    const col = this.colOf(lane);
    if (down) {
      this.downLanes.add(lane);
      this.colGlow[col] = performance.now();
      if (this.opts.mode === 'letters') this.colLabel[col] = LETTERS[lane] ?? '';
    } else {
      this.downLanes.delete(lane);
    }
  }

  private colPressed(col: number): boolean {
    for (const lane of this.downLanes) if (this.colOf(lane) === col) return true;
    return false;
  }

  burst(lane: number): void {
    if (!this.s.particles || this.s.reducedEffects) return;
    const g = this.geometry();
    const col = this.colOf(lane);
    const x = g.colCenter(col);
    const now = performance.now();
    const color = laneColor(this.s, col, this.cols);
    for (let i = 0; i < 9; i++) {
      const a = (i / 9) * Math.PI * 2 + Math.random() * 0.6;
      const sp = 50 + Math.random() * 150;
      this.particles.push({ x, y: g.lineY, vx: Math.cos(a) * sp, vy: Math.sin(a) * sp - 40, born: now, color });
    }
    if (this.particles.length > 300) this.particles.splice(0, this.particles.length - 300);
  }

  private geometry() {
    const rect = this.canvas.getBoundingClientRect();
    const W = rect.width;
    const H = rect.height;
    const cols = this.cols;
    const spacing = this.s.laneSpacingPx;
    const colW = clamp(Math.min((W - 48) / cols - spacing, 78 * this.s.noteScale), 10, 150);
    const totalW = cols * colW + (cols - 1) * spacing;
    const centerX = W / 2;
    let dirDown = this.s.scrollDirection === 'down';
    if (this.s.reverse) dirDown = !dirDown;
    const lineY = dirDown ? H * (1 - this.s.judgmentLinePos) : H * this.s.judgmentLinePos;
    const horizonY = dirDown ? H * 0.09 : H * 0.91;
    const travelSec = Math.abs(lineY - horizonY) / (PPS_BASE * this.s.scrollSpeed);
    const colCenter = (c: number) => centerX - totalW / 2 + c * (colW + spacing) + colW / 2;
    return { W, H, cols, colW, spacing, totalW, centerX, dirDown, lineY, horizonY, travelSec, colCenter };
  }

  /** Project (song-time, column) → screen position + scale. frac<0 = past the line. */
  private project(g: ReturnType<Playfield['geometry']>, tMs: number, now: number, col: number) {
    const dtSec = (tMs - now) / 1000;
    const frac = dtSec / g.travelSec;
    let y: number;
    let scale: number;
    if (frac <= 0) {
      // past the judgment line: continue linearly, full size
      y = g.lineY - frac * g.travelSec * PPS_BASE * this.s.scrollSpeed * (g.dirDown ? 1 : -1);
      scale = 1;
    } else {
      const p = persp(Math.min(frac, 1));
      y = g.lineY + (g.horizonY - g.lineY) * p;
      scale = 1 - (1 - HORIZON_W) * p;
    }
    const xLine = g.colCenter(col);
    const x = g.centerX + (xLine - g.centerX) * scale;
    return { x, y, scale, frac };
  }

  private modAlpha(frac: number): number {
    // p: 0 at horizon → 1 at the line
    const p = 1 - clamp(frac, 0, 1);
    let a = 1;
    if (this.s.hidden) a = Math.min(a, clamp(1 - (p - 0.45) / 0.3, 0, 1));
    if (this.s.sudden) a = Math.min(a, clamp((p - 0.55) / 0.15, 0, 1));
    return a;
  }

  draw(now: number, hud: HudState, countdownSec: number | null, notes: RuntimeNote[]): void {
    const ctx = fitCanvas(this.canvas);
    const g = this.geometry();
    const { W, H, cols, colW, lineY } = g;
    const font = this.s.fontFamily || 'system-ui';
    const hc = this.s.highContrast;
    const perfNow = performance.now();

    // background
    ctx.clearRect(0, 0, W, H);
    ctx.fillStyle = hc ? '#000' : `rgba(8,9,13,${clamp(this.s.bgDim + 0.4, 0, 1)})`;
    ctx.fillRect(0, 0, W, H);

    // highway (converging trapezoid)
    const edge = (side: -1 | 1, atScale: number) => g.centerX + side * (g.totalW / 2 + 14) * atScale;
    ctx.beginPath();
    ctx.moveTo(edge(-1, 1), lineY);
    ctx.lineTo(edge(-1, HORIZON_W), g.horizonY);
    ctx.lineTo(edge(1, HORIZON_W), g.horizonY);
    ctx.lineTo(edge(1, 1), lineY);
    ctx.closePath();
    ctx.fillStyle = hc ? '#0a0a0a' : 'rgba(255,255,255,0.028)';
    ctx.fill();

    // pressed-column glow wedges
    for (let c = 0; c < cols; c++) {
      const pressed = this.colPressed(c);
      const glowAge = perfNow - this.colGlow[c];
      const glow = pressed ? 1 : clamp(1 - glowAge / 180, 0, 1) * 0.5;
      if (glow <= 0.02) continue;
      const x0 = g.colCenter(c);
      const near = colW / 2 + 2;
      ctx.beginPath();
      ctx.moveTo(x0 - near, lineY);
      ctx.lineTo(g.centerX + (x0 - near - g.centerX) * HORIZON_W, g.horizonY);
      ctx.lineTo(g.centerX + (x0 + near - g.centerX) * HORIZON_W, g.horizonY);
      ctx.lineTo(x0 + near, lineY);
      ctx.closePath();
      ctx.fillStyle = laneColor(this.s, c, cols) + '14';
      ctx.fill();
    }

    // lane dividers
    ctx.strokeStyle = hc ? 'rgba(255,255,255,0.35)' : 'rgba(255,255,255,0.07)';
    ctx.lineWidth = 1;
    for (let i = 0; i <= cols; i++) {
      const xb = g.centerX - g.totalW / 2 + i * (colW + g.spacing) - g.spacing / 2;
      ctx.beginPath();
      ctx.moveTo(xb, lineY);
      ctx.lineTo(g.centerX + (xb - g.centerX) * HORIZON_W, g.horizonY);
      ctx.stroke();
    }

    // judgment line
    ctx.strokeStyle = hc ? '#fff' : 'rgba(255,255,255,0.55)';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(edge(-1, 1), lineY);
    ctx.lineTo(edge(1, 1), lineY);
    ctx.stroke();

    // receptors (rings)
    const rBase = Math.min(colW * 0.42, 30);
    for (let c = 0; c < cols; c++) {
      const x = g.colCenter(c);
      const color = laneColor(this.s, c, cols);
      const pressed = this.colPressed(c);
      const glow = pressed ? 1 : clamp(1 - (perfNow - this.colGlow[c]) / 180, 0, 1);
      ctx.beginPath();
      ctx.arc(x, lineY, rBase, 0, Math.PI * 2);
      ctx.strokeStyle = color;
      ctx.lineWidth = hc ? 3.5 : 2.5;
      ctx.globalAlpha = 0.5 + glow * 0.5;
      ctx.stroke();
      if (glow > 0) {
        ctx.globalAlpha = glow * 0.3;
        ctx.fillStyle = color;
        ctx.fill();
      }
      ctx.globalAlpha = 1;
      if (this.opts.mode === 'letters') {
        // echo the letter you just pressed inside its column's ring
        if (glow > 0.05 && this.colLabel[c]) {
          ctx.globalAlpha = glow;
          ctx.fillStyle = hc ? '#fff' : 'rgba(255,255,255,0.9)';
          ctx.font = `bold ${rBase * 1.05}px ${font}`;
          ctx.textAlign = 'center';
          ctx.textBaseline = 'middle';
          ctx.fillText(this.colLabel[c], x, lineY + 1);
          ctx.globalAlpha = 1;
          ctx.textBaseline = 'alphabetic';
        }
      } else {
        const label = this.opts.labels[c] ?? '';
        if (label) {
          ctx.fillStyle = hc ? '#fff' : 'rgba(255,255,255,0.55)';
          ctx.font = `600 ${clamp(colW * 0.26, 9, 13)}px ${font}`;
          ctx.textAlign = 'center';
          const ly = g.dirDown ? Math.min(H - 8, lineY + rBase + 16) : Math.max(12, lineY - rBase - 8);
          ctx.fillText(label, x, ly);
        }
      }
    }

    // notes, far → near so close gems overlap distant ones
    type Drawable = { n: RuntimeNote; x: number; y: number; scale: number; frac: number; tailY?: number; tailScale?: number; tailX?: number };
    const drawables: Drawable[] = [];
    for (const n of notes) {
      if (n.state === 'hit' || n.state === 'completed' || n.state === 'skipped') continue;
      const col = this.colOf(n.lane);
      const isHold = n.endMs > n.tMs;
      const head = n.state === 'holding'
        ? { x: g.colCenter(col), y: lineY, scale: 1, frac: 0 }
        : this.project(g, n.tMs, now, col);
      if (head.frac > 1.02) continue; // still beyond the horizon
      if (head.frac < 0 && !isHold && Math.abs(head.y - lineY) > 90) continue; // long gone
      const d: Drawable = { n, ...head };
      if (isHold) {
        const tail = this.project(g, n.endMs, now, col);
        if (tail.frac > 1) {
          d.tailY = g.horizonY;
          d.tailScale = HORIZON_W;
          d.tailX = g.centerX + (g.colCenter(col) - g.centerX) * HORIZON_W;
        } else {
          d.tailY = tail.y;
          d.tailScale = tail.scale;
          d.tailX = tail.x;
        }
      }
      drawables.push(d);
    }
    drawables.sort((a, b) => a.scale - b.scale);

    for (const d of drawables) {
      const { n } = d;
      const col = this.colOf(n.lane);
      const color = laneColor(this.s, col, cols);
      let alpha = n.state === 'holding' ? 1 : this.modAlpha(d.frac);
      if (n.state === 'missed' || n.state === 'dropped') alpha *= 0.25;
      if (alpha <= 0.01) continue;
      ctx.globalAlpha = alpha;

      if (d.tailY !== undefined) {
        // tapering hold body
        const wHead = colW * 0.3 * d.scale;
        const wTail = colW * 0.3 * (d.tailScale ?? d.scale);
        ctx.beginPath();
        ctx.moveTo(d.x - wHead / 2, d.y);
        ctx.lineTo((d.tailX ?? d.x) - wTail / 2, d.tailY);
        ctx.lineTo((d.tailX ?? d.x) + wTail / 2, d.tailY);
        ctx.lineTo(d.x + wHead / 2, d.y);
        ctx.closePath();
        ctx.fillStyle = n.state === 'dropped' ? '#444' : color + '77';
        ctx.fill();
      }
      this.drawGem(ctx, d.x, d.y, colW, d.scale, color, n, col, hc, font, rBase);
      ctx.globalAlpha = 1;
    }

    // particles
    if (this.particles.length) {
      const keep: Particle[] = [];
      for (const p of this.particles) {
        const age = (perfNow - p.born) / 380;
        if (age >= 1) continue;
        keep.push(p);
        ctx.globalAlpha = 1 - age;
        ctx.fillStyle = p.color;
        const px = p.x + p.vx * age * 0.38;
        const py = p.y + p.vy * age * 0.38;
        ctx.fillRect(px - 2, py - 2, 4, 4);
      }
      this.particles = keep;
      ctx.globalAlpha = 1;
    }

    // ---- HUD (minimal: one block top-right, combo center, name bottom-left) ----
    ctx.textAlign = 'right';
    ctx.fillStyle = hc ? '#fff' : 'rgba(255,255,255,0.92)';
    ctx.font = `700 21px ${font}`;
    ctx.fillText(String(hud.score).padStart(7, '0'), W - 14, 28);
    ctx.font = `12px ${font}`;
    ctx.fillStyle = hc ? '#fff' : 'rgba(255,255,255,0.55)';
    ctx.fillText(`${(hud.accuracy * 100).toFixed(2)}%  ·  ${hud.multiplier}x`, W - 14, 46);
    ctx.textAlign = 'left';
    ctx.fillText(hud.name, 12, H - 10);

    // health: thin bar on the right edge
    const hbH = H * 0.34;
    const hbY = (H - hbH) / 2;
    ctx.fillStyle = 'rgba(255,255,255,0.08)';
    ctx.fillRect(W - 7, hbY, 3, hbH);
    const hFrac = clamp(hud.health / 100, 0, 1);
    ctx.fillStyle = hud.health > 50 ? '#43d675' : hud.health > 25 ? '#f5d90a' : '#e5484d';
    ctx.fillRect(W - 7, hbY + hbH * (1 - hFrac), 3, hbH * hFrac);

    // combo
    if (hud.combo !== this.lastCombo) {
      this.lastCombo = hud.combo;
      this.comboPulseAt = perfNow;
    }
    if (hud.combo >= 3) {
      const pulse = clamp(1 - (perfNow - this.comboPulseAt) / 160, 0, 1);
      ctx.textAlign = 'center';
      ctx.font = `800 ${30 + pulse * 8}px ${font}`;
      ctx.fillStyle = hc ? '#fff' : `rgba(255,255,255,${0.7 + pulse * 0.3})`;
      ctx.fillText(String(hud.combo), W / 2, H * 0.32);
      ctx.font = `600 10px ${font}`;
      ctx.fillStyle = 'rgba(255,255,255,0.4)';
      ctx.fillText('C O M B O', W / 2, H * 0.32 + 15);
    }

    // judgment popup
    if (this.judgment) {
      const age = (perfNow - this.judgment.at) / 500;
      if (age < 1) {
        ctx.globalAlpha = 1 - age * age;
        ctx.textAlign = 'center';
        ctx.font = `800 22px ${font}`;
        ctx.fillStyle = judgeColor(this.s, this.judgment.name);
        const jy = g.dirDown ? lineY - rBase * 2 - 16 : lineY + rBase * 2 + 26;
        ctx.fillText(this.judgment.name.toUpperCase(), W / 2, jy - age * 12);
        ctx.globalAlpha = 1;
      } else {
        this.judgment = null;
      }
    }

    if (hud.failed) {
      ctx.fillStyle = 'rgba(150,20,30,0.32)';
      ctx.fillRect(0, 0, W, H);
      ctx.textAlign = 'center';
      ctx.font = `800 38px ${font}`;
      ctx.fillStyle = '#ff6b6b';
      ctx.fillText('FAILED', W / 2, H / 2);
    }

    if (countdownSec != null && countdownSec > 0) {
      ctx.textAlign = 'center';
      ctx.font = `800 60px ${font}`;
      ctx.fillStyle = 'rgba(255,255,255,0.9)';
      ctx.fillText(String(Math.ceil(countdownSec)), W / 2, H * 0.48);
    }
  }

  private drawGem(
    ctx: CanvasRenderingContext2D,
    x: number,
    y: number,
    colW: number,
    scale: number,
    color: string,
    n: RuntimeNote,
    col: number,
    hc: boolean,
    font: string,
    rBase: number,
  ): void {
    const skin = this.opts.mode === 'letters' ? 'gems' : this.s.noteSkin;
    const r = rBase * scale;

    if (skin === 'gems') {
      ctx.beginPath();
      ctx.arc(x, y, r, 0, Math.PI * 2);
      ctx.fillStyle = color;
      ctx.fill();
      ctx.lineWidth = Math.max(1.5, r * 0.16);
      ctx.strokeStyle = hc ? '#fff' : 'rgba(0,0,0,0.45)';
      ctx.stroke();
      if (!this.s.reducedEffects) {
        ctx.beginPath();
        ctx.arc(x - r * 0.3, y - r * 0.32, r * 0.24, 0, Math.PI * 2);
        ctx.fillStyle = 'rgba(255,255,255,0.4)';
        ctx.fill();
      }
      if (this.opts.mode === 'letters') {
        ctx.fillStyle = '#fff';
        ctx.font = `800 ${Math.max(8, r * 1.05)}px ${font}`;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.strokeStyle = 'rgba(0,0,0,0.55)';
        ctx.lineWidth = Math.max(1, r * 0.14);
        const ch = LETTERS[n.lane] ?? '?';
        ctx.strokeText(ch, x, y + 1);
        ctx.fillText(ch, x, y + 1);
        ctx.textBaseline = 'alphabetic';
      }
    } else if (skin === 'circles') {
      ctx.beginPath();
      ctx.arc(x, y, r, 0, Math.PI * 2);
      ctx.fillStyle = color;
      ctx.fill();
      if (hc) {
        ctx.strokeStyle = '#fff';
        ctx.lineWidth = 2;
        ctx.stroke();
      }
    } else if (skin === 'arrows' && this.cols <= 5) {
      const angles: Record<number, number[]> = {
        4: [Math.PI, Math.PI / 2, -Math.PI / 2, 0],
        5: [Math.PI, Math.PI / 2, NaN, -Math.PI / 2, 0],
      };
      const a = (angles[this.cols] ?? [])[col];
      ctx.save();
      ctx.translate(x, y);
      ctx.fillStyle = color;
      if (a != null && !Number.isNaN(a)) {
        ctx.rotate(a);
        ctx.beginPath();
        ctx.moveTo(r, 0);
        ctx.lineTo(-r * 0.6, -r * 0.7);
        ctx.lineTo(-r * 0.2, 0);
        ctx.lineTo(-r * 0.6, r * 0.7);
        ctx.closePath();
        ctx.fill();
      } else {
        ctx.beginPath();
        ctx.arc(0, 0, r * 0.7, 0, Math.PI * 2);
        ctx.fill();
      }
      if (hc) {
        ctx.strokeStyle = '#fff';
        ctx.lineWidth = 2;
        ctx.stroke();
      }
      ctx.restore();
    } else {
      // bars
      const w = (colW - 6) * scale;
      const h = Math.max(6, 16 * scale);
      ctx.fillStyle = color;
      ctx.beginPath();
      ctx.roundRect ? ctx.roundRect(x - w / 2, y - h / 2, w, h, h / 2) : ctx.rect(x - w / 2, y - h / 2, w, h);
      ctx.fill();
      if (hc) {
        ctx.strokeStyle = '#fff';
        ctx.lineWidth = 2;
        ctx.stroke();
      }
    }
  }
}
