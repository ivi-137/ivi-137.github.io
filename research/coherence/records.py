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


def macs_per_token(keys: float, ledger: bool) -> dict:
    """Multiply-accumulates per written token: projections and MLP (independent of context),
    attention (proportional to the keys attended), and the Ledger's read and status."""
    fixed = L * (4 * D * D + 2 * D * DFF) + D * VOC
    attn = L * 2 * keys * D
    led = 0
    if ledger:
        reads = L - 1
        led = reads * (2 * D * D + 3 * 2 * D * K + 2 * K * D) + (D * D + K * D)
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
