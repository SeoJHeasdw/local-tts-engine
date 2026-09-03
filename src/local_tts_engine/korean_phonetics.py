"""Pronunciation-space keys for comparing ASR output against spoken intent.

An automatic transcript is a different *spelling* of the same *sound*, not a
different sound.  Whisper writes ``27B`` where the speaker said ``이십칠 비`` and
``QN`` where the speaker said ``큐웬``.  Comparing those as text produces
confident nonsense, so every comparison in this project happens after the text
is folded into a deterministic pronunciation key:

    1. Hangul syllables decompose into their jamo, so a near-miss syllable
       differs by one symbol instead of one whole character.
    2. Leftover Latin letters become the Korean letter names a Korean speaker
       actually says, so ``QN`` and ``큐웬`` land one jamo apart.
    3. Distinctions Korean listeners no longer make (tense consonants written
       where a plain one was spoken, the ``ㅐ``/``ㅔ`` merger) fold together.

Nothing here guesses.  Every rule is a fixed table, so the same text always
produces the same key and a regression is a test failure rather than a
different-sounding lecture.
"""

from __future__ import annotations

import re
import unicodedata


HANGUL_START = 0xAC00
HANGUL_END = 0xD7A3

# Modern Hangul is a positional syllabary: (onset, nucleus, coda) pack into one
# code point, so a syllable decomposes with arithmetic rather than a lookup.
ONSETS = "ㄱㄲㄴㄷㄸㄹㅁㅂㅃㅅㅆㅇㅈㅉㅊㅋㅌㅍㅎ"
NUCLEI = "ㅏㅐㅑㅒㅓㅔㅕㅖㅗㅘㅙㅚㅛㅜㅝㅞㅟㅠㅡㅢㅣ"
CODAS = " ㄱㄲㄳㄴㄵㄶㄷㄹㄺㄻㄼㄽㄾㄿㅀㅁㅂㅄㅅㅆㅇㅈㅊㅋㅌㅍㅎ"

# A cluster coda is two consonants written in one slot. Splitting it keeps the
# key aligned with a transcript that resolved the cluster across a syllable
# boundary (읽어 → 일거).
CLUSTER_CODAS = {
    "ㄳ": "ㄱㅅ",
    "ㄵ": "ㄴㅈ",
    "ㄶ": "ㄴㅎ",
    "ㄺ": "ㄹㄱ",
    "ㄻ": "ㄹㅁ",
    "ㄼ": "ㄹㅂ",
    "ㄽ": "ㄹㅅ",
    "ㄾ": "ㄹㅌ",
    "ㄿ": "ㄹㅍ",
    "ㅀ": "ㄹㅎ",
    "ㅄ": "ㅂㅅ",
}

# Tense consonants are folded to their plain partner: a transcript writing the
# standard orthography (똑같이) and a dictionary writing the spoken form
# (똑까치) describe the same sound.  Aspirated consonants are NOT folded — the
# 런타임/런팀 class of misreadings must stay visible.
CONSONANT_FOLD = {"ㄲ": "ㄱ", "ㄸ": "ㄷ", "ㅃ": "ㅂ", "ㅆ": "ㅅ", "ㅉ": "ㅈ"}

# Vowel pairs that merged in contemporary Seoul Korean. Keeping them apart only
# manufactures disagreements between two systems that both heard the same vowel.
VOWEL_FOLD = {"ㅐ": "ㅔ", "ㅒ": "ㅖ", "ㅙ": "ㅞ", "ㅚ": "ㅞ"}

# How a Korean speaker reads a bare Latin letter aloud. Used only for letters an
# ASR left in the transcript after the pronunciation dictionary ran, which in
# practice means acronyms and model names.
LATIN_LETTER_SOUNDS = {
    "a": "에이", "b": "비", "c": "씨", "d": "디", "e": "이",
    "f": "에프", "g": "지", "h": "에이치", "i": "아이", "j": "제이",
    "k": "케이", "l": "엘", "m": "엠", "n": "엔", "o": "오",
    "p": "피", "q": "큐", "r": "알", "s": "에스", "t": "티",
    "u": "유", "v": "브이", "w": "더블유", "x": "엑스", "y": "와이",
    "z": "지",
}

DIGIT_SOUNDS = ("영", "일", "이", "삼", "사", "오", "육", "칠", "팔", "구")
# Only these. ``str.isdigit`` also answers yes to ①, ², and other numerals that
# ``int`` refuses, and a lecture slide or a transcript of one contains them
# often enough that reading them must never be able to end a run.
ASCII_DIGITS = "0123456789"

LATIN_RUN_PATTERN = re.compile(r"[A-Za-z]+")

HANGUL_COMPATIBILITY_JAMO = range(0x3130, 0x3190)

# A jamo can be written three ways: the compatibility letters this module
# produces (ㄱ), the conjoining letters that build a syllable (U+1100…), and the
# halfwidth forms NFKC rewrites into conjoining ones. They are the same sound,
# so everything is canonicalized onto the compatibility set before comparison.
CONJOINING_TO_COMPATIBILITY = {
    **{chr(0x1100 + index): onset for index, onset in enumerate(ONSETS)},
    **{chr(0x1161 + index): nucleus for index, nucleus in enumerate(NUCLEI)},
    **{chr(0x11A8 + index): coda for index, coda in enumerate(CODAS[1:])},
}


def compatibility_fold(character: str) -> str:
    """Rewrite a decorative character as the plain one a reader would say.

    Korean decks are full of ``①``, ``²``, ``㎡`` and fullwidth letters, and an
    ASR writes the plain forms. Folding them here keeps this key agreeing with
    the rest of the comparison stack, which normalizes the same way.

    Hangul syllables and compatibility jamo are left alone — NFKC would rewrite
    the latter into conjoining jamo and a bare jamo would stop matching the one
    a syllable decomposes into. Anything NFKC turns *into* a conjoining jamo
    (the halfwidth forms) is mapped back onto that same compatibility set.
    """
    code = ord(character)
    if HANGUL_START <= code <= HANGUL_END or code in HANGUL_COMPATIBILITY_JAMO:
        return character
    folded = unicodedata.normalize("NFKC", character)
    return "".join(CONJOINING_TO_COMPATIBILITY.get(symbol, symbol) for symbol in folded)


def decompose_syllable(character: str) -> str:
    """Return the jamo of one Hangul syllable, splitting cluster codas."""
    code = ord(character) - HANGUL_START
    onset, remainder = divmod(code, 21 * 28)
    nucleus, coda = divmod(remainder, 28)
    tail = CODAS[coda].strip()
    return ONSETS[onset] + NUCLEI[nucleus] + CLUSTER_CODAS.get(tail, tail)


def spell_latin_letters(text: str) -> str:
    """Read every Latin run as the Korean names of its letters."""
    return LATIN_RUN_PATTERN.sub(
        lambda match: "".join(LATIN_LETTER_SOUNDS.get(letter.casefold(), "") for letter in match.group(0)),
        text,
    )


def _fold(jamo: str) -> str:
    return "".join(VOWEL_FOLD.get(symbol, CONSONANT_FOLD.get(symbol, symbol)) for symbol in jamo)


def phonetic_key(text: str) -> str:
    """Fold text into the pronunciation key used by every automatic comparison.

    The caller is expected to have applied number normalization and the
    pronunciation dictionary first; this stage only removes the remaining
    difference between two spellings of one sound.
    """
    value = "".join(
        compatibility_fold(character) for character in unicodedata.normalize("NFC", text)
    )
    symbols: list[str] = []
    for character in value:
        if HANGUL_START <= ord(character) <= HANGUL_END:
            symbols.append(decompose_syllable(character))
        elif character in ASCII_DIGITS:
            symbols.append(phonetic_key(DIGIT_SOUNDS[ASCII_DIGITS.index(character)]))
        elif character.isalpha() or unicodedata.category(character).startswith("L"):
            symbols.append(character.casefold())
    return _fold("".join(symbols))


def phonetic_variants(text: str) -> tuple[str, ...]:
    """Return the plausible pronunciation keys for one piece of text.

    A transcript that leaves ``B`` in place may mean the letter was spoken
    (``비``) or that the ASR kept a symbol the speaker never uttered.  Both
    readings are offered and the caller keeps whichever agrees best, so an
    ambiguous transcript can never manufacture a mismatch on its own.
    """
    spelled = phonetic_key(spell_latin_letters(text))
    literal = phonetic_key(text)
    return tuple(dict.fromkeys(value for value in (spelled, literal) if value))


def approximate_match_cost(pattern: str, text: str) -> int:
    """Return the fewest edits that align ``pattern`` with any part of ``text``.

    Sellers' variant of edit distance: the text may start and end anywhere for
    free, so this measures "is this term in here somewhere", not "are these two
    strings equal".
    """
    if not pattern:
        return 0
    if not text:
        return len(pattern)
    previous = list(range(len(pattern) + 1))
    best = previous[-1]
    for character in text:
        current = [0]
        for index, expected in enumerate(pattern, start=1):
            current.append(
                min(
                    current[index - 1] + 1,
                    previous[index] + 1,
                    previous[index - 1] + (expected != character),
                )
            )
        previous = current
        best = min(best, previous[-1])
    return best


def pronunciation_distance(pattern: str, text: str) -> float:
    """Return the normalized cost of hearing ``pattern`` somewhere in ``text``."""
    if not pattern:
        return 0.0
    return approximate_match_cost(pattern, text) / len(pattern)


def count_pronunciation_matches(pattern: str, text: str, tolerance: float) -> int:
    """Count non-overlapping places where ``pattern`` is heard within ``text``.

    Used only to notice that a term said twice was read once.  Deliberately
    generous: an over-count hides an omission, while an under-count would
    invent one, and inventing work for the user is the failure mode this whole
    layer exists to remove.
    """
    if not pattern or not text:
        return 0
    limit = tolerance * len(pattern)
    stride = max(1, len(pattern) // 2)
    previous = list(range(len(pattern) + 1))
    matches = 0
    last_match_end = -stride
    for position, character in enumerate(text):
        current = [0]
        for index, expected in enumerate(pattern, start=1):
            current.append(
                min(
                    current[index - 1] + 1,
                    previous[index] + 1,
                    previous[index - 1] + (expected != character),
                )
            )
        previous = current
        if previous[-1] <= limit and position - last_match_end >= stride:
            matches += 1
            last_match_end = position
    return matches
