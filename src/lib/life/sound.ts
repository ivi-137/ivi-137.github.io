/**
 * Sonification. A horizontal scanline listens to one row of the colony; every
 * cell born on that row plucks a note, pitched by its x position on a
 * pentatonic scale. Block entropy opens and closes the filter, so ordered
 * colonies sound muffled and chaotic ones sound bright. Off by default.
 */
import type { Life } from './engine';

const SCALE = [0, 3, 5, 7, 10]; // minor pentatonic
const BASE = 110; // A2

export class Sonifier {
  private ctx: AudioContext | null = null;
  private out!: GainNode;
  private filter!: BiquadFilterNode;
  private prev: Uint8Array | null = null;
  private off: (() => void)[] = [];
  on = false;

  constructor(private life: Life) {}

  private build() {
    const ctx = new AudioContext();
    this.ctx = ctx;
    this.out = ctx.createGain();
    this.out.gain.value = 0.16;
    this.filter = ctx.createBiquadFilter();
    this.filter.type = 'lowpass';
    this.filter.frequency.value = 1800;
    this.filter.Q.value = 4;
    // a short feedback delay gives the plucks a room to ring in
    const delay = ctx.createDelay(1);
    delay.delayTime.value = 0.23;
    const fb = ctx.createGain();
    fb.gain.value = 0.32;
    this.filter.connect(this.out);
    this.filter.connect(delay);
    delay.connect(fb).connect(delay);
    delay.connect(this.out);
    this.out.connect(ctx.destination);
  }

  private pluck(freq: number, pan: number, t: number) {
    const ctx = this.ctx!;
    const osc = ctx.createOscillator();
    const env = ctx.createGain();
    const p = ctx.createStereoPanner();
    osc.type = 'triangle';
    osc.frequency.value = freq;
    p.pan.value = pan;
    env.gain.setValueAtTime(0, t);
    env.gain.linearRampToValueAtTime(0.5, t + 0.004);
    env.gain.exponentialRampToValueAtTime(0.0008, t + 0.9);
    osc.connect(env).connect(p).connect(this.filter);
    osc.start(t);
    osc.stop(t + 1);
  }

  async toggle(force = !this.on) {
    if (force === this.on) return this.on;
    this.on = force;
    if (force) {
      if (!this.ctx) this.build();
      await this.ctx!.resume();
      this.prev = null;
      this.life.probeY = Math.round(innerHeight * 0.62);
      this.off.push(this.life.onStep(() => this.tick()));
      this.off.push(this.life.onStats((s) => this.filter.frequency.setTargetAtTime(500 + s.entropy * 5200, this.ctx!.currentTime, 0.5)) as () => void);
    } else {
      this.off.forEach((f) => f());
      this.off = [];
      this.life.probeY = -1;
      await this.ctx?.suspend();
    }
    window.dispatchEvent(new CustomEvent('sound:change', { detail: this.on }));
    return this.on;
  }

  private tick() {
    if (!this.ctx) return;
    const row = this.life.probeRow(this.life.probeY);
    const prev = this.prev;
    this.prev = row;
    if (!prev) return;
    const births: number[] = [];
    for (let x = 0; x < row.length; x++) if (row[x] && !prev[x]) births.push(x);
    // at most four voices per generation, spread across the row
    const pick = births.length <= 4 ? births : [0, 1, 2, 3].map((i) => births[Math.floor(((i + 0.5) * births.length) / 4)]);
    const t = this.ctx.currentTime + 0.01;
    pick.forEach((x, i) => {
      const u = x / row.length;
      const step = Math.floor(u * SCALE.length * 3);
      const semis = SCALE[step % SCALE.length] + 12 * Math.floor(step / SCALE.length);
      this.pluck(BASE * 2 ** (semis / 12), u * 2 - 1, t + i * 0.018);
    });
  }
}
