"""
A tiny random-weight model with SmolLM2's architecture (Llama, grouped-query attention, tied embeddings) and a
small byte-level BPE tokenizer with SmolLM2's chat format, saved like a Hugging Face checkpoint. The tests and the
pipeline smoke run use it where the real weights cannot be downloaded; nothing about its outputs is meaningful.
"""
import pathlib

import torch
from tokenizers import Tokenizer, decoders, models, pre_tokenizers, processors, trainers
from transformers import LlamaConfig, LlamaForCausalLM, PreTrainedTokenizerFast

import sys

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1]))
from ifeval_bridge import load_ifeval  # noqa: E402

CHAT_TEMPLATE = (
    "{% for message in messages %}{% if loop.first and messages[0]['role'] != 'system' %}"
    "{{ '<|im_start|>system\nYou are a helpful AI assistant named SmolLM, trained by Hugging Face<|im_end|>\n' }}"
    "{% endif %}{{ '<|im_start|>' + message['role'] + '\n' + message['content'] + '<|im_end|>' + '\n' }}{% endfor %}"
    "{% if add_generation_prompt %}{{ '<|im_start|>assistant\n' }}{% endif %}"
)
SPECIAL = ['<|endoftext|>', '<|im_start|>', '<|im_end|>']


def build(path, layers=4, hidden=64, seed=0):
    path = pathlib.Path(path)
    if (path / 'config.json').exists():
        return path
    path.mkdir(parents=True, exist_ok=True)
    corpus = [e['prompt'] for e in load_ifeval()] + ['P.S. SECTION 1 *highlight* [name] <<title>> ****** ***', '0 1 2 3 4 5 6 7 8 9']
    bpe = Tokenizer(models.BPE())
    bpe.pre_tokenizer = pre_tokenizers.ByteLevel(add_prefix_space=False)
    bpe.decoder = decoders.ByteLevel()
    bpe.post_processor = processors.ByteLevel(trim_offsets=False)
    bpe.train_from_iterator(corpus, trainers.BpeTrainer(vocab_size=1024, special_tokens=SPECIAL, initial_alphabet=pre_tokenizers.ByteLevel.alphabet()))
    tok = PreTrainedTokenizerFast(tokenizer_object=bpe, bos_token='<|im_start|>', eos_token='<|im_end|>', pad_token='<|im_end|>')
    tok.chat_template = CHAT_TEMPLATE
    tok.save_pretrained(path)
    torch.manual_seed(seed)
    cfg = LlamaConfig(
        vocab_size=len(tok), hidden_size=hidden, intermediate_size=2 * hidden, num_hidden_layers=layers, num_attention_heads=4,
        num_key_value_heads=2, max_position_embeddings=8192, rms_norm_eps=1e-5, tie_word_embeddings=True, rope_theta=100000.0,
        bos_token_id=tok.bos_token_id, eos_token_id=tok.eos_token_id, pad_token_id=tok.pad_token_id,
    )
    LlamaForCausalLM(cfg).save_pretrained(path)
    return path
