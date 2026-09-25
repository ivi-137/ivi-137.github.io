"""
Encoding prompts and responses for a chat model, and a batched decoding loop that carries the Ledger's state.
"""
import math

import numpy as np
import torch

import obligations as ob

DISTRACTOR_HEAD = '\n\nBackground notes (not part of the request):\n'
DISTRACTOR_TAIL = '\n\nNow respond to the request above.'


def device_auto(name='auto'):
    torch.set_float32_matmul_precision('high')
    if name != 'auto':
        return torch.device(name)
    if torch.cuda.is_available():
        return torch.device('cuda')
    if torch.backends.mps.is_available():
        return torch.device('mps')
    return torch.device('cpu')


def eos_ids(tok):
    ids = {tok.eos_token_id}
    for t in ('<|im_end|>', '<|endoftext|>'):
        i = tok.convert_tokens_to_ids(t)
        if isinstance(i, int) and i != tok.unk_token_id and i is not None and i >= 0:
            ids.add(i)
    return sorted(i for i in ids if i is not None)


def with_distractor(prompt, distractor_text):
    return prompt + DISTRACTOR_HEAD + distractor_text + DISTRACTOR_TAIL if distractor_text else prompt


def encode_prompt(tok, user_text):
    """Token ids of the chat-formatted prompt (ending with the assistant header) and per-token number features."""
    text = tok.apply_chat_template([{'role': 'user', 'content': user_text}], add_generation_prompt=True, tokenize=False)
    enc = tok(text, add_special_tokens=False, return_offsets_mapping=True)
    ids, spans = enc['input_ids'], enc['offset_mapping']
    feat = np.zeros((len(ids), 2), np.float32)
    marks = ob.numbers(text)
    for t, (a, b) in enumerate(spans):
        for s, e, v in marks:
            if a < e and s < b:
                feat[t] = (1.0, math.log1p(v))
    return ids, feat


def encode_response(tok, text):
    """Token ids of a response and the character position at which each token ends."""
    enc = tok(text, add_special_tokens=False, return_offsets_mapping=True)
    return enc['input_ids'], [b for _, b in enc['offset_mapping']]


def _sample(logits, temperature, top_p, gen):
    if temperature <= 0:
        return logits.argmax(-1)
    probs = torch.softmax(logits.float() / temperature, -1)
    if top_p < 1:
        sorted_p, idx = probs.sort(-1, descending=True)
        keep = sorted_p.cumsum(-1) - sorted_p < top_p
        sorted_p = sorted_p * keep
        probs = torch.zeros_like(probs).scatter(-1, idx, sorted_p)
    probs = (probs / probs.sum(-1, keepdim=True)).cpu()  # the seeded generator lives on the CPU
    return torch.multinomial(probs, 1, generator=gen)[:, 0]


@torch.no_grad()
def generate(lm, tok, prompts, max_new_tokens=512, temperature=0.0, top_p=1.0, batch_size=16, seed=0, log=None):
    """Responses (strings) to user prompts, in order. Left-padded batches, KV cache, Ledger state carried."""
    dev = next(lm.backbone.parameters()).device
    stop = torch.tensor(eos_ids(tok), device=dev)
    pad = tok.pad_token_id if tok.pad_token_id is not None else int(stop[0])
    gen = torch.Generator(device='cpu').manual_seed(seed)
    encoded = [encode_prompt(tok, p) for p in prompts]
    order = sorted(range(len(prompts)), key=lambda i: -len(encoded[i][0]))
    out = [None] * len(prompts)
    for start in range(0, len(order), batch_size):
        idx = order[start : start + batch_size]
        T = max(len(encoded[i][0]) for i in idx)
        ids = torch.full((len(idx), T), pad, dtype=torch.long)
        mask = torch.zeros((len(idx), T), dtype=torch.long)
        feat = torch.zeros((len(idx), T, 2))
        for r, i in enumerate(idx):
            e, f = encoded[i]
            ids[r, T - len(e) :] = torch.tensor(e)
            mask[r, T - len(e) :] = 1
            feat[r, T - len(e) :] = torch.from_numpy(f)
        ids, mask, feat = ids.to(dev), mask.to(dev), feat.to(dev)
        logits, session = lm.prefill(ids, mask, feat)
        done = torch.zeros(len(idx), dtype=torch.bool, device=dev)
        toks = []
        for _ in range(max_new_tokens):
            nxt = _sample(logits, temperature, top_p, gen).to(dev)
            nxt = torch.where(done, torch.full_like(nxt, pad), nxt)
            toks.append(nxt)
            done |= torch.isin(nxt, stop)
            if bool(done.all()):
                break
            logits = lm.decode(session, nxt)
        seqs = torch.stack(toks, 1).cpu() if toks else torch.zeros(len(idx), 0, dtype=torch.long)
        for r, i in enumerate(idx):
            row = seqs[r].tolist()
            cut = next((j for j, t in enumerate(row) if t in set(stop.tolist())), len(row))
            out[i] = tok.decode(row[:cut], skip_special_tokens=True)
        if log:
            log(f'generated {min(start + batch_size, len(order))}/{len(order)}')
    return out
