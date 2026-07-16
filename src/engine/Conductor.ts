import type { AudioEngine } from '../audio/AudioEngine';

/**
 * Keeps song time locked to the AudioContext clock (not wall-clock/rAF), which is
 * what makes note sync frame-rate independent and stable to within a few ms.
 * Pausing uses ctx.suspend(): the audio clock freezes with the audio, so resume
 * introduces zero drift.
 */
export class Conductor {
  private anchorCtxSec = 0;
  private anchorSongMs = 0;
  private source: AudioBufferSourceNode | null = null;
  private buffer: AudioBuffer | null = null;
  rate = 1;
  playing = false;
  paused = false;
  /** subtracted from judged time: device output latency + user audio offset */
  judgeOffsetMs = 0;

  constructor(private audio: AudioEngine) {}

  /**
   * Lock the latency compensation. Call at the moment playback actually starts:
   * the audio device's reported output latency is only reliable once the context
   * is running and a source is scheduled, so sampling it here (rather than at
   * screen setup) keeps the very first note centered on the judgment line.
   *
   *   judged/heard song time  =  rawMs (fed to the DAC)  −  outputLatency  −  audioOffset
   *
   * so a key struck exactly when the player hears a beat lands at deltaMs ≈ 0.
   */
  setLatency(audioOffsetMs: number): void {
    const outMs = Math.min(400, Math.max(0, this.audio.outputLatencyMs()));
    this.judgeOffsetMs = outMs + audioOffsetMs;
  }

  /**
   * Start playback. Song time begins at (fromMs - leadInMs*rate) and reaches
   * fromMs exactly when the audio starts, giving a synchronized count-in.
   */
  play(buffer: AudioBuffer, opts: { fromMs?: number; rate?: number; leadInMs?: number } = {}): void {
    this.stop();
    const { fromMs = 0, rate = 1, leadInMs = 2000 } = opts;
    this.buffer = buffer;
    this.rate = rate;
    const ctx = this.audio.ctx;
    const startAt = ctx.currentTime + leadInMs / 1000;
    const src = ctx.createBufferSource();
    src.buffer = buffer;
    src.playbackRate.value = rate;
    src.connect(this.audio.master);
    src.start(startAt, Math.max(0, fromMs) / 1000);
    this.source = src;
    this.anchorCtxSec = ctx.currentTime;
    this.anchorSongMs = fromMs - leadInMs * rate;
    this.playing = true;
    this.paused = false;
  }

  /** Raw song position from the audio clock (no offsets). */
  rawMs(): number {
    if (!this.playing) return this.anchorSongMs;
    return (this.audio.ctx.currentTime - this.anchorCtxSec) * 1000 * this.rate + this.anchorSongMs;
  }

  /** Song time for judging (latency-compensated). */
  nowMs(): number {
    return this.rawMs() - this.judgeOffsetMs;
  }

  /**
   * Map a DOM event timestamp (performance.now() timeline) to song ms. Between
   * the physical keypress and this handler running, song time kept advancing —
   * back it out for sub-frame input accuracy.
   */
  eventMs(evTimeStamp: number): number {
    const lagMs = Math.max(0, performance.now() - evTimeStamp);
    return this.nowMs() - lagMs * this.rate;
  }

  async pause(): Promise<void> {
    if (!this.playing || this.paused) return;
    this.paused = true;
    this.audio.pauseHold = true;
    await this.audio.ctx.suspend();
  }

  async resume(): Promise<void> {
    if (!this.paused) return;
    this.paused = false;
    this.audio.pauseHold = false;
    await this.audio.ctx.resume();
  }

  stop(): void {
    if (this.source) {
      try {
        this.source.stop();
      } catch {
        /* already stopped */
      }
      this.source.disconnect();
      this.source = null;
    }
    if (this.playing) this.anchorSongMs = this.rawMs();
    this.playing = false;
    if (this.paused) {
      this.paused = false;
      this.audio.pauseHold = false;
      void this.audio.ctx.resume();
    }
  }

  /** Jump to a new position (rebuilds the source node). */
  seek(toMs: number, leadInMs = 300): void {
    if (!this.buffer) return;
    const buf = this.buffer;
    const rate = this.rate;
    this.play(buf, { fromMs: toMs, rate, leadInMs });
  }
}
