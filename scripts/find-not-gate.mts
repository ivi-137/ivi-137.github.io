/**
 * Search for a NOT gate built from glider collisions.
 *
 * Gun A (the input) fires one glider every 30 generations. Gun B (the clock),
 * mirrored, fires a crossing stream. We look for a relative placement where
 * each A-glider annihilates the matching B-glider completely: no debris, no
 * survivors. Then deleting an A-glider (input bit 0) lets exactly one
 * B-glider through (output bit 1): output = NOT input.
 *
 *   node scripts/find-not-gate.mts
 */
import { Board } from '../src/lib/life/cpu.ts';
import { LIBRARY, parseRle } from '../src/lib/life/rle.ts';

const gun = parseRle(LIBRARY.find((l) => l.name === 'Gosper glider gun')!.rle)!;
const W = 170, H = 150, MARGIN = 3;

const place = (b: Board, ox: number, oy: number, flip: boolean) =>
  b.place(gun.cells.map(([x, y]) => [flip ? gun.w - 1 - x : x, y] as [number, number]), ox, oy);

/** Absorbing boundary: anything that reaches the edge is erased, so the torus never wraps. */
const absorb = (b: Board) => {
  for (let y = 0; y < H; y++)
    for (let x = 0; x < W; x++) if (x < MARGIN || y < MARGIN || x >= W - MARGIN || y >= H - MARGIN) b.set(x, y, 0);
};

const live = (b: Board, pred: (x: number, y: number) => boolean) => {
  let n = 0;
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) if (b.cells[y * W + x] && pred(x, y)) n++;
  return n;
};

// 1. which way does the unflipped gun shoot?
{
  const b = new Board(W, H);
  place(b, 20, 20, false);
  for (let i = 0; i < 150; i++) b.step(), absorb(b);
  let sx = 0, sy = 0, n = 0;
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) if (b.cells[y * W + x] && (x > 20 + gun.w + 4 || y > 20 + gun.h + 4)) (sx += x), (sy += y), n++;
  console.log('gun A output centroid', (sx / n).toFixed(1), (sy / n).toFixed(1), 'cells', n, '(gun at 20,20 size', gun.w, 'x', gun.h, ')');
}

// 2. search placements of the mirrored gun B
const AX = 10, AY = 10;
const results: Array<{ dx: number; dy: number; below: number; period: boolean; pop: number }> = [];
for (let dx = 56; dx <= 96; dx++) {
  for (let dy = -6; dy <= 6; dy++) {
    const b = new Board(W, H);
    place(b, AX, AY, false);
    place(b, AX + dx, AY + dy, true);
    const pops: number[] = [];
    for (let t = 0; t < 560; t++) {
      b.step();
      absorb(b);
      if (t >= 470) pops.push(b.population());
    }
    const period = pops.every((p, i) => i < 30 || p === pops[i - 30]);
    // the streams cross somewhere between the guns; anything well below that line got through
    const crossY = AY + Math.max(0, dy) + gun.h + Math.abs(dx) / 2;
    const below = live(b, (_, y) => y > crossY + 14);
    results.push({ dx, dy, below, period, pop: pops[pops.length - 1] });
  }
}
const clean = results.filter((r) => r.period && r.below === 0).sort((a, b) => a.pop - b.pop);
console.log('clean annihilating placements:', clean.length);
console.log(clean.slice(0, 12));
