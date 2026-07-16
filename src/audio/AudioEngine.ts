import type { SongData } from '../types';
import type { DB } from '../store/db';
import { renderDemoSong } from './demoSong';

export class AudioEngine {
  ctx: AudioContext;
  master: GainNode;
  private bufferCache = new Map<string, AudioBuffer>();
  private previewSrc: AudioBufferSourceNode | null = null;
  private previewOnEnd: (() => void) | null = null;

  constructor() {
    this.ctx = new AudioContext({ latencyHint: 'interactive' });
    this.master = this.ctx.createGain();
    this.master.gain.value = 0.9;
    this.master.connect(this.ctx.destination);
  }

  /** Master output volume, 0..1. */
  setVolume(v: number): void {
    this.master.gain.value = Math.min(1, Math.max(0, v));
  }

  /** true while gameplay is deliberately paused (Conductor.pause suspends the
   *  context) — blocks the global click/keydown unlock from resuming it */
  pauseHold = false;

  /** AudioContext requires a user gesture on most browsers; call on any click/keydown. */
  async ensureRunning(): Promise<void> {
    if (this.pauseHold) return;
    if (this.ctx.state !== 'running') {
      try {
        await this.ctx.resume();
      } catch {
        /* resumed on next gesture */
      }
    }
  }

  /** Estimated ms between ctx.currentTime and sound reaching the speakers. */
  outputLatencyMs(): number {
    const c = this.ctx as any;
    const sec = (typeof c.outputLatency === 'number' && c.outputLatency) || this.ctx.baseLatency || 0;
    return sec * 1000;
  }

  async decodeBlob(blob: Blob): Promise<AudioBuffer> {
    const arr = await blob.arrayBuffer();
    return await this.ctx.decodeAudioData(arr);
  }

  async bufferForSong(song: SongData, db: DB): Promise<AudioBuffer> {
    const cacheKey = song.audioId ?? song.audioUrl ?? '__demo__';
    const cached = this.bufferCache.get(cacheKey);
    if (cached) return cached;
    let buf: AudioBuffer;
    if (song.audioId) {
      const blob = await db.get<Blob>('audio', song.audioId);
      if (!blob) throw new Error('Audio file missing from library');
      buf = await this.decodeBlob(blob);
    } else if (song.audioUrl) {
      const res = await fetch(song.audioUrl);
      if (!res.ok) throw new Error(`Could not fetch bundled audio (${res.status})`);
      buf = await this.ctx.decodeAudioData(await res.arrayBuffer());
    } else {
      buf = await renderDemoSong();
    }
    this.bufferCache.set(cacheKey, buf);
    return buf;
  }

  /** Play a faded snippet of a song (song-select preview). Only one preview at a time. */
  startPreview(buf: AudioBuffer, durSec = 12, onEnd?: () => void): void {
    this.stopPreview();
    const t = this.ctx.currentTime;
    // start around the 35% mark — usually past the intro, into the hook
    const from = Math.min(buf.duration * 0.35, Math.max(0, buf.duration - durSec));
    const dur = Math.min(durSec, buf.duration - from);
    const g = this.ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(0.85, t + 0.3);
    g.gain.setValueAtTime(0.85, Math.max(t + 0.3, t + dur - 1.2));
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    const src = this.ctx.createBufferSource();
    src.buffer = buf;
    src.connect(g).connect(this.master);
    src.start(t, from, dur + 0.05);
    src.onended = () => {
      if (this.previewSrc === src) this.stopPreview();
    };
    this.previewSrc = src;
    this.previewOnEnd = onEnd ?? null;
  }

  stopPreview(): void {
    const src = this.previewSrc;
    const onEnd = this.previewOnEnd;
    this.previewSrc = null;
    this.previewOnEnd = null;
    if (src) {
      src.onended = null;
      try {
        src.stop();
      } catch {
        /* already stopped */
      }
      src.disconnect();
      onEnd?.();
    }
  }

  isPreviewing(): boolean {
    return this.previewSrc !== null;
  }

  /** Short synthesized click for hit feedback — zero-asset, near-zero latency. */
  playHitSound(strong = false): void {
    const t = this.ctx.currentTime;
    const osc = this.ctx.createOscillator();
    const g = this.ctx.createGain();
    osc.type = 'square';
    osc.frequency.setValueAtTime(strong ? 1900 : 1400, t);
    g.gain.setValueAtTime(0.12, t);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.045);
    osc.connect(g).connect(this.master);
    osc.start(t);
    osc.stop(t + 0.05);
  }

  playMissSound(): void {
    const t = this.ctx.currentTime;
    const osc = this.ctx.createOscillator();
    const g = this.ctx.createGain();
    osc.type = 'sawtooth';
    osc.frequency.setValueAtTime(220, t);
    osc.frequency.exponentialRampToValueAtTime(90, t + 0.12);
    g.gain.setValueAtTime(0.08, t);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.13);
    osc.connect(g).connect(this.master);
    osc.start(t);
    osc.stop(t + 0.14);
  }
}
