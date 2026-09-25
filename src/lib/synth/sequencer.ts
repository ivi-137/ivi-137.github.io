/**
 * Orfeo 32: the sequencer, the harmony runner and the rollers.
 *
 * Clock. A look-ahead scheduler: a JS timer wakes every 25 ms and schedules
 * every sixteenth that falls within the next 120 ms on the AudioContext clock.
 * The worklet receives timestamped events and plays each on its exact sample;
 * the panel is told what was scheduled and when, so it can draw in time.
 *
 * Lanes. Eight lanes (gate, note, accent, probability, ratchet, T, M, duration)
 * each have their own length and clock divider, so they drift against each
 * other and realign (polymeter). All lanes share one of
 * seven play directions, including René-style cartesian motion on an 8×4 grid.
 *
 * At every loop of the gate lane: an elementary automaton may rewrite the
 * gates, a Turing-style register may mutate notes, the living background may
 * dictate the rhythm, and song mode may move to the next pattern.
 */
import { nextRow } from '../sigil';
import type { Engine } from './engine';
import { methodById, negate, fromPcs, roman, voice, mod12, type Chord, type Key } from './harmony';
import type { Midi } from './midi';
import type { SynthEvent } from './params';
import { DIRS, LANES, SCALES, STEPS, TIME_MULT, tuneHz, type LaneId, type OrfeoState, type Pattern } from './state';

export interface TickInfo {
  tick: number;
  time: number;
  pattern: number;
  idx: Record<LaneId, number>;
  fired: boolean;
  midi: number | null;
}
export interface ChordInfo {
  chord: Chord;
  time: number;
  key: Key;
  voicing: number[];
  n: number;
}

const BASE = 48; // C3

export class Sequencer {
  state: OrfeoState;
  engine: Engine;
  midi: Midi | null = null;
  playing = false;
  /** external MIDI clock drives the steps instead of the internal timer */
  external = false;
  transpose = 0;
  chord: Chord | null = null;
  private raw: Chord | null = null;
  private voicing: number[] | null = null;
  private exact = false;
  private chordN = 0;
  private memo: Record<string, Record<string, any>> = {};
  private tick = 0;
  private base = 0;
  private nextTime = 0;
  private timer = 0;
  private lastC: Partial<Record<LaneId, number>> = {};
  private pos: Partial<Record<LaneId, number>> = {};
  private chainPos = 0;
  private rz = [0, 0, 0, 0, 0];
  private arpI = 0;
  private extClocks = 0;
  onTick: (t: TickInfo) => void = () => {};
  onChord: (c: ChordInfo) => void = () => {};
  onNote: (midi: number, time: number) => void = () => {};
  onLoop: () => void = () => {};
  /** returns one row of the living background, or null if there is none */
  colonyRow: () => Uint8Array | null = () => null;

  constructor(state: OrfeoState, engine: Engine) {
    this.state = state;
    this.engine = engine;
  }

  get pattern(): Pattern {
    return this.state.patterns[this.state.cur];
  }
  get key(): Key {
    const iv = SCALES.find((s) => s.id === this.state.scale)?.iv ?? [0, 2, 4, 5, 7, 9, 11];
    return { tonic: this.state.root, minor: iv.includes(3) && !iv.includes(4) };
  }
  get stepDur() {
    return 60 / this.state.p['g.bpm'] / 4;
  }

  start() {
    if (this.playing || !this.engine.ctx) return;
    this.playing = true;
    this.tick = 0;
    this.base = 0;
    this.lastC = {};
    this.pos = {};
    this.chainPos = 0;
    this.arpI = 0;
    if (this.state.chain.length) this.state.cur = this.state.chain[0];
    this.nextTime = this.engine.now + 0.08;
    this.rz = this.rz.map(() => this.nextTime);
    this.midi?.transport(true);
    if (!this.external) {
      this.timer = window.setInterval(() => this.schedule(), 25);
      this.schedule();
    }
  }

  stop() {
    this.playing = false;
    clearInterval(this.timer);
    this.engine.events([{ k: 'off', at: this.engine.now }]);
    this.midi?.transport(false);
  }

  /** Called on every incoming MIDI clock (24 per quarter): six make a sixteenth. */
  externalClock() {
    if (!this.playing || !this.external) return;
    if (this.extClocks++ % 6 === 0) {
      const t = this.engine.now + 0.03;
      this.doTick(t, this.stepDur);
      this.tick++;
    }
  }

  private schedule() {
    const horizon = this.engine.now + 0.12;
    if (this.nextTime < this.engine.now - 0.2) this.nextTime = this.engine.now + 0.02; // the tab slept
    while (this.nextTime < horizon) {
      const dur = this.tickDur();
      this.doTick(this.nextTime, dur);
      this.nextTime += dur;
      this.tick++;
    }
    this.scheduleRollers(horizon);
  }

  /** This sixteenth's length: the duration lane, then swing on the off-beats. */
  private tickDur() {
    const p = this.pattern;
    const i = this.laneIndex(p, 'time', false);
    const mult = TIME_MULT[p.lanes.time[i]] ?? 1;
    const sw = this.state.p['g.swing'];
    return this.stepDur * mult * (this.tick % 2 === 0 ? 1 + sw : 1 - sw);
  }

  /** Where a lane is on this tick, for its own length, divider and the pattern's direction. */
  private laneIndex(p: Pattern, l: LaneId, advance = true): number {
    const len = Math.max(1, p.len[l]);
    const c = Math.floor((this.tick - this.base) / Math.max(1, p.div[l]));
    const dir = DIRS[p.dir]?.id ?? 'fwd';
    switch (dir) {
      case 'rev':
        return len - 1 - (c % len);
      case 'pend': {
        if (len === 1) return 0;
        const per = 2 * (len - 1);
        const k = c % per;
        return k < len ? k : per - k;
      }
      case 'cart': {
        // cartesian: x runs every step, y every third step, on an 8×4 grid
        const x = c % 8,
          y = Math.floor(c / 3) % 4;
        return (y * 8 + x) % len;
      }
      case 'knight':
        return (c * 5) % len;
      case 'drunk':
      case 'rand': {
        if (advance && this.lastC[l] !== c) {
          this.lastC[l] = c;
          const cur = this.pos[l] ?? 0;
          this.pos[l] = dir === 'rand' ? Math.floor(Math.random() * len) : (cur + (Math.random() < 0.5 ? -1 : 1) + len) % len;
        }
        return (this.pos[l] ?? 0) % len;
      }
      default:
        return c % len;
    }
  }

  /** A scale degree (or chord tone, or semitone) from the note lane → MIDI note. */
  noteMidi(deg: number): { midi: number; hz: number } {
    const s = this.state;
    const follow = s.harm.follow;
    if (follow === 1 && this.chord) {
      const ch = this.chord;
      if (ch.hz && this.exact) {
        const L = ch.hz.length;
        const k = ((deg % L) + L) % L;
        let hz = ch.hz[k] * 2 ** Math.floor(deg / L);
        while (hz < 110) hz *= 2;
        while (hz > 880) hz /= 2;
        hz *= 2 ** (this.transpose / 12);
        return { midi: 69 + 12 * Math.log2(hz / 440), hz };
      }
      const rel = [...new Set(ch.pcs.map((p) => mod12(p - ch.root)))].sort((a, b) => a - b);
      const L = rel.length;
      const k = ((deg % L) + L) % L;
      const midi = BASE + ch.root + rel[k] + 12 * Math.floor(deg / L) + this.transpose;
      return { midi, hz: tuneHz(midi, s.root, s.tuning) };
    }
    let midi: number;
    if (follow === 2) midi = BASE + s.root + deg;
    else {
      const iv = SCALES.find((x) => x.id === s.scale)?.iv ?? [0, 2, 4, 5, 7, 9, 11];
      const L = iv.length;
      midi = BASE + s.root + iv[((deg % L) + L) % L] + 12 * Math.floor(deg / L);
    }
    midi += this.transpose;
    return { midi, hz: tuneHz(midi, s.root, s.tuning) };
  }

  private chordHz(m: number) {
    return this.exact ? 440 * 2 ** ((m - 69) / 12) : tuneHz(m, this.state.root, this.state.tuning);
  }

  /** Ask the chosen method for the next chord, voice-lead it, and play it on the choir. */
  advanceChord(t: number, span: number) {
    const s = this.state,
      h = s.harm;
    const m = methodById(h.method);
    const key = this.key;
    const memo = (this.memo[m.id] ??= {});
    let ch = m.next({ key, prev: this.raw, i: this.chordN % 8, len: 8, rng: Math.random, spice: h.spice, memo });
    this.raw = ch;
    if (h.negative && m.id !== 'negative' && !ch.hz) {
      const mirrored = fromPcs(
        ch.pcs.map((p) => negate(p, key.tonic)),
        `mirror of ${ch.name}`,
      );
      ch = mirrored;
    }
    if (!ch.roman && ch.quality !== 'x' && ch.quality !== 'q' && !ch.hz) ch = { ...ch, roman: roman(ch, key.tonic) };
    this.exact = !!ch.hz;
    this.chord = ch;
    this.voicing = voice(ch, this.exact ? null : this.voicing, h.voicing);
    this.chordN++;
    this.arpI = 0;
    const ev: SynthEvent[] = [{ k: 'root', at: t, hz: ch.hz ? ch.hz[0] : 440 * 2 ** ((BASE + ch.root - 69) / 12) }];
    if (h.arp === 0)
      for (const n of this.voicing) {
        ev.push({ k: 'c', at: t, hz: this.chordHz(n), vel: 0.62, dur: span * 0.96, kind: 0 });
        this.midi?.note(1, n, 0.6, this.engine.toPerf(t), this.engine.toPerf(t + span * 0.96));
      }
    this.engine.events(ev);
    this.onChord({ chord: ch, time: t, key, voicing: this.voicing, n: this.chordN });
  }

  /** Play one chord immediately, outside the clock (the "next chord" button). */
  audition() {
    this.advanceChord(this.engine.now + 0.02, this.stepDur * this.state.harm.rate);
  }

  private arpNote(t: number, dur: number) {
    const v = this.voicing;
    if (!v?.length) return;
    const mode = this.state.harm.arp;
    const n = v.length;
    const i = this.arpI++;
    let k: number;
    if (mode === 1) k = i % (n * 2);
    else if (mode === 2) k = n * 2 - 1 - (i % (n * 2));
    else if (mode === 3) {
      const per = Math.max(1, n * 4 - 2);
      const j = i % per;
      k = j < n * 2 ? j : per - j;
    } else k = Math.floor(Math.random() * n * 2);
    const midi = v[k % n] + 12 * Math.floor(k / n);
    this.engine.events([{ k: 'c', at: t, hz: this.chordHz(midi), vel: 0.55 + Math.random() * 0.25, dur, kind: 1 }]);
    this.midi?.note(1, midi, 0.6, this.engine.toPerf(t), this.engine.toPerf(t + dur));
  }

  private doTick(t: number, dur: number) {
    const s = this.state;
    let p = this.pattern;
    // a new loop of the gate lane
    const gDiv = Math.max(1, p.div.gate);
    const gC = Math.floor((this.tick - this.base) / gDiv);
    if (this.tick > this.base && (this.tick - this.base) % gDiv === 0 && gC % Math.max(1, p.len.gate) === 0) {
      this.loop();
      p = this.pattern;
    }
    const idx = Object.fromEntries(LANES.map((l) => [l, this.laneIndex(p, l)])) as Record<LaneId, number>;
    const ev: SynthEvent[] = [{ k: 's', at: t }];
    if (this.tick % 16 === 0) ev.push({ k: 'b', at: t });
    // MIDI clock out: six pulses per sixteenth
    if (this.midi?.out) for (let c = 0; c < 6; c++) this.midi.clock(this.engine.toPerf(t + (c * dur) / 6));

    // harmony
    const h = s.harm;
    if (h.on && this.tick % h.rate === 0) this.advanceChord(t, this.stepDur * h.rate);
    if (h.on && h.arp > 0 && this.tick % h.arpRate === 0) this.arpNote(t, this.stepDur * h.arpRate * 1.4);

    // the lead
    const g = p.lanes.gate[idx.gate];
    let fired = false,
      midiOut: number | null = null;
    const heat = s.p['g.heat'];
    if (g > 0 && Math.random() < p.lanes.prob[idx.prob]) {
      fired = true;
      const { midi, hz } = this.noteMidi(p.lanes.note[idx.note]);
      midiOut = midi;
      const vel = p.lanes.vel[idx.vel];
      let n = Math.round(p.lanes.ratch[idx.ratch]);
      if (heat > 0 && Math.random() < heat * 0.25) n = Math.min(4, n + 1);
      // hold into the next step if it slides, so the two notes join
      const nextSlide = p.lanes.gate[(idx.gate + 1) % Math.max(1, p.len.gate)] === 2;
      const gateLen = s.p['g.gate'];
      for (let r = 0; r < n; r++) {
        const at = t + (r * dur) / n;
        const d = n > 1 ? (dur / n) * Math.min(0.9, gateLen) : nextSlide ? dur * 1.08 : dur * gateLen;
        ev.push({ k: 'n', at, hz, vel: vel * 0.72 ** r, dur: d, slide: r === 0 && g === 2 ? 1 : 0, t: p.lanes.timb[idx.timb], m: p.lanes.mod[idx.mod] });
        this.midi?.note(0, midi, vel, this.engine.toPerf(at), this.engine.toPerf(at + d));
      }
      // Fux's second voice, on the same step
      const cp = p.cp?.[idx.note];
      if (h.cp && cp != null) {
        const cm = cp + this.transpose;
        ev.push({ k: 'c', at: t, hz: tuneHz(cm, s.root, s.tuning), vel: 0.7, dur: dur * Math.max(0.5, gateLen), kind: 2 });
        this.midi?.note(2, cm, 0.7, this.engine.toPerf(t), this.engine.toPerf(t + dur * gateLen));
      }
      this.onNote(midi, t);
    }
    this.engine.events(ev);
    this.onTick({ tick: this.tick, time: t, pattern: s.cur, idx, fired, midi: midiOut });
  }

  /** Rulli: five pulse rollers dividing the bar 1–16 ways, each striking its own gong. */
  private scheduleRollers(horizon: number) {
    const s = this.state;
    if (!s.p['rz.on']) return;
    const bar = this.stepDur * 16;
    const ev: SynthEvent[] = [];
    for (let k = 0; k < 5; k++) {
      const d = Math.round(s.p[`rz.d${k + 1}`]);
      if (d <= 0) {
        this.rz[k] = 0;
        continue;
      }
      const per = bar / d;
      if (this.rz[k] < this.engine.now) this.rz[k] = this.engine.now + per - ((this.engine.now - this.rz[k]) % per);
      while (this.rz[k] < horizon) {
        ev.push({ k: 'g', at: this.rz[k], i: k, vel: 0.55 + Math.random() * 0.45 * (1 + s.p['g.heat']) });
        this.rz[k] += per;
      }
    }
    this.engine.events(ev);
  }

  /** End of a loop of the gate lane: automaton, mutation, colony, song mode. */
  private loop() {
    const s = this.state;
    const p = this.pattern;
    const len = Math.max(1, p.len.gate);
    if (s.colonyGates) {
      const row = this.colonyRow();
      if (row?.length) {
        const counts = new Array(len).fill(0);
        for (let x = 0; x < row.length; x++) counts[Math.floor((x / row.length) * len)] += row[x];
        const sorted = [...counts].sort((a, b) => a - b);
        const thr = sorted[Math.floor(len * 0.6)];
        for (let i = 0; i < len; i++) p.lanes.gate[i] = counts[i] > thr || (counts[i] > 0 && thr === 0) ? (p.lanes.gate[i] === 2 ? 2 : 1) : 0;
      }
    } else if (p.ca.on) {
      const row = Uint8Array.from(p.lanes.gate.slice(0, len).map((g) => (g ? 1 : 0)));
      const next = nextRow(row, p.ca.rule);
      // some rules empty a ring whose length is a power of two (Rule 90 always does): reseed one cell
      if (!next.some(Boolean)) next[Math.floor(Math.random() * len)] = 1;
      for (let i = 0; i < len; i++) p.lanes.gate[i] = next[i] ? (p.lanes.gate[i] === 2 ? 2 : 1) : 0;
    }
    const mut = Math.min(1, p.mut + s.p['g.heat'] * 0.15);
    if (mut > 0) for (let i = 0; i < STEPS; i++) if (Math.random() < mut * 0.25) p.lanes.note[i] = Math.round(-2 + Math.random() * 11);
    if (s.chain.length) {
      this.chainPos = (this.chainPos + 1) % s.chain.length;
      s.cur = s.chain[this.chainPos];
      this.lastC = {};
    }
    this.base = this.tick;
    this.onLoop();
  }
}
