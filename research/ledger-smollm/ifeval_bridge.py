"""
Access to the official IFEval code (fetched by setup_ifeval.py into vendor/). Evaluation always uses these
checkers unchanged; the Ledger's training labels (obligations.py) are derived from the same definitions.
"""
import json
import pathlib
import sys

VENDOR = pathlib.Path(__file__).resolve().parent / 'vendor'
if not (VENDOR / 'instruction_following_eval').exists():
    raise SystemExit('IFEval code missing: run  python setup_ifeval.py')
sys.path.insert(0, str(VENDOR))

from instruction_following_eval import evaluation_lib, instructions_registry, instructions_util  # noqa: E402

REGISTRY = instructions_registry.INSTRUCTION_DICT
DATA = VENDOR / 'instruction_following_eval' / 'data' / 'input_data.jsonl'


def load_ifeval():
    """The 541 IFEval prompts as dicts: key, prompt, instruction_id_list, kwargs."""
    return [json.loads(line) for line in DATA.read_text().splitlines() if line.strip()]


def checker(instruction_id, kwargs, prompt=None):
    """An official checker, built the way evaluation_lib builds it."""
    inst = REGISTRY[instruction_id](instruction_id)
    inst.build_description(**kwargs)
    args = inst.get_instruction_args()
    if args and 'prompt' in args and prompt is not None:
        inst.build_description(prompt=prompt)
    return inst


def follows(instruction_id, kwargs, response, prompt=None):
    """Strict verdict for one instruction, exactly as evaluation_lib.test_instruction_following_strict."""
    return bool(response.strip()) and bool(checker(instruction_id, kwargs, prompt).check_following(response))


def score(example, response):
    """Official strict and loose verdicts for one IFEval example and one response."""
    inp = evaluation_lib.InputExample(
        key=example['key'], instruction_id_list=example['instruction_id_list'], prompt=example['prompt'], kwargs=example['kwargs']
    )
    table = {example['prompt']: response}
    strict = evaluation_lib.test_instruction_following_strict(inp, table)
    loose = evaluation_lib.test_instruction_following_loose(inp, table)
    return {
        'strict': strict.follow_instruction_list,
        'loose': loose.follow_instruction_list,
        'strict_all': strict.follow_all_instructions,
        'loose_all': loose.follow_all_instructions,
    }
