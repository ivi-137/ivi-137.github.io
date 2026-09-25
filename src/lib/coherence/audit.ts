/**
 * A ledger for this notebook: the house style, written as monitors.
 *
 * Every monitor is a small automaton that reads a draft once. Each has a type
 * from linear temporal logic over finite traces:
 *
 *   G  invariant    must hold at every point of the draft (one slip breaks it)
 *   F  eventuality  must happen somewhere before the end
 *   L  last         must happen, and nothing of its kind may follow it
 *   S  shape        a property of the front matter
 *
 * `learn` reads the published posts and records how many of them keep each
 * rule (its support), so the audit states the style of this notebook rather
 * than a style someone typed in. `audit` checks a draft against it.
 */

export type Kind = 'G' | 'F' | 'L' | 'S';
export type Verdict = 'kept' | 'broken' | 'owed';

export interface Finding {
  id: string;
  kind: Kind;
  label: string;
  verdict: Verdict;
  /** 1-based line of the first break, if any */
  line?: number;
  detail?: string;
  /** posts in the corpus that keep this rule, out of `of` */
  support: number;
  of: number;
  required: boolean;
}

interface Doc {
  front: Record<string, string>;
  body: string;
  /** body lines, with their 1-based line number in the whole file */
  lines: { n: number; text: string; code: boolean; math: boolean }[];
}

const CLASS_IDS = ['P', 'NP', 'PSPACE', 'EXP', 'RE'];

/** American spellings this notebook does not use (it writes behaviour, neighbour, normalised). */
const AMERICAN: [RegExp, string][] = [
  [/\bbehavior(s|al)?\b/i, 'behaviour'],
  [/\bcolor(s|ed|ful|less)?\b/i, 'colour'],
  [/\bneighbor(s|hood|hoods|ing)?\b/i, 'neighbour'],
  [/\bfavorite\b/i, 'favourite'],
  [/\bhonor\b/i, 'honour'],
  [/\bcenter(s|ed)?\b/i, 'centre'],
  [/\bgray\b/i, 'grey'],
  [/\bmodeling\b/i, 'modelling'],
  [/\blabeled\b/i, 'labelled'],
  [/\b(normal|recogn|organ|summar|optim|minim|maxim|general|character|real|emphas|visual|special|standard|categor|memor|synchron|parameter)iz(e|es|ed|ing|ation|ations)\b/i, '-ise'],
  [/\banalyz(e|es|ed|ing)\b/i, 'analyse'],
];

const EMOJI = /\p{Extended_Pictographic}/u;

export function parse(src: string): Doc {
  const text = src.replace(/\r\n?/g, '\n');
  const front: Record<string, string> = {};
  let offset = 0;
  const m = text.match(/^---\n([\s\S]*?)\n---\n?/);
  if (m) {
    for (const row of m[1].split('\n')) {
      const kv = row.match(/^([A-Za-z_][\w-]*):\s*(.*)$/);
      if (kv) front[kv[1]] = kv[2].trim().replace(/^["']|["']$/g, '');
    }
    offset = m[0].split('\n').length - 1;
  }
  const body = m ? text.slice(m[0].length) : text;
  let fence = false;
  let display = false;
  const lines = body.split('\n').map((t, i) => {
    const isFence = /^\s*(```|~~~)/.test(t);
    const code = fence || isFence;
    if (isFence) fence = !fence;
    // inside a $$ … $$ display block (the delimiter lines themselves included)
    const odd = !code && (t.match(/\$\$/g) ?? []).length % 2 === 1;
    const math = display || odd;
    if (odd) display = !display;
    // display maths is skipped by the prose checks, like code
    return { n: i + 1 + offset, text: t, code: code || math, math };
  });
  return { front, body, lines };
}

/** Prose only: no code, no HTML, no import lines, no $$…$$ (the allowed form of maths). */
function prose(t: string) {
  return t
    .replace(/`[^`]*`/g, ' ')
    .replace(/<[^>]*>/g, ' ')
    .replace(/\$\$[\s\S]*?\$\$/g, ' ')
    .replace(/\]\([^)]*\)/g, '] ');
}

const isImport = (t: string) => /^(import|export)\s/.test(t);
const isHeading = (t: string) => /^#{1,6}\s/.test(t);
const words = (t: string) => t.split(/\s+/).filter(Boolean);

/** Sentence case: after the first word, capitals only on names, acronyms and numbers. */
function sentenceCase(title: string) {
  const w = words(title.replace(/[:,.!?()"“”]/g, ' '));
  if (w.length < 3) return true;
  const caps = w.slice(1).filter((x) => /^[A-Z][a-z]/.test(x) && !/^(I|I'm|Conway|Wolfram|Rule|Life|Game|Turing|Gosper|Chomsky|Transformer|Transformers|Ledger|Cook|Rice|Chaitin)$/.test(x));
  return caps.length <= Math.max(1, Math.floor((w.length - 1) / 3));
}

interface Rule {
  id: string;
  kind: Kind;
  label: string;
  /** returns null when kept, else [line, detail]; 'owed' when an eventuality never happened */
  check: (d: Doc) => null | { line?: number; detail: string; owed?: boolean };
  /** always required, whatever the corpus says (the author asked for it) */
  asked?: boolean;
}

const firstLine = (d: Doc, test: (t: string) => boolean) => d.lines.find((l) => !l.code && test(l.text));

const RULES: Rule[] = [
  {
    id: 'front',
    kind: 'S',
    label: 'Front matter has title, date, description, concepts and class',
    check: (d) => {
      const miss = ['title', 'date', 'description', 'concepts', 'class'].filter((k) => !(k in d.front));
      return miss.length ? { line: 1, detail: `missing: ${miss.join(', ')}` } : null;
    },
  },
  {
    id: 'class',
    kind: 'S',
    label: 'Filed under a complexity class, not a tag',
    check: (d) => (CLASS_IDS.includes(d.front.class) ? null : { line: 1, detail: `class "${d.front.class ?? ''}" is not one of ${CLASS_IDS.join(', ')}` }),
  },
  {
    id: 'title',
    kind: 'S',
    label: 'Title in sentence case',
    check: (d) => (d.front.title && sentenceCase(d.front.title) ? null : { line: 1, detail: `"${d.front.title ?? ''}" reads as Title Case` }),
  },
  {
    id: 'dek',
    kind: 'S',
    label: 'Description: one or two sentences, ending with a full stop',
    check: (d) => {
      const s = d.front.description ?? '';
      const n = (s.match(/[.!?](\s|$)/g) ?? []).length;
      return s && /[.!?]$/.test(s) && n <= 2 ? null : { line: 1, detail: s ? `"${s.slice(0, 60)}…"` : 'no description' };
    },
  },
  {
    id: 'opening',
    kind: 'F',
    label: 'Opens with a paragraph, not a heading',
    check: (d) => {
      const first = d.lines.find((l) => l.text.trim() && !isImport(l.text) && !l.code);
      return first && !isHeading(first.text) && !/^\s*[-*>|<]/.test(first.text) ? null : { line: first?.n, detail: 'the first thing a reader meets should be prose' };
    },
  },
  {
    id: 'headings',
    kind: 'G',
    label: 'Section headings are ## or ###, in sentence case',
    check: (d) => {
      for (const l of d.lines) {
        if (l.code || !isHeading(l.text)) continue;
        const depth = l.text.match(/^#+/)![0].length;
        const t = l.text.replace(/^#+\s*/, '');
        if (depth < 2 || depth > 3) return { line: l.n, detail: `level ${depth} heading: "${t}"` };
        if (!sentenceCase(t)) return { line: l.n, detail: `"${t}" reads as Title Case` };
      }
      return null;
    },
  },
  {
    id: 'math',
    kind: 'G',
    label: 'Maths only between $$ … $$ (a single $ is a dollar sign)',
    check: (d) => {
      for (const l of d.lines) {
        if (l.code) continue;
        const t = l.text.replace(/`[^`]*`/g, ' ').replace(/<[^>]*>/g, ' ').replace(/\$\$[\s\S]*?\$\$/g, ' ');
        const single = t.match(/(?<![\\$\w])\$(?![\s\d$])([^$\n]*?[^\s$\\])\$(?!\$|\d)/);
        if (single) return { line: l.n, detail: `single-dollar maths: ${single[0]}` };
        if (/\\\(|\\\[/.test(t)) return { line: l.n, detail: 'LaTeX \\( … \\) delimiters' };
      }
      return null;
    },
  },
  {
    id: 'spelling',
    kind: 'G',
    label: 'British spelling (behaviour, neighbour, normalised)',
    check: (d) => {
      for (const l of d.lines) {
        if (l.code || isImport(l.text)) continue;
        // quotations keep their original spelling
        const t = prose(l.text).replace(/"[^"]*"|“[^”]*”/g, ' ');
        for (const [re, uk] of AMERICAN) {
          const m = t.match(re);
          if (m) return { line: l.n, detail: `"${m[0]}" (this notebook writes ${uk})` };
        }
      }
      return null;
    },
  },
  {
    id: 'dashes',
    kind: 'G',
    label: 'No em dashes: colons, commas and full stops do that work',
    check: (d) => {
      const l = firstLine(d, (t) => /—/.test(prose(t)));
      return l ? { line: l.n, detail: l.text.trim().slice(0, 70) } : null;
    },
  },
  {
    id: 'emoji',
    kind: 'G',
    label: 'No emoji',
    check: (d) => {
      const l = firstLine(d, (t) => EMOJI.test(prose(t)));
      return l ? { line: l.n, detail: l.text.trim().slice(0, 50) } : null;
    },
  },
  {
    id: 'captions',
    kind: 'G',
    label: 'Every live figure has a caption that ends with a full stop',
    check: (d) => {
      for (const l of d.lines) {
        if (l.code || !/<div\s+data-[\w-]+/.test(l.text)) continue;
        const cap = l.text.match(/data-caption="([^"]*)"/);
        if (!cap || !/[.!?]$/.test(cap[1].trim())) return { line: l.n, detail: cap ? `"${cap[1]}"` : 'no data-caption' };
      }
      return null;
    },
  },
  {
    id: 'links',
    kind: 'G',
    label: 'Links to other posts end with a slash',
    check: (d) => {
      const l = firstLine(d, (t) => /\]\(\/posts\/[^)]*[^/)#]\)/.test(t));
      return l ? { line: l.n, detail: l.text.match(/\]\(\/posts\/[^)]*\)/)![0].slice(2, -1) } : null;
    },
  },
  {
    id: 'why',
    kind: 'L',
    label: 'Last section explains the filing: “Why the class is X”, with X the class',
    check: (d) => {
      const heads = d.lines.filter((l) => !l.code && /^##\s/.test(l.text));
      const why = heads.filter((l) => /^##\s+Why the class is\b/i.test(l.text));
      if (!why.length) return { detail: 'never explains why the post is filed where it is', owed: true };
      const at = why[why.length - 1];
      const cls = at.text.match(/Why the class is\s+\**([A-Z]+)/i)?.[1];
      if (cls && d.front.class && cls.toUpperCase() !== d.front.class.toUpperCase()) return { line: at.n, detail: `says ${cls}, filed as ${d.front.class}` };
      if (heads[heads.length - 1] !== at) return { line: heads[heads.length - 1].n, detail: `“${heads[heads.length - 1].text.slice(3)}” comes after it` };
      return null;
    },
  },
  {
    id: 'sources',
    kind: 'L',
    label: 'Ends with a rule and *Further reading:* (sources come last)',
    asked: true,
    check: (d) => {
      const idx = d.lines.findIndex((l) => !l.code && /^\*Further reading:?\*/.test(l.text.trim()));
      if (idx < 0) return { detail: 'no sources at the end', owed: true };
      const before = d.lines.slice(0, idx).reverse().find((l) => l.text.trim());
      if (!before || before.text.trim() !== '---') return { line: d.lines[idx].n, detail: 'not set off by a --- rule' };
      const after = d.lines.slice(idx + 1).find((l) => l.text.trim() && (isHeading(l.text) || /^<div\s/.test(l.text) || /^---$/.test(l.text.trim())));
      return after ? { line: after.n, detail: 'something other than sources follows them' } : null;
    },
  },
];

export interface Style {
  of: number;
  support: Record<string, number>;
}

/** Read the published posts and count how many keep each rule. */
export function learn(sources: string[]): Style {
  const support: Record<string, number> = {};
  for (const r of RULES) support[r.id] = 0;
  for (const s of sources) {
    const d = parse(s);
    for (const r of RULES) if (!r.check(d)) support[r.id]++;
  }
  return { of: sources.length, support };
}

/** A rule is owed when at least two thirds of the posts keep it, or when the author asked for it. */
export function audit(src: string, style: Style): Finding[] {
  const d = parse(src);
  return RULES.map((r) => {
    const res = r.check(d);
    const support = style.support[r.id] ?? 0;
    return {
      id: r.id,
      kind: r.kind,
      label: r.label,
      verdict: !res ? 'kept' : res.owed ? 'owed' : 'broken',
      line: res?.line,
      detail: res?.detail,
      support,
      of: style.of,
      required: !!r.asked || support * 3 >= style.of * 2,
    } satisfies Finding;
  });
}

export const coherent = (f: Finding[]) => f.every((x) => !x.required || x.verdict === 'kept');
