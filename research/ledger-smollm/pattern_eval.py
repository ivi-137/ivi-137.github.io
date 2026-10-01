"""
The house-pattern test for one variant, at several context lengths: every test prompt answered, every answer audited.

At length L > 0, L tokens of unrelated background text sit between the two example answers and the new question, so
the evidence for the house pattern recedes while the question stays close. The output length is the other axis: the
test asks for 3, 6, 9 and 12 items.

  python pattern_eval.py --variant base --lengths 0 2000 6000
  python pattern_eval.py --run runs-patterns/ledger-s0 --lengths 0 2000 6000
"""
import argparse
import json
import os
import pathlib
import time

import torch

import patterns as pt
from chat import backgrounds, device_auto, generate
from load import DEFAULT_MODEL, build, load_run


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('--run', help='a trained run directory (runs/<variant>-s<seed>)')
    ap.add_argument('--variant', default='base', help='used when no --run is given')
    ap.add_argument('--model', default=None)
    ap.add_argument('--test', default='data-patterns/test.jsonl')
    ap.add_argument('--distractors', default='data-patterns/distractors.jsonl')
    ap.add_argument('--lengths', type=int, nargs='+', default=[0])
    ap.add_argument('--limit', type=int, default=0, help='first N test prompts of each n only')
    ap.add_argument('--max-new-tokens', type=int, default=1024)
    ap.add_argument('--batch-size', type=int, default=16)
    ap.add_argument('--max-batch-tokens', type=int, default=32768)
    ap.add_argument('--out', default='results-patterns')
    ap.add_argument('--device', default='auto')
    ap.add_argument('--dtype', default='auto')
    ap.add_argument('--overwrite', action='store_true')
    a = ap.parse_args()
    dev = device_auto(a.device)
    if a.run:
        lm, tok, info = load_run(a.run, dev, a.model, a.dtype)
        name = pathlib.Path(a.run).name
    else:
        lm, tok, _ = build(a.model or DEFAULT_MODEL, a.variant, dev, dtype=a.dtype)
        info, name = {'variant': a.variant, 'seed': None}, a.variant
    lm.eval()
    tests = [json.loads(l) for l in pathlib.Path(a.test).read_text(encoding='utf-8').splitlines() if l.strip()]
    if a.limit:
        seen = {}
        tests = [t for t in tests if seen.setdefault(t['n'], []).append(t) or len(seen[t['n']]) <= a.limit]
    passages = [json.loads(l)['text'] for l in pathlib.Path(a.distractors).read_text(encoding='utf-8').splitlines() if l.strip()] if any(a.lengths) else []
    out = pathlib.Path(a.out)
    out.mkdir(parents=True, exist_ok=True)
    for L in a.lengths:
        path = out / f'{name}-L{L}.jsonl'
        if path.exists() and not a.overwrite:
            print(f'{name} L={L}: already done -> {path}', flush=True)
            continue
        t0 = time.time()
        bg = backgrounds(tok, passages, len(tests), L)
        inputs = [pt.assemble(t['parts'], b) for t, b in zip(tests, bg)]
        bs = max(1, min(a.batch_size, a.max_batch_tokens // (L + 1024 + a.max_new_tokens)))
        responses = generate(lm, tok, inputs, max_new_tokens=a.max_new_tokens, batch_size=bs, log=lambda m: print(f'  L={L} {m}', flush=True))
        rows = []
        for t, r in zip(tests, responses):
            v = pt.audit(r, t['rules'], t['n'])
            rows.append({'key': t['key'], 'n': t['n'], 'length': L, 'variant': info['variant'], 'seed': info.get('seed'), 'rules': t['rules'],
                         'verdicts': v, 'coherent': pt.coherent(v), 'tokens': len(tok(r, add_special_tokens=False)['input_ids']), 'response': r})
        tmp = path.with_name(path.name + '.tmp')
        tmp.write_text(''.join(json.dumps(r) + '\n' for r in rows), encoding='utf-8')
        os.replace(tmp, path)
        acc = sum(r['coherent'] for r in rows) / max(1, len(rows))
        by_n = {n: sum(r['coherent'] for r in rows if r['n'] == n) / max(1, sum(r['n'] == n for r in rows)) for n in sorted({r['n'] for r in rows})}
        print(f'{name} L={L}: coherent {acc:.3f} ' + ' '.join(f'n={n}:{v:.2f}' for n, v in by_n.items()) + f' ({len(rows)} prompts, {time.time() - t0:.0f}s) -> {path}', flush=True)


if __name__ == '__main__':
    torch.set_grad_enabled(False)
    main()
