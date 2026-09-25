/**
 * Sanity-check the atlas catalogue against facts from the literature:
 *   node scripts/check-atlas.mts
 */
import { additive, classify, conserving, family, globalMap, lambda, representative } from '../src/lib/eca.ts';

const reps = [...new Set([...Array(256).keys()].map(representative))];
console.log('families:', reps.length, '(expected 88)');

const byClass: Record<number, number[]> = { 1: [], 2: [], 3: [], 4: [] };
for (const r of reps) byClass[classify(r).wclass].push(r);
for (const k of [1, 2, 3, 4]) console.log(`class ${k}: ${byClass[k].length} families →`, byClass[k].join(' '));

// Literature: class III families usually listed (Wolfram 2002)
const expectedIII = [18, 22, 30, 45, 60, 90, 105, 122, 126, 146, 150];
console.log('expected class III families present:', expectedIII.map((r) => `${r}:${classify(r).wclass}`).join(' '));

const add = [...Array(256).keys()].filter((r) => additive(r));
console.log('additive rules:', add.length, add.join(' '));
const cons = [...Array(256).keys()].filter(conserving);
console.log('number-conserving:', cons.join(' '), '(expected 170 184 204 226 240)');
const rev = [...Array(256).keys()].filter((r) => globalMap(r).reversible);
console.log('reversible:', rev.join(' '), '(expected 15 51 85 170 204 240)');
console.log('λ(110) =', lambda(110), 'family(110) =', family(110).join(','), 'GoE(110) from ring', globalMap(110).edenFrom);
console.log('damage 30 / 110 / 90 / 184 / 204:', [30, 110, 90, 184, 204].map((r) => classify(r).damage).join(' / '));
