/**
 * Space-filling curves: continuous surjections f: [0,1] → [0,1]² approximated
 * at finite order. Each maps a 1D index to a cell of a square grid so that
 * neighbours in the sequence stay neighbours in the plane.
 */

/** Hilbert curve of order k on a 2^k × 2^k grid: index d ∈ [0, 4^k) → (x, y). */
export function hilbert(k: number, d: number): [number, number] {
  let x = 0, y = 0;
  for (let s = 1; s < 1 << k; s <<= 1) {
    const rx = 1 & (d >> 1);
    const ry = 1 & (d ^ rx);
    if (ry === 0) {
      if (rx === 1) {
        x = s - 1 - x;
        y = s - 1 - y;
      }
      [x, y] = [y, x];
    }
    x += s * rx;
    y += s * ry;
    d >>= 2;
  }
  return [x, y];
}

/**
 * Peano curve of order k on a 3^k × 3^k grid (Peano 1890, in Sagan's digit
 * form). Write d in base 3 as t₁t₂…t₂ₖ. Then
 *   xⱼ = κ^(t₂+t₄+…+t₂ⱼ₋₂)(t₂ⱼ₋₁),   yⱼ = κ^(t₁+t₃+…+t₂ⱼ₋₁)(t₂ⱼ),   κ(t) = 2 − t.
 */
export function peano(k: number, d: number): [number, number] {
  const t: number[] = [];
  for (let i = 0; i < 2 * k; i++) {
    t.unshift(d % 3);
    d = Math.floor(d / 3);
  }
  let x = 0, y = 0, sumEven = 0, sumOdd = 0;
  for (let j = 0; j < k; j++) {
    const a = t[2 * j], b = t[2 * j + 1];
    const xj = sumEven % 2 ? 2 - a : a;
    sumOdd += a;
    const yj = sumOdd % 2 ? 2 - b : b;
    sumEven += b;
    x = x * 3 + xj;
    y = y * 3 + yj;
  }
  return [x, y];
}

export type Curve = 'hilbert' | 'peano';
export const side = (c: Curve, k: number) => (c === 'hilbert' ? 2 ** k : 3 ** k);
export const point = (c: Curve, k: number, d: number) => (c === 'hilbert' ? hilbert(k, d) : peano(k, d));

/**
 * Box-counting dimension estimate of the curve's image: count occupied boxes
 * N(ε) at successively finer scales and fit log N against log(1/ε). For a
 * space-filling curve the slope tends to D = 2.
 */
export function boxDimension(c: Curve, k: number) {
  const n = side(c, k);
  const base = c === 'hilbert' ? 2 : 3;
  const pts: Array<[number, number]> = [];
  for (let d = 0; d < n * n; d++) pts.push(point(c, k, d));
  const rows: Array<{ eps: number; boxes: number }> = [];
  for (let j = 1; j <= k; j++) {
    const cells = base ** j;
    const size = n / cells;
    const seen = new Set<number>();
    for (const [x, y] of pts) seen.add(Math.floor(y / size) * cells + Math.floor(x / size));
    rows.push({ eps: 1 / cells, boxes: seen.size });
  }
  // least-squares slope of log N vs log 1/ε
  const xs = rows.map((r) => Math.log(1 / r.eps)), ys = rows.map((r) => Math.log(r.boxes));
  const mx = xs.reduce((a, b) => a + b) / xs.length, my = ys.reduce((a, b) => a + b) / ys.length;
  let num = 0, den = 0;
  xs.forEach((x, i) => ((num += (x - mx) * (ys[i] - my)), (den += (x - mx) ** 2)));
  return { rows, dimension: den ? num / den : 2 };
}
