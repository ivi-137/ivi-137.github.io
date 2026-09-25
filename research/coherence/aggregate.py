"""
Collect results/<variant>-s<seed>.json into results/summary.json (read by the post).

  python aggregate.py
"""
from __future__ import annotations

import json
from collections import defaultdict
from pathlib import Path

import numpy as np

RES = Path(__file__).parent / 'results'
ORDER = ['base', 'base_aux', 'ledger', 'ledger_joint', 'ledger_nogate', 'ledger_nosup']


def stats(xs):
    xs = [x for x in xs if x is not None]
    if not xs:
        return None
    a = np.array(xs, float)
    return {'mean': round(float(a.mean()), 4), 'min': round(float(a.min()), 4), 'max': round(float(a.max()), 4), 'sd': round(float(a.std(ddof=1)) if len(a) > 1 else 0.0, 4), 'n': len(a)}


def main():
    runs = defaultdict(list)
    for f in sorted(RES.glob('*-s*.json')):
        s = json.load(open(f))['summary']
        runs[s['variant']].append(s)
    out = {'variants': {}}
    for v in ORDER:
        if v not in runs:
            continue
        rs = runs[v]
        mons = list(rs[0]['all'].keys())
        d = {
            'seeds': len(rs),
            'n_params': rs[0]['n_params'],
            'final_lm': stats([r['final_lm'] for r in rs]),
            'all': {m: stats([r['all'][m] for r in rs]) for m in mons},
            'conflict': {m: stats([r['conflict'].get(m) for r in rs]) for m in mons},
            'by_k': {k: {'coherent': stats([r['by_k'][k]['coherent'] for r in rs]), 'length': stats([r['by_k'][k]['length'] for r in rs])} for k in rs[0]['by_k']},
            'survival': {'L': rs[0]['survival']['L'], 'S': np.mean([r['survival']['S'] for r in rs], 0).round(4).tolist()},
            # attention on the example posts, averaged over layers and seeds
            'attention': np.mean([np.mean(r['attention'], 0) for r in rs], 0).round(4).tolist(),
            'attention_layers': np.mean([r['attention'] for r in rs], 0).round(4).tolist(),
            'n_samples': rs[0]['n'],
            'n_conflict': rs[0]['conflict']['n'],
        }
        out['variants'][v] = d
        c = d['all']['coherent']
        print(f"{v:14s} seeds={len(rs)} coherent={c['mean']:.3f} [{c['min']:.3f},{c['max']:.3f}]  conflict={d['conflict']['coherent']['mean']:.3f}  " + ' '.join(f"{m}={d['all'][m]['mean']:.3f}" for m in mons if m not in ('coherent',)))
    json.dump(out, open(RES / 'summary.json', 'w'), indent=1)


if __name__ == '__main__':
    main()
