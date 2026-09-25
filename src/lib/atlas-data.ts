/**
 * The atlas catalogue, computed once at build time (server-only: uses zlib).
 * Every number the atlas shows comes from here.
 */
import { deflateRawSync } from 'node:zlib';
import { additive, classify, conserving, family, globalMap, lambda, pack, randomRow, representative, spacetime, type Entry } from './eca';

export function catalogue(): Entry[] {
  return [...Array(256).keys()].map((rule) => {
    const g = globalMap(rule);
    const c = classify(rule);
    // compressibility of a 256 × 256 spacetime diagram from a random start:
    // a crude, honest upper bound on its Kolmogorov complexity
    const bits = spacetime(rule, randomRow(256, 1729), 256);
    const raw = pack(bits);
    const compress = Math.round((deflateRawSync(raw, { level: 9 }).length / raw.length) * 1000) / 1000;
    return {
      rule,
      bits: rule.toString(2).padStart(8, '0'),
      lambda: lambda(rule),
      family: family(rule),
      rep: representative(rule),
      additive: additive(rule),
      conserving: conserving(rule),
      reversible: g.reversible,
      edenFrom: g.edenFrom,
      ...c,
      compress,
    };
  });
}

export const ROOMS = [
  {
    n: 1,
    roman: 'I',
    title: 'Homogeneous',
    text: 'Every random beginning collapses into one colour. The rules that erase: whatever you give them, they forget it.',
  },
  {
    n: 2,
    roman: 'II',
    title: 'Periodic',
    text: 'Structures freeze, blink or slide, and information stays local. Most of the collection lives here; their futures are cheap to predict.',
  },
  {
    n: 3,
    roman: 'III',
    title: 'Chaotic',
    text: 'Aperiodic and random-looking. Flip a single bit and the difference spreads at the speed of light. Short programs, incompressible output.',
  },
  {
    n: 4,
    roman: 'IV',
    title: 'Complex',
    text: 'Localised structures drifting over a periodic background and colliding. The narrow room where computation lives: Rule 110 is universal.',
  },
] as const;

/** Curatorial notes. Where a claim is not measured on the page, it is a documented fact about the rule. */
export const NOTES: Record<number, string> = {
  0: 'Everything dies in one step. The zero of the collection.',
  18: 'From one cell, a Sierpiński triangle; from noise, chaos punctuated by travelling defects.',
  22: 'Nested from a single cell, chaotic from random starts.',
  30: 'Chaotic from a single cell. Wolfram used its centre column as a random number generator.',
  45: 'Chaotic, with a characteristic lean: the pattern drifts as it churns.',
  54: 'Long studied as class IV: gliders and collisions on a periodic background.',
  60: 'Additive: each cell becomes the XOR of itself and its left neighbour. Pascal’s triangle mod 2, sheared.',
  73: 'Walls form and isolate regions that evolve independently; a borderline case between classes.',
  90: 'XOR of the two neighbours. From one cell, the Sierpiński triangle exactly: Pascal’s triangle mod 2.',
  105: 'Rule 150 with its output negated: 1 ⊕ l ⊕ c ⊕ r. Affine rather than linear.',
  106: 'Filed as III or IV depending on the author: its textures sometimes carry structures.',
  110: 'Turing-complete. Matthew Cook, published 2004: gliders on a periodic ether emulate a cyclic tag system.',
  122: 'Chaotic from random starts, nested from a single cell.',
  124: 'Rule 110 in a mirror. Universal.',
  126: 'Nested from a single cell, chaotic from random starts: a dense, noisy Sierpiński.',
  137: 'Rule 110 with black and white swapped. Universal. The emblem of this site.',
  146: 'A close cousin of Rule 18: nested from one cell, chaotic from noise.',
  150: 'XOR of all three cells. Additive; from one cell a dense fractal with dimension log₂(1+√5).',
  170: 'A pure shift: every pattern slides one cell to the left forever. Reversible.',
  184: 'Traffic: every 1 is a car that moves right when the cell ahead is free. Conserves the number of cars.',
  193: 'Rule 110 mirrored and complemented. Universal.',
  204: 'Identity: nothing ever changes. Reversible, trivially.',
  232: 'Majority vote: noise freezes into blocks.',
  240: 'A pure shift to the right. Reversible.',
  255: 'Everything lives. The complement of Rule 0.',
};
