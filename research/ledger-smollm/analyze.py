"""
Summarise results/*.jsonl: accuracy with Wilson intervals, accuracy by obligation type, exact McNemar tests on
paired prompts, and the change of accuracy with context length with paired bootstrap intervals.

  python analyze.py            # writes results/summary.json and results/summary.md
"""
import argparse
import collections
import json
import math
import pathlib

import numpy as np

import obligations as ob

SHAPE_NAME = {ob.G: 'invariant', ob.F: 'eventuality', ob.N: 'count'}


def wilson(k, n, z=1.96):
    if n == 0:
        return (0.0, 0.0)
    p = k / n
    d = 1 + z * z / n
    c = (p + z * z / (2 * n)) / d
    h = z * math.sqrt(p * (1 - p) / n + z * z / (4 * n * n)) / d
    return (round(c - h, 4), round(c + h, 4))


def mcnemar(b, c):
    """Exact two-sided McNemar test on b (only first right) and c (only second right)."""
    n = b + c
    if n == 0:
        return 1.0
    tail = sum(math.comb(n, i) for i in range(min(b, c) + 1)) / 2**n
    return min(1.0, 2 * tail)


def shape_of(iid):
    return SHAPE_NAME[ob.SHAPE[ob.SLOT[iid]]] if iid in ob.SLOT else 'unsupported'


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('--results', default='results')
    ap.add_argument('--boot', type=int, default=2000)
    a = ap.parse_args()
    res = pathlib.Path(a.results)
    rows = [json.loads(line) for f in sorted(res.glob('*-L*.jsonl')) for line in f.read_text(encoding='utf-8').splitlines() if line.strip()]
    if not rows:
        raise SystemExit(f'no results in {res}')
    # prompt-level strict verdicts: runs[variant][seed][length][key]
    runs = collections.defaultdict(lambda: collections.defaultdict(dict))
    groups = collections.defaultdict(list)
    for r in rows:
        runs[r['variant']][(r['seed'], r['length'])][r['key']] = r['strict_all']
        groups[(r['variant'], r['length'])].append(r)
    table = []
    for (variant, L), rs in sorted(groups.items(), key=lambda x: (x[0][1], x[0][0])):
        n, k = len(rs), sum(r['strict_all'] for r in rs)
        shapes = collections.defaultdict(lambda: [0, 0])
        for r in rs:
            for iid, ok in zip(r['instruction_id_list'], r['strict']):
                shapes[shape_of(iid)][0] += ok
                shapes[shape_of(iid)][1] += 1
        table.append({
            'variant': variant, 'length': L, 'seeds': len({r['seed'] for r in rs}), 'prompts': n,
            'prompt_strict': round(k / n, 4), 'prompt_strict_ci': wilson(k, n),
            'prompt_loose': round(sum(r['loose_all'] for r in rs) / n, 4),
            'instruction_strict': round(sum(sum(r['strict']) for r in rs) / sum(len(r['strict']) for r in rs), 4),
            'instruction_loose': round(sum(sum(r['loose']) for r in rs) / sum(len(r['loose']) for r in rs), 4),
            'by_type': {s: round(v[0] / v[1], 4) for s, v in sorted(shapes.items())},
        })

    def paired(v1, v2, L):
        """Discordant counts over matching prompts (and matching seeds when both variants have seeds)."""
        b = c = 0
        for (s1, l1), d1 in runs[v1].items():
            if l1 != L:
                continue
            for (s2, l2), d2 in runs[v2].items():
                if l2 != L or (s1 is not None and s2 is not None and s1 != s2):
                    continue
                for key in d1.keys() & d2.keys():
                    b += d1[key] and not d2[key]
                    c += d2[key] and not d1[key]
        return b, c

    lengths = sorted({L for _, L in groups})
    variants = sorted(runs)
    tests = []
    for L in lengths:
        for v1, v2 in [(v, 'base') for v in variants if v != 'base'] + [('ledger', 'lora'), ('ledger', 'ledger_joint'), ('ledger', 'ledger_nogate')]:
            if v1 in runs and v2 in runs:
                b, c = paired(v1, v2, L)
                if b + c:
                    tests.append({'length': L, 'a': v1, 'b': v2, 'only_a': b, 'only_b': c, 'p': mcnemar(b, c)})

    # accuracy change from the shortest context, per variant, with a paired bootstrap over prompts
    rng = np.random.default_rng(0)
    drops = []

    def acc_by_key(variant, L):
        per = collections.defaultdict(list)
        for (s, l), d in runs[variant].items():
            if l == L:
                for key, ok in d.items():
                    per[key].append(ok)
        return {k: float(np.mean(v)) for k, v in per.items()}

    L0 = lengths[0]
    for v in variants:
        a0 = acc_by_key(v, L0)
        for L in lengths[1:]:
            aL = acc_by_key(v, L)
            keys = sorted(a0.keys() & aL.keys())
            if not keys:
                continue
            diff = np.array([aL[k] - a0[k] for k in keys])
            boot = [diff[rng.integers(0, len(diff), len(diff))].mean() for _ in range(a.boot)]
            drops.append({'variant': v, 'from': L0, 'to': L, 'change': round(float(diff.mean()), 4),
                          'ci': [round(float(np.percentile(boot, 2.5)), 4), round(float(np.percentile(boot, 97.5)), 4)]})
    # does the Ledger lose less than each control? (difference of changes, paired over prompts)
    contrasts = []
    for ctrl in ('base', 'lora', 'ledger_joint', 'ledger_nogate'):
        if 'ledger' not in runs or ctrl not in runs:
            continue
        for L in lengths[1:]:
            l0, lL, c0, cL = acc_by_key('ledger', L0), acc_by_key('ledger', L), acc_by_key(ctrl, L0), acc_by_key(ctrl, L)
            keys = sorted(l0.keys() & lL.keys() & c0.keys() & cL.keys())
            if not keys:
                continue
            d = np.array([(lL[k] - l0[k]) - (cL[k] - c0[k]) for k in keys])
            boot = [d[rng.integers(0, len(d), len(d))].mean() for _ in range(a.boot)]
            contrasts.append({'control': ctrl, 'to': L, 'ledger_minus_control_change': round(float(d.mean()), 4),
                              'ci': [round(float(np.percentile(boot, 2.5)), 4), round(float(np.percentile(boot, 97.5)), 4)]})
    summary = {'table': table, 'mcnemar': tests, 'length_change': drops, 'length_contrast': contrasts}
    (res / 'summary.json').write_text(json.dumps(summary, indent=2), encoding='utf-8')
    md = ['| variant | context | seeds | prompt strict (95% CI) | prompt loose | instr. strict | invariant | eventuality | count | unsupported |',
          '|---|---|---|---|---|---|---|---|---|---|']
    for t in table:
        bt = t['by_type']
        md.append(f"| {t['variant']} | {t['length']} | {t['seeds']} | {t['prompt_strict']:.3f} ({t['prompt_strict_ci'][0]:.3f}-{t['prompt_strict_ci'][1]:.3f}) "
                  f"| {t['prompt_loose']:.3f} | {t['instruction_strict']:.3f} | {bt.get('invariant', 0):.3f} | {bt.get('eventuality', 0):.3f} "
                  f"| {bt.get('count', 0):.3f} | {bt.get('unsupported', 0):.3f} |")
    md += ['', '| context | A | B | only A | only B | exact McNemar p |', '|---|---|---|---|---|---|']
    md += [f"| {t['length']} | {t['a']} | {t['b']} | {t['only_a']} | {t['only_b']} | {t['p']:.2g} |" for t in tests]
    md += ['', '| ledger minus control, change of prompt strict accuracy from shortest context | to | mean | 95% CI |', '|---|---|---|---|']
    md += [f"| {c['control']} | {c['to']} | {c['ledger_minus_control_change']:+.3f} | {c['ci'][0]:+.3f} to {c['ci'][1]:+.3f} |" for c in contrasts]
    (res / 'summary.md').write_text('\n'.join(md) + '\n', encoding='utf-8')
    print('\n'.join(md))


if __name__ == '__main__':
    main()
