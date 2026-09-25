"""
Fetch the official IFEval checkers and prompts (Zhou et al., 2023; Apache-2.0) at a pinned commit
into vendor/instruction_following_eval/, and the NLTK sentence tokenizer they use.

  python setup_ifeval.py
"""
import pathlib
import urllib.request

import nltk

SHA = 'd36068b845da4c2b24927fee2cea1e6ef98dadda'
BASE = f'https://raw.githubusercontent.com/google-research/google-research/{SHA}/instruction_following_eval/'
FILES = ['instructions.py', 'instructions_registry.py', 'instructions_util.py', 'evaluation_lib.py', 'data/input_data.jsonl']

out = pathlib.Path(__file__).parent / 'vendor' / 'instruction_following_eval'
(out / 'data').mkdir(parents=True, exist_ok=True)
for f in FILES:
    urllib.request.urlretrieve(BASE + f, out / f)
    print('fetched', f)
(out / '__init__.py').write_text('')
(out / 'SOURCE').write_text(f'google-research/google-research @ {SHA}, instruction_following_eval/ (Apache License 2.0)\n')
for pkg in ('punkt', 'punkt_tab'):
    nltk.download(pkg, quiet=True)
print('done:', out)
