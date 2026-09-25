/**
 * The toy transformer from research/coherence/model.py, run token by token in
 * the browser with a key/value cache. Same arithmetic as the JAX version:
 * pre-LN blocks, rotary positions, tanh-GELU, tied embeddings; and, for the
 * Ledger variant, the clerk, the typed accumulators, the separate-softmax read
 * and the <eos> gate.
 */

export interface Manifest {
  cfg: { variant: string; V: number; d: number; L: number; H: number; dff: number; K: number; clerk_layer: number };
  tensors: { name: string; shape: number[]; offset: number }[];
  vocab: string[];
  bigram: number[][];
  prior: { font: number[]; head: number[]; math: number[]; why: number; src: number; formula: number };
  k: [number, number];
  n_params: number;
}

type T = { data: Float32Array; shape: number[] };

const INVARIANT = 0, EVENT = 1, COUNT = 2;
export const SLOT_TYPE = [INVARIANT, INVARIANT, INVARIANT, EVENT, EVENT, COUNT, EVENT, EVENT];
export const SLOT_NAME = ['font', 'heading', 'maths', 'why', 'sources', 'length', 'free', 'free'];

function half(bits: number) {
  const s = bits & 0x8000 ? -1 : 1;
  const e = (bits >> 10) & 0x1f;
  const f = bits & 0x3ff;
  if (e === 0) return s * 2 ** -14 * (f / 1024);
  if (e === 31) return f ? NaN : s * Infinity;
  return s * 2 ** (e - 15) * (1 + f / 1024);
}

export async function loadNet(base: string, name: string): Promise<Net> {
  const [meta, buf] = await Promise.all([
    fetch(`${base}/${name}.json`).then((r) => r.json() as Promise<Manifest>),
    fetch(`${base}/${name}.bin`).then((r) => r.arrayBuffer()),
  ]);
  return netFrom(meta, buf);
}

export function netFrom(meta: Manifest, buf: ArrayBuffer): Net {
  const u16 = new Uint16Array(buf);
  const w: Record<string, T> = {};
  for (const t of meta.tensors) {
    const n = t.shape.reduce((a, b) => a * b, 1);
    const data = new Float32Array(n);
    for (let i = 0; i < n; i++) data[i] = half(u16[t.offset + i]);
    w[t.name] = { data, shape: t.shape };
  }
  return new Net(meta, w);
}

// ── small linear algebra on Float32Array ──

/** y = x · W, W stored row-major (in × out) */
function matvec(x: Float32Array, W: T, y = new Float32Array(W.shape[1])) {
  const [n, m] = W.shape;
  const w = W.data;
  y.fill(0);
  for (let i = 0; i < n; i++) {
    const xi = x[i];
    if (xi === 0) continue;
    const row = i * m;
    for (let j = 0; j < m; j++) y[j] += xi * w[row + j];
  }
  return y;
}

function layerNorm(x: Float32Array, g: T, b: T) {
  const n = x.length;
  let m = 0;
  for (let i = 0; i < n; i++) m += x[i];
  m /= n;
  let v = 0;
  for (let i = 0; i < n; i++) v += (x[i] - m) ** 2;
  v /= n;
  const s = 1 / Math.sqrt(v + 1e-5);
  const y = new Float32Array(n);
  for (let i = 0; i < n; i++) y[i] = (x[i] - m) * s * g.data[i] + b.data[i];
  return y;
}

const gelu = (x: number) => 0.5 * x * (1 + Math.tanh(0.7978845608 * (x + 0.044715 * x * x * x)));
const sigmoid = (x: number) => 1 / (1 + Math.exp(-x));

function softmaxInPlace(a: Float32Array | number[], n = a.length) {
  let mx = -Infinity;
  for (let i = 0; i < n; i++) mx = Math.max(mx, a[i]);
  let s = 0;
  for (let i = 0; i < n; i++) s += a[i] = Math.exp(a[i] - mx);
  for (let i = 0; i < n; i++) a[i] /= s;
  return a;
}

function rope(v: Float32Array, H: number, pos: number) {
  const dh = v.length / H;
  const hf = dh / 2;
  for (let h = 0; h < H; h++) {
    const o = h * dh;
    for (let j = 0; j < hf; j++) {
      const ang = pos / 10000 ** (j / hf);
      const c = Math.cos(ang), s = Math.sin(ang);
      const x1 = v[o + j], x2 = v[o + hf + j];
      v[o + j] = x1 * c - x2 * s;
      v[o + hf + j] = x1 * s + x2 * c;
    }
  }
}

export interface LedgerView {
  /** what the clerk extracted: argmax and confidence per supervised slot */
  read: { font: number; head: number; math: number; why: number; src: number; k: number };
  /** paid 0..1 per slot, at the last token */
  u: number[];
  /** pending 0..1 per slot, at the last token */
  pend: number[];
  /** multiplicative factor the gate applies to p(<eos>) (≤ 1) */
  eosFactor: number;
  /** attention the last token paid to each slot, averaged over heads and read layers */
  attn: number[];
}

export class Net {
  cfg: Manifest['cfg'];
  meta: Manifest;
  ledger: boolean;
  private w: Record<string, T>;
  private kc: Float32Array[][] = [];
  private vc: Float32Array[][] = [];
  private h1: Float32Array[] = [];
  private pos = 0;
  private g = -1;
  // ledger state
  private o: Float32Array[] = [];
  private req: number[] = [];
  private kHat = 0;
  private logNot: number[] = [];
  private count: number[] = [];
  /** per slot: (paid, pending, required), the three numbers the state adds to o_i */
  private slots: number[][] | null = null;
  /** per read layer: o_i · W_kv for every slot (once per prompt), and W_s · W_kv (once) */
  private kvO: Float32Array[][] = [];
  private kvS: Float32Array[] = [];
  view: LedgerView | null = null;
  /** gauge fixing: the output alphabet is one member per style family */
  gauged: boolean;
  /** written tokens may not attend to the example posts */
  evicts: boolean;
  private hidden: number[] = [];
  private exFrom = 0;
  private exTo = 0;
  /** keys each written token attended to, summed over written tokens */
  keysSeen = 0;

  constructor(meta: Manifest, w: Record<string, T>) {
    this.meta = meta;
    this.cfg = meta.cfg;
    this.w = w;
    this.ledger = meta.cfg.variant.startsWith('ledger');
    this.gauged = meta.cfg.variant.includes('frame');
    this.evicts = meta.cfg.variant.endsWith('evict');
    const ids = Object.fromEntries(meta.vocab.map((t, i) => [t, i]));
    this.hidden = meta.vocab.filter((t) => /^(F[1-9]|H[1-9]|M[1-9]\(|\)M[1-9])$/.test(t)).map((t) => ids[t]);
  }

  /** Positions [from, to) hold the example posts (only matters for a model that evicts them). */
  examples(from: number, to: number) {
    this.exFrom = from;
    this.exTo = to;
  }

  private t(name: string) {
    const x = this.w[name];
    if (!x) throw new Error(`missing tensor ${name}`);
    return x;
  }

  reset() {
    const { L } = this.cfg;
    this.kc = Array.from({ length: L }, () => []);
    this.vc = Array.from({ length: L }, () => []);
    this.h1 = [];
    this.pos = 0;
    this.g = -1;
    this.slots = null;
    this.o = [];
    this.view = null;
    this.keysSeen = 0;
  }

  /** Feed one token. `gen` marks the first written position (<new>) and everything after it. */
  step(tok: number, gen: boolean): Float32Array {
    const { d, H, L, V, clerk_layer: cl } = this.cfg;
    const dh = d / H;
    const t = this.pos++;
    if (gen && this.g < 0) this.g = t;
    let x = new Float32Array(this.t('emb').data.subarray(tok * d, tok * d + d));
    const attnSlots = new Array(this.cfg.K).fill(0);
    let reads = 0;
    for (let l = 0; l < L; l++) {
      const P = (n: string) => this.t(`layers.${l}.${n}`);
      const a = layerNorm(x, P('ln1.g'), P('ln1.b'));
      const qkv = matvec(a, P('wqkv'));
      const q = qkv.slice(0, d), k = qkv.slice(d, 2 * d), v = qkv.slice(2 * d);
      rope(q, H, t);
      rope(k, H, t);
      this.kc[l].push(k);
      this.vc[l].push(v);
      const out = new Float32Array(d);
      const sc = new Float32Array(t + 1);
      // an evicting model's written tokens never see the example posts: their keys can be gone
      const skip = gen && this.evicts;
      if (l === 0 && gen) this.keysSeen += t + 1 - (skip ? this.exTo - this.exFrom : 0);
      for (let h = 0; h < H; h++) {
        const o = h * dh;
        for (let s = 0; s <= t; s++) {
          if (skip && s >= this.exFrom && s < this.exTo) {
            sc[s] = -Infinity;
            continue;
          }
          const ks = this.kc[l][s];
          let dot = 0;
          for (let j = 0; j < dh; j++) dot += q[o + j] * ks[o + j];
          sc[s] = dot / Math.sqrt(dh);
        }
        softmaxInPlace(sc, t + 1);
        for (let s = 0; s <= t; s++) {
          const vs = this.vc[l][s], p = sc[s];
          for (let j = 0; j < dh; j++) out[o + j] += p * vs[o + j];
        }
      }
      const proj = matvec(out, P('wo'));
      for (let i = 0; i < d; i++) x[i] += proj[i];
      if (this.ledger && this.slots && l >= cl) {
        const R = (n: string) => this.t(`ledger.read.${l - cl}.${n}`);
        const r = this.read(l - cl, layerNorm(x, R('ln.g'), R('ln.b')), R('wq'), R('wo'), attnSlots);
        reads++;
        const gate = Math.tanh(R('g').data[0]);
        for (let i = 0; i < d; i++) x[i] += gate * r[i];
      }
      const m = layerNorm(x, P('ln2.g'), P('ln2.b'));
      const hid = matvec(m, P('w1'));
      const b1 = P('b1').data;
      for (let i = 0; i < hid.length; i++) hid[i] = gelu(hid[i] + b1[i]);
      const y = matvec(hid, P('w2'));
      const b2 = P('b2').data;
      for (let i = 0; i < d; i++) x[i] += y[i] + b2[i];
      if (l === cl - 1 && this.ledger) {
        this.h1.push(x.slice());
        if (gen) {
          if (this.slots === null) this.clerk();
          this.status(x);
        }
      }
    }
    const f = layerNorm(x, this.t('lnf.g'), this.t('lnf.b'));
    const E = this.t('emb').data;
    const logits = new Float32Array(V);
    for (let tkn = 0; tkn < V; tkn++) {
      let s = 0;
      const row = tkn * d;
      for (let i = 0; i < d; i++) s += f[i] * E[row + i];
      logits[tkn] = s;
    }
    if (this.gauged) for (const v of this.hidden) logits[v] = -1e9;
    if (this.ledger && this.slots && this.view) {
      const gamma = this.t('ledger.gamma').data[0];
      let gate = 0;
      for (let i = 3; i < 6; i++) gate += Math.log1p(-this.view.pend[i] * 0.999);
      logits[2] += gamma * gate;
      this.view.eosFactor = Math.exp(gamma * gate);
      if (reads) this.view.attn = attnSlots.map((a) => a / (reads * H));
    }
    return logits;
  }

  /**
   * The read. A slot's state is o_i + f_i · W_s with f_i three numbers, so its keys and values are
   * o_i · W_kv (precomputed) + f_i · (W_s · W_kv) (precomputed): O(Kd) per token, nothing in n.
   */
  private read(r: number, x: Float32Array, wq: T, wo: T, acc: number[]) {
    const { d, H, K } = this.cfg;
    const dh = d / H;
    const q = matvec(x, wq);
    const S = this.kvS[r];
    const kv = this.slots!.map((f, i) => {
      const v = this.kvO[r][i].slice();
      for (let k = 0; k < 3; k++) for (let j = 0; j < 2 * d; j++) v[j] += f[k] * S[k * 2 * d + j];
      return v;
    });
    const out = new Float32Array(d);
    const a = new Float32Array(K);
    for (let h = 0; h < H; h++) {
      const o = h * dh;
      for (let i = 0; i < K; i++) {
        let dot = 0;
        for (let j = 0; j < dh; j++) dot += q[o + j] * kv[i][o + j];
        a[i] = dot / Math.sqrt(dh);
      }
      softmaxInPlace(a);
      for (let i = 0; i < K; i++) {
        acc[i] += a[i];
        for (let j = 0; j < dh; j++) out[o + j] += a[i] * kv[i][d + o + j];
      }
    }
    return matvec(out, wo);
  }

  /** K learned queries read the prompt once. */
  private clerk() {
    const { d, H, K } = this.cfg;
    const dh = d / H;
    const lnG = this.t('ledger.ln_c.g'), lnB = this.t('ledger.ln_c.b');
    const wkv = this.t('ledger.wkv');
    const prompt = this.h1.slice(0, this.g);
    const kv = prompt.map((h) => matvec(layerNorm(h, lnG, lnB), wkv));
    const Q = this.t('ledger.q').data;
    const slot = this.t('ledger.slot').data;
    this.o = [];
    for (let i = 0; i < K; i++) {
      const cat = new Float32Array(d);
      for (let h = 0; h < H; h++) {
        const o = h * dh;
        const sc = new Float32Array(prompt.length);
        for (let s = 0; s < prompt.length; s++) {
          let dot = 0;
          for (let j = 0; j < dh; j++) dot += Q[i * d + o + j] * kv[s][o + j];
          sc[s] = dot / Math.sqrt(dh);
        }
        softmaxInPlace(sc);
        for (let s = 0; s < prompt.length; s++) for (let j = 0; j < dh; j++) cat[o + j] += sc[s] * kv[s][d + o + j];
      }
      const oi = matvec(cat, this.t('ledger.wo'));
      for (let j = 0; j < d; j++) oi[j] += slot[i * d + j];
      this.o.push(layerNorm(oi, this.t('ledger.ln_o.g'), this.t('ledger.ln_o.b')));
    }
    // keys and values of every slot's fixed part, and of the three-number correction, per read layer
    const reads = this.cfg.L - this.cfg.clerk_layer;
    this.kvO = [];
    this.kvS = [];
    for (let r = 0; r < reads; r++) {
      const wkv = this.t(`ledger.read.${r}.wkv`);
      this.kvO.push(this.o.map((o) => matvec(o, wkv)));
      const ws = this.t('ledger.ws');
      const rows = new Float32Array(3 * 2 * d);
      for (let k = 0; k < 3; k++) rows.set(matvec(ws.data.subarray(k * d, (k + 1) * d) as Float32Array, wkv), k * 2 * d);
      this.kvS.push(rows);
    }
    const pr = [0, 1, 2, 3, 4, 5].map((i) => Array.from(softmaxInPlace(matvec(this.o[i], this.t(`ledger.ext.${i}`)))));
    const [kMin] = this.meta.k;
    this.kHat = pr[5].reduce((s, p, j) => s + p * (j + kMin), 0);
    this.req = new Array(K).fill(1);
    this.req[3] = pr[3][1];
    this.req[4] = pr[4][1];
    this.logNot = new Array(K).fill(0);
    this.count = new Array(K).fill(0);
    const arg = (p: number[]) => p.indexOf(Math.max(...p));
    this.view = {
      read: { font: arg(pr[0]), head: arg(pr[1]), math: arg(pr[2]), why: pr[3][1], src: pr[4][1], k: arg(pr[5]) + kMin },
      u: new Array(K).fill(0),
      pend: new Array(K).fill(0),
      eosFactor: 1,
      attn: new Array(K).fill(0),
    };
  }

  /** Typed accumulators, advanced by the token just read. */
  private status(h: Float32Array) {
    const { d, K } = this.cfg;
    const hz = matvec(layerNorm(h, this.t('ledger.ln_c.g'), this.t('ledger.ln_c.b')), this.t('ledger.wz_h'));
    const bz = this.t('ledger.bz').data;
    const u: number[] = [], pend: number[] = [];
    this.slots = [];
    for (let i = 0; i < K; i++) {
      const oz = matvec(this.o[i], this.t('ledger.wz_o'));
      let z = 0;
      for (let j = 0; j < d; j++) z += hz[j] * oz[j];
      const e = sigmoid(z / Math.sqrt(d) + bz[i]);
      this.logNot[i] += Math.log1p(-e * 0.999);
      this.count[i] += e;
      const ty = SLOT_TYPE[i];
      const ui = ty === EVENT ? 1 - Math.exp(this.logNot[i]) : ty === COUNT ? sigmoid(4 * (this.count[i] - this.kHat + 0.5)) : 0;
      const pi = ty === INVARIANT ? 0 : this.req[i] * (1 - ui);
      u.push(ui);
      pend.push(pi);
      this.slots.push([ui, pi, this.req[i]]);
    }
    if (this.view) Object.assign(this.view, { u, pend });
  }
}
