/**
 * Verify the NOT gate found by find-not-gate.mts and emit its geometry.
 *
 * Input  = the A stream. A bit 0 is encoded by deleting one A-glider in a
 *          "tap" box on its lane before it reaches the crossing.
 * Output = the B stream, read in a detector box past the crossing. A B-glider
 *          survives exactly when its A partner was missing.
 *
 *   node scripts/verify-not-gate.mts
 */
import { Board } from '../src/lib/life/cpu.ts';
import { LIBRARY, parseRle } from '../src/lib/life/rle.ts';

const gun = parseRle(LIBRARY.find((l) => l.name === 'Gosper glider gun')!.rle)!;
const W = 170, H = 150, MARGIN = 3;
const AX = 10, AY = 10;
const DX = Number(process.argv[2] ?? 61), DY = Number(process.argv[3] ?? 1);

const place = (b: Board, ox: number, oy: number, flip: boolean) =>
  b.place(gun.cells.map(([x, y]) => [flip ? gun.w - 1 - x : x, y] as [number, number]), ox, oy);
const absorb = (b: Board) => {
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) if (x < MARGIN || y < MARGIN || x >= W - MARGIN || y >= H - MARGIN) b.set(x, y, 0);
};
type Box = { x0: number; y0: number; x1: number; y1: number };
const count = (b: Board, r: Box) => {
  let n = 0;
  for (let y = r.y0; y <= r.y1; y++) for (let x = r.x0; x <= r.x1; x++) n += b.cells[y * W + x];
  return n;
};
const clear = (b: Board, r: Box) => {
  for (let y = r.y0; y <= r.y1; y++) for (let x = r.x0; x <= r.x1; x++) b.set(x, y, 0);
};

/** Find one lone glider in a y-band when a single gun runs alone; return its padded box and phase. */
function findGlider(flip: boolean, gx: number, yMin: number, yMax: number): { box: Box; phase: number } {
  const b = new Board(W, H);
  place(b, flip ? AX + DX : AX, flip ? AY + DY : AY, flip);
  for (let t = 1; t < 400; t++) {
    b.step();
    absorb(b);
    if (t < 200) continue;
    const pts: Array<[number, number]> = [];
    for (let y = yMin; y <= yMax; y++) for (let x = 0; x < W; x++) if (b.cells[y * W + x]) pts.push([x, y]);
    // exactly one glider (5 cells) fully inside the band, away from its edges
    if (pts.length === 5) {
      const xs = pts.map((p) => p[0]), ys = pts.map((p) => p[1]);
      const box = { x0: Math.min(...xs) - 1, y0: Math.min(...ys) - 1, x1: Math.max(...xs) + 1, y1: Math.max(...ys) + 1 };
      if (box.y0 > yMin && box.y1 < yMax && Math.abs((box.x0 + box.x1) / 2 - gx) < 40) return { box, phase: t % 30 };
    }
  }
  throw new Error('no glider found');
}

const crossY = AY + Math.max(0, DY) + gun.h + Math.abs(DX) / 2;
const tap = findGlider(false, AX + gun.w, AY + gun.h + 6, AY + gun.h + 16);
const out = findGlider(true, AX + DX, Math.round(crossY) + 16, Math.round(crossY) + 26);
console.log({ DX, DY, crossY, tap, out });

function run(bits: number[]) {
  const b = new Board(W, H);
  place(b, AX, AY, false);
  place(b, AX + DX, AY + DY, true);
  const read: number[] = [];
  let k = 0;
  for (let t = 1; t < 300 + bits.length * 30 + 300; t++) {
    b.step();
    absorb(b);
    // after warm-up, gate one A-glider per period according to the input bit
    if (t >= 300 && t % 30 === tap.phase && k < bits.length) {
      if (count(b, tap.box) !== 5) throw new Error(`tap box not holding a glider at t=${t}`);
      if (bits[k] === 0) clear(b, tap.box);
      k++;
    }
    if (t >= 300 && t % 30 === out.phase) read.push(count(b, out.box) >= 5 ? 1 : 0);
  }
  return read;
}

const tests = [
  [1, 0, 1, 1, 0, 0, 1, 0, 1, 1, 1, 0],
  [0, 0, 0, 1, 1, 1, 0, 1, 0, 0, 1, 1],
  [0, 1, 0, 1, 0, 1, 0, 1, 0, 1, 0, 1],
];
let latency = -1;
for (const bits of tests) {
  const read = run(bits);
  // find the pipeline delay at which output = NOT input for every bit
  const ok = (s: number) => bits.every((v, i) => read[i + s] === 1 - v);
  const s = [...Array(12).keys()].find(ok);
  console.log('in ', bits.join(''), '\nout', read.join(''), ' delay', s ?? 'NONE');
  if (s === undefined) process.exit(1);
  latency = s;
}
console.log(JSON.stringify({ gate: { AX, AY, DX, DY, W, H, tap, out, latency } }));
