/**
 * Elementary cellular automata: exact properties and measured behaviour.
 *
 * Neighbourhood index n = 4·left + 2·centre + right; a rule r maps n to bit
 * (r >> n) & 1 (Wolfram's numbering, 1983). Everything here is deterministic:
 * random initial conditions come from a seeded generator so the catalogue is
 * identical on every build.
 */

export const step = (row: Uint8Array, rule: number, out = new Uint8Array(row.length)) => {
  const w = row.length;
  for (let i = 0; i < w; i++) out[i] = (rule >> ((row[(i + w - 1) % w] << 2) | (row[i] << 1) | row[(i + 1) % w])) & 1;
  return out;
};

export function spacetime(rule: number, init: Uint8Array, rows: number) {
  const w = init.length;
  const out = new Uint8Array(w * rows);
  let row = init.slice();
  for (let t = 0; t < rows; t++) {
    out.set(row, t * w);
    row = step(row, rule);
  }
  return out;
}

export function prng(seed: number) {
  let s = seed >>> 0 || 1;
  return () => {
    s ^= s << 13;
    s ^= s >>> 17;
    s ^= s << 5;
    return (s >>> 0) / 4294967296;
  };
}
export const randomRow = (w: number, seed: number, density = 0.5) => {
  const r = prng(seed);
  return Uint8Array.from({ length: w }, () => (r() < density ? 1 : 0));
};

// ── symmetry ───────────────────────────────────────────────────────────────

export const mirror = (r: number) => {
  let o = 0;
  for (let n = 0; n < 8; n++) if ((r >> n) & 1) o |= 1 << (((n & 1) << 2) | (n & 2) | ((n >> 2) & 1));
  return o;
};
export const complement = (r: number) => {
  let o = 0;
  for (let n = 0; n < 8; n++) if (!((r >> (7 - n)) & 1)) o |= 1 << n;
  return o;
};
export const family = (r: number) => [...new Set([r, mirror(r), complement(r), mirror(complement(r))])].sort((a, b) => a - b);
export const representative = (r: number) => family(r)[0];

// ── exact properties ───────────────────────────────────────────────────────

/** Langton's λ: the fraction of neighbourhoods that map to the live state. */
export const lambda = (r: number) => {
  let n = 0;
  for (let i = 0; i < 8; i++) n += (r >> i) & 1;
  return n / 8;
};

/** Additive (affine over GF(2)): f = c ⊕ (a·l ⊕ b·c ⊕ d·r) for constants a, b, d, c. */
export function additive(r: number): string | null {
  for (let mask = 0; mask < 8; mask++)
    for (const k of [0, 1]) {
      let ok = true;
      for (let n = 0; n < 8 && ok; n++) {
        let v = k;
        if (mask & 4) v ^= (n >> 2) & 1;
        if (mask & 2) v ^= (n >> 1) & 1;
        if (mask & 1) v ^= n & 1;
        if (v !== ((r >> n) & 1)) ok = false;
      }
      if (ok) {
        const terms = [mask & 4 ? 'l' : '', mask & 2 ? 'c' : '', mask & 1 ? 'r' : ''].filter(Boolean);
        return `${k ? '1 ⊕ ' : ''}${terms.join(' ⊕ ') || (k ? '' : '0')}`.replace(/ ⊕ $/, '') || '1';
      }
    }
  return null;
}

/**
 * Number-conserving: the count of live cells never changes on any ring.
 * Checked exhaustively on every ring of length 3–12 (a rule that conserves on
 * all of them conserves in general for radius-1 rules).
 */
export function conserving(r: number) {
  for (let w = 3; w <= 12; w++) {
    for (let c = 0; c < 1 << w; c++) {
      const row = Uint8Array.from({ length: w }, (_, i) => (c >> i) & 1);
      const next = step(row, r);
      let a = 0, b = 0;
      for (let i = 0; i < w; i++) (a += row[i]), (b += next[i]);
      if (a !== b) return false;
    }
  }
  return true;
}

/**
 * Global map on rings of length 3–12, checked by brute force:
 *  - reversible: a bijection on every ring;
 *  - edenFrom: the smallest ring on which some configuration has no
 *    predecessor (a Garden of Eden), or null if none up to 12.
 */
export function globalMap(r: number) {
  let reversible = true;
  let edenFrom: number | null = null;
  for (let w = 3; w <= 12; w++) {
    const size = 1 << w;
    const seen = new Uint8Array(size);
    let hit = 0;
    for (let c = 0; c < size; c++) {
      let img = 0;
      for (let i = 0; i < w; i++) {
        const n = (((c >> ((i + w - 1) % w)) & 1) << 2) | (((c >> i) & 1) << 1) | ((c >> ((i + 1) % w)) & 1);
        img |= ((r >> n) & 1) << i;
      }
      if (!seen[img]) (seen[img] = 1), hit++;
    }
    if (hit < size) {
      reversible = false;
      edenFrom ??= w;
    }
  }
  return { reversible, edenFrom };
}

// ── measured behaviour ─────────────────────────────────────────────────────

/** Temporal period of the attractor, allowing a spatial shift (e.g. Rule 170 slides). */
function attractor(rule: number, init: Uint8Array, transient: number, maxP: number) {
  const w = init.length;
  let row = init.slice();
  for (let t = 0; t < transient; t++) row = step(row, rule);
  const ref = row.slice();
  for (let p = 1; p <= maxP; p++) {
    row = step(row, rule);
    for (let s = -Math.min(p, 8); s <= Math.min(p, 8); s++) {
      let eq = true;
      for (let i = 0; i < w && eq; i++) if (row[i] !== ref[(i + s + w) % w]) eq = false;
      if (eq) return { period: p, shift: s, uniform: ref.every((v) => v === ref[0]) };
    }
  }
  return null;
}

/**
 * Damage spreading: run from a random row and from the same row with one bit
 * flipped; report the fraction of cells that differ after T steps. Chaotic
 * rules spread the defect across the whole ring; ordered ones heal or freeze it.
 */
export function damage(rule: number, w: number, T: number, seed: number) {
  const a0 = randomRow(w, seed);
  const b0 = a0.slice();
  b0[w >> 1] ^= 1;
  let a = a0, b = b0;
  for (let t = 0; t < T; t++) (a = step(a, rule)), (b = step(b, rule));
  let d = 0;
  for (let i = 0; i < w; i++) d += a[i] ^ b[i];
  return d / w;
}

export const pack = (bits: Uint8Array) => {
  const out = new Uint8Array(Math.ceil(bits.length / 8));
  bits.forEach((v, i) => v && (out[i >> 3] |= 128 >> (i & 7)));
  return out;
};

/** Wolfram's rules usually cited as class IV. Behavioural measures cannot certify this. */
export const CLASS_IV = new Set([54, 147, 110, 124, 137, 193]);

export type WClass = 1 | 2 | 3 | 4;
export interface Entry {
  rule: number;
  bits: string;
  lambda: number;
  family: number[];
  rep: number;
  additive: string | null;
  conserving: boolean;
  reversible: boolean;
  edenFrom: number | null;
  wclass: WClass;
  period: number | null; // typical attractor period from random starts, null if none found (chaotic)
  shift: number;
  damage: number; // mean fraction of ring altered by a one-bit defect
  compress: number; // deflate(spacetime) / raw, from random starts (filled in by the caller)
}

/**
 * Behavioural classification after Wolfram (1984), made explicit:
 *   I   every random start ends in a uniform state;
 *   II  every random start ends in a (possibly shifting) periodic state;
 *   III otherwise;
 *   IV  from the literature (see CLASS_IV).
 */
export function classify(rule: number): Pick<Entry, 'wclass' | 'period' | 'shift' | 'damage'> {
  const W = 149; // odd ring, avoids parity artefacts of even widths
  let allUniform = true, allPeriodic = true;
  let period: number | null = null, shift = 0;
  for (const seed of [11, 23, 37, 51]) {
    const at = attractor(rule, randomRow(W, seed), 600, 160);
    if (!at) {
      allPeriodic = false;
      allUniform = false;
    } else {
      period = Math.max(period ?? 0, at.period);
      if (at.shift) shift = at.shift;
      if (!at.uniform) allUniform = false;
    }
  }
  // several seeds and horizons that are not powers of two: for additive rules a
  // power-of-two horizon collapses the damage cone to a few cells (Lucas' theorem)
  const runs = [[5, 97], [9, 121], [13, 149]] as const;
  const dmg = runs.reduce((a, [s, T]) => a + damage(rule, 256, T, s), 0) / runs.length;
  const wclass: WClass = CLASS_IV.has(rule) ? 4 : allUniform ? 1 : allPeriodic ? 2 : 3;
  return { wclass, period: allPeriodic ? period : null, shift, damage: Math.round(dmg * 1000) / 1000 };
}
