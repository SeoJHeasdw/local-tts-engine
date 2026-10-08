"""Which stretches of a text are English, decided in one place.

Three layers need the same answer: the pronunciation rules must leave English
untouched (the article ``a`` was read 에이), the voice router must hand it to
the English voice, and the reviewers must not expect a Korean reading of it.
Each used to carry its own rule, so they drifted apart.

A *span* is a character range ``(start, end)`` of the text it came from.
"""
from __future__ import annotations

import re

# A protected span stands in for text the rules must not touch (private use).
PLACEHOLDER = "-"
FOREIGN = re.compile(rf"[가-힣ㄱ-ㅎㅏ-ㅣ{PLACEHOLDER}]")
HANGUL = re.compile(r"[가-힣ㄱ-ㅎㅏ-ㅣ]")
LATIN = re.compile(r"[A-Za-z]")
QUOTED_ENGLISH_PATTERN = re.compile(r'''["“]([^"“”\n]+)["”]''')

# English words at the front of a token that goes on in Korean: idea라고, project를.
_STEM = re.compile(r"[A-Za-z][A-Za-z0-9'’]*")
_TOKEN = re.compile(r"\S+")
# A token ending like this closes its clause or sentence; what follows starts afresh.
_CLOSING_PUNCTUATION = ",;:.!?，；。！？"

# English prose is three or more words; two could be a term or a name.
MIN_PROSE_WORDS = 3
# A version number after the last word belongs to the name (Opus 5, GPT 4).
_VERSION = re.compile(r"[0-9][0-9.,]*")
# Prose has grammar words; a list of terms (Authorization, Attention Budget) does
# not, and its words keep the dictionary's Korean readings. A fixed table of the
# commonest English function words, never a per-term decision.
FUNCTION_WORDS = frozenset(
    "a an the and or but nor so if than then as of in on at to for with from by into over about "
    "is are was were be been being am do does did done have has had will would can could should must may might "
    "i me my we us our you your he him his she her it its they them their this that these those there here "
    "not no all any each every some more most very just also what which who whom how why when where".split()
)


def is_english_sentence(text: str) -> bool:
    """Conservatively recognize prose, not an isolated technical identifier."""
    return not FOREIGN.search(text) and sum(
        bool(LATIN.search(token)) for token in text.split()
    ) >= MIN_PROSE_WORDS


def english_runs(text: str) -> list[tuple[int, int]]:
    """English prose written without quotation marks, as spans of ``text``.

    A run is the stretch between Korean (or protected) tokens, with leading and
    trailing numbers or symbols left to the Korean around them (a version number
    right after the last word stays: ``Opus 5``). An English stem glued to a
    Korean ending joins the run before it, unless that run closes a clause:
    ``It is a great idea라고`` is English up to ``idea``, while in
    ``success, Today는`` the comma ends the run and ``Today`` is left to the
    Korean voice. A run is prose when it has three or more ordinary words
    (acronyms such as RAG, LLM, API do not count) and at least one function
    word; without grammar it is a list of terms.
    """
    spans: list[tuple[int, int]] = []
    # The open run, one (start, end, text) per token.
    run: list[tuple[int, int, str]] = []

    def close(stem: tuple[int, int] | None = None) -> None:
        tokens = list(run)
        run.clear()
        while tokens and not LATIN.search(tokens[0][2]):
            tokens.pop(0)
        while tokens and not LATIN.search(tokens[-1][2]) and not _VERSION.fullmatch(tokens[-1][2]):
            tokens.pop()
        if not tokens:
            return
        start, end = tokens[0][0], tokens[-1][1]
        words = sum(bool(LATIN.search(item[2])) and bool(re.search(r"[a-z]", item[2])) for item in tokens)
        if not any(re.sub(r"^\W+|\W+$", "", item[2]).casefold() in FUNCTION_WORDS for item in tokens):
            return
        if (stem is not None and LATIN.search(tokens[-1][2])
                and text[end - 1] not in _CLOSING_PUNCTUATION):
            end, words = stem[1], words + 1
        if words >= MIN_PROSE_WORDS:
            spans.append((start, end))

    for match in _TOKEN.finditer(text):
        token = match.group()
        if not FOREIGN.search(token):
            run.append((match.start(), match.end(), token))
            continue
        stem = _STEM.match(token)
        if stem and stem.end() < len(token) and FOREIGN.match(token, stem.end()):
            close((match.start(), match.start() + stem.end()))
        else:
            close()
    close()
    return spans


def english_prose_spans(text: str) -> list[tuple[int, int]]:
    """Spans of English prose written without quotation marks."""
    return english_runs(text)
