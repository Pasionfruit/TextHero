import type { SongData } from '../types';
import type { DB } from '../store/db';
import { renderDemoSong } from './demoSong';

export class AudioEngine {
  ctx: AudioContext;
  master: GainNode;
  private bufferCache = new Map<string, AudioBuffer>();

  constructor() {
    this.ctx = new AudioContext({ latencyHint: 'interactive' });
    this.master = this.ctx.createGain();
    this.master.gain.value = 0.9;
    this.master.connect(this.ctx.destination);
  }

  /** AudioContext requires a user gesture on most browsers; call on any click/keydown. */
  async ensureRunning(): Promise<void> {
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
