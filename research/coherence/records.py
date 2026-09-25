"""
Load every evaluated run and re-audit its stored outputs with the current monitors, so that
all variants are judged by exactly the same rules. Also attaches what each prompt cost.
"""
from __future__ import annotations

import json
from collections import defaultdict
from pathlib import Path

import numpy as np

import evaluate as E
from toy import IMPLICIT, REQ, Style, audit

RES = Path(__file__).parent / 'results'

# the toy model's sizes (model.default_cfg): width, layers, feed-forward, slots, vocabulary
D, L, DFF, K, VOC = 64, 3, 256, 8, 96


def macs_per_token(keys: float, variant: str) -> dict:
    """Multiply-accumulates per written token: projections and MLP (independent of context),
    attention (proportional to the keys attended), and the Ledger's status and its placement:
    an attention read costs a query and output projection plus a rank-3 update of K keys and
    values (their fixed part is computed once per prompt); a layer-norm modulation or a logit
    bias costs a projection of the 3K status numbers (the slot-mean part is fixed per prompt)."""
    fixed = L * (4 * D * D + 2 * D * DFF) + D * VOC
    attn = L * 2 * keys * D
    led = 0
    if variant.startswith('ledger'):
        led = D * D + K * D  # status
        read = 2 * D * D + 3 * 2 * D * K + 2 * K * D
        led += {'ledger_top': 1 * read, 'ledger_film': (L - 1) * 3 * K * 4 * D, 'ledger_logit': 3 * K * VOC, 'ledger_joint': (L - 1) * 2 * K * D}.get(variant, (L - 1) * read)
    return {'fixed': fixed, 'attention': attn, 'ledger': led, 'total': fixed + attn + led}


def load():
    prompts = E.prompts()
    n0 = [len(p[0]) for p in prompts]
    req = [p[0].index(REQ) for p in prompts]
    runs = defaultdict(list)
    for f in sorted(RES.glob('*-s*.json')):
        d = json.load(open(f))
        v = d['summary']['variant']
        seed = int(f.stem.rsplit('-s', 1)[1])
        recs = d['records']
        evict = v.endswith('evict')
        for i, r in enumerate(recs):
            st = Style(*r['style'])
            ok, first, paras = audit(r['y'], st, r['k'], r['ended'])
            r['ok'], r['first'], r['paras'] = ok, first, paras
            r['coherent'] = all(ok[m] for m in IMPLICIT)
            span = n0[i] - (req[i] - 1 if evict else 0)
            r['keys'] = span + (len(r['y']) + 1) / 2
            r['n0'] = n0[i]
        runs[v].append({'seed': seed, 'records': recs, 'summary': d['summary']})
    return runs
