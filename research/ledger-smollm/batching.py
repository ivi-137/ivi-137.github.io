"""
Training examples: a chat prompt, a response that keeps its instructions, and the Ledger's labels.

A record (one JSON line of data/train.jsonl) holds
  prompt       the request with its instructions (what IFEval-style checkers read)
  input        what the model is shown (the prompt, possibly followed by background notes)
  response     a response that passes every checker
  instruction_id_list, kwargs
"""
import math

import numpy as np
import torch

import obligations as ob
from chat import encode_prompt, encode_response


def make_example(tok, rec, eos_id, max_len=1024):
    p_ids, numfeat = encode_prompt(tok, rec.get('input', rec['prompt']))
    r_ids, ends = encode_response(tok, rec['response'])
    r_ids, ends = r_ids + [eos_id], ends + [len(rec['response'])]
    if len(p_ids) + len(r_ids) > max_len:
        return None
    K = ob.K
    applies = np.zeros(K, np.float32)
    relation = np.full(K, -100, np.int64)
    nlog = np.zeros(K, np.float32)
    paid = np.zeros((len(r_ids), K), np.float32)
    event = np.zeros((len(r_ids), K), np.float32)
    for iid, kw in zip(rec['instruction_id_list'], rec['kwargs']):
        if iid not in ob.SLOT:
            continue
        k = ob.SLOT[iid]
        applies[k] = 1
        if ob.SHAPE[k] == ob.N:
            rel, n = ob.target(iid, kw)
            relation[k], nlog[k] = rel, math.log1p(n)
        lab = ob.token_targets(iid, kw, rec['response'], ends, prompt=rec['prompt'])
        (paid if ob.SHAPE[k] == ob.F else event)[:, k] = lab
    return {'p_ids': p_ids, 'numfeat': numfeat, 'r_ids': r_ids, 'applies': applies, 'relation': relation, 'nlog': nlog, 'paid': paid, 'event': event}


def collate(examples, pad_id):
    B = len(examples)
    T = max(len(e['p_ids']) + len(e['r_ids']) for e in examples)
    K = ob.K
    out = {
        'input_ids': torch.full((B, T), pad_id, dtype=torch.long),
        'attention_mask': torch.zeros((B, T), dtype=torch.long),
        'prompt_mask': torch.zeros((B, T), dtype=torch.bool),
        'resp_mask': torch.zeros((B, T), dtype=torch.bool),
        'rmask': torch.zeros((B, T), dtype=torch.bool),
        'lm_mask': torch.zeros((B, T), dtype=torch.bool),
        'numfeat': torch.zeros((B, T, 2)),
        'paid': torch.zeros((B, T, K)),
        'event': torch.zeros((B, T, K)),
        'applies': torch.from_numpy(np.stack([e['applies'] for e in examples])),
        'relation': torch.from_numpy(np.stack([e['relation'] for e in examples])),
        'nlog': torch.from_numpy(np.stack([e['nlog'] for e in examples])),
    }
    for b, e in enumerate(examples):
        P, R = len(e['p_ids']), len(e['r_ids'])
        out['input_ids'][b, : P + R] = torch.tensor(e['p_ids'] + e['r_ids'])
        out['attention_mask'][b, : P + R] = 1
        out['prompt_mask'][b, :P] = True
        out['resp_mask'][b, P : P + R] = True
        out['rmask'][b, P - 1 : P + R] = True  # the last prompt position predicts the first response token
        out['lm_mask'][b, P - 1 : P + R - 1] = True
        out['numfeat'][b, :P] = torch.from_numpy(e['numfeat'])
        out['paid'][b, P : P + R] = torch.from_numpy(e['paid'])
        out['event'][b, P : P + R] = torch.from_numpy(e['event'])
    return out


def to(batch, device):
    return {k: v.to(device) for k, v in batch.items()}
