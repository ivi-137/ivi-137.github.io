"""
A small decoder-only transformer, with and without the Ledger.

Variants (cfg['variant']):
  base        pre-LN transformer, RoPE, tied embeddings
  base_aux    base + the same supervision the Ledger gets, as linear probes on the residual stream
  ledger      base + Ledger: clerk, typed status, separate-softmax read, EOS gate, supervised
  ledger_joint   Ledger slots read inside the ordinary softmax (no separate normalisation)
  ledger_nogate  Ledger without the EOS gate
  ledger_nosup   Ledger trained on the language-model loss alone
  base_frame     base + gauge fixing: the style is read by counting, the context is moved into the
                 canonical frame, the output is restricted to one member per orbit, and mapped back
  ledger_frame   Ledger + gauge fixing
  ledger_frame_evict   Ledger + gauge fixing, and written tokens may not attend to the example posts
                 (only the clerk and the frame read them), so their keys and values can be dropped

The Ledger (K slots):
  clerk    K learned queries attend once over the prompt  ->  o_i          (what is owed)
  status   per written token, a typed accumulator per slot ->  u_i(t)      (how much is paid)
             eventuality: u = 1 - prod(1 - sigmoid(z))     (noisy-OR, monotone)
             count:       u = sigmoid(4 (sum sigmoid(z) - k_hat + 1/2))
             invariant:   u = 0                              (never paid, always in force)
  read     each written token attends to the K slots with its own softmax (normalised over K,
           not over the context), added to the residual stream through tanh(g), g = 0 at init
  gate     logit(<eos>) += gamma * sum_i log(1 - pending_i + eps), gamma = 0 at init

Slot roles in the toy: 0 font, 1 heading, 2 math (invariants), 3 why, 4 sources (eventualities),
5 length (count), 6-7 free (eventualities, unsupervised).
"""
from __future__ import annotations

import math

import jax
import jax.numpy as jnp

from toy import EOS, K_MAX, K_MIN, N_FONT, N_HEAD, N_MATH, NONCANONICAL, PAD, V

K = 8
INVARIANT, EVENT, COUNT = 0, 1, 2
SLOT_TYPE = [INVARIANT, INVARIANT, INVARIANT, EVENT, EVENT, COUNT, EVENT, EVENT]
N_LEN = K_MAX - K_MIN + 1
HEADS_OUT = [N_FONT, N_HEAD, N_MATH, 2, 2, N_LEN]  # extraction heads for slots 0..5


def default_cfg(variant='base', **kw):
    cfg = dict(variant=variant, V=V, d=64, L=3, H=4, dff=256, K=K, clerk_layer=1, lam_ext=0.3, lam_ev=0.3)
    cfg.update(kw)
    return cfg


def has_ledger(cfg):
    return cfg['variant'].startswith('ledger')


def supervised(cfg):
    return cfg['variant'] in ('base_aux', 'ledger', 'ledger_joint', 'ledger_nogate', 'ledger_frame', 'ledger_frame_evict')


def gauged(cfg):
    return 'frame' in cfg['variant']


def evicts(cfg):
    return cfg['variant'].endswith('evict')


# ── init ─────────────────────────────────────────────────────────────────


def _dense(key, i, o, scale=1.0):
    return jax.random.normal(key, (i, o)) * (scale / math.sqrt(i))


def init(key, cfg):
    d, L, dff = cfg['d'], cfg['L'], cfg['dff']
    ks = iter(jax.random.split(key, 64))
    p = {
        'emb': jax.random.normal(next(ks), (cfg['V'], d)) * 0.05,
        'lnf': _ln(d),
        'layers': [],
    }
    for _ in range(L):
        p['layers'].append(
            {
                'ln1': _ln(d),
                'wqkv': _dense(next(ks), d, 3 * d),
                'wo': _dense(next(ks), d, d, 1 / math.sqrt(2 * L)),
                'ln2': _ln(d),
                'w1': _dense(next(ks), d, dff),
                'b1': jnp.zeros(dff),
                'w2': _dense(next(ks), dff, d, 1 / math.sqrt(2 * L)),
                'b2': jnp.zeros(d),
            }
        )
    if cfg['variant'] == 'base_aux':
        p['aux'] = {
            'ln': _ln(d),
            'ext': [_dense(next(ks), d, n) for n in HEADS_OUT],
            'ev': _dense(next(ks), d, 3),
            'ev_b': jnp.zeros(3),
        }
    if has_ledger(cfg):
        Kk = cfg['K']
        n_read = L - cfg['clerk_layer']
        p['ledger'] = {
            'ln_c': _ln(d),
            'q': jax.random.normal(next(ks), (Kk, d)) * 0.5,
            'wkv': _dense(next(ks), d, 2 * d),
            'wo': _dense(next(ks), d, d),
            'ln_o': _ln(d),
            'ext': [_dense(next(ks), d, n) for n in HEADS_OUT],
            'wz_h': _dense(next(ks), d, d),
            'wz_o': _dense(next(ks), d, d),
            'bz': jnp.full(Kk, -2.0),
            'slot': jax.random.normal(next(ks), (Kk, d)) * 0.1,
            'ws': _dense(next(ks), 3, d),
            'gamma': jnp.zeros(()),
            'read': [
                {
                    'ln': _ln(d),
                    'wq': _dense(next(ks), d, d),
                    'wkv': _dense(next(ks), d, 2 * d),
                    'wo': _dense(next(ks), d, d),
                    'g': jnp.zeros(()),
                }
                for _ in range(n_read)
            ],
        }
    return p


def _ln(d):
    return {'g': jnp.ones(d), 'b': jnp.zeros(d)}


def ln(p, x):
    m = x.mean(-1, keepdims=True)
    v = ((x - m) ** 2).mean(-1, keepdims=True)
    return (x - m) / jnp.sqrt(v + 1e-5) * p['g'] + p['b']


# ── attention ────────────────────────────────────────────────────────────


def rope(x, pos):
    """x: (B, T, H, dh)."""
    dh = x.shape[-1]
    half = dh // 2
    freq = 1.0 / (10000 ** (jnp.arange(half) / half))
    ang = pos[:, :, None, None] * freq  # (B,T,1,half)
    c, s = jnp.cos(ang), jnp.sin(ang)
    x1, x2 = x[..., :half], x[..., half:]
    return jnp.concatenate([x1 * c - x2 * s, x1 * s + x2 * c], -1)


def self_attn(lp, x, pos, valid, H, slots=None, slot_on=None, hide=None):
    """Causal multi-head attention. If `slots` (B,T,K,d) is given, their keys join the same softmax
    (the 'joint' ablation): each query sees its context *and* the K slots, normalised together."""
    B, T, d = x.shape
    dh = d // H
    qkv = x @ lp['wqkv']
    q, k, v = jnp.split(qkv, 3, -1)
    q = rope(q.reshape(B, T, H, dh), pos)
    k = rope(k.reshape(B, T, H, dh), pos)
    v = v.reshape(B, T, H, dh)
    logits = jnp.einsum('bthd,bshd->bhts', q, k) / math.sqrt(dh)
    causal = jnp.tril(jnp.ones((T, T), bool))
    mask = causal[None, None] & valid[:, None, None, :]
    if hide is not None:
        mask = mask & ~hide[:, None]  # hide: (B,T,S) keys a query may not see
    logits = jnp.where(mask, logits, -1e9)
    if slots is None:
        a = jax.nn.softmax(logits, -1)
        out = jnp.einsum('bhts,bshd->bthd', a, v)
    else:
        _, _, Kk, _ = slots.shape
        sk, sv = jnp.split(slots @ lp['wqkv'][:, d:], 2, -1)  # reuse this layer's key/value maps
        sk = sk.reshape(B, T, Kk, H, dh)
        sv = sv.reshape(B, T, Kk, H, dh)
        ls = jnp.einsum('bthd,btkhd->bhtk', q, sk) / math.sqrt(dh)
        ls = jnp.where(slot_on[:, None, :, None], ls, -1e9)
        a = jax.nn.softmax(jnp.concatenate([logits, ls], -1), -1)
        out = jnp.einsum('bhts,bshd->bthd', a[..., :T], v) + jnp.einsum('bhtk,btkhd->bthd', a[..., T:], sv)
    return out.reshape(B, T, d) @ lp['wo'], a


def mlp(lp, x):
    return jax.nn.gelu(x @ lp['w1'] + lp['b1']) @ lp['w2'] + lp['b2']


# ── the Ledger ───────────────────────────────────────────────────────────


def clerk(P, h, prompt_mask, H):
    """K learned queries read the prompt once. h: (B,T,d). Returns o: (B,K,d)."""
    B, T, d = h.shape
    dh = d // H
    Kk = P['q'].shape[0]
    hc = ln(P['ln_c'], h)
    k, v = jnp.split(hc @ P['wkv'], 2, -1)
    q = P['q'].reshape(Kk, H, dh)
    k = k.reshape(B, T, H, dh)
    v = v.reshape(B, T, H, dh)
    lg = jnp.einsum('khd,bthd->bhkt', q, k) / math.sqrt(dh)
    lg = jnp.where(prompt_mask[:, None, None, :], lg, -1e9)
    a = jax.nn.softmax(lg, -1)
    o = jnp.einsum('bhkt,bthd->bkhd', a, v).reshape(B, Kk, d) @ P['wo']
    return ln(P['ln_o'], o + P['slot'])


def status(P, h, o, gen_mask, k_hat):
    """Typed accumulators. Returns event probabilities e (B,T,K) and paid u (B,T,K)."""
    d = h.shape[-1]
    hz = ln(P['ln_c'], h) @ P['wz_h']  # (B,T,d)
    oz = o @ P['wz_o']  # (B,K,d)
    z = jnp.einsum('btd,bkd->btk', hz, oz) / math.sqrt(d) + P['bz']
    e = jax.nn.sigmoid(z) * gen_mask[..., None]
    # eventuality: noisy-OR, computed in parallel as a cumulative sum of logs
    u_ev = 1.0 - jnp.exp(jnp.cumsum(jnp.log1p(-e * 0.999), axis=1))
    # count: running sum against the clerk's estimate of the target
    c = jnp.cumsum(e, axis=1)
    u_ct = jax.nn.sigmoid(4.0 * (c - k_hat[:, None, None] + 0.5))
    ty = jnp.array(SLOT_TYPE)
    u = jnp.where(ty == EVENT, u_ev, jnp.where(ty == COUNT, u_ct, 0.0))
    return e, u


def forward(p, x, gen_mask, cfg, want_attn=False, exm=None):
    """x: (B,T) tokens; gen_mask: (B,T) 1 from <new> on; exm: (B,T) positions inside the example
    posts (used only when the variant evicts them). Returns logits and extras."""
    B, T = x.shape
    hide = None
    if evicts(cfg):
        hide = (gen_mask > 0)[:, :, None] & exm[:, None, :]
    H = cfg['H']
    valid = x != PAD
    valid = valid.at[:, 0].set(True)
    pos = jnp.broadcast_to(jnp.arange(T), (B, T)).astype(jnp.float32)
    h = p['emb'][x]
    extras = {}
    variant = cfg['variant']
    led = has_ledger(cfg)
    slots = None
    attn = []
    for li, lp in enumerate(p['layers']):
        joint = variant == 'ledger_joint' and slots is not None
        a_out, a = self_attn(lp, ln(lp['ln1'], h), pos, valid, H, slots if joint else None, gen_mask > 0 if joint else None, hide)
        if want_attn:
            attn.append(a)
        h = h + a_out
        if led and slots is not None and variant != 'ledger_joint':
            rp = p['ledger']['read'][li - cfg['clerk_layer']]
            h = h + jnp.tanh(rp['g']) * read(rp, ln(rp['ln'], h), slots, H) * gen_mask[..., None]
        h = h + mlp(lp, ln(lp['ln2'], h))
        if li == cfg['clerk_layer'] - 1:
            if led:
                P = p['ledger']
                prompt_mask = valid & (gen_mask == 0)
                o = clerk(P, h, prompt_mask, H)
                ext = [o[:, i] @ P['ext'][i] for i in range(len(HEADS_OUT))]
                pr = [jax.nn.softmax(e, -1) for e in ext]
                k_hat = (pr[5] * (jnp.arange(N_LEN) + K_MIN)).sum(-1)
                e, u = status(P, h, o, gen_mask, k_hat)
                ty = jnp.array(SLOT_TYPE)
                req = jnp.ones((B, cfg['K']))
                req = req.at[:, 3].set(pr[3][:, 1]).at[:, 4].set(pr[4][:, 1])
                pend = jnp.where(ty == INVARIANT, 0.0, req[:, None, :] * (1 - u))  # (B,T,K)
                feat = jnp.stack([u, pend, jnp.broadcast_to(req[:, None, :], u.shape)], -1)  # (B,T,K,3)
                slots = o[:, None, :, :] + feat @ P['ws']  # (B,T,K,d)
                extras.update(ext=ext, e=e, u=u, pend=pend, k_hat=k_hat, req=req)
            if variant == 'base_aux':
                A = p['aux']
                ha = ln(A['ln'], h)
                g_idx = jnp.argmax(gen_mask, axis=1)
                hg = ha[jnp.arange(B), g_idx]
                extras['ext'] = [hg @ w for w in A['ext']]
                extras['e'] = jax.nn.sigmoid(ha @ A['ev'] + A['ev_b'])
    logits = ln(p['lnf'], h) @ p['emb'].T
    if gauged(cfg):
        # the output alphabet is the set of orbits: one member per style family
        logits = logits.at[..., jnp.array(NONCANONICAL)].set(-1e9)
    if led and variant != 'ledger_nogate':
        pend = extras['pend'][..., 3:6]
        gate = p['ledger']['gamma'] * jnp.log1p(-pend * 0.999).sum(-1)
        logits = logits.at[..., EOS].add(gate * gen_mask)
    if want_attn:
        extras['attn'] = attn
    return logits, extras


def read(rp, x, slots, H):
    """Each position attends to its K slots; the softmax runs over the K slots only."""
    B, T, d = x.shape
    Kk = slots.shape[2]
    dh = d // H
    q = (x @ rp['wq']).reshape(B, T, H, dh)
    k, v = jnp.split(slots @ rp['wkv'], 2, -1)
    k = k.reshape(B, T, Kk, H, dh)
    v = v.reshape(B, T, Kk, H, dh)
    a = jax.nn.softmax(jnp.einsum('bthd,btkhd->bthk', q, k) / math.sqrt(dh), -1)
    return jnp.einsum('bthk,btkhd->bthd', a, v).reshape(B, T, d) @ rp['wo']


# ── loss ─────────────────────────────────────────────────────────────────


def canonical(b, cfg):
    """Move a batch into the canonical frame (identity for ungauged variants)."""
    if not gauged(cfg):
        return b
    b = dict(b)
    b['x'] = jnp.take_along_axis(b['perm'], b['x'], axis=1)
    b['labels'] = b['labels'].at[:, :3].set(0)  # in the canonical frame the style is (0, 0, 0)
    return b


def loss_fn(p, b, cfg):
    b = canonical(b, cfg)
    x = b['x']
    logits, ex = forward(p, x, b['gen_mask'], cfg, exm=b.get('exm'))
    lp = jax.nn.log_softmax(logits[:, :-1], -1)
    tgt = x[:, 1:]
    nll = -jnp.take_along_axis(lp, tgt[..., None], -1)[..., 0]
    m = b['loss_mask'][:, :-1]
    lm = (nll * m).sum() / m.sum()
    total = lm
    metrics = {'lm': lm}
    if supervised(cfg):
        lab = b['labels']
        ext = sum(-jnp.take_along_axis(jax.nn.log_softmax(ex['ext'][i], -1), lab[:, i : i + 1], -1).mean() for i in range(6))
        gm = b['gen_mask']
        if cfg['variant'] == 'base_aux':
            pe = ex['e']  # (B,T,3): paragraph start, why seen, src seen
            tgt_ev = b['ev']
        else:
            # count slot learns paragraph starts; eventuality slots learn "paid" from the monitors
            pe = jnp.stack([ex['e'][..., 5], ex['u'][..., 3], ex['u'][..., 4]], -1)
            tgt_ev = b['ev']
        pe = jnp.clip(pe, 1e-5, 1 - 1e-5)
        bce = -(tgt_ev * jnp.log(pe) + (1 - tgt_ev) * jnp.log1p(-pe))
        ev = (bce * gm[..., None]).sum() / (gm.sum() * 3)
        total = total + cfg['lam_ext'] * ext + cfg['lam_ev'] * ev
        metrics.update(ext=ext, ev=ev)
    return total, metrics


def n_params(p):
    return sum(x.size for x in jax.tree_util.tree_leaves(p))
