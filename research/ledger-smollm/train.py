"""
Train one variant on the frozen model: only the Ledger (or the LoRA adapters) learn.

  python train.py --variant ledger --seed 0            # also: lora, ledger_joint, ledger_nogate
"""
import argparse
import dataclasses
import json
import math
import pathlib
import random
import time

import numpy as np
import torch

from batching import collate, make_example, to
from chat import device_auto
from ledger import LedgerConfig
from load import DEFAULT_MODEL, build, save_run


def batches(examples, size, rng, max_tokens):
    """Shuffled batches of similar length (less padding), at most `size` examples and `max_tokens` padded tokens."""
    length = lambda i: len(examples[i]['p_ids']) + len(examples[i]['r_ids'])
    chunks, cur = [], []
    for i in sorted(range(len(examples)), key=length):
        if cur and (len(cur) == size or (len(cur) + 1) * length(i) > max_tokens):
            chunks.append(cur)
            cur = []
        cur.append(i)
    if cur:
        chunks.append(cur)
    rng.shuffle(chunks)
    return chunks


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('--model', default=DEFAULT_MODEL)
    ap.add_argument('--variant', required=True, choices=['lora', 'ledger', 'ledger_joint', 'ledger_nogate'])
    ap.add_argument('--data', default='data/train.jsonl')
    ap.add_argument('--out', default='runs')
    ap.add_argument('--seed', type=int, default=0)
    ap.add_argument('--epochs', type=float, default=2)
    ap.add_argument('--batch-size', type=int, default=8)
    ap.add_argument('--lr', type=float, default=None, help='default 1e-3 for the Ledger, 3e-4 for LoRA')
    ap.add_argument('--max-len', type=int, default=2048)
    ap.add_argument('--max-batch-tokens', type=int, default=3072, help='cap on padded tokens per batch (memory)')
    ap.add_argument('--dtype', default='auto', help='frozen model precision: auto (bfloat16 on a GPU), float32, bfloat16')
    ap.add_argument('--clerk-layer', type=int, default=9)
    ap.add_argument('--width', type=int, default=128)
    ap.add_argument('--heads', type=int, default=4)
    ap.add_argument('--lora-rank', type=int, default=None, help='default: matched to the Ledger\'s parameter count')
    ap.add_argument('--lam-ext', type=float, default=0.3)
    ap.add_argument('--lam-ev', type=float, default=0.3)
    ap.add_argument('--limit', type=int, default=0, help='use only the first N records')
    ap.add_argument('--max-minutes', type=float, default=0, help='stop training after this long (0: no limit)')
    ap.add_argument('--device', default='auto')
    a = ap.parse_args()
    random.seed(a.seed), np.random.seed(a.seed), torch.manual_seed(a.seed)
    name = f'{a.variant}-s{a.seed}'
    out = pathlib.Path(a.out) / name
    t0 = time.time()
    log_lines = []

    def log(msg, **kv):
        line = {'t': round(time.time() - t0, 1), 'msg': msg, **kv}
        log_lines.append(line)
        print(f'[{line["t"]:7.0f}s] {msg} ' + ' '.join(f'{k}={v}' for k, v in kv.items()), flush=True)

    dev = device_auto(a.device)
    lcfg = LedgerConfig(clerk_layer=a.clerk_layer, width=a.width, heads=a.heads)
    lm, tok, rank = build(a.model, a.variant, dev, lcfg, a.lora_rank, a.dtype)
    lm.backbone.eval()
    params = sum(p.numel() for p in lm.trainable())
    log('built', variant=a.variant, trainable=params, lora_rank=rank if a.variant == 'lora' else None, device=str(dev),
        dtype=str(next(lm.backbone.parameters()).dtype))

    recs = [json.loads(line) for line in pathlib.Path(a.data).read_text(encoding='utf-8').splitlines() if line.strip()]
    recs = recs[: a.limit] if a.limit else recs
    examples = [e for e in (make_example(tok, r, tok.eos_token_id, a.max_len) for r in recs) if e is not None]
    log('examples', kept=len(examples), dropped_too_long=len(recs) - len(examples))
    rng = random.Random(a.seed)
    steps_per_epoch = len(batches(examples, a.batch_size, random.Random(0), a.max_batch_tokens))
    total = max(1, int(steps_per_epoch * a.epochs))
    lr = a.lr or (3e-4 if a.variant == 'lora' else 1e-3)
    opt = torch.optim.AdamW(lm.trainable(), lr=lr, weight_decay=0.0)
    warm = max(1, total // 20)
    sched = torch.optim.lr_scheduler.LambdaLR(opt, lambda s: min(1, (s + 1) / warm) * 0.5 * (1 + math.cos(math.pi * min(1, s / total))))
    step, stopped = 0, False
    run = {}
    while step < total and not stopped:
        for chunk in batches(examples, a.batch_size, rng, a.max_batch_tokens):
            b = to(collate([examples[i] for i in chunk], tok.pad_token_id), dev)
            losses = lm.loss(b, a.lam_ext, a.lam_ev)
            opt.zero_grad(set_to_none=True)
            losses['total'].backward()
            torch.nn.utils.clip_grad_norm_(lm.trainable(), 1.0)
            opt.step()
            sched.step()
            step += 1
            for k, v in losses.items():
                v = float(v.detach())
                run[k] = 0.95 * run.get(k, v) + 0.05 * v
            if step % 20 == 0 or step == total:
                extra = {}
                if lm.ledger is not None:
                    with torch.no_grad():
                        gs = [float(r.lam) if lm.ledger.cfg.joint else float(torch.tanh(r.g)) for r in lm.ledger.reads.values()]
                        extra = {'read_gate_mean': round(float(np.mean(gs)), 6), 'gamma': round(float(lm.ledger.gamma), 4)}
                log('step', step=step, of=total, **{k: round(v, 4) for k, v in run.items()}, **extra)
            if step >= total or (a.max_minutes and time.time() - t0 > 60 * a.max_minutes):
                stopped = step < total
                break
    info = {'variant': a.variant, 'model': a.model, 'seed': a.seed, 'trainable_params': params, 'steps': step, 'planned_steps': total,
            'stopped_early': stopped, 'minutes': round((time.time() - t0) / 60, 2), 'final': {k: round(v, 5) for k, v in run.items()},
            'ledger': dataclasses.asdict(lcfg) if a.variant.startswith('ledger') else None,
            'lora_rank': rank if a.variant == 'lora' else None, 'args': vars(a)}
    save_run(out, lm, info)
    (out / 'log.jsonl').write_text(''.join(json.dumps(x) + '\n' for x in log_lines), encoding='utf-8')
    log('saved', path=str(out))


if __name__ == '__main__':
    main()
