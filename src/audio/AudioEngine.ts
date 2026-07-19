import type { SongData } from '../types';
import type { DB } from '../store/db';
import { renderDemoSong } from './demoSong';

export class AudioEngine {
  ctx: AudioContext;
  master: GainNode;
  private bufferCache = new Map<string, AudioBuffer>();
  private previewSrc: AudioBufferSourceNode | null = null;
  private previewOnEnd: (() => void) | null = null;
  private uiBuffers = new Map<string, AudioBuffer>();
  private bgSource: AudioBufferSourceNode | null = null;
  private bgGain: GainNode | null = null;
  private bgUrl: string | null = null;
  private bgVolume = 0.35;
  private bgDucked = false;

  constructor() {
    this.ctx = new AudioContext({ latencyHint: 'interactive' });
    this.master = this.ctx.createGain();
    this.master.gain.value = 0.5;
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

  private async uiBuffer(url: string): Promise<AudioBuffer> {
    let buf = this.uiBuffers.get(url);
    if (!buf) {
      const res = await fetch(url);
      buf = await this.ctx.decodeAudioData(await res.arrayBuffer());
      this.uiBuffers.set(url, buf);
    }
    return buf;
  }

  /** Decoded length of a UI sound in seconds (0 if it can't be decoded). */
  async uiSoundDuration(url: string): Promise<number> {
    try {
      return (await this.uiBuffer(url)).duration;
    } catch {
      return 0;
    }
  }

  private uiCtx: AudioContext | null = null;

  /** One-shot UI sound (hover, click, countdown). Silent until the first user
   *  gesture. While gameplay is paused the main context is suspended, so the
   *  sound plays through a small side context instead. */
  async playUiSound(url: string, volume = 0.8): Promise<void> {
    try {
      const buf = await this.uiBuffer(url); // decoding works even while suspended
      if (this.ctx.state === 'running') {
        const src = this.ctx.createBufferSource();
        src.buffer = buf;
        const g = this.ctx.createGain();
        g.gain.value = volume;
        src.connect(g).connect(this.master);
        src.start();
        return;
      }
      if (!this.pauseHold) return; // audio not yet unlocked by a gesture
      this.uiCtx ??= new AudioContext();
      if (this.uiCtx.state !== 'running') await this.uiCtx.resume();
      const src = this.uiCtx.createBufferSource();
      src.buffer = buf;
      const g = this.uiCtx.createGain();
      g.gain.value = volume * this.master.gain.value;
      src.connect(g).connect(this.uiCtx.destination);
      src.start();
    } catch {
      /* decorative — never block on it */
    }
  }

  /** Loop background music (menu screens). No-op until a user gesture unlocks audio. */
  async startMenuMusic(url: string): Promise<void> {
    if (this.bgSource && this.bgUrl === url) return;
    this.stopMenuMusic();
    this.bgUrl = url;
    try {
      if (this.ctx.state !== 'running') return; // retried on the next gesture
      const buf = await this.uiBuffer(url);
      if (this.bgUrl !== url || this.bgSource || this.ctx.state !== 'running') return;
      const src = this.ctx.createBufferSource();
      src.buffer = buf;
      src.loop = true;
      const g = this.ctx.createGain();
      g.gain.value = this.bgDucked ? 0 : this.bgVolume;
      src.connect(g).connect(this.master);
      src.start();
      this.bgSource = src;
      this.bgGain = g;
    } catch {
      /* decorative */
    }
  }

  stopMenuMusic(): void {
    if (this.bgSource) {
      try {
        this.bgSource.stop();
      } catch {
        /* already stopped */
      }
      this.bgSource.disconnect();
    }
    this.bgSource = null;
    this.bgGain = null;
    this.bgUrl = null;
  }

  setMenuMusicVolume(v: number): void {
    this.bgVolume = Math.min(1, Math.max(0, v));
    if (this.bgGain && !this.bgDucked) this.bgGain.gain.setTargetAtTime(this.bgVolume, this.ctx.currentTime, 0.05);
  }

  /** Pause the menu music instantly (song preview playing); restore with a short fade-in. */
  duckMenuMusic(ducked: boolean): void {
    this.bgDucked = ducked;
    if (!this.bgGain) return;
    const g = this.bgGain.gain;
    g.cancelScheduledValues(this.ctx.currentTime);
    if (ducked) g.setValueAtTime(0, this.ctx.currentTime);
    else g.setTargetAtTime(this.bgVolume, this.ctx.currentTime, 0.15);
  }

  /** Play a faded snippet of a song (song-select preview). Only one preview at a time. */
  startPreview(buf: AudioBuffer, durSec = 12, onEnd?: () => void): void {
    this.stopPreview();
    this.duckMenuMusic(true);
    const t = this.ctx.currentTime;
    // start around the 35% mark — usually past the intro, into the hook
    const from = Math.min(buf.duration * 0.35, Math.max(0, buf.duration - durSec));
    const dur = Math.min(durSec, buf.duration - from);
    // previews sit well below full game volume so browsing stays comfortable
    const PREVIEW_GAIN = 0.4;
    const g = this.ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(PREVIEW_GAIN, t + 0.3);
    g.gain.setValueAtTime(PREVIEW_GAIN, Math.max(t + 0.3, t + dur - 1.2));
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
    this.duckMenuMusic(false);
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
