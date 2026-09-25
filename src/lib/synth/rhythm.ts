/**
 * Euclidean rhythms (Toussaint, "The Euclidean Algorithm Generates Traditional
 * Musical Rhythms", 2005): k onsets spread as evenly as possible over n steps,
 * by Bjorklund's pairing algorithm. E(3,8) is the tresillo, E(5,8) the cinquillo.
 */
export function euclid(k: number, n: number, rotate = 0): number[] {
  k = Math.max(0, Math.min(n, Math.round(k)));
  if (k === 0) return new Array(n).fill(0);
  let a: number[][] = Array.from({ length: k }, () => [1]);
  let b: number[][] = Array.from({ length: n - k }, () => [0]);
  while (b.length > 1) {
    const m = Math.min(a.length, b.length);
    const paired = a.slice(0, m).map((x, i) => [...x, ...b[i]]);
    const rest = a.length > m ? a.slice(m) : b.slice(m);
    a = paired;
    b = rest;
  }
  const out = [...a.flat(), ...b.flat()];
  const r = ((Math.round(rotate) % n) + n) % n;
  return out.map((_, i) => out[(i - r + n) % n]);
}
