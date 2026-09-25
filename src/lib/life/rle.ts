/**
 * Run Length Encoded patterns: the lingua franca of Life software (Golly,
 * LifeWiki). `x = 3, y = 3, rule = B3/S23\nbo$2bo$3o!` is a glider.
 */
export interface RlePattern {
  w: number;
  h: number;
  rule?: string;
  cells: Array<[number, number]>;
}

export function parseRle(src: string): RlePattern | null {
  const lines = src.split(/\r?\n/).filter((l) => !l.startsWith('#'));
  let w = 0, h = 0, rule: string | undefined;
  const header = lines.find((l) => /^\s*x\s*=/.test(l));
  if (header) {
    w = Number(header.match(/x\s*=\s*(\d+)/)?.[1] ?? 0);
    h = Number(header.match(/y\s*=\s*(\d+)/)?.[1] ?? 0);
    rule = header.match(/rule\s*=\s*([^\s,]+)/i)?.[1];
  }
  const body = lines.filter((l) => l !== header).join('').replace(/\s+/g, '');
  if (!body) return null;
  const cells: Array<[number, number]> = [];
  let x = 0, y = 0, n = '';
  for (const ch of body) {
    if (ch >= '0' && ch <= '9') n += ch;
    else {
      const k = n ? Number(n) : 1;
      n = '';
      if (ch === 'b' || ch === '.') x += k;
      else if (ch === 'o' || ch === 'A' || /[a-zA-Z]/.test(ch) && ch !== '$') {
        for (let i = 0; i < k; i++) cells.push([x++, y]);
      } else if (ch === '$') {
        y += k;
        x = 0;
      } else if (ch === '!') break;
      else return null;
    }
  }
  if (!cells.length) return null;
  w ||= Math.max(...cells.map((c) => c[0])) + 1;
  h ||= Math.max(...cells.map((c) => c[1])) + 1;
  return { w, h, rule, cells };
}

export function toRle(p: RlePattern) {
  const rows: string[] = [];
  const grid = Array.from({ length: p.h }, () => new Uint8Array(p.w));
  for (const [x, y] of p.cells) grid[y][x] = 1;
  for (const row of grid) {
    let s = '', run = 0, cur = -1;
    const flush = () => {
      if (run) s += (run > 1 ? run : '') + (cur ? 'o' : 'b');
    };
    for (const v of row) {
      if (v === cur) run++;
      else flush(), (cur = v), (run = 1);
    }
    if (cur === 1) flush(); // trailing dead cells are implicit
    rows.push(s);
  }
  // collapse runs of empty rows into n$
  let body = '';
  let blank = 0;
  rows.forEach((r, i) => {
    if (!r && i < rows.length - 1) return blank++;
    if (i > 0) body += (blank + 1 > 1 ? blank + 1 : '') + '$';
    blank = 0;
    body += r;
  });
  const out = `x = ${p.w}, y = ${p.h}${p.rule ? `, rule = ${p.rule}` : ''}\n`;
  return out + (body + '!').replace(/(.{1,70})/g, '$1\n').trim();
}

/** The library the Lab offers. Discoverers and years from the LifeWiki record. */
export const LIBRARY: Array<{ name: string; note: string; rle: string }> = [
  { name: 'Glider', note: 'Richard Guy, 1970. c/4 diagonal spaceship.', rle: 'bo$2bo$3o!' },
  { name: 'LWSS', note: 'Lightweight spaceship. c/2 orthogonal.', rle: 'bo2bo$o4b$o3bo$4o!' },
  { name: 'R-pentomino', note: 'Five cells that take 1103 generations to settle.', rle: 'b2o$2ob$bo!' },
  { name: 'Acorn', note: 'Charles Corderman. Stabilises after 5206 generations.', rle: 'bo5b$3bo3b$2o2b3o!' },
  { name: 'Diehard', note: 'Vanishes completely after exactly 130 generations.', rle: '6bob$2o6b$bo3b3o!' },
  { name: 'Pulsar', note: 'Period-3 oscillator with fourfold symmetry.', rle: '2b3o3b3o2b2$o4bobo4bo$o4bobo4bo$o4bobo4bo$2b3o3b3o2b2$2b3o3b3o2b$o4bobo4bo$o4bobo4bo$o4bobo4bo2$2b3o3b3o!' },
  { name: 'Pentadecathlon', note: 'Period 15. Looks like breathing.', rle: '2bo4bo2b$2ob4ob2o$2bo4bo!' },
  { name: 'Gosper glider gun', note: 'Bill Gosper, 1970. First known infinite growth.', rle: '24bo11b$22bobo11b$12b2o6b2o12b2o$11bo3bo4b2o12b2o$2o8bo5bo3b2o14b$2o8bo3bob2o4bobo11b$10bo5bo7bo11b$11bo3bo20b$12b2o!' },
  { name: 'Replicator', note: 'In HighLife (B36/S23) this copies itself.', rle: '2b3o$bo2bo$o3bo$o2bob$3o!' },
];
