/**
 * Stochos 64: data model and clock.
 *
 * Eight tracks, each with its own MIDI channel, length (polymeter, 1–128
 * steps) and speed. Sixteen patterns; a song is a list of rows (pattern,
 * repeats, mutes, transpose, tempo), as on Elektron machines. Steps carry
 * parameter locks: velocity, length, chance, trig condition, micro-timing
 * and a CC value. A look-ahead scheduler on the AudioContext clock sends
 * MIDI with timestamps and can play a small preview voice.
 */
import { Midi } from '../synth/midi';
import { caStep, nomosSequence } from './math';
import { smf, type SmfEvent } from './smf';

export const MAX_STEPS = 128;
export const SPEEDS = [0.25, 0.5, 0.75, 1, 1.5, 2];
export const CONDS = ['—', '1:2', '2:2', '1:3', '1:4', '3:4', 'FILL', '!FILL', 'PRE', '!PRE', '1ST', '!1ST'] as const;

export interface Step {
  on: boolean;
  note: number; // MIDI
  vel: number; // 0–1
  len: number; // in steps
  prob: number; // 0–1
  cond: number; // index into CONDS
  micro: number; // −0.45 … 0.45 of a step
  cc: number; // 0–127, or −1 for no lock
}
export interface Track {
  name: string;
  ch: number; // 0–15
  len: number;
  speed: number; // index into SPEEDS
  mute: boolean;
  solo: boolean;
  cc: number; // CC number for the lock lane
  ca: number; // 0 = off, else ECA rule applied to gates each loop
  sieve: string; // pitch sieve for generators (empty = chromatic)
}
export interface Pattern {
  steps: Step[][]; // [track][step]
}
/**
 * Transitions: how a song row leaves (or enters). Each runs over a window of
 * steps, driven by a curve c(u), u ∈ [0, 1], and touches only the tracks in `mask`.
 */
export const TX = ['none', 'fade out', 'fade in', 'filter close', 'filter open', 'build (roll)', 'golden drop', 'erosion', 'stochastic morph', 'riser', 'Fibonacci entries', 'accelerando', 'ritardando'] as const;
export const TX_ENTRY = new Set(['fade in', 'filter open', 'Fibonacci entries']); // these run at the start of a row
export const CURVES = ['linear', 'exponential', 'logistic', 'sine', 'Brownian bridge'] as const;
export const TX_LENS = [4, 8, 16, 32, 64];
export interface Transition {
  type: number; // index into TX
  len: number; // steps
  curve: number; // index into CURVES
  mask: number; // tracks affected
}
const PHI = (1 + Math.sqrt(5)) / 2;
const FIB = [1, 1, 2, 3, 5, 8, 13, 21, 34, 55];
/** A Brownian bridge from 0 to 1: a random walk pinned at both ends, so every transition breathes differently. */
function bridge(n = 64) {
  const w = [0];
  for (let i = 1; i <= n; i++) w.push(w[i - 1] + (Math.random() * 2 - 1) / Math.sqrt(n));
  return w.map((x, i) => Math.min(1, Math.max(0, i / n + 0.45 * (x - (i / n) * w[n]))));
}
export function curve(k: number, u: number, br?: number[]): number {
  u = Math.min(1, Math.max(0, u));
  switch (CURVES[k]) {
    case 'exponential':
      return (Math.exp(4 * u) - 1) / (Math.exp(4) - 1);
    case 'logistic': {
      const L = (x: number) => 1 / (1 + Math.exp(-12 * (x - 0.5)));
      return (L(u) - L(0)) / (L(1) - L(0));
    }
    case 'sine':
      return 0.5 - 0.5 * Math.cos(Math.PI * u);
    case 'Brownian bridge':
      return br ? br[Math.round(u * (br.length - 1))] : u;
    default:
      return u;
  }
}

export interface SongRow {
  pat: number;
  reps: number;
  mutes: number; // bitmask over tracks
  trans: number; // semitones
  bpm: number; // 0 = keep
  tx?: Transition;
}
export interface State {
  bpm: number;
  swing: number;
  master: number; // pattern length in steps (song advances on this)
  tracks: Track[];
  pats: Pattern[];
  cur: number; // pattern being edited / played in pattern mode
  song: SongRow[];
  songMode: boolean;
  markovSong: boolean; // Analogique: next row drawn from a Markov chain over the song
  nomos: boolean; // Nomos Alpha: cube rotations permute tracks each pattern loop
  fill: boolean;
}

const COLORS = ['#16140f', '#c0392b', '#2336d6', '#2f6b00', '#9a6b00', '#6a2fcf', '#0f7a74', '#b0306a'];
export const trackColor = (i: number) => COLORS[i % 8];

export const emptyStep = (note = 60): Step => ({ on: false, note, vel: 0.8, len: 0.5, prob: 1, cond: 0, micro: 0, cc: -1 });
export const emptyPattern = (): Pattern => ({ steps: [...Array(8).keys()].map((t) => [...Array(MAX_STEPS)].map(() => emptyStep(36 + t * 5))) });

export function initial(): State {
  const names = ['kick', 'snare', 'hat', 'bass', 'lead', 'pad', 'perc', 'fx'];
  const s: State = {
    bpm: 118,
    swing: 0,
    master: 64,
    tracks: names.map((name, i) => ({ name, ch: i, len: 64, speed: 3, mute: false, solo: false, cc: 74, ca: 0, sieve: '' })),
    pats: [...Array(16)].map(emptyPattern),
    cur: 0,
    song: [{ pat: 0, reps: 2, mutes: 0, trans: 0, bpm: 0 }],
    songMode: false,
    markovSong: false,
    nomos: false,
    fill: false,
  };
  // a starting figure: four on the floor, backbeat, a sieve hat, a bass line
  const p = s.pats[0].steps;
  for (let i = 0; i < 64; i++) {
    if (i % 4 === 0) Object.assign(p[0][i], { on: true, note: 36 });
    if (i % 8 === 4) Object.assign(p[1][i], { on: true, note: 38 });
    if (i % 3 === 0 || i % 5 === 0) Object.assign(p[2][i], { on: true, note: 42, vel: 0.5 + (i % 5 === 0 ? 0.3 : 0) });
    if ([0, 3, 6, 10, 12].includes(i % 16)) Object.assign(p[3][i], { on: true, note: [33, 33, 36, 31, 38][[0, 3, 6, 10, 12].indexOf(i % 16)], len: 0.8 });
  }
  return s;
}

export type Fired = { track: number; step: number; time: number };

export class Engine {
  s: State;
  midi: Midi;
  ctx: AudioContext | null = null;
  playing = false;
  preview = true;
  clockOut = true;
  extClock = false;
  private timer = 0;
  private pos: number[] = [];
  private next: number[] = [];
  private loops: number[] = [];
  private pre: boolean[] = [];
  private masterStep = 0;
  private masterNext = 0;
  private clockNext = 0;
  private row = 0;
  private rep = 0;
  private perm = [0, 1, 2, 3, 4, 5, 6, 7];
  private nomosIdx = 0;
  private nomosSeq = nomosSequence(64);
  private listeners = new Set<(f: Fired) => void>();
  private rowListeners = new Set<(row: number, pat: number) => void>();
  private extTicks = 0;
  private rowStart = 0;
  private live: (Transition & { start: number; bpm0: number }) | null = null;
  private bridges = new Map<string, number[]>();
  private rowBpm0 = 0;
  /** Pattern mode: a pattern chosen while playing waits for the next boundary (as on Elektron machines). */
  queued: number | null = null;

  constructor(s: State, midi: Midi) {
    this.s = s;
    this.midi = midi;
  }

  private ensureCtx() {
    this.ctx ??= new AudioContext({ latencyHint: 'interactive' });
    return this.ctx;
  }
  get stepDur() {
    return 60 / this.s.bpm / 4;
  }
  get playingPattern() {
    return this.s.songMode ? this.s.song[this.row]?.pat ?? this.s.cur : this.s.cur;
  }
  get songRow() {
    return this.row;
  }

  async start() {
    const ctx = this.ensureCtx();
    await ctx.resume();
    if (this.playing) return;
    this.playing = true;
    const t0 = ctx.currentTime + 0.08;
    this.pos = Array(8).fill(-1);
    this.next = Array(8).fill(t0);
    this.loops = Array(8).fill(0);
    this.pre = Array(8).fill(true);
    this.masterStep = 0;
    this.masterNext = t0;
    this.clockNext = t0;
    this.row = 0;
    this.rep = 0;
    this.perm = [0, 1, 2, 3, 4, 5, 6, 7];
    this.nomosIdx = 0;
    this.rowStart = t0;
    this.live = null;
    if (this.s.songMode) this.applyRowTempo();
    this.rowBpm0 = this.s.bpm;
    if (this.clockOut) this.midi.transport(true);
    if (!this.extClock) {
      this.timer = window.setInterval(() => this.schedule(), 20);
      this.schedule();
    }
  }

  stop() {
    this.playing = false;
    clearInterval(this.timer);
    if (this.clockOut) this.midi.transport(false);
    this.midi.panic();
  }

  /** External MIDI clock: 24 PPQN, 6 pulses per sixteenth. */
  clockIn() {
    if (!this.playing || !this.extClock || !this.ctx) return;
    if (this.extTicks++ % 6) return;
    const t = this.ctx.currentTime + 0.02;
    this.masterNext = t;
    for (let i = 0; i < 8; i++) if (this.next[i] <= t + this.stepDur) this.next[i] = t;
    this.schedule(t + 0.001);
  }

  private toPerf(t: number) {
    return performance.now() + (t - this.ctx!.currentTime) * 1000;
  }

  private schedule(horizonOverride?: number) {
    const ctx = this.ctx!;
    const horizon = horizonOverride ?? ctx.currentTime + 0.12;
    // master clock: pattern boundaries (song rows, Nomos rotations, CA)
    while (this.masterNext < horizon) {
      if (this.masterStep > 0 && this.masterStep % this.s.master === 0) this.patternEnd();
      this.tempo(this.masterNext);
      if (this.live && this.masterNext >= this.live.start + this.live.len * this.stepDur) this.endLive();
      this.masterStep++;
      this.masterNext += this.stepDur;
    }
    // MIDI clock out at 24 PPQN
    if (this.clockOut && !this.extClock) {
      while (this.clockNext < horizon) {
        this.midi.clock(this.toPerf(this.clockNext));
        this.clockNext += 60 / this.s.bpm / 24;
      }
    }
    const pat = this.s.pats[this.playingPattern];
    const row = this.s.songMode ? this.s.song[this.row] : null;
    const anySolo = this.s.tracks.some((t) => t.solo);
    for (let ti = 0; ti < 8; ti++) {
      const tr = this.s.tracks[ti];
      const dur = this.stepDur / SPEEDS[tr.speed];
      while (this.next[ti] < horizon) {
        const len = Math.max(1, Math.min(MAX_STEPS, tr.len));
        const wrapped = this.pos[ti] >= 0 && this.pos[ti] + 1 >= len;
        this.pos[ti] = (this.pos[ti] + 1) % len;
        if (wrapped) this.trackLoop(ti);
        const p = this.pos[ti];
        const swing = p % 2 ? this.s.swing * dur * 0.5 : 0;
        const t = this.next[ti] + swing;
        // Nomos: track ti plays the material of track perm[ti] on its own channel
        const src = this.s.nomos ? this.perm[ti] : ti;
        const m = this.shape(ti, p % MAX_STEPS, t);
        const st = m.swap ?? pat.steps[src][p % MAX_STEPS];
        const muted = tr.mute || (anySolo && !tr.solo) || (row ? (row.mutes >> ti) & 1 : 0);
        if (m.cc >= 0) this.midi.out?.send([0xb0 | tr.ch, tr.cc & 127, m.cc], this.toPerf(t));
        if (st.on && !muted && !m.skip && this.condition(ti, st)) this.fire(ti, p, st, t + st.micro * dur, dur, (row?.trans ?? 0) + m.trans, m.vel, m.rat);
        this.next[ti] += dur;
      }
    }
  }

  /** Elektron-style trig conditions. */
  private condition(ti: number, st: Step): boolean {
    const loop = this.loops[ti];
    let ok = Math.random() < st.prob;
    const c = CONDS[st.cond];
    const ab = /^(\d):(\d)$/.exec(c);
    if (ab) ok = ok && loop % Number(ab[2]) === Number(ab[1]) - 1;
    else if (c === 'FILL') ok = ok && this.s.fill;
    else if (c === '!FILL') ok = ok && !this.s.fill;
    else if (c === 'PRE') ok = ok && this.pre[ti];
    else if (c === '!PRE') ok = ok && !this.pre[ti];
    else if (c === '1ST') ok = ok && loop === 0;
    else if (c === '!1ST') ok = ok && loop > 0;
    if (c !== 'PRE' && c !== '!PRE') this.pre[ti] = ok;
    return ok;
  }

  private fire(ti: number, step: number, st: Step, t: number, dur: number, trans: number, velMul = 1, rat = 1) {
    const tr = this.s.tracks[ti];
    const note = Math.max(0, Math.min(127, st.note + trans));
    for (let r = 0; r < rat; r++) {
      const tt = t + (r * dur) / rat;
      const vel = Math.min(1, st.vel * velMul * (r ? 0.82 : 1));
      if (vel < 0.02) continue;
      const len = Math.max(0.01, (st.len * dur) / rat);
      this.midi.note(tr.ch, note, vel, this.toPerf(tt), this.toPerf(tt + len));
      if (this.preview) this.blip(ti, note, vel, tt, Math.max(0.03, len));
    }
    if (st.cc >= 0 && this.midi.out) this.midi.out.send([0xb0 | tr.ch, tr.cc & 127, st.cc & 127], this.toPerf(t));
    this.listeners.forEach((fn) => fn({ track: ti, step, time: t }));
  }

  // ── transitions ───────────────────────────────────────────────────────────

  /** The transition windows active at time t: the current song row's, and a live one. */
  windows(t: number) {
    const out: Array<{ tx: Transition; u: number; key: string; live: boolean }> = [];
    const sd = this.stepDur;
    const row = this.s.songMode ? this.s.song[this.row] : null;
    if (row?.tx?.type) {
      const rowLen = this.s.master * Math.max(1, row.reps);
      const len = Math.min(row.tx.len, rowLen);
      const entry = TX_ENTRY.has(TX[row.tx.type]);
      const a = entry ? this.rowStart : this.rowStart + (rowLen - len) * sd;
      if (t >= a && t < a + len * sd) out.push({ tx: row.tx, u: (t - a) / (len * sd), key: `r${this.rowStart.toFixed(3)}`, live: false });
    }
    if (this.live && t >= this.live.start && t < this.live.start + this.live.len * sd) out.push({ tx: this.live, u: (t - this.live.start) / (this.live.len * sd), key: `l${this.live.start.toFixed(3)}`, live: true });
    return out;
  }

  private c(w: { tx: Transition; u: number; key: string }) {
    let br = this.bridges.get(w.key);
    if (!br && CURVES[w.tx.curve] === 'Brownian bridge') this.bridges.set(w.key, (br = bridge()));
    if (this.bridges.size > 16) this.bridges.delete(this.bridges.keys().next().value!);
    return curve(w.tx.curve, w.u, br);
  }

  /** The active transition's curve, sampled, for drawing. */
  plot(w: { tx: Transition; u: number; key: string }, n = 48) {
    return [...Array(n + 1).keys()].map((i) => this.c({ ...w, u: i / n }));
  }

  private nextPattern(live: boolean) {
    if (live || !this.s.songMode) return this.queued ?? (this.s.cur + 1) % 16;
    return this.s.song[(this.row + 1) % this.s.song.length].pat;
  }

  /** How the active transitions reshape one step of one track. */
  private shape(ti: number, p: number, t: number) {
    const m = { skip: false, vel: 1, rat: 1, trans: 0, cc: -1, swap: null as Step | null };
    for (const w of this.windows(t)) {
      if (!((w.tx.mask >> ti) & 1)) continue;
      const c = this.c(w);
      switch (TX[w.tx.type]) {
        case 'fade out': // linear in decibels (Weber–Fechner): 0 to −48 dB
          m.vel *= 10 ** ((-48 * c) / 20);
          break;
        case 'fade in':
          m.vel *= 10 ** ((-48 * (1 - c)) / 20);
          break;
        case 'filter close':
          m.cc = Math.round(127 * (1 - c));
          break;
        case 'filter open':
          m.cc = Math.round(127 * c);
          break;
        case 'build (roll)': // subdivisions double: 1, 2, 4, 8 hits per step
          m.rat = Math.min(8, 2 ** Math.floor(c * 3.999));
          m.vel *= 0.55 + 0.45 * c;
          break;
        case 'golden drop': // silence from the golden section of the window to the downbeat
          if (w.u >= 1 / PHI) m.skip = true;
          break;
        case 'erosion':
          if (Math.random() < c) m.skip = true;
          break;
        case 'stochastic morph':
          if (Math.random() < c) m.swap = this.s.pats[this.nextPattern(w.live)].steps[ti][p];
          break;
        case 'riser':
          m.trans += Math.round(12 * c);
          break;
        case 'Fibonacci entries': {
          // the j-th of k masked tracks enters at (F(j+2)−1)/(F(k+2)−1) of the window: gaps grow by Fibonacci numbers
          const order = [...Array(8).keys()].filter((i) => (w.tx.mask >> i) & 1);
          const j = order.indexOf(ti), k = order.length;
          if (w.u < (FIB[j + 1] - 1) / (FIB[k + 1] - 1 || 1)) m.skip = true;
          break;
        }
      }
    }
    return m;
  }

  /** Accelerando / ritardando: the tempo glides along the curve toward the target. */
  private tempo(t: number) {
    for (const w of this.windows(t)) {
      const type = TX[w.tx.type];
      if (type !== 'accelerando' && type !== 'ritardando') continue;
      const base = w.live ? this.live!.bpm0 : this.rowBpm0;
      const next = w.live ? 0 : this.s.song[(this.row + 1) % this.s.song.length].bpm;
      const target = next || base * (type === 'accelerando' ? 1.25 : 0.8);
      this.s.bpm = Math.round((base + (target - base) * this.c(w)) * 10) / 10;
    }
  }

  /** Fire a transition now, starting at the next bar (16 steps). */
  go(tx: Transition) {
    if (!this.playing) return;
    const wait = (16 - (this.masterStep % 16)) % 16;
    this.live = { ...tx, start: this.masterNext + wait * this.stepDur, bpm0: this.s.bpm };
  }

  private endLive() {
    const l = this.live!;
    if (TX[l.type] === 'filter close') this.resetCC(l.mask, l.start + l.len * this.stepDur);
    this.live = null;
  }

  private resetCC(mask: number, t: number) {
    this.s.tracks.forEach((tr, i) => (mask >> i) & 1 && this.midi.out?.send([0xb0 | tr.ch, tr.cc & 127, 127], this.toPerf(t)));
  }

  /** A small preview voice so the sequencer can be heard without MIDI hardware. */
  private blip(ti: number, note: number, vel: number, t: number, dur: number) {
    const ctx = this.ctx!;
    const f = 440 * 2 ** ((note - 69) / 12);
    const o = ctx.createOscillator(), g = ctx.createGain(), p = ctx.createStereoPanner();
    o.type = (['sine', 'triangle', 'square', 'sawtooth', 'triangle', 'sine', 'square', 'sawtooth'] as OscillatorType[])[ti];
    o.frequency.setValueAtTime(ti === 0 ? f * 3 : f, t);
    if (ti === 0) o.frequency.exponentialRampToValueAtTime(f, t + 0.05);
    const peak = 0.12 * vel * (ti === 2 || ti === 6 ? 0.5 : 1);
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(peak, t + 0.004);
    g.gain.exponentialRampToValueAtTime(0.0001, t + Math.min(1.2, dur + 0.08));
    p.pan.value = ((ti % 4) - 1.5) * 0.3;
    o.connect(g).connect(p).connect(ctx.destination);
    o.start(t);
    o.stop(t + Math.min(1.3, dur + 0.1));
  }

  private trackLoop(ti: number) {
    this.loops[ti]++;
    const rule = this.s.tracks[ti].ca;
    if (rule > 0) {
      const steps = this.s.pats[this.playingPattern].steps[ti];
      const len = this.s.tracks[ti].len;
      const next = caStep(steps.slice(0, len).map((s) => s.on), rule);
      next.forEach((on, i) => (steps[i].on = on));
    }
  }

  private patternEnd() {
    if (this.s.nomos) this.perm = this.nomosSeq[this.nomosIdx++ % this.nomosSeq.length];
    if (!this.s.songMode && this.queued !== null) {
      this.s.cur = this.queued;
      this.queued = null;
      this.pos = Array(8).fill(-1);
      this.rowListeners.forEach((fn) => fn(-1, this.s.cur));
    }
    if (!this.s.songMode || !this.s.song.length) return;
    if (++this.rep < Math.max(1, this.s.song[this.row].reps)) return;
    this.rep = 0;
    const leaving = this.s.song[this.row].tx;
    if (leaving && TX[leaving.type] === 'filter close') this.resetCC(leaving.mask, this.masterNext);
    this.row = this.s.markovSong ? this.markovNext() : (this.row + 1) % this.s.song.length;
    this.rowStart = this.masterNext;
    this.pos = Array(8).fill(-1);
    this.loops = Array(8).fill(0);
    this.applyRowTempo();
    this.rowListeners.forEach((fn) => fn(this.row, this.playingPattern));
  }

  /** Analogique (Xenakis, 1958–59): the next row follows the song's own transition statistics. */
  private markovNext() {
    const rows = this.s.song;
    const from = rows[this.row].pat;
    const cands = rows.map((r, i) => ({ i, w: rows[(i - 1 + rows.length) % rows.length].pat === from ? 3 : 0.25 }));
    let r = Math.random() * cands.reduce((a, c) => a + c.w, 0);
    for (const c of cands) if ((r -= c.w) <= 0) return c.i;
    return 0;
  }

  private applyRowTempo() {
    const r = this.s.song[this.row];
    if (r?.bpm) this.s.bpm = r.bpm;
    this.rowBpm0 = this.s.bpm;
  }

  /** Preview one note now (keyboard, step input). */
  async audition(ti: number, note: number, vel = 0.8) {
    const ctx = this.ensureCtx();
    await ctx.resume();
    const t = ctx.currentTime + 0.01;
    this.midi.note(this.s.tracks[ti].ch, note, vel, performance.now() + 10, performance.now() + 250);
    if (this.preview) this.blip(ti, note, vel, t, 0.25);
  }

  onFire(fn: (f: Fired) => void) {
    this.listeners.add(fn);
  }
  onRow(fn: (row: number, pat: number) => void) {
    this.rowListeners.add(fn);
  }

  /** The song (or the current pattern) as a Standard MIDI File, one track per sequencer track. */
  export(): Uint8Array {
    const PPQ = 96, perStep = PPQ / 4;
    const rows = this.s.songMode && this.s.song.length ? this.s.song : [{ pat: this.s.cur, reps: 1, mutes: 0, trans: 0, bpm: 0 }];
    const tracks: SmfEvent[][] = [...Array(8)].map(() => []);
    let base = 0;
    for (const row of rows)
      for (let rep = 0; rep < Math.max(1, row.reps); rep++) {
        for (let ti = 0; ti < 8; ti++) {
          const tr = this.s.tracks[ti];
          if (tr.mute || (row.mutes >> ti) & 1) continue;
          const sp = SPEEDS[tr.speed], len = Math.max(1, tr.len);
          const n = Math.floor(this.s.master * sp);
          for (let k = 0; k < n; k++) {
            const st = this.s.pats[row.pat].steps[ti][k % len];
            if (!st.on) continue;
            const tick = Math.round(base + ((k + st.micro) * perStep) / sp);
            const note = Math.max(0, Math.min(127, st.note + row.trans));
            tracks[ti].push({ tick: Math.max(0, tick), data: [0x90 | tr.ch, note, Math.max(1, Math.round(st.vel * 127))] });
            tracks[ti].push({ tick: Math.max(0, tick) + Math.max(1, Math.round((st.len * perStep) / sp)), data: [0x80 | tr.ch, note, 0] });
          }
        }
        base += this.s.master * perStep;
      }
    return smf(tracks, PPQ, this.s.bpm, this.s.tracks.map((t) => t.name));
  }
}
