/**
 * Attrattore: the dynamics. A chaotic flow (Lorenz 1963 or Rössler 1976)
 * integrated with RK4; events at the crossings of a Poincaré section; and a
 * swarm of Reynolds boids (1987) that flies through the same flow. Five
 * flows here (Lorenz, Rössler, Thomas, Chua, Aizawa); ten planar systems in
 * systems.ts.
 */
export type V3 = [number, number, number];
export const SYSTEMS = {
  lorenz: {
    name: 'Lorenz (1963)',
    param: { label: 'ρ', min: 20, max: 60, def: 28, step: 0.1 },
    f: (p: V3, k: number): V3 => [10 * (p[1] - p[0]), p[0] * (k - p[2]) - p[1], p[0] * p[1] - (8 / 3) * p[2]],
    start: [1, 1, 20] as V3,
    dt: 0.008,
    /** section: the plane z = ρ − 1, crossed upward */
    section: (a: V3, b: V3, k: number) => a[2] < k - 1 && b[2] >= k - 1,
    coord: (p: V3) => p[0], // which lobe, and how far out
    scale: 0.028,
    center: (k: number): V3 => [0, 0, k - 3],
    span: 50,
    plane: (k: number): V3[] => [[-24, -30, k - 1], [24, -30, k - 1], [24, 30, k - 1], [-24, 30, k - 1]],
  },
  rossler: {
    name: 'Rössler (1976)',
    param: { label: 'c', min: 4, max: 13, def: 5.7, step: 0.1 },
    f: (p: V3, k: number): V3 => [-p[1] - p[2], p[0] + 0.2 * p[1], 0.2 + p[2] * (p[0] - k)],
    start: [1, 1, 0] as V3,
    dt: 0.02,
    /** section: the half-plane x = 0, y < 0, crossed with x increasing */
    section: (a: V3, b: V3) => a[0] < 0 && b[0] >= 0 && b[1] < 0,
    coord: (p: V3) => p[1],
    scale: 0.05,
    center: (): V3 => [0, 0, 3],
    span: 30,
    plane: (): V3[] => [[0, -14, -2], [0, 0, -2], [0, 0, 22], [0, -14, 22]],
  },
  thomas: {
    name: 'Thomas (1999)',
    param: { label: 'b', min: 0.12, max: 0.3, def: 0.19, step: 0.001 },
    f: (p: V3, k: number): V3 => [Math.sin(p[1]) - k * p[0], Math.sin(p[2]) - k * p[1], Math.sin(p[0]) - k * p[2]],
    start: [1.1, 1.1, -0.01] as V3,
    dt: 0.04,
    /** section: the plane z = 0, crossed upward */
    section: (a: V3, b: V3) => a[2] < 0 && b[2] >= 0,
    coord: (p: V3) => p[0],
    scale: 0.125,
    center: (): V3 => [0, 0, 0],
    span: 9,
    plane: (): V3[] => [[-5, -5, 0], [5, -5, 0], [5, 5, 0], [-5, 5, 0]],
  },
  chua: {
    name: "Chua's circuit (1983)",
    param: { label: 'α', min: 8, max: 16, def: 15.6, step: 0.1 },
    f: (p: V3, k: number): V3 => {
      const h = -0.714 * p[0] + 0.5 * (-1.143 + 0.714) * (Math.abs(p[0] + 1) - Math.abs(p[0] - 1));
      return [k * (p[1] - p[0] - h), p[0] - p[1] + p[2], -28 * p[1]];
    },
    start: [0.7, 0, 0] as V3,
    dt: 0.01,
    /** section: the plane y = 0, crossed upward; x says which scroll */
    section: (a: V3, b: V3) => a[1] < 0 && b[1] >= 0,
    coord: (p: V3) => p[0],
    scale: 0.2,
    center: (): V3 => [0, 0, 0],
    span: 7,
    plane: (): V3[] => [[-3, 0, -4], [3, 0, -4], [3, 0, 4], [-3, 0, 4]],
  },
  aizawa: {
    name: 'Aizawa (1982)',
    param: { label: 'a', min: 0.6, max: 0.99, def: 0.95, step: 0.01 },
    f: ([x, y, z]: V3, k: number): V3 => [(z - 0.7) * x - 3.5 * y, 3.5 * x + (z - 0.7) * y, 0.6 + k * z - z ** 3 / 3 - (x * x + y * y) * (1 + 0.25 * z) + 0.1 * z * x ** 3],
    start: [0.1, 0, 0] as V3,
    dt: 0.01,
    /** section: the half-plane y = 0, x > 0; the height says where the tube is */
    section: (a: V3, b: V3) => a[1] < 0 && b[1] >= 0 && b[0] > 0,
    coord: (p: V3) => p[2],
    scale: 0.4,
    center: (): V3 => [0, 0, 0.6],
    span: 3.5,
    plane: (): V3[] => [[0, 0, -0.6], [1.6, 0, -0.6], [1.6, 0, 1.9], [0, 0, 1.9]],
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
  seed(n: number, around: V3, spread = 20) {
    while (this.pos.length < n) {
      this.pos.push([around[0] + (Math.random() - 0.5) * spread, around[1] + (Math.random() - 0.5) * spread, around[2] + (Math.random() - 0.5) * spread]);
      this.vel.push([0, 0, 0]);
    }
    this.pos.length = this.vel.length = n;
  }
  /** `lead` is the trajectory's current point: the flock chases it, so it stays on the attractor. */
  update(sys: SystemId, k: number, p: SwarmParams, dt: number, lead: V3) {
    const n = this.pos.length;
    if (!n) return;
    const f = SYSTEMS[sys].f, L = SYSTEMS[sys].span / 50; // lengths scale with the attractor
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
        if (d2 < 9 * L * L && d2 > 1e-8) (sep[0] += dx / d2), (sep[1] += dy / d2), (sep[2] += dz / d2);
      }
      for (let d = 0; d < 3; d++) {
        const acc = p.coupling * (flow[d] * 0.35 - v[d]) + p.cohesion * (c[d] - q[d]) * 0.4 + p.alignment * (av[d] - v[d]) + p.separation * sep[d] * 6 * L * L + (0.3 + p.coupling) * (lead[d] - q[d]) * 0.25;
        v[d] += acc * dt;
      }
      const sp = Math.hypot(...v);
      if (sp > 40 * L) for (let d = 0; d < 3; d++) v[d] *= (40 * L) / sp;
      for (let d = 0; d < 3; d++) q[d] += v[d] * dt;
    }
  }
}
