import { mulberry32 } from '../util';

/**
 * Built-in demo track, synthesized at runtime with OfflineAudioContext so the game
 * ships with zero audio assets. The same event tables drive chart generation, so
 * demo charts always line up with what you hear.
 */
export const DEMO_BPM = 120;
export const DEMO_OFFSET_MS = 500;
export const DEMO_BEATS = 96; // 48 seconds at 120 BPM
export const DEMO_TAIL_SEC = 2;

export interface DemoEvents {
  kicks: number[]; // beats
  snares: number[];
  hats: number[];
  bass: Array<{ beat: number; midi: number; len: number }>;
  melody: Array<{ beat: number; midi: number; len: number }>;
}

const PENT = [57, 60, 62, 64, 67, 69, 72]; // A minor pentatonic-ish
const BASS_ROOTS = [33, 33, 36, 31]; // A A C G, one per bar cycle

let cachedEvents: DemoEvents | null = null;

export function demoEvents(): DemoEvents {
  if (cachedEvents) return cachedEvents;
  const rng = mulberry32(0xc0ffee);
  const ev: DemoEvents = { kicks: [], snares: [], hats: [], bass: [], melody: [] };

  for (let bar = 0; bar < DEMO_BEATS / 4; bar++) {
    const b0 = bar * 4;
    const intro = bar < 2;
    const breakdown = bar >= 12 && bar < 14;

    ev.kicks.push(b0, b0 + 2);
    if (!intro && rng() < 0.35) ev.kicks.push(b0 + 2.5);
    ev.snares.push(b0 + 1, b0 + 3);
    if (!intro && !breakdown) {
      for (let i = 0; i < 8; i++) ev.hats.push(b0 + i * 0.5);
    }
    const root = BASS_ROOTS[bar % BASS_ROOTS.length];
    ev.bass.push({ beat: b0, midi: root, len: 1.5 });
    ev.bass.push({ beat: b0 + 2, midi: root, len: 1 });
    if (rng() < 0.5) ev.bass.push({ beat: b0 + 3.5, midi: root + 12, len: 0.5 });

    if (!intro) {
      // melody phrase: 2-6 notes per bar, occasionally a long held note
      let t = b0;
      while (t < b0 + 4) {
        const long = rng() < 0.18;
        const len = long ? 1.5 + Math.floor(rng() * 2) * 0.5 : rng() < 0.4 ? 0.5 : 1;
        const midi = PENT[Math.floor(rng() * PENT.length)];
        ev.melody.push({ beat: t, midi, len });
        t += Math.max(0.5, len + (rng() < 0.3 ? 0.5 : 0));
      }
    }
  }
  ev.melody = ev.melody.filter((m) => m.beat < DEMO_BEATS - 1);
  cachedEvents = ev;
  return ev;
}

const beatSec = (beat: number) => DEMO_OFFSET_MS / 1000 + (beat * 60) / DEMO_BPM;
const midiHz = (m: number) => 440 * Math.pow(2, (m - 69) / 12);

let cachedBuffer: AudioBuffer | null = null;

export async function renderDemoSong(): Promise<AudioBuffer> {
  if (cachedBuffer) return cachedBuffer;
  const sr = 44100;
  const durSec = DEMO_OFFSET_MS / 1000 + (DEMO_BEATS * 60) / DEMO_BPM + DEMO_TAIL_SEC;
  const ctx = new OfflineAudioContext(2, Math.ceil(sr * durSec), sr);

  const comp = ctx.createDynamicsCompressor();
  comp.threshold.value = -14;
  comp.ratio.value = 5;
  comp.connect(ctx.destination);
  const master = ctx.createGain();
  master.gain.value = 0.8;
  master.connect(comp);

  const noise = ctx.createBuffer(1, sr, sr);
  {
    const d = noise.getChannelData(0);
    const rng = mulberry32(42);
    for (let i = 0; i < d.length; i++) d[i] = rng() * 2 - 1;
  }

  const ev = demoEvents();

  for (const b of ev.kicks) {
    const t = beatSec(b);
    const osc = ctx.createOscillator();
    const g = ctx.createGain();
    osc.frequency.setValueAtTime(160, t);
    osc.frequency.exponentialRampToValueAtTime(42, t + 0.14);
    g.gain.setValueAtTime(1, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + 0.19);
    osc.connect(g).connect(master);
    osc.start(t);
    osc.stop(t + 0.2);
  }

  for (const b of ev.snares) {
    const t = beatSec(b);
    const src = ctx.createBufferSource();
    src.buffer = noise;
    const f = ctx.createBiquadFilter();
    f.type = 'highpass';
    f.frequency.value = 1700;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.5, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + 0.16);
    src.connect(f).connect(g).connect(master);
    src.start(t, 0, 0.2);
    const tone = ctx.createOscillator();
    tone.type = 'triangle';
    tone.frequency.value = 196;
    const tg = ctx.createGain();
    tg.gain.setValueAtTime(0.25, t);
    tg.gain.exponentialRampToValueAtTime(0.001, t + 0.09);
    tone.connect(tg).connect(master);
    tone.start(t);
    tone.stop(t + 0.1);
  }

  for (const b of ev.hats) {
    const t = beatSec(b);
    const src = ctx.createBufferSource();
    src.buffer = noise;
    const f = ctx.createBiquadFilter();
    f.type = 'highpass';
    f.frequency.value = 7500;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.16, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + 0.045);
    src.connect(f).connect(g).connect(master);
    src.start(t, 0.1, 0.06);
  }

  for (const n of ev.bass) {
    const t = beatSec(n.beat);
    const d = (n.len * 60) / DEMO_BPM;
    const osc = ctx.createOscillator();
    osc.type = 'square';
    osc.frequency.value = midiHz(n.midi);
    const f = ctx.createBiquadFilter();
    f.type = 'lowpass';
    f.frequency.value = 520;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(0.22, t + 0.01);
    g.gain.setValueAtTime(0.22, t + d - 0.05);
    g.gain.linearRampToValueAtTime(0, t + d);
    osc.connect(f).connect(g).connect(master);
    osc.start(t);
    osc.stop(t + d + 0.02);
  }

  for (const n of ev.melody) {
    const t = beatSec(n.beat);
    const d = (n.len * 60) / DEMO_BPM;
    for (const detune of [-6, 6]) {
      const osc = ctx.createOscillator();
      osc.type = 'sawtooth';
      osc.frequency.value = midiHz(n.midi);
      osc.detune.value = detune;
      const f = ctx.createBiquadFilter();
      f.type = 'lowpass';
      f.frequency.setValueAtTime(2600, t);
      f.frequency.exponentialRampToValueAtTime(900, t + d);
      const g = ctx.createGain();
      g.gain.setValueAtTime(0, t);
      g.gain.linearRampToValueAtTime(0.09, t + 0.015);
      g.gain.setValueAtTime(0.09, t + Math.max(0.02, d - 0.06));
      g.gain.linearRampToValueAtTime(0, t + d);
      osc.connect(f).connect(g).connect(master);
      osc.start(t);
      osc.stop(t + d + 0.02);
    }
  }

  cachedBuffer = await ctx.startRendering();
  return cachedBuffer;
}
