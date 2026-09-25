"""
A toy version of "read my blog and write another post like it".

Every episode has an author with a house style:

  font      which of 6 paragraph fonts they write in      (an invariant: every paragraph)
  heading   which of 4 heading styles they use            (an invariant: every heading)
  math      which of 3 formula delimiters they use        (an invariant, but sparse)
  why       whether posts close with a "why" section      (an eventuality)
  sources   whether posts end with a sources section      (an eventuality, and it must be last)

The context shows 2-3 of the author's posts, then a request written in the *default*
style (font 0, delimiters 0), which says how many paragraphs to write. The model then
writes a new post. The house style is never stated. It has to be read off the posts,
and held against the request that sits right next to the point where writing starts.

The monitors at the bottom are the paper's verifiers: each one is a finite automaton
that reads the output once.
"""
from __future__ import annotations

import numpy as np

SPECIAL = ['<pad>', '<bos>', '<eos>', '<post>', '</post>', '<req>', '<new>', '#', 'WHY', 'SRC']
N_FONT, N_HEAD, N_MATH = 6, 4, 3
K_MIN, K_MAX = 3, 16
N_REF, N_WORD = 8, 48

VOCAB = (
    SPECIAL
    + [f'F{i}' for i in range(N_FONT)]
    + [f'H{i}' for i in range(N_HEAD)]
    + [f'M{i}(' for i in range(N_MATH)]
    + [f')M{i}' for i in range(N_MATH)]
    + [f'L{k}' for k in range(K_MIN, K_MAX + 1)]
    + [f'R{i}' for i in range(N_REF)]
    + [f'w{i}' for i in range(N_WORD)]
)
ID = {t: i for i, t in enumerate(VOCAB)}
V = len(VOCAB)
PAD, BOS, EOS, POST, END_POST, REQ, NEW, HASH, WHY, SRC = range(10)
FONT0 = ID['F0']
HEAD0 = ID['H0']
MOPEN0 = ID['M0(']
MCLOSE0 = ID[')M0']
LEN0 = ID[f'L{K_MIN}']
REF0 = ID['R0']
WORD0 = ID['w0']

# the prior: most authors write in the default style, so a model that stops
# looking at the evidence drifts back to it
P_FONT = np.array([0.40] + [0.12] * (N_FONT - 1))
P_HEAD = np.array([0.40] + [0.20] * (N_HEAD - 1))
P_MATH = np.array([0.50] + [0.25] * (N_MATH - 1))
P_WHY = 0.5
P_SRC = 0.5
P_FORMULA = 0.15  # per paragraph

# the prose itself: a fixed sparse bigram chain over 48 words, shared by every author
_r = np.random.default_rng(137)
BIGRAM = np.full((N_WORD, N_WORD), 0.2 / N_WORD)
for a in range(N_WORD):
    BIGRAM[a, _r.choice(N_WORD, 4, replace=False)] += 0.2
BIGRAM /= BIGRAM.sum(1, keepdims=True)


def is_font(t): return FONT0 <= t < FONT0 + N_FONT
def is_head(t): return HEAD0 <= t < HEAD0 + N_HEAD
def is_mopen(t): return MOPEN0 <= t < MOPEN0 + N_MATH
def is_mclose(t): return MCLOSE0 <= t < MCLOSE0 + N_MATH
def is_ref(t): return REF0 <= t < REF0 + N_REF


class Style:
    __slots__ = ('font', 'head', 'math', 'why', 'src')

    def __init__(self, font, head, math, why, src):
        self.font, self.head, self.math, self.why, self.src = font, head, math, why, src

    @staticmethod
    def sample(r: np.random.Generator) -> 'Style':
        return Style(
            int(r.choice(N_FONT, p=P_FONT)),
            int(r.choice(N_HEAD, p=P_HEAD)),
            int(r.choice(N_MATH, p=P_MATH)),
            int(r.random() < P_WHY),
            int(r.random() < P_SRC),
        )

    def labels(self):
        return [self.font, self.head, self.math, self.why, self.src]


def words(r, n):
    w = [int(r.integers(N_WORD))]
    for _ in range(n - 1):
        w.append(int(r.choice(N_WORD, p=BIGRAM[w[-1]])))
    return [WORD0 + x for x in w]


def paragraph(r, font, math, formula: bool):
    body = words(r, int(r.integers(2, 5)))
    if formula:
        at = int(r.integers(1, len(body) + 1))
        body[at:at] = [MOPEN0 + math, *words(r, 2), MCLOSE0 + math]
    return [FONT0 + font, *body]


def post(r, st: Style, k: int, force_formula=False):
    """k paragraphs in the author's style (the why paragraph counts as one)."""
    body_k = k - 1 if st.why else k
    formulas = [r.random() < P_FORMULA for _ in range(k)]
    if force_formula and not any(formulas):
        formulas[int(r.integers(k))] = True
    out, i = [], 0
    intro = min(body_k, int(r.integers(1, 3)))
    for _ in range(intro):
        out += paragraph(r, st.font, st.math, formulas[i]); i += 1
    while i < body_k:
        out += [HASH, HEAD0 + st.head, *words(r, 2)]
        for _ in range(min(body_k - i, int(r.integers(2, 5)))):
            out += paragraph(r, st.font, st.math, formulas[i]); i += 1
    if st.why:
        out += [HASH, HEAD0 + st.head, WHY, *words(r, 1)]
        out += paragraph(r, st.font, st.math, formulas[i]); i += 1
    if st.src:
        out += [SRC] + [REF0 + int(x) for x in r.choice(N_REF, int(r.integers(1, 4)), replace=False)]
    return out


def request(r, k):
    """The ask, written the way people write in a chat box: default font, default delimiters."""
    return [REQ, LEN0 + (k - K_MIN), *paragraph(r, 0, 0, True)]


def episode(r, k=None, n_ex=None, st=None, T=320):
    """Returns (tokens, start-of-writing index, style, k)."""
    while True:
        st = st or Style.sample(r)
        k = k or int(r.integers(K_MIN, K_MAX + 1))
        n_ex = n_ex or int(r.integers(2, 4))
        seq = [BOS]
        for j in range(n_ex):
            # every set of examples shows at least one formula, so the delimiter is knowable
            seq += [POST, *post(r, st, int(r.integers(3, 9)), force_formula=(j == 0)), END_POST]
        seq += request(r, k)
        g = len(seq)
        seq += [NEW, *post(r, st, k), EOS]
        if len(seq) <= T:
            return seq, g, st, k


def batch(r, B, T=320, **kw):
    """Teacher-forcing batch. Loss only on what the model writes (after <new>)."""
    x = np.zeros((B, T), np.int32)
    loss_mask = np.zeros((B, T), np.float32)
    gen_mask = np.zeros((B, T), np.float32)  # positions at or after <new>
    g_idx = np.zeros(B, np.int32)
    labels = np.zeros((B, 6), np.int32)  # font, head, math, why, src, k-K_MIN
    ev = np.zeros((B, T, 3), np.float32)  # per position: paragraph starts here, WHY seen, SRC seen
    for b in range(B):
        seq, g, st, k = episode(r, T=T, **kw)
        n = len(seq)
        x[b, :n] = seq
        g_idx[b] = g
        # position t predicts token t+1
        loss_mask[b, g:n - 1] = 1
        gen_mask[b, g:n] = 1
        labels[b] = [*st.labels(), k - K_MIN]
        seen_w = seen_s = 0
        for t in range(g, n):
            tok = seq[t]
            seen_w |= tok == WHY
            seen_s |= tok == SRC
            ev[b, t] = [float(is_font(tok)), float(seen_w), float(seen_s)]
    return dict(x=x, loss_mask=loss_mask, gen_mask=gen_mask, g=g_idx, labels=labels, ev=ev)


def prompt(r, k, st=None, n_ex=2, T=320):
    """A context that ends at <new>, for sampling."""
    while True:
        seq, g, st2, k2 = episode(r, k=k, n_ex=n_ex, st=st, T=T)
        return seq[: g + 1], st2, k2


# ── monitors ──────────────────────────────────────────────────────────────
# Each check reads the output once, left to right. Invariants report the first
# position where they broke; eventualities can only be judged at the end.

MONITORS = ['font', 'heading', 'math', 'why', 'sources', 'order', 'length']
IMPLICIT = ['font', 'heading', 'math', 'why', 'sources', 'order']


def audit(y: list[int], st: Style, k: int, ended: bool):
    """y: tokens written after <new>, without <eos>. Returns (ok per monitor, first break per monitor)."""
    ok = dict.fromkeys(MONITORS, True)
    first = dict.fromkeys(MONITORS, None)

    def fail(name, t):
        if ok[name]:
            ok[name] = False
            first[name] = t

    end = len(y)
    paras = 0
    why_at = src_at = None
    for t, tok in enumerate(y):
        if is_font(tok):
            paras += 1
            if tok != FONT0 + st.font: fail('font', t)
        elif is_head(tok):
            if tok != HEAD0 + st.head: fail('heading', t)
        elif is_mopen(tok):
            if tok != MOPEN0 + st.math: fail('math', t)
        elif is_mclose(tok):
            if tok != MCLOSE0 + st.math: fail('math', t)
        elif tok == WHY:
            if not st.why or why_at is not None: fail('why', t)
            why_at = t
        elif tok == SRC:
            if not st.src or src_at is not None: fail('sources', t)
            src_at = t
        if src_at is not None and t > src_at and not is_ref(tok):
            fail('sources', t)  # sources must be the last thing
        if tok in (POST, END_POST, REQ, NEW, BOS, PAD) or (LEN0 <= tok < LEN0 + (K_MAX - K_MIN + 1)):
            fail('font', t)  # structural garbage counts against the surface form
    if not ended:
        # never finished: every eventuality is unpaid
        for m in ('why', 'sources', 'length'):
            fail(m, end)
    if st.why and why_at is None: fail('why', end)
    if st.src and src_at is None: fail('sources', end)
    if st.why and st.src and why_at is not None and src_at is not None and src_at < why_at:
        fail('order', src_at)
    if paras != k: fail('length', end)
    return ok, first, paras


def render(seq):
    return ' '.join(VOCAB[t] for t in seq)


if __name__ == '__main__':
    r = np.random.default_rng(0)
    for _ in range(2):
        seq, g, st, k = episode(r)
        print(len(seq), g, st.labels(), k)
        print(render(seq[:g]))
        print('  >>', render(seq[g:]))
        ok, first, paras = audit(seq[g + 1 : -1], st, k, True)
        assert all(ok.values()), (ok, first)
    lens = [len(episode(r)[0]) for _ in range(2000)]
    print('V', V, 'len mean', np.mean(lens), 'p95', np.percentile(lens, 95), 'max', max(lens))
