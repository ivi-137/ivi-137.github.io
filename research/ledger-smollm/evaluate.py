"""
Official IFEval (541 prompts, strict and loose) for one variant, at several context lengths.

At length L > 0 each request is followed by L tokens of unrelated background text and a line asking for a
response to the request above; the checkers still see the original request. This is the paper's key test: the
share of attention left for the instructions shrinks with L (Lemma 1), the Ledger's read does not (Prop. 6 (ii)).

  python evaluate.py --variant base --lengths 0 1000 2000 4000
  python evaluate.py --run runs/ledger-s0 --lengths 0 1000 2000 4000
"""
import argparse
import json
import pathlib
import time

import torch

from chat import device_auto, generate, with_distractor
from ifeval_bridge import load_ifeval, score
from load import DEFAULT_MODEL, build, load_run


def backgrounds(tok, passages, n, length, seed=0):
    """n background texts of `length` tokens, cut from the passage corpus at fixed, prompt-specific offsets."""
    if length <= 0:
        return [''] * n
    ids = tok('\n\n'.join(passages), add_special_tokens=False)['input_ids']
    if not ids:
        raise SystemExit('no background passages: run data.py first')
    if len(ids) < length:
        ids = ids * (length // max(1, len(ids)) + 1)
    step = max(1, (len(ids) - length) // max(1, n))
    return [tok.decode(ids[(i * step + seed) % max(1, len(ids) - length) :][:length]) for i in range(n)]


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('--run', help='a trained run directory (runs/<variant>-s<seed>)')
    ap.add_argument('--variant', default='base', help='used when no --run is given')
    ap.add_argument('--model', default=None)
    ap.add_argument('--lengths', type=int, nargs='+', default=[0])
    ap.add_argument('--limit', type=int, default=0, help='first N IFEval prompts only')
    ap.add_argument('--max-new-tokens', type=int, default=1024)
    ap.add_argument('--batch-size', type=int, default=16)
    ap.add_argument('--max-batch-tokens', type=int, default=65536, help='smaller batches at long contexts (memory)')
    ap.add_argument('--distractors', default='data/distractors.jsonl')
    ap.add_argument('--out', default='results')
    ap.add_argument('--device', default='auto')
    a = ap.parse_args()
    dev = device_auto(a.device)
    if a.run:
        lm, tok, info = load_run(a.run, dev, a.model)
        name = pathlib.Path(a.run).name
    else:
        lm, tok, _ = build(a.model or DEFAULT_MODEL, a.variant, dev)
        info, name = {'variant': a.variant, 'seed': None}, a.variant
    lm.eval()
    examples = load_ifeval()
    examples = examples[: a.limit] if a.limit else examples
    passages = [json.loads(line)['text'] for line in pathlib.Path(a.distractors).read_text().splitlines() if line.strip()] if any(a.lengths) else []
    out = pathlib.Path(a.out)
    out.mkdir(parents=True, exist_ok=True)
    for L in a.lengths:
        t0 = time.time()
        bg = backgrounds(tok, passages, len(examples), L)
        inputs = [with_distractor(e['prompt'], b) for e, b in zip(examples, bg)]
        bs = max(1, min(a.batch_size, a.max_batch_tokens // (L + 256 + a.max_new_tokens)))
        responses = generate(lm, tok, inputs, max_new_tokens=a.max_new_tokens, batch_size=bs,
                             log=lambda m: print(f'  L={L} {m}', flush=True))
        rows = []
        for e, r in zip(examples, responses):
            s = score(e, r)
            rows.append({'key': e['key'], 'length': L, 'variant': info['variant'], 'seed': info.get('seed'),
                         'instruction_id_list': e['instruction_id_list'], **s, 'response': r})
        path = out / f'{name}-L{L}.jsonl'
        path.write_text(''.join(json.dumps(r) + '\n' for r in rows))
        acc = sum(r['strict_all'] for r in rows) / len(rows)
        ins = sum(sum(r['strict']) for r in rows) / sum(len(r['strict']) for r in rows)
        print(f'{name} L={L}: prompt-level strict {acc:.3f}, instruction-level strict {ins:.3f} '
              f'({len(rows)} prompts, {time.time() - t0:.0f}s) -> {path}', flush=True)


if __name__ == '__main__':
    torch.set_grad_enabled(False)
    main()
