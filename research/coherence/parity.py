"""
Reference logits for checking the browser implementation (src/lib/coherence/net.ts).

  python parity.py runs/ledger-s0.pkl out.json
Uses the float16-rounded weights, exactly as exported.
"""
import json
import pickle
import sys

import jax
import jax.numpy as jnp
import numpy as np

import model as M
from toy import episode

run = pickle.load(open(sys.argv[1], 'rb'))
cfg = run['cfg']
params = jax.tree_util.tree_map(lambda a: jnp.asarray(np.asarray(a, np.float16).astype(np.float32)), run['params'])
seq, g, st, k = episode(np.random.default_rng(5))
seq = seq[: g + 40]
x = jnp.asarray([seq])
gm = jnp.asarray([[0.0] * g + [1.0] * (len(seq) - g)])
logits, ex = M.forward(params, x, gm, cfg)
out = {'seq': seq, 'g': g, 'logits': np.asarray(logits[0, g:]).tolist()}
if 'u' in ex:
    out['u'] = np.asarray(ex['u'][0, -1]).tolist()
    out['pend'] = np.asarray(ex['pend'][0, -1]).tolist()
json.dump(out, open(sys.argv[2], 'w'))
print('ok', len(seq), g)
