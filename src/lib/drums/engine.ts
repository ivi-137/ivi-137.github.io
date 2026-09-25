/**
 * Tamburo 8: the sequencer and the studio.
 *
 * Clock. A look-ahead scheduler ("a tale of two clocks"): a coarse JS timer
 * wakes every 25 ms and schedules every step that falls within the next
 * 120 ms on the sample-accurate AudioContext clock. The UI is told what was
 * scheduled and when, so the playhead is drawn in sync with what you hear.
 *
 * Automaton. A voice with its automaton switched on treats its eight steps as
 * a row of an elementary cellular automaton on a ring, and applies its rule at
 * the end of every bar. Rule 90 makes mirrored, self-similar grooves; Rule 30
 * never quite repeats until it falls into one of the 256 states it has visited.
 *
 * Studio. Voices → drive (tanh waveshaper) → tone (lowpass) → dry + tape echo
 * (delay line whose time wobbles under two slow LFOs: wow and flutter, with a
 * darkening filter in the feedback loop) → master → analyser.
 */
import { VOICES, type VoiceParams } from './voices';
import { nextRow } from '../sigil';
import { loadTap, Tap } from '../audio/recorder';

export const STEPS = 8;

export interface Track extends VoiceParams {
  steps: number[]; // 0/1 × 8
  chance: number; // 0..1 probability a lit step fires
  roll: number; // 0..3 extra ratchets inside the step
  ca: boolean;
  rule: number;
  mute: boolean;
}

export interface Global {
  bpm: number;
  swing: number; // 0..0.6
  drive: number; // 0..1
  tone: number; // 0..1
  echo: number; // wet 0..1
  time: number; // 0..1 → delay time in steps
  wow: number; // 0..1
}

export interface State {
  tracks: Track[];
  global: Global;
}

export const DEFAULT: State = {
  global: { bpm: 104, swing: 0.12, drive: 0.35, tone: 0.72, echo: 0.22, time: 0.375, wow: 0.3 },
  tracks: [
    { steps: [1, 0, 0, 0, 1, 0, 0, 1], tune: 0.5, decay: 0.45, level: 0.9, chance: 1, roll: 0, ca: false, rule: 90, mute: false },
    { steps: [0, 0, 1, 0, 0, 0, 1, 0], tune: 0.5, decay: 0.35, level: 0.7, chance: 1, roll: 0, ca: false, rule: 30, mute: false },
    { steps: [1, 1, 1, 1, 1, 1, 1, 1], tune: 0.5, decay: 0.12, level: 0.55, chance: 0.8, roll: 1, ca: false, rule: 110, mute: false },
    { steps: [0, 1, 0, 0, 0, 1, 0, 1], tune: 0.55, decay: 0.3, level: 0.6, chance: 0.9, roll: 0, ca: true, rule: 137, mute: false },
    { steps: [0, 0, 0, 1, 0, 0, 0, 0], tune: 0.45, decay: 0.55, level: 0.5, chance: 0.7, roll: 0, ca: true, rule: 90, mute: false },
    { steps: [0, 0, 0, 0, 0, 0, 1, 0], tune: 0.5, decay: 0.4, level: 0.45, chance: 0.6, roll: 2, ca: true, rule: 30, mute: false },
  ],
};

export type Tick = { step: number; time: number; fired: boolean[]; bar: number };

export class Tamburo {
  ctx: AudioContext | null = null;
  state: State;
  playing = false;
  analyser!: AnalyserNode;
  private bus!: GainNode;
  private shaper!: WaveShaperNode;
  private tone!: BiquadFilterNode;
  private wet!: GainNode;
  private delay!: DelayNode;
  private wowDepth!: GainNode;
  private flutterDepth!: GainNode;
  private timer = 0;
  private nextTime = 0;
  private step = 0;
  private bar = 0;
  private listeners = new Set<(t: Tick) => void>();
  private barListeners = new Set<() => void>();
  private tap: Tap | null = null;

  constructor(state: State) {
    this.state = state;
  }

  private build() {
    const ctx = new AudioContext({ latencyHint: 'interactive' });
    this.ctx = ctx;
    this.bus = ctx.createGain();
    this.shaper = ctx.createWaveShaper();
    this.shaper.oversample = '2x';
    this.tone = ctx.createBiquadFilter();
    this.tone.type = 'lowpass';
    this.tone.Q.value = 0.9;
    const master = ctx.createGain();
    master.gain.value = 0.85;
    const dry = ctx.createGain();
    this.wet = ctx.createGain();
    this.delay = ctx.createDelay(2);
    const fb = ctx.createGain();
    fb.gain.value = 0.42;
    const dark = ctx.createBiquadFilter();
    dark.type = 'lowpass';
    dark.frequency.value = 2600;
    // tape transport wobble
    const wow = ctx.createOscillator();
    wow.frequency.value = 0.55;
    this.wowDepth = ctx.createGain();
    const flutter = ctx.createOscillator();
    flutter.frequency.value = 7.3;
    this.flutterDepth = ctx.createGain();
    wow.connect(this.wowDepth).connect(this.delay.delayTime);
    flutter.connect(this.flutterDepth).connect(this.delay.delayTime);
    wow.start();
    flutter.start();

    this.bus.connect(this.shaper).connect(this.tone);
    this.tone.connect(dry).connect(master);
    this.tone.connect(this.delay);
    this.delay.connect(dark).connect(fb).connect(this.delay);
    dark.connect(this.wet).connect(master);
    const limiter = ctx.createDynamicsCompressor();
    limiter.threshold.value = -6;
    limiter.ratio.value = 12;
    this.analyser = ctx.createAnalyser();
    this.analyser.fftSize = 1024;
    master.connect(limiter).connect(this.analyser).connect(ctx.destination);
    this.applyGlobal();
  }

  /** Push the global knobs into the audio graph. */
  applyGlobal() {
    if (!this.ctx) return;
    const g = this.state.global;
    const k = 1 + g.drive * 18;
    const curve = new Float32Array(1024);
    for (let i = 0; i < curve.length; i++) {
      const x = (i / (curve.length - 1)) * 2 - 1;
      curve[i] = Math.tanh(k * x) / Math.tanh(k);
    }
    this.shaper.curve = curve;
    const now = this.ctx.currentTime;
    this.tone.frequency.setTargetAtTime(300 * 2 ** (g.tone * 6), now, 0.05);
    this.wet.gain.setTargetAtTime(g.echo * 0.9, now, 0.05);
    const stepDur = 60 / g.bpm / 2;
    this.delay.delayTime.setTargetAtTime(Math.max(0.05, stepDur * (1 + Math.round(g.time * 5))), now, 0.08);
    this.wowDepth.gain.setTargetAtTime(g.wow * 0.006, now, 0.1);
    this.flutterDepth.gain.setTargetAtTime(g.wow * 0.0009, now, 0.1);
  }

  async start() {
    if (!this.ctx) this.build();
    await this.ctx!.resume();
    if (this.playing) return;
    this.playing = true;
    this.step = 0;
    this.nextTime = this.ctx!.currentTime + 0.06;
    this.timer = window.setInterval(() => this.schedule(), 25);
    this.schedule();
  }

  stop() {
    this.playing = false;
    clearInterval(this.timer);
  }

  /** Audition one voice now (pads, keyboard). */
  async hit(i: number) {
    if (!this.ctx) this.build();
    await this.ctx!.resume();
    const tr = this.state.tracks[i];
    VOICES[i].play(this.ctx!, this.bus, this.ctx!.currentTime + 0.005, tr, 1);
  }

  private schedule() {
    const ctx = this.ctx!;
    while (this.nextTime < ctx.currentTime + 0.12) {
      this.fireStep(this.step, this.nextTime);
      const stepDur = 60 / this.state.global.bpm / 2; // eighth notes
      // swing delays every off-beat
      const swing = this.state.global.swing * stepDur;
      this.nextTime += this.step % 2 === 0 ? stepDur + swing : stepDur - swing;
      this.step = (this.step + 1) % STEPS;
      if (this.step === 0) this.endBar();
    }
  }

  private fireStep(step: number, t: number) {
    const ctx = this.ctx!;
    const stepDur = 60 / this.state.global.bpm / 2;
    const fired = this.state.tracks.map((tr, i) => {
      if (tr.mute || !tr.steps[step] || Math.random() > tr.chance) return false;
      const n = 1 + tr.roll;
      for (let r = 0; r < n; r++) VOICES[i].play(ctx, this.bus, t + (r * stepDur) / n, tr, r === 0 ? 1 : 0.55 ** r);
      return true;
    });
    const tick = { step, time: t, fired, bar: this.bar };
    this.listeners.forEach((fn) => fn(tick));
  }

  private endBar() {
    this.bar++;
    for (const tr of this.state.tracks) {
      if (!tr.ca) continue;
      const next = nextRow(Uint8Array.from(tr.steps), tr.rule);
      // Some rules extinguish a ring of 8 (Rule 90 always does: 8 is a power of 2).
      // A dead row reseeds itself with one live cell, so the voice keeps regenerating.
      if (!next.some(Boolean)) next[Math.floor(Math.random() * STEPS)] = 1;
      tr.steps = Array.from(next);
    }
    this.barListeners.forEach((fn) => fn());
  }

  onTick(fn: (t: Tick) => void) {
    this.listeners.add(fn);
  }
  onBar(fn: () => void) {
    this.barListeners.add(fn);
  }

  /** A recording tap on the master bus (after the limiter), created on first use. */
  async recorder(): Promise<Tap> {
    if (!this.ctx) this.build();
    await this.ctx!.resume();
    if (!this.tap) {
      await loadTap(this.ctx!);
      this.tap = new Tap(this.ctx!, 2);
      this.analyser.connect(this.tap.node);
    }
    return this.tap;
  }

  dispose() {
    this.tap?.dispose();
    this.stop();
    this.ctx?.close();
  }
}

// ── share links: the whole machine in a URL fragment ────────────────────────

const q = (v: number) => Math.round(v * 99);
export function encode(s: State): string {
  const g = s.global;
  const tracks = s.tracks.map((t) =>
    [parseInt(t.steps.join(''), 2), q(t.tune), q(t.decay), q(t.level), q(t.chance), t.roll, t.ca ? 1 : 0, t.rule, t.mute ? 1 : 0].join('.'),
  );
  return [`${g.bpm}.${q(g.swing)}.${q(g.drive)}.${q(g.tone)}.${q(g.echo)}.${q(g.time)}.${q(g.wow)}`, ...tracks].join('_');
}

export function decode(code: string): State | null {
  try {
    const [gs, ...ts] = code.split('_');
    const g = gs.split('.').map(Number);
    if (ts.length !== 6 || g.length !== 7 || g.some(Number.isNaN)) return null;
    const u = (v: number) => Math.max(0, Math.min(1, v / 99));
    return {
      global: { bpm: Math.max(40, Math.min(220, g[0])), swing: u(g[1]), drive: u(g[2]), tone: u(g[3]), echo: u(g[4]), time: u(g[5]), wow: u(g[6]) },
      tracks: ts.map((t) => {
        const v = t.split('.').map(Number);
        return {
          steps: [...(v[0] & 255).toString(2).padStart(8, '0')].map(Number),
          tune: u(v[1]),
          decay: u(v[2]),
          level: u(v[3]),
          chance: u(v[4]),
          roll: Math.max(0, Math.min(3, v[5] | 0)),
          ca: v[6] === 1,
          rule: (v[7] | 0) & 255,
          mute: v[8] === 1,
        };
      }),
    };
  } catch {
    return null;
  }
}
