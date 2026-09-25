"""
Train one variant on the toy task.

  python train.py --variant ledger --seed 0 --steps 3000
"""
from __future__ import annotations

import argparse
import json
import pickle
import time
from pathlib import Path

import jax
import jax.numpy as jnp
import numpy as np
import optax

import model as M
from toy import batch

OUT = Path(__file__).parent / 'runs'


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--variant', default='base')
    ap.add_argument('--seed', type=int, default=0)
    ap.add_argument('--steps', type=int, default=3000)
    ap.add_argument('--bs', type=int, default=32)
    ap.add_argument('--T', type=int, default=288)
    ap.add_argument('--lr', type=float, default=2e-3)
    ap.add_argument('--d', type=int, default=64)
    ap.add_argument('--L', type=int, default=3)
    a = ap.parse_args()

    cfg = M.default_cfg(a.variant, d=a.d, L=a.L, dff=4 * a.d)
    key = jax.random.PRNGKey(a.seed)
    params = M.init(key, cfg)
    sched = optax.warmup_cosine_decay_schedule(0.0, a.lr, min(200, a.steps // 10), a.steps, a.lr * 0.05)
    opt = optax.chain(optax.clip_by_global_norm(1.0), optax.adamw(sched, weight_decay=0.01))
    state = opt.init(params)

    @jax.jit
    def step(params, state, b):
        (loss, met), grads = jax.value_and_grad(M.loss_fn, has_aux=True)(params, b, cfg)
        upd, state = opt.update(grads, state, params)
        return optax.apply_updates(params, upd), state, loss, met

    r = np.random.default_rng(1000 + a.seed)
    log = []
    t0 = time.time()
    for i in range(1, a.steps + 1):
        b = {k: jnp.asarray(v) for k, v in batch(r, a.bs, a.T).items()}
        params, state, loss, met = step(params, state, b)
        if i % 100 == 0 or i == 1:
            m = {k: float(v) for k, v in met.items()}
            m.update(step=i, loss=float(loss), sec=round(time.time() - t0, 1))
            if M.has_ledger(cfg):
                L = params['ledger']
                m['gamma'] = float(L['gamma'])
                m['g'] = [round(float(jnp.tanh(rp['g'])), 3) for rp in L['read']]
            log.append(m)
            print(json.dumps(m), flush=True)
    name = f'{a.variant}-s{a.seed}'
    OUT.mkdir(exist_ok=True)
    with open(OUT / f'{name}.pkl', 'wb') as f:
        pickle.dump({'cfg': cfg, 'params': jax.device_get(params), 'log': log, 'n_params': int(M.n_params(params))}, f)
    print('saved', name, 'params', M.n_params(params))


if __name__ == '__main__':
    main()
