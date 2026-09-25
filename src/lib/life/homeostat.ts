/**
 * The homeostat: a second-order feedback loop between the reader and the colony.
 *
 * Observer. Every pointer move, click, key and scroll is coded as a symbol
 * (pointer: 8 headings × 3 speeds; plus click, key-class and scroll symbols).
 * Over a sliding window we take the Shannon entropy of those symbols and scale
 * it by activity. That is H_you, the variety of your input.
 *
 * Regulator. Ashby's Law of Requisite Variety says a regulator must have at
 * least as much variety as the disturbances it faces. So the colony is steered
 * until its own measured variety, block entropy H_colony, tracks H_you. The
 * levers are tempo (generations per second), perturbation (seeding long-lived
 * methuselahs where you are looking) and vividness (render intensity). Calm
 * input lets the colony settle into still lifes; restless input keeps it
 * turbulent.
 *
 * The site also watches itself: both signals are drawn in the HUD, so the
 * reader sees the system that is observing them.
 */
import type { Life, Stats } from './engine';
import { ACORN, R_PENTOMINO } from './patterns';

const WINDOW_MS = 6000;
const ALPHABET = 8 * 3 + 1 + 4 + 2; // headings×speeds, click, key classes, scroll up/down
const H_MAX = Math.log2(ALPHABET);

export interface Reading {
  you: number; // input variety, 0..1
  colony: number; // colony block entropy, 0..1
  target: number; // entropy the regulator is steering toward
  tempo: number;
  on: boolean;
}

export class Homeostat {
  private events: Array<{ t: number; s: number }> = [];
  private last = { x: 0, y: 0, t: 0 };
  private colony = 0;
  private tempo = 1;
  private vivid = 1;
  private px = innerWidth / 2;
  private py = innerHeight / 2;
  private listeners = new Set<(r: Reading) => void>();
  readonly history: Reading[] = [];
  on: boolean;

  constructor(private life: Life, opts: { on: boolean }) {
    this.on = opts.on;
    addEventListener('pointermove', (e) => this.move(e), { passive: true });
    addEventListener('pointerdown', () => this.emit(24), { passive: true });
    addEventListener('keydown', (e) => this.emit(25 + (/^[a-z]$/i.test(e.key) ? 0 : /^\d$/.test(e.key) ? 1 : e.key.startsWith('Arrow') ? 2 : 3)));
    addEventListener('wheel', (e) => this.emit(e.deltaY > 0 ? 29 : 30), { passive: true });
    life.onStats((s: Stats) => (this.colony = s.entropy));
    setInterval(() => this.regulate(), 500);
  }

  private emit(s: number) {
    this.events.push({ t: performance.now(), s });
  }

  private move(e: PointerEvent) {
    const now = performance.now();
    this.px = e.clientX;
    this.py = e.clientY;
    const dx = e.clientX - this.last.x, dy = e.clientY - this.last.y;
    const dt = Math.max(1, now - this.last.t);
    this.last = { x: e.clientX, y: e.clientY, t: now };
    const dist = Math.hypot(dx, dy);
    if (dist < 3) return;
    const heading = Math.round(((Math.atan2(dy, dx) + Math.PI) / (2 * Math.PI)) * 8) % 8;
    const speed = dist / dt;
    const band = speed < 0.3 ? 0 : speed < 1.2 ? 1 : 2;
    this.emit(heading * 3 + band);
  }

  /** H_you: normalised entropy of recent symbols, damped when you're idle. */
  variety() {
    const now = performance.now();
    while (this.events.length && now - this.events[0].t > WINDOW_MS) this.events.shift();
    const n = this.events.length;
    if (n < 2) return 0;
    const counts = new Map<number, number>();
    for (const e of this.events) counts.set(e.s, (counts.get(e.s) ?? 0) + 1);
    let h = 0;
    for (const c of counts.values()) h -= (c / n) * Math.log2(c / n);
    const activity = Math.min(1, n / (WINDOW_MS / 1000) / 12); // ~12 symbols/s counts as fully active
    return (h / H_MAX) * activity;
  }

  private regulate() {
    const you = this.variety();
    // map input variety onto the colony's natural entropy range
    const target = 0.06 + 0.42 * you;
    const err = target - this.colony;
    if (this.on) {
      this.tempo = Math.min(2.2, Math.max(0.35, this.tempo + err * 1.6));
      this.vivid = Math.min(1.25, Math.max(0.75, 0.8 + you * 0.5));
      // too little variety in the colony: inject a perturbation near the observer
      if (err > 0.05 && Math.random() < Math.min(0.9, err * 6) && this.life.running) {
        const jitter = () => (Math.random() - 0.5) * 240;
        const p = Math.random() < 0.7 ? R_PENTOMINO : ACORN;
        this.life.stampAt(p, this.px + jitter(), this.py + jitter(), Math.random() < 0.5, Math.random() < 0.5);
      }
    } else {
      this.tempo += (1 - this.tempo) * 0.2;
      this.vivid += (1 - this.vivid) * 0.2;
    }
    this.life.tempo = this.tempo;
    this.life.vividness = this.vivid;
    const r: Reading = { you, colony: this.colony, target, tempo: this.tempo, on: this.on };
    this.history.push(r);
    if (this.history.length > 120) this.history.shift();
    this.listeners.forEach((fn) => fn(r));
  }

  toggle(on = !this.on) {
    this.on = on;
    return on;
  }

  onReading(fn: (r: Reading) => void) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }
}
