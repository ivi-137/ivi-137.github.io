"""The shapes an obligation can take in the Ledger's state, the relations of a count, and reading numbers in a prompt.
Shared by every obligation set (obligations.py for IFEval, patterns.py for house patterns)."""
import re

G, F, N = 0, 1, 2  # invariant, eventuality, count
LESS, AT_LEAST, EXACTLY = 0, 1, 2

_WORDS = {w: i for i, w in enumerate('zero one two three four five six seven eight nine ten eleven twelve thirteen fourteen fifteen sixteen seventeen eighteen nineteen twenty'.split())}


def numbers(text):
    """(start, end, value) for every number written in the text, in digits or as a word up to twenty."""
    out = [(m.start(), m.end(), int(m.group())) for m in re.finditer(r'\d+', text)]
    out += [(m.start(), m.end(), _WORDS[m.group().lower()]) for m in re.finditer(r'\b(' + '|'.join(_WORDS) + r')\b', text, flags=re.IGNORECASE)]
    return sorted(out)
