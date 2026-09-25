/** Rows top-to-bottom, `O` = live. Classic patterns from the LifeWiki canon. */
export type Pattern = readonly string[];

export const GLIDER: Pattern = ['.O.', '..O', 'OOO'];
export const R_PENTOMINO: Pattern = ['.OO', 'OO.', '.O.'];
/** Stabilises only after 5206 generations — a long-lived perturbation. */
export const ACORN: Pattern = ['.O.....', '...O...', 'OO..OOO'];
/** Bill Gosper, 1970. Period 30. Won Conway's $50 prize for unbounded growth. */
export const GOSPER_GUN: Pattern = [
  '........................O...........',
  '......................O.O...........',
  '............OO......OO............OO',
  '...........O...O....OO............OO',
  'OO........O.....O...OO..............',
  'OO........O...O.OO....O.O...........',
  '..........O.....O.......O...........',
  '...........O...O....................',
  '............OO......................',
];

/** Live-cell offsets, optionally mirrored (mirroring a glider changes its heading). */
export function cells(p: Pattern, flipX = false, flipY = false): Array<[number, number]> {
  const h = p.length;
  const w = p[0].length;
  const out: Array<[number, number]> = [];
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++)
      if (p[y][x] === 'O') out.push([flipX ? w - 1 - x : x, flipY ? h - 1 - y : y]);
  return out;
}

export const size = (p: Pattern) => [p[0].length, p.length] as const;
