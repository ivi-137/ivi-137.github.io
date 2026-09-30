/**
 * Posto giusto: an XY pad in the spirit of the Korg Kaoss Pad that Jonny
 * Greenwood plays live on "Everything in Its Right Place", catching Thom
 * Yorke's voice and cutting, filtering and reversing it. It works on one bus
 * of the instrument, only while a finger is on it (or with HOLD).
 *
 *   filtro    X cutoff, Y resonance: a resonant low pass sweep
 *   440       an envelope filter after the DOD 440 in Greenwood's pedalboard:
 *             the louder the input, the higher the peak. X range, Y resonance
 *   taglia    touch to catch the last slice and repeat it: X slice (1/32 to a bar), Y speed
 *   rovescio  a reverse delay: X window, Y feedback
 *   whammy    a pitch shifter after the DigiTech Whammy: X ±2 octaves, Y blend
 */
import { Delay, Follower, SVF, Shifter, clamp, expMap } from './fx';

export const PAD_MODES = ['filtro', '440', 'taglia', 'rovescio', 'whammy'] as const;
/** Slices for taglia, in beats (a bar is four). */
export const SLICES = [0.125, 0.25, 0.5, 1, 2, 4];
export const SLICE_NAMES = ['1/32', '1/16', '1/8', '1/4', '1/2', '1 bar'];

/** Whammy interval in semitones for X, snapping to the nearest semitone when close. */
export function whammySt(x: number) {
  const st = (clamp(x) - 0.5) * 48;
  const r = Math.round(st);
  return Math.abs(st - r) < 0.3 ? r : st;
}

export class Pad {
  sr: number;
  ringL: Delay;
  ringR: Delay;
  svfL: SVF;
  svfR: SVF;
  env: Follower;
  shL = new Shifter(0);
  shR = new Shifter(0.37);
  eng = 0;
  private held = false;
  private capW = 0;
  private loopPos = 0;
  private lastL = 0;
  private lastR = 0;
  private sweep = 0;
  private fx = -1;
  private tick = 0;
  private fy = -1;
  outL = 0;
  outR = 0;
  constructor(sr: number) {
    this.sr = sr;
    this.ringL = new Delay(sr * 8.5);
    this.ringR = new Delay(sr * 8.5);
    this.svfL = new SVF(sr);
    this.svfR = new SVF(sr);
    this.env = new Follower(sr, 2, 70);
  }

  /**
   * One frame. touch: a finger on the pad (or HOLD); mode 0..4; x, y 0..1;
   * mix 0..1; beat: samples per beat, for taglia's slices.
   */
  process(inL: number, inR: number, touch: boolean, mode: number, x: number, y: number, mix: number, beat: number) {
    this.eng += ((touch ? 1 : 0) - this.eng) * 0.004;
    const e = this.eng * mix;
    // taglia holds the catch still: the ring stops recording while a slice repeats
    const freeze = mode === 2 && touch;
    if (touch && !this.held) {
      this.held = true;
      this.capW = this.ringL.w;
      this.loopPos = 0;
    }
    if (!touch) this.held = false;
    if (!freeze) {
      const fb = mode === 3 ? clamp(y) * 0.85 : 0;
      this.ringL.write(inL + this.lastL * fb);
      this.ringR.write(inR + this.lastR * fb);
    }
    if (e < 1e-4 && !touch) {
      this.lastL = this.lastR = 0;
      this.outL = inL;
      this.outR = inR;
      return;
    }
    let wl = inL,
      wr = inR;
    if (mode === 0) {
      if (x !== this.fx || y !== this.fy) {
        this.fx = x;
        this.fy = y;
        this.svfL.set(expMap(x, 60, 16000), 0.1 + 0.85 * y);
        this.svfR.set(expMap(x, 60, 16000), 0.1 + 0.85 * y);
      }
      wl = this.svfL.run(inL, 0);
      wr = this.svfR.run(inR, 0);
    } else if (mode === 1) {
      const lvl = this.env.run((inL + inR) * 0.5);
      this.sweep += (Math.min(1, lvl * (1.5 + 10 * x)) - this.sweep) * 0.02;
      if ((this.tick++ & 15) === 0) {
        const hz = expMap(this.sweep, 180, 180 + 3800 * (0.3 + x));
        this.svfL.set(hz, 0.45 + 0.5 * y);
        this.svfR.set(hz, 0.45 + 0.5 * y);
        this.fx = -1;
      }
      this.svfL.tick(inL);
      this.svfR.tick(inR);
      wl = this.svfL.bp * 0.8 + this.svfL.lp * 0.35;
      wr = this.svfR.bp * 0.8 + this.svfR.lp * 0.35;
    } else if (mode === 2) {
      const len = Math.max(64, Math.min(this.sr * 8, SLICES[Math.min(SLICES.length - 1, Math.floor(clamp(x) * SLICES.length))] * beat));
      const rate = Math.pow(2, (clamp(y) - 0.5) * 2);
      this.loopPos += rate;
      if (this.loopPos >= len) this.loopPos -= len;
      const start = this.capW - len;
      const u = this.loopPos / len;
      const edge = Math.min(1, (u * len) / 96, ((1 - u) * len) / 96);
      wl = this.ringL.at(start + this.loopPos) * edge;
      wr = this.ringR.at(start + this.loopPos) * edge;
    } else if (mode === 3) {
      const W = expMap(x, 0.1, 1.6) * this.sr;
      wl = this.shL.run(this.ringL, 2, W, -1);
      wr = this.shR.run(this.ringR, 2, W, -1);
      this.lastL = wl;
      this.lastR = wr;
    } else {
      const ratio = Math.pow(2, whammySt(x) / 12);
      const W = 0.06 * this.sr;
      wl = this.shL.run(this.ringL, 2, W, ratio);
      wr = this.shR.run(this.ringR, 2, W, ratio);
      const blend = clamp(y);
      wl = inL * (1 - blend) + wl * blend;
      wr = inR * (1 - blend) + wr * blend;
    }
    this.outL = inL * (1 - e) + wl * e;
    this.outR = inR * (1 - e) + wr * e;
  }
}
