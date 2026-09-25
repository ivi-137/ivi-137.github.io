/**
 * The toy blog from research/coherence/toy.py: an author's house style, prompts
 * drawn from the same distribution as training, the monitors, and a renderer
 * that turns tokens back into something that looks like a post.
 */
import type { Manifest } from './net';

export interface Style {
  font: number;
  head: number;
  math: number;
  why: number;
  src: number;
}

export const MONITORS = ['font', 'heading', 'math', 'why', 'sources', 'order', 'length'] as const;
export type Monitor = (typeof MONITORS)[number];
export const IMPLICIT: Monitor[] = ['font', 'heading', 'math', 'why', 'sources', 'order'];

/** The prose is deliberately meaningless: only its form is under test. */
export const LEXICON = [
  'cell', 'rule', 'glider', 'row', 'signal', 'colony', 'bit', 'grid',
  'pattern', 'gun', 'state', 'step', 'noise', 'order', 'entropy', 'class',
  'proof', 'machine', 'tape', 'halts', 'grows', 'moves', 'dies', 'copies',
  'reads', 'writes', 'emerges', 'collides', 'repeats', 'slowly', 'again', 'never',
  'every', 'three', 'eight', 'alive', 'dark', 'live', 'simple', 'local',
  'global', 'green', 'colourless', 'ideas', 'sleep', 'furiously', 'the', 'of',
];
export const REFS = [
  'Vaswani et al. 2017', 'Cook 2004', 'Wolfram 1984', 'Berlekamp, Conway & Guy 1982',
  'Chomsky 1957', 'Gardner 1970', 'Pnueli 1977', 'Bauer, Leucker & Schallhart 2011',
];
export const FONT_NAMES = ['plain serif', 'display italic', 'monospace', 'small caps', 'sans', 'spaced capitals'];
export const HEAD_NAMES = ['sentence', 'CAPITALS', '§ numbered', 'underlined'];
export const MATH_OPEN = ['$', '$$', '\\('];
export const MATH_CLOSE = ['$', '$$', '\\)'];

export function rng(seed: number) {
  let s = seed >>> 0 || 1;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export class Toy {
  id: Record<string, number>;
  V: number;
  kMin: number;
  kMax: number;
  constructor(public meta: Manifest) {
    this.id = Object.fromEntries(meta.vocab.map((t, i) => [t, i]));
    this.V = meta.vocab.length;
    [this.kMin, this.kMax] = meta.k;
  }
  get EOS() { return this.id['<eos>']; }
  get NEW() { return this.id['<new>']; }
  isFont = (t: number) => this.kind(t) === 'F';
  kind(t: number): string {
    const s = this.meta.vocab[t];
    if (/^F\d$/.test(s)) return 'F';
    if (/^H\d$/.test(s)) return 'H';
    if (/^M\d\($/.test(s)) return 'MO';
    if (/^\)M\d$/.test(s)) return 'MC';
    if (/^R\d$/.test(s)) return 'R';
    if (/^w\d+$/.test(s)) return 'w';
    if (/^L\d+$/.test(s)) return 'L';
    return s;
  }
  num(t: number) {
    return Number(this.meta.vocab[t].replace(/\D/g, ''));
  }

  private pick(r: () => number, p: number[]) {
    let x = r();
    for (let i = 0; i < p.length; i++) if ((x -= p[i]) < 0) return i;
    return p.length - 1;
  }
  sampleStyle(r: () => number): Style {
    const P = this.meta.prior;
    return { font: this.pick(r, P.font), head: this.pick(r, P.head), math: this.pick(r, P.math), why: +(r() < P.why), src: +(r() < P.src) };
  }
  private words(r: () => number, n: number) {
    const w = [Math.floor(r() * 48)];
    for (let i = 1; i < n; i++) w.push(this.pick(r, this.meta.bigram[w[i - 1]]));
    return w.map((x) => this.id[`w${x}`]);
  }
  private paragraph(r: () => number, font: number, math: number, formula: boolean) {
    const body = this.words(r, 2 + Math.floor(r() * 3));
    if (formula) {
      const at = 1 + Math.floor(r() * body.length);
      body.splice(at, 0, this.id[`M${math}(`], ...this.words(r, 2), this.id[`)M${math}`]);
    }
    return [this.id[`F${font}`], ...body];
  }
  post(r: () => number, st: Style, k: number, forceFormula = false) {
    const bodyK = st.why ? k - 1 : k;
    const f = Array.from({ length: k }, () => r() < this.meta.prior.formula);
    if (forceFormula && !f.some(Boolean)) f[Math.floor(r() * k)] = true;
    const out: number[] = [];
    let i = 0;
    const intro = Math.min(bodyK, 1 + Math.floor(r() * 2));
    for (let j = 0; j < intro; j++) out.push(...this.paragraph(r, st.font, st.math, f[i++]));
    while (i < bodyK) {
      out.push(this.id['#'], this.id[`H${st.head}`], ...this.words(r, 2));
      const n = Math.min(bodyK - i, 2 + Math.floor(r() * 3));
      for (let j = 0; j < n; j++) out.push(...this.paragraph(r, st.font, st.math, f[i++]));
    }
    if (st.why) {
      out.push(this.id['#'], this.id[`H${st.head}`], this.id['WHY'], ...this.words(r, 1));
      out.push(...this.paragraph(r, st.font, st.math, f[i++]));
    }
    if (st.src) {
      const n = 1 + Math.floor(r() * 3);
      const refs = [...Array(8).keys()].sort(() => r() - 0.5).slice(0, n);
      out.push(this.id['SRC'], ...refs.map((x) => this.id[`R${x}`]));
    }
    return out;
  }
  /** A context ending at <new>: n_ex posts by the author, then a request in the default style. */
  prompt(r: () => number, st: Style, k: number, nEx = 2) {
    const seq = [this.id['<bos>']];
    for (let j = 0; j < nEx; j++) seq.push(this.id['<post>'], ...this.post(r, st, 3 + Math.floor(r() * 6), j === 0), this.id['</post>']);
    seq.push(this.id['<req>'], this.id[`L${k}`], ...this.paragraph(r, 0, 0, true), this.NEW);
    return seq;
  }

  /** The monitors, exactly as in toy.py. y excludes <new> and <eos>. */
  audit(y: number[], st: Style, k: number, ended: boolean) {
    const ok = Object.fromEntries(MONITORS.map((m) => [m, true])) as Record<Monitor, boolean>;
    const first = Object.fromEntries(MONITORS.map((m) => [m, -1])) as Record<Monitor, number>;
    const bad = new Set<number>();
    const fail = (m: Monitor, t: number) => {
      if (t < y.length) bad.add(t);
      if (ok[m]) (ok[m] = false), (first[m] = t);
    };
    let paras = 0, whyAt = -1, srcAt = -1;
    y.forEach((tok, t) => {
      const k2 = this.kind(tok);
      if (k2 === 'F') {
        paras++;
        if (this.num(tok) !== st.font) fail('font', t);
      } else if (k2 === 'H') {
        if (this.num(tok) !== st.head) fail('heading', t);
      } else if (k2 === 'MO' || k2 === 'MC') {
        if (this.num(tok) !== st.math) fail('math', t);
      } else if (k2 === 'WHY') {
        if (!st.why || whyAt >= 0) fail('why', t);
        whyAt = t;
      } else if (k2 === 'SRC') {
        if (!st.src || srcAt >= 0) fail('sources', t);
        srcAt = t;
      }
      if (srcAt >= 0 && t > srcAt && k2 !== 'R') fail('sources', t);
      if (['<post>', '</post>', '<req>', '<new>', '<bos>', '<pad>', 'L'].includes(k2)) fail('font', t);
    });
    const end = y.length;
    if (!ended) for (const m of ['why', 'sources', 'length'] as Monitor[]) fail(m, end);
    if (st.why && whyAt < 0) fail('why', end);
    if (st.src && srcAt < 0) fail('sources', end);
    if (st.why && st.src && whyAt >= 0 && srcAt >= 0 && srcAt < whyAt) fail('order', srcAt);
    if (paras !== k) fail('length', end);
    return { ok, first, paras, bad };
  }
}

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);

/** Tokens → a small post. `bad` marks token indices a monitor flagged. */
export function renderPost(toy: Toy, y: number[], bad = new Set<number>(), k?: number) {
  const out: string[] = [];
  let open: 'p' | 'h' | null = null;
  let cls = '';
  const close = () => {
    if (open === 'p') out.push('</p>');
    if (open === 'h') out.push('</h5>');
    open = null;
  };
  let hNum = 0;
  let refs: string[] = [];
  let inSrc = false;
  y.forEach((tok, i) => {
    const kind = toy.kind(tok);
    const b = bad.has(i) ? ' is-bad' : '';
    if (kind === 'F') {
      close();
      cls = `tf tf--${toy.num(tok)}`;
      out.push(`<p class="${cls}${b}">`);
      open = 'p';
    } else if (kind === '#') {
      close();
      out.push('<h5 class="th">');
      open = 'h';
    } else if (kind === 'H') {
      hNum++;
      const s = toy.num(tok);
      out.push(`<span class="th--${s}${b}" data-h="${s === 2 ? `§ ${hNum}` : ''}"></span>`);
    } else if (kind === 'WHY') {
      out.push(`<span class="tw${b}">Why the class is NP</span>`);
    } else if (kind === 'MO') {
      out.push(`<span class="tm${b}"><b>${esc(MATH_OPEN[toy.num(tok)])}</b>`);
    } else if (kind === 'MC') {
      out.push(`<b>${esc(MATH_CLOSE[toy.num(tok)])}</b></span>`);
    } else if (kind === 'w') {
      out.push(`<span>${LEXICON[toy.num(tok)]}</span> `);
    } else if (kind === 'SRC') {
      close();
      inSrc = true;
      out.push(`<hr class="tr${b}"><p class="ts${b}"><em>Further reading:</em> <span data-refs></span></p>`);
    } else if (kind === 'R') {
      refs.push(`<span class="${b}">${esc(REFS[toy.num(tok)])}</span>`);
    } else if (kind !== '<eos>') {
      out.push(`<span class="tx${b}">${esc(toy.meta.vocab[tok])}</span> `);
    }
  });
  close();
  let html = out.join('');
  if (inSrc) html = html.replace('<span data-refs></span>', refs.join('; ') || '…');
  if (k !== undefined) html = html.replace(/^/, '');
  return html;
}
