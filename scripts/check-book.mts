/**
 * The clerk's book against the Python it ports (research/ledger-smollm/patterns.py):
 *   node scripts/check-book.mts
 * Fixtures come from research/ledger-smollm/book_fixtures.py: answers broken on purpose with Python's verdicts and
 * label positions, and prompts with what Python's clerk reads from their examples.
 */
import { readFileSync } from 'node:fs';
import { audit, book, coherent, pieces, readRules, splitPrompt, stateAt, type Rules, type Verdict } from '../src/lib/coherence/book.ts';
import { PRESETS } from '../src/lib/coherence/book-presets.ts';

let failed = 0;
const check = (label: string, ok: boolean, detail = '') => {
  if (!ok) failed++;
  if (!ok || process.argv.includes('-v')) console.log(`${ok ? '✓' : '✗'} ${label}${detail ? `  (${detail})` : ''}`);
};
const same = (a: unknown, b: unknown) => JSON.stringify(sortKeys(a)) === JSON.stringify(sortKeys(b));
function sortKeys(x: unknown): unknown {
  if (Array.isArray(x)) return x.map(sortKeys);
  if (x && typeof x === 'object') return Object.fromEntries(Object.keys(x).sort().map((k) => [k, sortKeys((x as Record<string, unknown>)[k])]));
  return x;
}

interface AnswerCase {
  rules: Rules;
  n: number;
  text: string;
  verdicts: Record<string, Verdict>;
  milestones: Record<string, number[]>;
}
interface PromptCase {
  prompt: string;
  examples: string[];
  read: Rules;
  rules: Rules;
  n: number;
}
const fx = JSON.parse(readFileSync(new URL('./fixtures/book-parity.json', import.meta.url), 'utf8')) as { answers: AnswerCase[]; prompts: PromptCase[] };

// 1. the monitors: the same verdicts, and the book ends where the verdicts say
let verdicts = 0;
let rowsOk = 0;
let labels = 0;
for (const [i, c] of fx.answers.entries()) {
  const v = audit(c.text, c.rules, c.n);
  if (same(v, c.verdicts)) verdicts++;
  else check(`answer ${i}: verdicts`, false, `${JSON.stringify(v)} vs ${JSON.stringify(c.verdicts)}`);
  const rows = book(c.text, c.rules, c.n);
  const ids = rows.map((r) => r.id).sort();
  const end = c.text.length;
  const agree = same(ids, Object.keys(c.verdicts).sort()) && rows.every((r) => r.ok === c.verdicts[r.id].ok && (stateAt(r, end, true).tone === 'broken') === !r.ok);
  if (agree) rowsOk++;
  else check(`answer ${i}: book rows`, false, rows.map((r) => `${r.id}:${r.ok}/${stateAt(r, end, true).tone}`).join(' '));
  // the Ledger's labels: an item counts at its first letter, a TL;DR is paid when its label is written
  const counted = rows.find((r) => r.id === 'items')!.events.filter((e) => e.mark === 'count' || e.mark === 'over').map((e) => e.at);
  const tldr = rows.find((r) => r.id === 'tldr')?.events.filter((e) => e.mark === 'paid').map((e) => e.at) ?? [];
  if (same(counted, c.milestones.items) && same(tldr, c.milestones.tldr ?? [])) labels++;
  else check(`answer ${i}: label positions`, false, `${counted} vs ${c.milestones.items}; ${tldr} vs ${c.milestones.tldr}`);
}
check(`monitors: ${verdicts} of ${fx.answers.length} answers get Python's verdicts`, verdicts === fx.answers.length);
check(`book: ${rowsOk} of ${fx.answers.length} answers end as the verdicts say`, rowsOk === fx.answers.length);
check(`labels: ${labels} of ${fx.answers.length} answers count items and pay TL;DRs where Python does`, labels === fx.answers.length);
const broken = fx.answers.filter((c) => !Object.values(c.verdicts).every((x) => x.ok)).length;
check(`the fixtures break things: ${broken} of ${fx.answers.length}`, broken > fx.answers.length / 2);

// 2. the clerk: the same rules read from the same examples, and the same n
let read = 0;
let truth = 0;
for (const [i, c] of fx.prompts.entries()) {
  const p = splitPrompt(c.prompt);
  const answers = p.examples.map(([, a]) => a);
  const r = readRules(answers);
  const ok = same(answers, c.examples) && same(r, c.read) && p.n === c.n;
  if (ok) read++;
  else check(`prompt ${i}: the clerk`, false, `${JSON.stringify(r)} vs ${JSON.stringify(c.read)}; n ${p.n} vs ${c.n}; ${answers.length} examples`);
  if (same({ ...r, signoff: r.signoff?.toLowerCase() ?? null }, { ...c.rules, signoff: c.rules.signoff?.toLowerCase() ?? null })) truth++;
}
check(`clerk: ${read} of ${fx.prompts.length} prompts read as Python reads them`, read === fx.prompts.length);
check(`clerk: ${truth} of ${fx.prompts.length} read the author's true rules (two examples determine them)`, truth === fx.prompts.length);

// 3. pieces cover the text exactly
let covered = 0;
for (const c of fx.answers) {
  const e = pieces(c.text);
  if ((e.length === 0 && c.text === '') || (e[e.length - 1] === c.text.length && e.every((x, i) => i === 0 || x > e[i - 1]))) covered++;
}
check(`pieces: ${covered} of ${fx.answers.length} answers cut into increasing pieces that cover them`, covered === fx.answers.length);
const cut = (s: string) => pieces(s).map((e, i, a) => s.slice(i ? a[i - 1] : 0, e));
check('pieces: words with their space, markers apart, digits one by one', same(cut('(12) **Warm the pot**: rinse'), ['(', '1', '2', ')', ' **', 'Warm', ' the', ' pot', '**:', ' rinse']), cut('(12) **Warm the pot**: rinse').join('|'));

// 4. the presets say what their captions say
for (const p of PRESETS) {
  const pr = splitPrompt(p.prompt);
  const rules = readRules(pr.examples.map(([, a]) => a));
  const v = audit(p.response, rules, pr.n ?? 0);
  const bad = Object.keys(v).filter((k) => !v[k].ok).sort();
  check(`preset "${p.name}": breaks ${bad.join(', ') || 'nothing'}`, same(bad, [...p.breaks].sort()) && pr.n === p.n && coherent(v) === (p.breaks.length === 0), JSON.stringify(v));
}

console.log(failed ? `\n${failed} check(s) failed` : `\nall checks passed (${fx.answers.length} answers, ${fx.prompts.length} prompts, ${PRESETS.length} presets)`);
process.exit(failed ? 1 : 0);
