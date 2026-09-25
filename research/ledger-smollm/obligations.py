"""
IFEval instructions as Ledger obligations.

Each supported instruction type owns one typed slot, as in the toy experiment (paper, Section 5):
  G  invariant    in force at every step, never pending (no comma, all lowercase, ...)
  F  eventuality  pending until paid (a postscript, a title, an end phrase, ...)
  N  count        per-token events counted towards a target read from the prompt, with a relation
                  (at least / less than / exactly): words, sentences, bullets, paragraphs, ...

Training labels for the state come from the official checkers' own definitions, evaluated on every prefix of a
response: a *milestone* is the character position at which a prefix first gains one more counted unit (N) or
first pays its obligation (F). Evaluation never uses these labels; it uses the official checkers unchanged.
"""
import re
from functools import lru_cache

import numpy as np

from ifeval_bridge import instructions_util

G, F, N = 0, 1, 2
LESS, AT_LEAST, EXACTLY = 0, 1, 2

SLOTS = [
    ('punctuation:no_comma', G),
    ('keywords:forbidden_words', G),
    ('change_case:english_lowercase', G),
    ('change_case:english_capital', G),
    ('language:response_language', G),
    ('detectable_format:json_format', G),
    ('startend:quotation', G),
    ('detectable_content:postscript', F),
    ('detectable_format:title', F),
    ('detectable_format:constrained_response', F),
    ('combination:two_responses', F),
    ('combination:repeat_prompt', F),
    ('startend:end_checker', F),
    ('keywords:existence', N),
    ('keywords:frequency', N),
    ('length_constraints:number_words', N),
    ('length_constraints:number_sentences', N),
    ('length_constraints:number_paragraphs', N),
    ('detectable_format:number_bullet_lists', N),
    ('detectable_format:number_highlighted_sections', N),
    ('detectable_format:multiple_sections', N),
    ('detectable_content:number_placeholders', N),
    ('change_case:capital_word_frequency', N),
]
K = len(SLOTS)
SLOT = {iid: i for i, (iid, _) in enumerate(SLOTS)}
SHAPE = np.array([s for _, s in SLOTS])
# Two IFEval types are left to the base model: letter counts fall inside tokens, and the n-th paragraph's first
# word is a positional constraint, not one of the three shapes.
UNSUPPORTED = ('keywords:letter_frequency', 'length_constraints:nth_paragraph_first_word')
# Count targets are read from a number written in the prompt, except the number of required keywords.
POINTER = np.array([shape == N and iid != 'keywords:existence' for iid, shape in SLOTS])

_REL = {'less than': LESS, 'at least': AT_LEAST}
_CONSTRAINED = ('My answer is yes.', 'My answer is no.', 'My answer is maybe.')


def target(iid, kw):
    """(relation, n) for a count slot."""
    if iid == 'keywords:existence':
        return AT_LEAST, len(kw['keywords'])
    if iid == 'keywords:frequency':
        return _REL[kw['relation']], kw['frequency']
    if iid == 'length_constraints:number_words':
        return _REL[kw['relation']], kw['num_words']
    if iid == 'length_constraints:number_sentences':
        return _REL[kw['relation']], kw['num_sentences']
    if iid == 'length_constraints:number_paragraphs':
        return EXACTLY, kw['num_paragraphs']
    if iid == 'detectable_format:number_bullet_lists':
        return EXACTLY, kw['num_bullets']
    if iid == 'detectable_format:number_highlighted_sections':
        return AT_LEAST, kw['num_highlights']
    if iid == 'detectable_format:multiple_sections':
        return AT_LEAST, kw['num_sections']
    if iid == 'detectable_content:number_placeholders':
        return AT_LEAST, kw['num_placeholders']
    if iid == 'change_case:capital_word_frequency':
        return _REL[kw['capital_relation']], kw['capital_frequency']
    raise KeyError(iid)


@lru_cache(maxsize=1)
def _sentence_tokenizer():
    return instructions_util._get_sentence_tokenizer()


def _paragraph_starts(text):
    """First character of every non-empty part between the checker's *** separators."""
    out, prev = [], 0
    for a, b in [m.span() for m in re.finditer(r'\s?\*\*\*\s?', text)] + [(len(text), len(text))]:
        body = text[prev:a]
        if body.strip():
            out.append(prev + len(body) - len(body.lstrip()) + 1)
        prev = b
    return out


def milestones(iid, kw, text, prompt=None):
    """Sorted character positions (prefix lengths) at which a count gains a unit (N) or an obligation is paid (F)."""
    if iid == 'keywords:existence':
        found = [re.search(k, text, flags=re.IGNORECASE) for k in kw['keywords']]
        return sorted(m.end() for m in found if m)
    if iid == 'keywords:frequency':
        return [m.end() for m in re.finditer(kw['keyword'], text, flags=re.IGNORECASE)]
    if iid == 'length_constraints:number_words':
        return [m.start() + 1 for m in re.finditer(r'\w+', text)]
    if iid == 'length_constraints:number_sentences':
        return [a + 1 for a, _ in _sentence_tokenizer().span_tokenize(text)]
    if iid == 'length_constraints:number_paragraphs':
        return _paragraph_starts(text)
    if iid == 'detectable_format:number_bullet_lists':
        star = [m.start() + m.group().index('*') + 2 for m in re.finditer(r'^\s*\*[^\*].*$', text, flags=re.MULTILINE)]
        dash = [m.start() + m.group().index('-') + 1 for m in re.finditer(r'^\s*-.*$', text, flags=re.MULTILINE)]
        return sorted(star + dash)
    if iid == 'detectable_format:number_highlighted_sections':
        one = [m.end() for m in re.finditer(r'\*[^\n\*]*\*', text) if m.group().strip('*').strip()]
        two = [m.end() for m in re.finditer(r'\*\*[^\n\*]*\*\*', text) if m.group().removeprefix('**').removesuffix('**').strip()]
        return sorted(one + two)
    if iid == 'detectable_format:multiple_sections':
        # a header counts as soon as its first digit is written
        pat = r'\s?' + kw['section_spliter'] + r'\s?\d+\s?'
        return [m.start() + re.search(r'\d', m.group()).start() + 1 for m in re.finditer(pat, text)]
    if iid == 'detectable_content:number_placeholders':
        return [m.end() for m in re.finditer(r'\[.*?\]', text)]
    if iid == 'change_case:capital_word_frequency':
        out, cur = [], 0
        for tok in instructions_util.nltk.word_tokenize(text):
            at = text.find(tok, cur)
            if at < 0:
                continue
            cur = at + len(tok)
            if tok.isupper():
                out.append(cur)
        return out
    # eventualities: the single position at which the prefix first pays
    low = text.lower()
    m = None
    if iid == 'detectable_content:postscript':
        marker = kw['postscript_marker']
        pat = r'p\.\s?s\.' if marker == 'P.S.' else r'p\.\s?p\.\s?s' if marker == 'P.P.S' else re.escape(marker.lower())
        m = re.search(pat, low)
        return [m.end()] if m else []
    if iid == 'detectable_format:title':
        for m in re.finditer(r'<<[^\n]+>>', text):
            if m.group().lstrip('<').rstrip('>').strip():
                return [m.end()]
        return []
    if iid == 'detectable_format:constrained_response':
        ends = [text.find(c) + len(c) for c in _CONSTRAINED if c in text]
        return [min(ends)] if ends else []
    if iid == 'combination:two_responses':
        at = text.find('******')
        return [at + 6] if at >= 0 else []
    if iid == 'combination:repeat_prompt':
        p = kw['prompt_to_repeat'].strip().lower()
        stripped = low.lstrip()
        return [len(low) - len(stripped) + len(p)] if stripped.startswith(p) else []
    if iid == 'startend:end_checker':
        phrase = kw['end_phrase'].strip().lower()
        at = low.find(phrase)
        return [at + len(phrase)] if at >= 0 else []
    return []  # invariants carry no milestones


def token_targets(iid, kw, text, ends, prompt=None):
    """Per-token labels for a response whose t-th token ends at character ends[t].

    F: paid[t] = 1 once the prefix ending at token t has paid.   N: event[t] = 1 if token t adds a counted unit.
    """
    ends = np.asarray(ends)
    marks = np.asarray(milestones(iid, kw, text, prompt), dtype=np.int64)
    shape = SHAPE[SLOT[iid]]
    if shape == F:
        return (ends >= marks[0]).astype(np.float32) if len(marks) else np.zeros(len(ends), np.float32)
    if shape == N:
        counts = np.searchsorted(marks, ends, side='right')
        return (np.diff(np.concatenate([[0], counts])) > 0).astype(np.float32)
    return np.zeros(len(ends), np.float32)


_WORDS = {w: i for i, w in enumerate('zero one two three four five six seven eight nine ten eleven twelve thirteen fourteen fifteen sixteen seventeen eighteen nineteen twenty'.split())}


def numbers(text):
    """(start, end, value) for every number written in the text, in digits or as a word up to twenty."""
    out = [(m.start(), m.end(), int(m.group())) for m in re.finditer(r'\d+', text)]
    out += [(m.start(), m.end(), _WORDS[m.group().lower()]) for m in re.finditer(r'\b(' + '|'.join(_WORDS) + r')\b', text, flags=re.IGNORECASE)]
    return sorted(out)
