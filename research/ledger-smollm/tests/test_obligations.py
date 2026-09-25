"""The Ledger's labels must agree with the official IFEval checkers they are derived from."""
import sys
import pathlib

import numpy as np
import pytest

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1]))
import obligations as ob  # noqa: E402
from ifeval_bridge import follows  # noqa: E402

TEXTS = [
    '',
    'Hello world.',
    'The QUICK brown fox. It JUMPS over the lazy DOG! Does it? Yes, NASA says so.\n\nA second paragraph here.',
    '* first bullet\n* second bullet\n- third bullet\n\nNot a bullet. *highlighted part* and **bold part** and ** **.',
    'SECTION 1\nIntro text. [name] lives at [address].\nSECTION 2\nMore text *one* *two* *three*.',
    'Para one is here.\n\n***\n\nPara two follows.\n***\nPara three ends it.',
    'Section 1 opening. Section 2 middle. Section 3 end. keyword keyword KEYWORD key word.',
    '<<A Title>>\nBody text with a comma, and more.\nP.S. remember this.',
    'Answer first. ****** Second answer differs.',
    'Some words then My answer is maybe. Is there anything else I can help with?',
    'I love the committee and the simple things. Simple. COMMITTEE!',
]

COUNTS = [
    ('keywords:frequency', lambda n, rel: {'keyword': 'keyword', 'frequency': n, 'relation': rel}),
    ('length_constraints:number_words', lambda n, rel: {'num_words': n, 'relation': rel}),
    ('length_constraints:number_sentences', lambda n, rel: {'num_sentences': n, 'relation': rel}),
    ('change_case:capital_word_frequency', lambda n, rel: {'capital_frequency': n, 'capital_relation': rel}),
    ('detectable_format:number_highlighted_sections', lambda n, rel: {'num_highlights': n}),
    ('detectable_format:multiple_sections', lambda n, rel: {'num_sections': n, 'section_spliter': 'SECTION'}),
    ('detectable_content:number_placeholders', lambda n, rel: {'num_placeholders': n}),
    ('detectable_format:number_bullet_lists', lambda n, rel: {'num_bullets': n}),
    ('length_constraints:number_paragraphs', lambda n, rel: {'num_paragraphs': n}),
]


RELATIONAL = {'keywords:frequency', 'length_constraints:number_words', 'length_constraints:number_sentences', 'change_case:capital_word_frequency'}


@pytest.mark.parametrize('iid,make', COUNTS)
@pytest.mark.parametrize('text', TEXTS)
def test_count_matches_checker(iid, make, text):
    c = len(ob.milestones(iid, make(1, 'at least'), text))
    rel, _ = ob.target(iid, make(1, 'at least'))
    if iid == 'length_constraints:number_paragraphs' and '****' in text:
        return  # an empty part between separators fails the checker whatever the count
    if rel == ob.EXACTLY:
        if c:
            assert follows(iid, make(c, None), text)
        assert not follows(iid, make(c + 1, None), text)
    else:
        if c:
            assert follows(iid, make(c, 'at least'), text)
        assert not follows(iid, make(c + 1, 'at least'), text)
        if text.strip() and iid in RELATIONAL:
            assert follows(iid, make(c + 1, 'less than'), text)
            if c:
                assert not follows(iid, make(c, 'less than'), text)


PREFIX_EXACT = ['keywords:frequency', 'length_constraints:number_words', 'detectable_format:number_highlighted_sections',
                'detectable_format:multiple_sections', 'detectable_content:number_placeholders', 'length_constraints:number_paragraphs']


@pytest.mark.parametrize('iid', PREFIX_EXACT)
@pytest.mark.parametrize('text', TEXTS)
def test_counts_are_prefix_consistent(iid, text):
    """count(prefix of length p) equals the number of full-text milestones at or before p."""
    make = dict(COUNTS)[iid]
    if iid == 'length_constraints:number_paragraphs' and '****' in text:
        return  # '******' separates two responses; its prefixes are not paragraphs
    marks = np.array(ob.milestones(iid, make(1, 'at least'), text))
    for p in range(len(text) + 1):
        assert len(ob.milestones(iid, make(1, 'at least'), text[:p])) == int((marks <= p).sum()), (iid, p)


EVENTUALITIES = [
    ('detectable_content:postscript', {'postscript_marker': 'P.S.'}),
    ('detectable_format:title', {}),
    ('detectable_format:constrained_response', {}),
    ('startend:end_checker', {'end_phrase': 'Is there anything else I can help with?'}),
    ('combination:two_responses', {}),
    ('combination:repeat_prompt', {'prompt_to_repeat': 'Answer first.'}),
    ('keywords:existence', {'keywords': ['committee', 'simple']}),
]


@pytest.mark.parametrize('iid,kw', EVENTUALITIES)
@pytest.mark.parametrize('text', TEXTS)
def test_paid_whenever_checker_passes(iid, kw, text):
    marks = ob.milestones(iid, kw, text)
    if follows(iid, kw, text):
        need = len(kw['keywords']) if iid == 'keywords:existence' else 1
        assert len(marks) >= need
        assert max(marks) <= len(text)


def test_token_targets_shapes_and_monotonicity():
    text = TEXTS[4]
    ends = list(range(3, len(text), 4)) + [len(text)]
    paid = ob.token_targets('detectable_content:postscript', {'postscript_marker': 'P.S.'}, TEXTS[7], list(range(1, len(TEXTS[7]) + 1)))
    assert np.all(np.diff(paid) >= 0) and paid[-1] == 1
    ev = ob.token_targets('detectable_content:number_placeholders', {'num_placeholders': 2}, text, ends)
    assert ev.shape == (len(ends),) and ev.sum() == 2


def test_numbers():
    assert [v for *_, v in ob.numbers('Write at least 300 words in three paragraphs, 2 bullets.')] == [300, 3, 2]


def test_slot_table():
    assert ob.K == 23 and len(set(i for i, _ in ob.SLOTS)) == ob.K
    from ifeval_bridge import REGISTRY
    assert set(REGISTRY) == set(ob.SLOT) | set(ob.UNSUPPORTED)
