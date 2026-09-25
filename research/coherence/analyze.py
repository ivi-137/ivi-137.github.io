"""
Hazards, done properly.

  python analyze.py             # prints tables for every variant in results/
  python analyze.py --json      # also writes results/hazards.json (read by the post)

Two questions from the theory:
  1. Per opportunity to break, do sparse invariants (maths) break more often than dense ones (font)?
  2. Does the hazard of breaking an invariant rise as the post gets longer (dilution),
     or stay flat (pure compounding)?

(2) uses a Kaplan-Meier estimate: at each paragraph index, the risk set is the posts
that reached that paragraph with the invariant still intact. Posts that end are
censored, not counted as survivors.
"""
from __future__ import annotations

import json
import sys
from collections import defaultdict

import numpy as np

from records import RES, load
from toy import FONT0, HEAD0, IMPLICIT, MOPEN0, is_font, is_head, is_mopen


def wilson(k, n, z=1.96):
    """95% Wilson interval for a proportion."""
    if n == 0:
        return (0.0, 1.0)
    p = k / n
    d = 1 + z * z / n
    c = (p + z * z / (2 * n)) / d
    h = z * np.sqrt(p * (1 - p) / n + z * z / (4 * n * n)) / d
    return (float(max(0.0, c - h)), float(min(1.0, c + h)))


def mcnemar(a, b):
    """Exact two-sided McNemar test on paired booleans: returns (a only, b only, p)."""
    from math import comb

    x = sum(1 for i, j in zip(a, b) if i and not j)
    y = sum(1 for i, j in zip(a, b) if j and not i)
    n = x + y
    if n == 0:
        return x, y, 1.0
    tail = sum(comb(n, i) for i in range(0, min(x, y) + 1)) / 2**n
    return x, y, float(min(1.0, 2 * tail))


def opportunities(recs, kind):
    """Pooled hazard per opportunity: first breaks / opportunities up to and including the first break."""
    test = {'font': is_font, 'heading': is_head, 'math': is_mopen}[kind]
    good = {'font': lambda t, st: t == FONT0 + st[0], 'heading': lambda t, st: t == HEAD0 + st[1], 'math': lambda t, st: t == MOPEN0 + st[2]}[kind]
    opp = brk = 0
    for r in recs:
        for tok in r['y']:
            if test(tok):
                opp += 1
                if not good(tok, r['style']):
                    brk += 1
                    break
    return brk, opp


def km_by_paragraph(recs, max_p=16):
    """Hazard of the first font break at paragraph j, among posts that reached paragraph j intact."""
    at_risk = np.zeros(max_p)
    breaks = np.zeros(max_p)
    for r in recs:
        st = r['style']
        j = 0
        for tok in r['y']:
            if is_font(tok):
                if j >= max_p:
                    break
                at_risk[j] += 1
                if tok != FONT0 + st[0]:
                    breaks[j] += 1
                    break
                j += 1
    h = np.where(at_risk > 0, breaks / np.maximum(at_risk, 1), np.nan)
    return h, at_risk, breaks


def main():
    runs = defaultdict(list)
    seeds = defaultdict(list)
    for v, rs in load().items():
        for r in sorted(rs, key=lambda x: x['seed']):
            runs[v].append(r['records'])
            seeds[v].append(r['seed'])
    out = {}
    for v, rr in runs.items():
        recs = [r for rs in rr for r in rs]
        row = {}
        for kind in ('font', 'heading', 'math'):
            b, o = opportunities(recs, kind)
            row[kind] = {'breaks': b, 'opportunities': o, 'hazard': b / max(o, 1), 'ci': wilson(b, o)}
        coh = [r['coherent'] for r in recs]
        row['coherent'] = {'k': int(sum(coh)), 'n': len(coh), 'rate': float(np.mean(coh)), 'ci': wilson(sum(coh), len(coh))}
        # paired against the baseline: same prompts, same seed index
        if v != 'base' and 'base' in runs:
            bs = dict(zip(seeds['base'], runs['base']))
            pa, pb = [], []
            for sd, rs in zip(seeds[v], rr):
                if sd in bs:
                    pa += [r['coherent'] for r in rs]
                    pb += [r['coherent'] for r in bs[sd]]
            x, y, p = mcnemar(pa, pb)
            row['vs_base'] = {'pairs': len(pa), 'only_this': x, 'only_base': y, 'p': p}
        h, n, b = km_by_paragraph(recs)
        # pool paragraphs into thirds of a long post to steady the estimate
        bins = [(0, 1), (1, 4), (4, 8), (8, 16)]
        pooled = [{'from': lo + 1, 'to': hi, 'hazard': float(b[lo:hi].sum() / max(n[lo:hi].sum(), 1)), 'at_risk': int(n[lo:hi].sum()), 'breaks': int(b[lo:hi].sum())} for lo, hi in bins]
        row['font_by_paragraph'] = pooled
        row['seeds'] = len(rr)
        out[v] = row
        print(f"\n{v}  ({len(rr)} seeds, {len(recs)} posts)")
        for kind in ('font', 'heading', 'math'):
            x = row[kind]
            print(f"  {kind:8s} first breaks {x['breaks']:4d} / {x['opportunities']:6d} opportunities = {100 * x['hazard']:.2f}% per opportunity")
        c = row['coherent']
        print(f"  coherent {c['k']}/{c['n']} = {100 * c['rate']:.1f}% [{100 * c['ci'][0]:.1f}, {100 * c['ci'][1]:.1f}]" + (f"   vs base (paired): {row['vs_base']['only_this']} only here, {row['vs_base']['only_base']} only in base, p = {row['vs_base']['p']:.2g}" if 'vs_base' in row else ''))
        print('  font hazard by paragraph:', '  '.join(f"¶{p['from']}-{p['to']}: {100 * p['hazard']:.2f}% ({p['breaks']}/{p['at_risk']})" for p in pooled))
    if '--json' in sys.argv:
        json.dump(out, open(RES / 'hazards.json', 'w'), indent=1)


if __name__ == '__main__':
    main()
