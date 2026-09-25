"""
Collect results/<variant>-s<seed>.json into results/summary.json (read by the post).
Every stored output is re-audited with the current monitors (records.py).

  python aggregate.py
"""
from __future__ import annotations

import json

import numpy as np

from records import RES, load, macs_per_token
from toy import IMPLICIT, MONITORS

ORDER = ['base', 'base_aux', 'base_frame', 'ledger_nosup', 'ledger_nogate', 'ledger_joint', 'ledger', 'ledger_frame', 'ledger_frame_evict']
KS = [4, 7, 10, 13, 16]


def stats(xs):
    xs = [x for x in xs if x is not None]
    if not xs:
        return None
    a = np.array(xs, float)
    return {'mean': round(float(a.mean()), 4), 'min': round(float(a.min()), 4), 'max': round(float(a.max()), 4), 'sd': round(float(a.std(ddof=1)) if len(a) > 1 else 0.0, 4), 'n': len(a)}


def rates(recs):
    out = {m: float(np.mean([r['ok'][m] for r in recs])) for m in MONITORS}
    out['coherent'] = float(np.mean([r['coherent'] for r in recs]))
    out['ended'] = float(np.mean([r['ended'] for r in recs]))
    return out


def main():
    runs = load()
    out = {'variants': {}}
    for v in ORDER:
        if v not in runs:
            continue
        rs = sorted(runs[v], key=lambda x: x['seed'])
        per = [rates(r['records']) for r in rs]
        conf = [rates([x for x in r['records'] if x['style'][0] != 0 or x['style'][2] != 0]) for r in rs]
        keys = float(np.mean([x['keys'] for r in rs for x in r['records']]))
        n0 = float(np.mean([x['n0'] for r in rs for x in r['records']]))
        d = {
            'seeds': len(rs),
            'n_params': rs[0]['summary']['n_params'],
            'final_lm': stats([r['summary']['final_lm'] for r in rs]),
            'all': {m: stats([p[m] for p in per]) for m in per[0]},
            'conflict': {m: stats([p[m] for p in conf]) for m in conf[0]},
            'by_k': {k: {'coherent': stats([np.mean([x['coherent'] for x in r['records'] if x['k'] == k]) for r in rs]), 'length': stats([np.mean([x['ok']['length'] for x in r['records'] if x['k'] == k]) for r in rs])} for k in KS},
            'attention': np.mean([np.mean(r['summary']['attention'], 0) for r in rs], 0).round(4).tolist(),
            'attention_layers': np.mean([r['summary']['attention'] for r in rs], 0).round(4).tolist(),
            'keys_per_token': round(keys, 1),
            'prompt_tokens': round(n0, 1),
            'macs_per_token': macs_per_token(keys, v.startswith('ledger')),
            'n_samples': len(rs[0]['records']),
        }
        out['variants'][v] = d
        c = d['all']['coherent']
        print(f"{v:19s} seeds={len(rs)} coherent={c['mean']:.3f} [{c['min']:.3f},{c['max']:.3f}] keys/token={keys:6.1f} MACs/token={d['macs_per_token']['total']:,}  " + ' '.join(f"{m}={d['all'][m]['mean']:.3f}" for m in MONITORS))
    json.dump(out, open(RES / 'summary.json', 'w'), indent=1)


if __name__ == '__main__':
    main()
