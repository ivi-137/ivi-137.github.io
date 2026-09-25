"""
Sample new posts from trained runs and audit them.

  python evaluate.py runs/base-s0.pkl runs/ledger-s0.pkl ...

For every run: the same 300 prompts (5 requested lengths x 60), n_ex = 2, sampled at
temperature 1 (the model's own distribution, no decoding tricks). Every output is read
by the monitors in toy.py. Also measures, on teacher-forced text, how much attention the
written tokens pay to the example posts as the post gets longer.
"""
from __future__ import annotations

import json
import pickle
import sys
from pathlib import Path

import jax
import jax.numpy as jnp
import numpy as np

import model as M
from toy import EOS, IMPLICIT, MONITORS, PAD, REQ, Style, audit, batch, prompt

KS = [4, 7, 10, 13, 16]
PER_K = 60
TB = 320
OUT = Path(__file__).parent / 'results'


def prompts(seed=7):
    r = np.random.default_rng(seed)
    items = []
    for k in KS:
        for _ in range(PER_K):
            seq, st, k2 = prompt(r, k, n_ex=2)
            items.append((seq, st, k2))
    return items


def sample(params, cfg, items, seed=0, temp=1.0, bs=150):
    fwd = jax.jit(lambda p, x, gm: M.forward(p, x, gm, cfg)[0])
    key = jax.random.PRNGKey(seed)
    outs = [None] * len(items)
    for s in range(0, len(items), bs):
        chunk = items[s : s + bs]
        B = len(chunk)
        x = np.zeros((B, TB), np.int32)
        gm = np.zeros((B, TB), np.float32)
        pos = np.zeros(B, np.int32)
        for b, (seq, _, _) in enumerate(chunk):
            x[b, : len(seq)] = seq
            gm[b, len(seq) - 1 :] = 1  # from <new> on
            pos[b] = len(seq) - 1
        start = pos.copy()
        done = np.zeros(B, bool)
        while not done.all():
            logits = np.asarray(fwd(params, jnp.asarray(x), jnp.asarray(gm)))
            lg = logits[np.arange(B), pos] / temp
            lg[:, PAD] = -1e9
            key, sk = jax.random.split(key)
            tok = np.asarray(jax.random.categorical(sk, jnp.asarray(lg)))
            for b in range(B):
                if done[b]:
                    continue
                x[b, pos[b] + 1] = tok[b]
                pos[b] += 1
                if tok[b] == EOS or pos[b] >= TB - 1:
                    done[b] = True
        for b in range(B):
            y = x[b, start[b] + 1 : pos[b] + 1].tolist()
            ended = bool(y and y[-1] == EOS)
            if ended:
                y = y[:-1]
            outs[s + b] = (y, ended)
    return outs


def attention_curve(params, cfg, seed=11, n=64, T=288, max_off=110):
    """Mean attention mass from written tokens onto the example posts, by offset into the post."""
    r = np.random.default_rng(seed)
    b = batch(r, n, T)
    _, ex = M.forward(params, jnp.asarray(b['x']), jnp.asarray(b['gen_mask']), cfg, want_attn=True)
    x = b['x']
    req = np.array([int(np.where(row == REQ)[0][0]) for row in x])
    curves = []
    for a in ex['attn']:
        a = np.asarray(a).mean(1)  # (B,T,S) averaged over heads; joint variant has T+K keys
        a = a[:, :, :T]
        tot = np.zeros(max_off)
        cnt = np.zeros(max_off)
        for i in range(n):
            g = b['g'][i]
            n_tok = int((x[i] != PAD).sum())
            for t in range(g, min(n_tok, g + max_off)):
                tot[t - g] += a[i, t, 1 : req[i]].sum()
                cnt[t - g] += 1
        curves.append((tot / np.maximum(cnt, 1)).tolist())
    return curves


def summarise(recs):
    def rate(sub, m):
        return float(np.mean([r['ok'][m] for r in sub])) if sub else None

    out = {'n': len(recs)}
    out['all'] = {m: rate(recs, m) for m in MONITORS}
    out['all']['coherent'] = float(np.mean([all(r['ok'][m] for m in IMPLICIT) for r in recs]))
    out['all']['ended'] = float(np.mean([r['ended'] for r in recs]))
    conflict = [r for r in recs if r['style'][0] != 0 or r['style'][2] != 0]
    out['conflict'] = {m: rate(conflict, m) for m in MONITORS}
    out['conflict']['coherent'] = float(np.mean([all(r['ok'][m] for m in IMPLICIT) for r in conflict]))
    out['conflict']['n'] = len(conflict)
    out['by_k'] = {}
    for k in KS:
        sub = [r for r in recs if r['k'] == k]
        out['by_k'][k] = {m: rate(sub, m) for m in MONITORS}
        out['by_k'][k]['coherent'] = float(np.mean([all(r['ok'][m] for m in IMPLICIT) for r in sub]))
    # survival of the three invariants against output position
    firsts = []
    for r in recs:
        f = [r['first'][m] for m in ('font', 'heading', 'math') if r['first'][m] is not None]
        firsts.append(min(f) if f else None)
    L = np.arange(0, 121, 5)
    out['survival'] = {'L': L.tolist(), 'S': [float(np.mean([f is None or f >= l for f in firsts])) for l in L]}
    return out


def main(paths):
    OUT.mkdir(exist_ok=True)
    items = prompts()
    for path in paths:
        run = pickle.load(open(path, 'rb'))
        cfg, params = run['cfg'], jax.tree_util.tree_map(jnp.asarray, run['params'])
        outs = sample(params, cfg, items)
        recs = []
        for (seq, st, k), (y, ended) in zip(items, outs):
            ok, first, paras = audit(y, st, k, ended)
            recs.append(dict(k=k, style=st.labels(), ok=ok, first=first, paras=paras, ended=ended, n=len(y), y=y))
        summ = summarise(recs)
        summ['attention'] = attention_curve(params, cfg)
        summ['variant'] = cfg['variant']
        summ['n_params'] = run['n_params']
        summ['final_lm'] = run['log'][-1]['lm']
        name = Path(path).stem
        json.dump({'summary': summ, 'records': recs}, open(OUT / f'{name}.json', 'w'))
        a = summ['all']
        print(name, json.dumps({k: round(v, 3) for k, v in a.items()}), 'conflict coherent', round(summ['conflict']['coherent'], 3), flush=True)


if __name__ == '__main__':
    main(sys.argv[1:])
