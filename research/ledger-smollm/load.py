"""Load the frozen model and wrap it as one of the variants; save and restore the trained parameters of a run."""
import dataclasses
import json
import pathlib

import torch
from transformers import AutoModelForCausalLM, AutoTokenizer

from chat import eos_ids
from ledger import Ledger, LedgerConfig, LedgerLM

DEFAULT_MODEL = 'HuggingFaceTB/SmolLM2-135M-Instruct'


def ledger_params(mcfg, lcfg):
    return sum(p.numel() for p in Ledger(dataclasses.replace(lcfg, joint=False), mcfg).parameters())


def matched_lora_rank(mcfg, lcfg):
    """LoRA rank on q_proj and v_proj whose parameter count is closest to the Ledger's."""
    d = mcfg.hidden_size
    head_dim = getattr(mcfg, 'head_dim', None) or d // mcfg.num_attention_heads
    per_rank = mcfg.num_hidden_layers * ((d + mcfg.num_attention_heads * head_dim) + (d + mcfg.num_key_value_heads * head_dim))
    return max(1, round(ledger_params(mcfg, lcfg) / per_rank))


def resolve_dtype(dtype, device):
    """'auto': bfloat16 for the frozen model on a GPU that supports it (half the memory), float32 otherwise.
    The Ledger and the LoRA adapters always keep float32 parameters."""
    if dtype != 'auto':
        return getattr(torch, dtype) if isinstance(dtype, str) else dtype
    return torch.bfloat16 if device.type == 'cuda' and torch.cuda.is_bf16_supported() else torch.float32


def build(model, variant, device, lcfg=None, lora_rank=None, dtype='auto'):
    tok = AutoTokenizer.from_pretrained(model)
    backbone = AutoModelForCausalLM.from_pretrained(model, dtype=resolve_dtype(dtype, device), attn_implementation='sdpa')
    lcfg = lcfg or LedgerConfig()
    rank = lora_rank or matched_lora_rank(backbone.config, lcfg)
    lm = LedgerLM(backbone, variant, lcfg, rank, eos_ids(tok)).to(device)
    return lm, tok, rank


def save_run(path, lm, info):
    path = pathlib.Path(path)
    path.mkdir(parents=True, exist_ok=True)
    torch.save(lm.trainable_state(), path / 'weights.pt')
    (path / 'run.json').write_text(json.dumps(info, indent=2), encoding='utf-8')


def load_run(path, device, model=None, dtype='auto'):
    path = pathlib.Path(path)
    info = json.loads((path / 'run.json').read_text(encoding='utf-8'))
    lcfg = LedgerConfig(**info['ledger']) if info.get('ledger') else None
    lm, tok, _ = build(model or info['model'], info['variant'], device, lcfg, info.get('lora_rank'), dtype)
    state = torch.load(path / 'weights.pt', map_location=device)
    missing = {n for n, p in lm.named_parameters() if p.requires_grad} - set(state)
    if missing:
        raise ValueError(f'{path}: weights missing for {sorted(missing)[:5]}')
    lm.load_state_dict(state, strict=False)
    lm.eval()
    return lm, tok, info
