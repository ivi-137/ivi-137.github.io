/**
 * The clerk's book for the house-pattern study, in the browser.
 *
 * A port of research/ledger-smollm/patterns.py: the clerk that reads the house
 * pattern off two example answers (`readRules`), the monitors that audit an
 * answer (`audit`, identical verdicts), and, for the view, every monitor's
 * history over the answer (`book`): where each obligation was owed, paid,
 * counted or broken, as character positions. Monitors judge complete lines,
 * except where the Python labels do otherwise: a TL;DR is paid when its label
 * is written, an item counts once its marker and first letter are.
 *
 * scripts/check-book.mts checks parity with the Python on fixtures it wrote.
 */

export const MARKERS = ['1.', '1)', '(1)', '#1', '-', '*', '•', '→'];
export const NUMBERED = 4;
export const TLDR_LABELS = ['TL;DR:', 'In short:', 'Summary:', 'The gist:'];
export const SOURCE_HEADERS = ['Sources:', 'Further reading:', 'References:'];
const WORDS = 'zero one two three four five six seven eight nine ten eleven twelve thirteen fourteen fifteen sixteen seventeen eighteen nineteen twenty'.split(' ');

export interface Rules {
  marker: number;
  bold: number;
  lowercase: number;
  tldr: string | null;
  sources: string | null;
  signoff: string | null;
}

export interface Verdict {
  ok: boolean;
  break_at?: number | null;
  opportunities?: number;
  found?: number;
}

const ITEM = /^\s*(?:(\d+)\.|(\d+)\)|\((\d+)\)|#(\d+)|([-*•→]))[ \t]+(\S.*)$/;
const SOURCE = /^\s*\[\d+\]\s+\S/;
const UPPER = /[A-Z]/;

/** [style, number or null, text] if the line is a list item. */
export function parseItem(line: string): [number, number | null, string] | null {
  const m = ITEM.exec(line);
  if (!m) return null;
  for (let g = 0; g < 4; g++) if (m[g + 1] !== undefined) return [g, Number(m[g + 1]), m[6]];
  return [4 + '-*•→'.indexOf(m[5]), null, m[6]];
}

/** Where an item's text starts in the line (Python's m.start(6)). */
const itemTextAt = (line: string) => {
  const m = ITEM.exec(line);
  return m ? line.length - m[6].length : -1;
};

const pyStrip = (s: string) => s.replace(/^\s+|\s+$/g, '');
const cased = (s: string | null, r: Rules) => (s === null ? null : r.lowercase ? s.toLowerCase() : s);
const isBold = (body: string) => body.startsWith('**') && body.slice(2).includes('**');

type Kind = 'item' | 'tldr' | 'sources' | 'source' | 'signoff' | 'prose';
interface Line {
  text: string;
  /** character offsets of the raw line in the answer */
  start: number;
  end: number;
  kind: Kind;
}

function lines(text: string, r: Rules): Line[] {
  const tl = cased(r.tldr, r);
  const sh = cased(r.sources, r);
  const so = cased(r.signoff, r);
  const out: Line[] = [];
  let at = 0;
  for (const l of text.split('\n')) {
    const s = pyStrip(l);
    if (s) {
      const kind: Kind = tl && s.startsWith(tl) ? 'tldr' : sh && s === sh ? 'sources' : so && s === so ? 'signoff' : SOURCE.test(s) ? 'source' : parseItem(s) ? 'item' : 'prose';
      out.push({ text: l, start: at, end: at + l.length, kind });
    }
    at += l.length + 1;
  }
  return out;
}

/** The monitors' verdicts: the same dictionary as patterns.audit. */
export function audit(text: string, r: Rules, n: number): Record<string, Verdict> {
  const ls = lines(text, r);
  const kinds = ls.map((l) => l.kind);
  const items = ls.filter((l) => l.kind === 'item').map((l) => parseItem(pyStrip(l.text))!);
  const out: Record<string, Verdict> = {};
  let brk = items.findIndex(([st, num], j) => st !== r.marker || (st < NUMBERED && num !== j + 1));
  out.marker = { ok: brk < 0, break_at: brk < 0 ? null : brk, opportunities: items.length };
  brk = items.findIndex(([, , body]) => isBold(body) !== Boolean(r.bold));
  out.bold = { ok: brk < 0, break_at: brk < 0 ? null : brk, opportunities: items.length };
  if (r.lowercase) {
    brk = ls.findIndex((l) => UPPER.test(l.text));
    out.lowercase = { ok: brk < 0, break_at: brk < 0 ? null : brk, opportunities: ls.length };
  }
  const lastItem = kinds.lastIndexOf('item');
  if (r.tldr) {
    const at = kinds.indexOf('tldr');
    out.tldr = { ok: at >= 0 };
    out.tldr_first = { ok: at === 0 };
  }
  if (r.sources) {
    const at = kinds.indexOf('sources');
    const after = at >= 0 ? kinds.slice(at + 1) : [];
    out.sources = { ok: at >= 0 && after.includes('source') };
    out.sources_after = { ok: at >= 0 && at > lastItem };
    out.sources_only = { ok: at >= 0 && after.every((k) => k === 'source' || k === 'signoff') };
  }
  if (r.signoff) {
    const at = kinds.indexOf('signoff');
    out.signoff = { ok: at >= 0 };
    out.signoff_last = { ok: at >= 0 && at === kinds.length - 1 };
  }
  out.items = { ok: items.length === n, found: items.length };
  return out;
}

export const coherent = (v: Record<string, Verdict>) => Object.values(v).every((x) => x.ok);

// ── the clerk: the pattern as two examples show it ─────────────────────

/** patterns.read_rules: majority counts over the example answers. */
export function readRules(answers: string[]): Rules {
  const items = answers.flatMap((a) => a.split('\n').map((l) => parseItem(pyStrip(l))).filter((x): x is [number, number | null, string] => x !== null));
  const styles = items.map(([st]) => st);
  let marker = 0;
  let best = -1;
  for (let s = 0; s < MARKERS.length; s++) {
    const c = styles.filter((x) => x === s).length;
    if (c > best && c > 0) [marker, best] = [s, c];
  }
  const bolds = items.filter(([, , b]) => b.startsWith('**')).length;
  const firsts = answers.map((a) => pyStrip(a.split('\n')[0]));
  const lasts = answers.map((a) => {
    const ne = a.split('\n').map(pyStrip).filter(Boolean);
    return ne.length ? ne[ne.length - 1] : '';
  });
  const tldr = TLDR_LABELS.find((lab) => firsts.every((f) => f.toLowerCase().startsWith(lab.toLowerCase()))) ?? null;
  const heads = SOURCE_HEADERS.filter((h) => answers.every((a) => a.split('\n').some((l) => pyStrip(l).toLowerCase() === h.toLowerCase())));
  const lower = answers.every((a) => !UPPER.test(a));
  const same = lasts.every((x) => x === lasts[0]);
  const signoff = answers.length && same && lasts[0] && !parseItem(lasts[0]) && !SOURCE.test(lasts[0]) ? lasts[0] : null;
  return { marker, bold: bolds * 2 > items.length ? 1 : 0, lowercase: lower ? 1 : 0, tldr, sources: heads[0] ?? null, signoff };
}

/** Numbers written in the text, in digits or as words up to twenty, in order (shapes.numbers). */
export function numbers(text: string): { start: number; end: number; value: number }[] {
  const out: { start: number; end: number; value: number }[] = [];
  for (const m of text.matchAll(/\d+/g)) out.push({ start: m.index!, end: m.index! + m[0].length, value: Number(m[0]) });
  for (const m of text.matchAll(new RegExp(`\\b(${WORDS.join('|')})\\b`, 'gi'))) out.push({ start: m.index!, end: m.index! + m[0].length, value: WORDS.indexOf(m[0].toLowerCase()) });
  return out.sort((a, b) => a.start - b.start || a.end - b.end);
}

export interface Prompt {
  /** [question, answer] for every answered question */
  examples: [string, string][];
  /** the last question, if it has no answer yet */
  question: string | null;
  /** the number of items it asks for */
  n: number | null;
}

/** A prompt in the study's layout: answered questions, then a new one (background notes may sit before it). */
export function splitPrompt(prompt: string): Prompt {
  const text = prompt.replace(/\r\n?/g, '\n');
  const qs = [...text.matchAll(/^Question:[ \t]*(.*)$/gm)];
  const blocks = qs.map((m, i) => {
    const from = m.index! + m[0].length;
    const to = i + 1 < qs.length ? qs[i + 1].index! : text.length;
    let body = text.slice(from, to).replace(/^\s*\n?Answer:[ \t]*\n?/, '');
    const bg = body.indexOf('\nBackground notes (not part of the column):');
    if (bg >= 0) body = body.slice(0, bg);
    return [pyStrip(m[1]), body.replace(/^\n+|\s+$/g, '')] as [string, string];
  });
  const last = blocks[blocks.length - 1];
  const open = last && !last[1];
  const question = open ? last[0] : null;
  const n = question ? (numbers(question)[0]?.value ?? null) : null;
  return { examples: open ? blocks.slice(0, -1) : blocks, question, n };
}

// ── pieces: roughly tokens ─────────────────────────────────────────────

/**
 * End offsets of the answer's pieces, cut the way byte-level BPE tokenisers
 * cut text before merging (GPT-2's pattern, digits one by one as in SmolLM2).
 * A long word may be two or three real tokens; markers and punctuation agree.
 */
export function pieces(text: string): number[] {
  const re = /'(?:s|t|re|ve|m|ll|d)| ?\p{L}+| ?\p{N}| ?[^\s\p{L}\p{N}]+|\s+(?!\S)|\s+/gu;
  const ends: number[] = [];
  for (const m of text.matchAll(re)) ends.push(m.index! + m[0].length);
  return ends;
}

/** Index of the piece that holds character position p (the first whose end reaches it). */
export function pieceAt(ends: number[], p: number) {
  let lo = 0;
  let hi = ends.length - 1;
  if (hi < 0) return 0;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (ends[mid] >= p) hi = mid;
    else lo = mid + 1;
  }
  return lo;
}

// ── the book: every monitor's history over the answer ──────────────────

export type Shape = 'G' | 'F' | 'O' | 'L' | 'N';
export type Mark = 'tick' | 'break' | 'paid' | 'unpaid' | 'count' | 'over' | 'short';
export interface Event {
  /** character position in the answer (a prefix length) */
  at: number;
  mark: Mark;
  /** the running count, for count events */
  k?: number;
  /** where the line that broke a rule starts */
  from?: number;
  /** a tick that settles the rule for good */
  final?: boolean;
}
export interface Row {
  id: string;
  shape: Shape;
  label: string;
  events: Event[];
  ok: boolean;
  /** the obligation as the clerk wrote it down */
  owes: string;
  /** the target, for the count */
  n?: number;
}

export const SHAPE_NAME: Record<Shape, string> = { G: 'always', F: 'eventually', O: 'before', L: 'last', N: 'count' };

const quote = (s: string) => `“${s}”`;

export function book(text: string, r: Rules, n: number): Row[] {
  const ls = lines(text, r);
  const end = text.length;
  const rows: Row[] = [];
  const itemLines = ls.filter((l) => l.kind === 'item');
  const items = itemLines.map((l) => parseItem(pyStrip(l.text))!);

  // invariants, one opportunity per item line (lowercase: per non-empty line)
  const invariant = (id: string, label: string, owes: string, opp: Line[], bad: (j: number) => boolean) => {
    const events: Event[] = [];
    let ok = true;
    for (let j = 0; j < opp.length; j++) {
      if (bad(j)) {
        events.push({ at: opp[j].end, mark: 'break', from: opp[j].start });
        ok = false;
        break;
      }
      events.push({ at: opp[j].end, mark: 'tick' });
    }
    rows.push({ id, shape: 'G', label, events, ok, owes });
  };
  const sample = MARKERS[r.marker];
  invariant('marker', 'marker', r.marker < NUMBERED ? `${sample.replace('1', 'n')}, counting 1, 2, 3…` : quote(sample), itemLines, (j) => items[j][0] !== r.marker || (items[j][0] < NUMBERED && items[j][1] !== j + 1));
  invariant('bold', r.bold ? 'bold leads' : 'plain leads', r.bold ? '**lead**: text' : 'lead: text', itemLines, (j) => isBold(items[j][2]) !== Boolean(r.bold));
  if (r.lowercase) invariant('lowercase', 'lowercase', 'no capital letter', ls, (j) => UPPER.test(ls[j].text));

  const after = (l: Line) => ls.slice(ls.indexOf(l) + 1);
  if (r.tldr) {
    const tl = cased(r.tldr, r)!;
    const first = ls.find((l) => l.kind === 'tldr');
    rows.push({ id: 'tldr', shape: 'F', label: 'TL;DR', owes: quote(tl), ok: !!first, events: [first ? { at: first.start + first.text.indexOf(tl) + tl.length, mark: 'paid' } : { at: end, mark: 'unpaid' }] });
    const head = ls[0];
    rows.push({ id: 'tldr_first', shape: 'O', label: 'TL;DR first', owes: 'before anything else', ok: !!head && head.kind === 'tldr',
      events: [head ? (head.kind === 'tldr' ? { at: head.end, mark: 'tick', final: true } : { at: head.end, mark: 'break', from: head.start }) : { at: end, mark: 'unpaid' }] });
  }
  if (r.sources) {
    const header = ls.find((l) => l.kind === 'sources');
    const rest = header ? after(header) : [];
    const src = rest.find((l) => l.kind === 'source');
    rows.push({ id: 'sources', shape: 'F', label: 'sources', owes: `${quote(cased(r.sources, r)!)} and a source`, ok: !!src, events: [src ? { at: src.end, mark: 'paid' } : { at: end, mark: 'unpaid' }] });
    const late = rest.find((l) => l.kind === 'item');
    rows.push({ id: 'sources_after', shape: 'O', label: 'sources after', owes: 'no item after the header', ok: !!header && !late,
      events: !header ? [{ at: end, mark: 'unpaid' }] : late ? [{ at: header.end, mark: 'tick' }, { at: late.end, mark: 'break', from: late.start }] : [{ at: header.end, mark: 'tick' }] });
    const stray = rest.find((l) => l.kind !== 'source' && l.kind !== 'signoff');
    rows.push({ id: 'sources_only', shape: 'L', label: 'sources only', owes: 'after the header: sources, the sign-off', ok: !!header && !stray,
      events: !header ? [{ at: end, mark: 'unpaid' }] : stray ? [{ at: header.end, mark: 'tick' }, { at: stray.end, mark: 'break', from: stray.start }] : [{ at: header.end, mark: 'tick' }] });
  }
  if (r.signoff) {
    const so = ls.find((l) => l.kind === 'signoff');
    rows.push({ id: 'signoff', shape: 'F', label: 'sign-off', owes: quote(cased(r.signoff, r)!), ok: !!so, events: [so ? { at: so.end, mark: 'paid' } : { at: end, mark: 'unpaid' }] });
    const next = so ? after(so)[0] : undefined;
    rows.push({ id: 'signoff_last', shape: 'L', label: 'sign-off last', owes: 'nothing after it', ok: !!so && !next,
      events: !so ? [{ at: end, mark: 'unpaid' }] : next ? [{ at: so.end, mark: 'tick' }, { at: next.end, mark: 'break', from: next.start }] : [{ at: so.end, mark: 'tick' }] });
  }
  const events: Event[] = itemLines.map((l, j) => (j < n ? { at: l.start + itemTextAt(l.text) + 1, mark: 'count', k: j + 1 } : { at: l.start + itemTextAt(l.text) + 1, mark: 'over', k: j + 1, from: l.start }));
  if (itemLines.length < n) events.push({ at: end, mark: 'short', k: itemLines.length });
  rows.push({ id: 'items', shape: 'N', label: 'items', owes: `exactly ${n}`, ok: itemLines.length === n, events, n });
  return rows;
}

const BAD = new Set<Mark>(['break', 'over', 'unpaid', 'short']);

/** What the clerk's book says about a row once the first `upto` characters are written (`done`: the answer ended there). */
export function stateAt(row: Row, upto: number, done: boolean): { tone: 'quiet' | 'owed' | 'kept' | 'broken'; text: string } {
  const seen = row.events.filter((e) => e.at <= upto);
  const bad = seen.find((e) => BAD.has(e.mark));
  if (bad) {
    if (bad.mark === 'over') return { tone: 'broken', text: `item ${bad.k}: too many` };
    if (bad.mark === 'short') return { tone: 'broken', text: `ended at ${bad.k} of ${row.n}` };
    if (bad.mark === 'unpaid') return { tone: 'broken', text: row.shape === 'F' ? 'never paid' : 'never came' };
    return { tone: 'broken', text: row.shape === 'G' ? `broke at ${row.id === 'lowercase' ? 'line' : 'item'} ${seen.length}` : 'broken' };
  }
  const last = seen[seen.length - 1];
  switch (row.shape) {
    case 'N':
      return { tone: done && row.ok ? 'kept' : 'owed', text: `${last?.k ?? 0} of ${row.n}` };
    case 'F':
      return last ? { tone: 'kept', text: 'paid' } : { tone: 'owed', text: 'owed' };
    case 'G':
      return last ? { tone: 'kept', text: `kept ${seen.length}×` } : { tone: 'quiet', text: '·' };
    default:
      return last ? (done || last.final ? { tone: 'kept', text: 'kept' } : { tone: 'owed', text: 'kept so far' }) : { tone: 'owed', text: 'waiting' };
  }
}
