"""
Export trained runs for the in-browser demo.

  python export.py runs/base-s0.pkl runs/ledger-s0.pkl --out ../../public/coherence

Writes <name>.bin (float16, little-endian) and <name>.json (config, tensor table, and the
toy's vocabulary and bigram chain, so the page can make prompts from the same distribution).
"""
from __future__ import annotations

import argparse
import json
import pickle
from pathlib import Path

import numpy as np

import toy


def flat(tree, prefix=''):
    if isinstance(tree, dict):
        for k in sorted(tree):
            yield from flat(tree[k], f'{prefix}.{k}' if prefix else k)
    elif isinstance(tree, (list, tuple)):
        for i, v in enumerate(tree):
            yield from flat(v, f'{prefix}.{i}')
    else:
        yield prefix, np.asarray(tree, np.float32)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('runs', nargs='+')
    ap.add_argument('--out', default='../../public/coherence')
    a = ap.parse_args()
    out = Path(a.out)
    out.mkdir(parents=True, exist_ok=True)
    for path in a.runs:
        run = pickle.load(open(path, 'rb'))
        name = run['cfg']['variant']
        tensors, blob, off = [], [], 0
        for key, arr in flat(run['params']):
            h = arr.astype(np.float16)
            tensors.append({'name': key, 'shape': list(arr.shape), 'offset': off})
            blob.append(h.tobytes())
            off += h.size
        (out / f'{name}.bin').write_bytes(b''.join(blob))
        meta = {
            'cfg': run['cfg'],
            'tensors': tensors,
            'vocab': toy.VOCAB,
            'bigram': np.round(toy.BIGRAM, 5).tolist(),
            'prior': {'font': toy.P_FONT.tolist(), 'head': toy.P_HEAD.tolist(), 'math': toy.P_MATH.tolist(), 'why': toy.P_WHY, 'src': toy.P_SRC, 'formula': toy.P_FORMULA},
            'k': [toy.K_MIN, toy.K_MAX],
            'n_params': run['n_params'],
        }
        (out / f'{name}.json').write_text(json.dumps(meta, separators=(',', ':')))
        print(name, off, 'params', f'{off * 2 / 1024:.0f} KiB')


if __name__ == '__main__':
    main()
