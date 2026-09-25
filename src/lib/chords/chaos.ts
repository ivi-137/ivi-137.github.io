/**
 * Attrattore: the dynamics. A chaotic flow (Lorenz 1963 or Rössler 1976)
 * integrated with RK4; events at the crossings of a Poincaré section; and a
 * swarm of Reynolds boids (1987) that flies through the same flow.
 */
export type V3 = [number, number, number];
export const SYSTEMS = {
  lorenz: {
    name: 'Lorenz (1963)',
    param: { label: 'ρ', min: 20, max: 60, def: 28 },
    f: (p: V3, k: number): V3 => [10 * (p[1] - p[0]), p[0] * (k - p[2]) - p[1], p[0] * p[1] - (8 / 3) * p[2]],
    start: [1, 1, 20] as V3,
    dt: 0.008,
    /** section: the plane z = ρ − 1, crossed upward */
    section: (a: V3, b: V3, k: number) => a[2] < k - 1 && b[2] >= k - 1,
    coord: (p: V3) => p[0], // which lobe, and how far out
    scale: 0.028,
    center: (k: number): V3 => [0, 0, k - 3],
  },
  rossler: {
    name: 'Rössler (1976)',
    param: { label: 'c', min: 4, max: 13, def: 5.7 },
    f: (p: V3, k: number): V3 => [-p[1] - p[2], p[0] + 0.2 * p[1], 0.2 + p[2] * (p[0] - k)],
    start: [1, 1, 0] as V3,
    dt: 0.02,
    /** section: the half-plane x = 0, y < 0, crossed with x increasing */
    section: (a: V3, b: V3) => a[0] < 0 && b[0] >= 0 && b[1] < 0,
    coord: (p: V3) => p[1],
    scale: 0.05,
    center: (): V3 => [0, 0, 3],
  },
} as const;
export type SystemId = keyof typeof SYSTEMS;

export function rk4(sys: SystemId, p: V3, k: number, dt: number): V3 {
  const f = SYSTEMS[sys].f;
  const add = (a: V3, b: V3, s: number): V3 => [a[0] + b[0] * s, a[1] + b[1] * s, a[2] + b[2] * s];
  const k1 = f(p, k), k2 = f(add(p, k1, dt / 2), k), k3 = f(add(p, k2, dt / 2), k), k4 = f(add(p, k3, dt), k);
  return [0, 1, 2].map((i) => p[i] + (dt / 6) * (k1[i] + 2 * k2[i] + 2 * k3[i] + k4[i])) as V3;
}

export class Flow {
  p: V3;
  trail: V3[] = [];
  crossings: number[] = []; // recent section coordinates, for normalisation
  sys: SystemId;
  k: number;
  constructor(sys: SystemId, k: number) {
    this.sys = sys;
    this.k = k;
    this.p = [...SYSTEMS[sys].start] as V3;
  }
  reset(sys: SystemId, k: number) {
    this.sys = sys;
    this.k = k;
    this.p = [...SYSTEMS[sys].start] as V3;
    this.trail = [];
    this.crossings = [];
  }
  /** Advance n steps; returns u ∈ [0,1] for every section crossing (position within the recent range). */
  step(n: number): number[] {
    const S = SYSTEMS[this.sys];
    const hits: number[] = [];
    for (let i = 0; i < n; i++) {
      const next = rk4(this.sys, this.p, this.k, S.dt);
      if (!next.every(Number.isFinite)) return (this.reset(this.sys, this.k), hits);
      if (S.section(this.p, next, this.k)) {
        const c = S.coord(next);
        this.crossings.push(c);
        if (this.crossings.length > 64) this.crossings.shift();
        const lo = Math.min(...this.crossings), hi = Math.max(...this.crossings);
        hits.push(hi > lo ? (c - lo) / (hi - lo) : 0.5);
      }
      this.p = next;
      this.trail.push(next);
      if (this.trail.length > 1800) this.trail.shift();
    }
    return hits;
  }
}

/** Reynolds boids, carried by the flow: separation, alignment, cohesion, plus coupling to the vector field. */
export interface SwarmParams {
  count: number;
  cohesion: number;
  alignment: number;
  separation: number;
  coupling: number;
}
export class Swarm {
  pos: V3[] = [];
  vel: V3[] = [];
  seed(n: number, around: V3) {
    while (this.pos.length < n) {
      this.pos.push([around[0] + (Math.random() - 0.5) * 20, around[1] + (Math.random() - 0.5) * 20, around[2] + (Math.random() - 0.5) * 20]);
      this.vel.push([0, 0, 0]);
    }
    this.pos.length = this.vel.length = n;
  }
  /** `lead` is the trajectory's current point: the flock chases it, so it stays on the attractor. */
  update(sys: SystemId, k: number, p: SwarmParams, dt: number, lead: V3) {
    const n = this.pos.length;
    if (!n) return;
    const f = SYSTEMS[sys].f;
    const c: V3 = [0, 0, 0], av: V3 = [0, 0, 0];
    for (let i = 0; i < n; i++) for (let d = 0; d < 3; d++) (c[d] += this.pos[i][d] / n), (av[d] += this.vel[i][d] / n);
    for (let i = 0; i < n; i++) {
      const q = this.pos[i], v = this.vel[i];
      const flow = f(q, k);
      const sep: V3 = [0, 0, 0];
      for (let j = 0; j < n; j++) {
        if (i === j) continue;
        const dx = q[0] - this.pos[j][0], dy = q[1] - this.pos[j][1], dz = q[2] - this.pos[j][2];
        const d2 = dx * dx + dy * dy + dz * dz;
        if (d2 < 9 && d2 > 1e-6) (sep[0] += dx / d2), (sep[1] += dy / d2), (sep[2] += dz / d2);
      }
      for (let d = 0; d < 3; d++) {
        const acc = p.coupling * (flow[d] * 0.35 - v[d]) + p.cohesion * (c[d] - q[d]) * 0.4 + p.alignment * (av[d] - v[d]) + p.separation * sep[d] * 6 + (0.3 + p.coupling) * (lead[d] - q[d]) * 0.25;
        v[d] += acc * dt;
      }
      const sp = Math.hypot(...v);
      if (sp > 40) for (let d = 0; d < 3; d++) v[d] *= 40 / sp;
      for (let d = 0; d < 3; d++) q[d] += v[d] * dt;
    }
  }
}
