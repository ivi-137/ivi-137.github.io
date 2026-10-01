"""
Summarise the house-pattern results (results-patterns/*.jsonl): whole answers kept, each monitor and each shape, the
length exponent over the number of items (and the Ledger's minus each control's, paired bootstrap), hazards per
opportunity by item position, the count, stopping with a debt, exact McNemar tests on paired prompts, and the change
with context length (paired bootstrap).

  python pattern_analyze.py --results results-patterns    # writes summary.json and summary.md there
"""
import argparse
import collections
import json
import pathlib

import numpy as np

import patterns as pt
from stats import mcnemar, wilson

SHAPES = ['invariant', 'eventuality', 'order', 'last', 'count']
BINS = [(0, 0, '1'), (1, 3, '2-4'), (4, 7, '5-8'), (8, 99, '9+')]
CONTROLS = ('base', 'lora', 'ledger_joint', 'ledger_nogate')


def kappa(rows, ns, rng=None):
    """Length exponent per item: minus the slope of log S(n); with rng, on a bootstrap resample of each n's prompts."""
    ok, tot = [], []
    for n in ns:
        rs = [r for r in rows if r['n'] == n]
        if rng is not None and rs:
            rs = [rs[i] for i in rng.integers(0, len(rs), len(rs))]
        ok.append(sum(r['coherent'] for r in rs))
        tot.append(len(rs))
    return -pt.log_survival_slope(ns, ok, tot) + 0.0  # no '-0.000'


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('--results', default='results-patterns')
    ap.add_argument('--boot', type=int, default=2000)
    a = ap.parse_args()
    res = pathlib.Path(a.results)
    rows = [json.loads(l) for f in sorted(res.glob('*-L*.jsonl')) for l in f.read_text(encoding='utf-8').splitlines() if l.strip()]
    if not rows:
        raise SystemExit(f'no results in {res}')
    rng = np.random.default_rng(0)
    groups = collections.defaultdict(list)
    for r in rows:
        groups[(r['variant'], r['length'])].append(r)
    lengths = sorted({L for _, L in groups})
    variants = sorted({v for v, _ in groups})
    ns = sorted({r['n'] for r in rows})

    table, by_n, hazards, count, stops, exponents = [], [], [], [], [], []
    for (v, L), rs in sorted(groups.items(), key=lambda x: (x[0][1], x[0][0])):
        n, k = len(rs), sum(r['coherent'] for r in rs)
        mon = collections.defaultdict(lambda: [0, 0])
        shape = collections.defaultdict(lambda: [0, 0])
        for r in rs:
            for name, ver in r['verdicts'].items():
                if ver.get('opportunities') == 0:
                    continue  # an invariant with nothing to keep is kept vacuously: not evidence either way
                mon[name][0] += ver['ok']
                mon[name][1] += 1
                shape[pt.SHAPE_OF_MONITOR[name]][0] += ver['ok']
                shape[pt.SHAPE_OF_MONITOR[name]][1] += 1
        table.append({'variant': v, 'length': L, 'seeds': len({r['seed'] for r in rs}), 'prompts': n, 'coherent': round(k / n, 4),
                      'coherent_ci': wilson(k, n), 'tokens': round(float(np.mean([r['tokens'] for r in rs])), 1),
                      'monitors': {m: round(x[0] / x[1], 4) for m, x in sorted(mon.items())},
                      'shapes': {s: round(shape[s][0] / shape[s][1], 4) for s in SHAPES if shape[s][1]}})
        for nn in ns:
            sub = [r for r in rs if r['n'] == nn]
            if sub:
                kk = sum(r['coherent'] for r in sub)
                by_n.append({'variant': v, 'length': L, 'n': nn, 'prompts': len(sub), 'coherent': round(kk / len(sub), 4), 'ci': wilson(kk, len(sub)),
                             'tokens': round(float(np.mean([r['tokens'] for r in sub])), 1)})
                items = [r['verdicts']['items'] for r in sub]
                count.append({'variant': v, 'length': L, 'n': nn, 'exact': round(float(np.mean([x['ok'] for x in items])), 4),
                              'mean_found': round(float(np.mean([x['found'] for x in items])), 2)})
        k0 = kappa(rs, ns)
        boot = [kappa(rs, ns, rng) for _ in range(a.boot // 4)]
        exponents.append({'variant': v, 'length': L, 'kappa_per_item': round(k0, 4),
                          'ci': [round(float(np.nanpercentile(boot, 2.5)), 4), round(float(np.nanpercentile(boot, 97.5)), 4)]})
        for m in ('marker', 'bold', 'lowercase'):
            h = pt.hazard_rows(rs, m)
            if not h:
                continue
            at, br = sum(x[0] for x in h.values()), sum(x[1] for x in h.values())
            bins = {}
            for lo, hi, name in BINS:
                a_, b_ = sum(h[j][0] for j in h if lo <= j <= hi), sum(h[j][1] for j in h if lo <= j <= hi)
                if a_:
                    bins[name] = {'at_risk': a_, 'breaks': b_, 'rate': round(b_ / a_, 5), 'ci': wilson(b_, a_)}
            hazards.append({'variant': v, 'length': L, 'monitor': m, 'at_risk': at, 'breaks': br, 'rate': round(br / at, 5) if at else 0,
                            'ci': wilson(br, at), 'by_position': bins})
        owed = [(r['n'], name, r['verdicts'][name]['ok']) for r in rs for name in ('tldr', 'sources', 'signoff') if name in r['verdicts']]
        if owed:
            stops.append({'variant': v, 'length': L, 'owed': len(owed), 'unpaid': sum(not ok for _, _, ok in owed),
                          'unpaid_rate': round(sum(not ok for _, _, ok in owed) / len(owed), 4),
                          'by_n': {nn: round(sum(not ok for x, _, ok in owed if x == nn) / max(1, sum(x == nn for x, _, _ in owed)), 4) for nn in ns}})

    # paired tests: the Ledger against each control, same prompts (and seeds when both have them)
    verdict = collections.defaultdict(dict)
    for r in rows:
        verdict[(r['variant'], r['length'])][(r['seed'], r['key'])] = r['coherent']

    def paired(v1, v2, L):
        b = c = 0
        other = collections.defaultdict(dict)
        for (s2, key), y in verdict[(v2, L)].items():
            other[key][s2] = y
        for (s1, key), x in verdict[(v1, L)].items():
            for s2, y in other[key].items():
                if s1 is None or s2 is None or s1 == s2:
                    b += x and not y
                    c += y and not x
        return b, c

    tests = []
    for L in lengths:
        for ctrl in CONTROLS:
            if ('ledger', L) in verdict and (ctrl, L) in verdict:
                b, c = paired('ledger', ctrl, L)
                tests.append({'length': L, 'a': 'ledger', 'b': ctrl, 'only_a': b, 'only_b': c, 'p': mcnemar(b, c)})

    # context length: change from the shortest context, and the Ledger's change minus each control's (paired bootstrap)
    def by_key(v, L):
        per = collections.defaultdict(list)
        for (s, key), x in verdict[(v, L)].items():
            per[key].append(x)
        return {k: float(np.mean(x)) for k, x in per.items()}

    L0 = lengths[0]
    drops, contrasts = [], []
    for v in variants:
        for L in lengths[1:]:
            a0, aL = by_key(v, L0), by_key(v, L)
            keys = sorted(a0.keys() & aL.keys())
            if keys:
                d = np.array([aL[k] - a0[k] for k in keys])
                bt = [d[rng.integers(0, len(d), len(d))].mean() for _ in range(a.boot)]
                drops.append({'variant': v, 'from': L0, 'to': L, 'change': round(float(d.mean()), 4),
                              'ci': [round(float(np.percentile(bt, 2.5)), 4), round(float(np.percentile(bt, 97.5)), 4)]})
    for ctrl in CONTROLS:
        if 'ledger' not in variants or ctrl not in variants:
            continue
        for L in lengths[1:]:
            l0, lL, c0, cL = by_key('ledger', L0), by_key('ledger', L), by_key(ctrl, L0), by_key(ctrl, L)
            keys = sorted(l0.keys() & lL.keys() & c0.keys() & cL.keys())
            if keys:
                d = np.array([(lL[k] - l0[k]) - (cL[k] - c0[k]) for k in keys])
                bt = [d[rng.integers(0, len(d), len(d))].mean() for _ in range(a.boot)]
                contrasts.append({'control': ctrl, 'to': L, 'ledger_minus_control_change': round(float(d.mean()), 4),
                                  'ci': [round(float(np.percentile(bt, 2.5)), 4), round(float(np.percentile(bt, 97.5)), 4)]})

    # the length exponent itself, Ledger minus control: the same prompts resampled for both (within each n)
    n_of = {r['key']: r['n'] for r in rows}

    def kappa_of(pairs):
        """Length exponent per item from (n, share kept) pairs, one per prompt (a share averages the seeds)."""
        ok = [sum(x for m, x in pairs if m == n) for n in ns]
        return -pt.log_survival_slope(ns, ok, [sum(1 for m, _ in pairs if m == n) for n in ns]) + 0.0

    kappa_diffs = []
    for ctrl in CONTROLS:
        if 'ledger' not in variants or ctrl not in variants:
            continue
        for L in lengths:
            a_, c_ = by_key('ledger', L), by_key(ctrl, L)
            keys = sorted(a_.keys() & c_.keys())
            if not keys:
                continue
            per_n = [[k for k in keys if n_of[k] == n] for n in ns]
            bt = []
            for _ in range(a.boot // 4):
                pick = [g[i] for g in per_n if g for i in rng.integers(0, len(g), len(g))]
                bt.append(kappa_of([(n_of[k], a_[k]) for k in pick]) - kappa_of([(n_of[k], c_[k]) for k in pick]))
            ka, kc = kappa_of([(n_of[k], a_[k]) for k in keys]), kappa_of([(n_of[k], c_[k]) for k in keys])
            kappa_diffs.append({'control': ctrl, 'length': L, 'ledger_kappa': round(ka, 4), 'control_kappa': round(kc, 4),
                                'difference': round(ka - kc, 4),
                                'ci': [round(float(np.nanpercentile(bt, 2.5)), 4), round(float(np.nanpercentile(bt, 97.5)), 4)]})

    summary = {'table': table, 'by_n': by_n, 'length_exponent': exponents, 'hazards': hazards, 'count': count, 'stopping_unpaid': stops,
               'mcnemar': tests, 'context_change': drops, 'context_contrast': contrasts,
               'kappa_contrast': kappa_diffs}
    (res / 'summary.json').write_text(json.dumps(summary, indent=2), encoding='utf-8')
    md = ['| variant | context | seeds | coherent (95% CI) | tokens | ' + ' | '.join(SHAPES) + ' |', '|---|---|---|---|---|' + '---|' * len(SHAPES)]
    for t in table:
        md.append(f"| {t['variant']} | {t['length']} | {t['seeds']} | {t['coherent']:.3f} ({t['coherent_ci'][0]:.3f}-{t['coherent_ci'][1]:.3f}) | {t['tokens']} | "
                  + ' | '.join(f"{t['shapes'][s]:.3f}" if s in t['shapes'] else '-' for s in SHAPES) + ' |')
    md += ['', '| variant | context | ' + ' | '.join(f'n={n}' for n in ns) + ' | length exponent per item (95% CI) |', '|---|---|' + '---|' * len(ns) + '---|']
    for e in exponents:
        cells = [next((f"{b['coherent']:.2f}" for b in by_n if b['variant'] == e['variant'] and b['length'] == e['length'] and b['n'] == n), '-') for n in ns]
        md.append(f"| {e['variant']} | {e['length']} | " + ' | '.join(cells) + f" | {e['kappa_per_item']:.3f} ({e['ci'][0]:.3f} to {e['ci'][1]:.3f}) |")
    md += ['', '| context | control | length exponent, ledger | control | ledger minus control (95% CI) |', '|---|---|---|---|---|']
    md += [f"| {k['length']} | {k['control']} | {k['ledger_kappa']:.3f} | {k['control_kappa']:.3f} | {k['difference']:+.3f} ({k['ci'][0]:+.3f} to {k['ci'][1]:+.3f}) |"
           for k in kappa_diffs]
    md += ['', '| variant | context | monitor | hazard per opportunity (95% CI) | ' + ' | '.join(f'item {b[2]}' for b in BINS) + ' |', '|---|---|---|---|' + '---|' * len(BINS)]
    for h in hazards:
        md.append(f"| {h['variant']} | {h['length']} | {h['monitor']} | {h['rate']:.4f} ({h['ci'][0]:.4f}-{h['ci'][1]:.4f}) | "
                  + ' | '.join(f"{h['by_position'][b[2]]['rate']:.4f}" if b[2] in h['by_position'] else '-' for b in BINS) + ' |')
    md += ['', '| variant | context | ' + ' | '.join(f'count exact n={n}' for n in ns) + ' | debts unpaid at the end |', '|---|---|' + '---|' * len(ns) + '---|']
    for v in variants:
        for L in lengths:
            cells = [next((f"{c['exact']:.2f}" for c in count if c['variant'] == v and c['length'] == L and c['n'] == n), '-') for n in ns]
            st = next((s for s in stops if s['variant'] == v and s['length'] == L), None)
            md.append(f'| {v} | {L} | ' + ' | '.join(cells) + f" | {st['unpaid_rate']:.3f} of {st['owed']} |" if st else f'| {v} | {L} | ' + ' | '.join(cells) + ' | - |')
    md += ['', '| context | A | B | only A | only B | exact McNemar p |', '|---|---|---|---|---|---|']
    md += [f"| {t['length']} | {t['a']} | {t['b']} | {t['only_a']} | {t['only_b']} | {t['p']:.2g} |" for t in tests]
    md += ['', '| ledger minus control, change of coherent share from the shortest context | to | mean | 95% CI |', '|---|---|---|---|']
    md += [f"| {c['control']} | {c['to']} | {c['ledger_minus_control_change']:+.3f} | {c['ci'][0]:+.3f} to {c['ci'][1]:+.3f} |" for c in contrasts]
    (res / 'summary.md').write_text('\n'.join(md) + '\n', encoding='utf-8')
    print('\n'.join(md))


if __name__ == '__main__':
    main()
