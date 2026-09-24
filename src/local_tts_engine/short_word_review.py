"""Research-only contextual evidence for short Korean word substitutions.

Not imported by production scoring. A transcript is not acoustic proof: these
records may help compare candidates, but must not fail, approve, or regenerate
audio by themselves. In particular repeated soft evidence stays soft evidence.
"""

from __future__ import annotations

from difflib import SequenceMatcher
import re
from typing import Any

from .korean_phonetics import CODAS, ONSETS, phonetic_key
from .pronunciation import comparison_pronunciation


SHORT_WORD_REVIEW_POLICY = "ko-short-word-context-research-v1"
_KOREAN_WORD = re.compile(r"[가-힣]+")
_ALPHANUMERIC = re.compile(r"[가-힣A-Za-z0-9]")
_CONTEXT_CHARACTERS = 4
_PARTICLES = ("에서", "으로", "에게", "까지", "부터", "처럼", "보다", "하고",
              "은", "는", "이", "가", "을", "를", "의", "에", "와", "과", "도", "로", "만")
_COUNTERS = frozenset(("개", "건", "명", "번", "장", "시", "분", "초", "원", "배", "살", "턴", "일", "주", "년"))
_FUNCTION_WORDS = frozenset((
    "이거", "저거", "그거", "여기", "저기", "거기", "우리", "저희", "너희",
    "내가", "네가", "니가", "제가", "나는", "너는", "그는", "그게", "이게", "저게",
    "이건", "그건", "저건", "이런", "그런", "저런", "그럼", "거는", "거나",
    "하게", "하기", "하는", "하면", "하고", "해서", "해도", "되지", "되면",
    "되고", "되게", "되기", "되어", "이죠", "거죠", "이제", "그냥", "정도",
    "하나", "둘이", "셋이", "둘째", "셋째", "넷째",
))
_NUMBER = re.compile(
    r"(?:[영공일이삼사오육칠팔구십백천만억조경]+|"
    r"한|두|세|네|열|스무|스물|서른|마흔|쉰|예순|일흔|여든|아흔|"
    r"다섯|여섯|일곱|여덟|아홉|몇)"
    r"(?:개|건|명|번|장|시|분|초|원|배|살|턴|일|주|년)?"
)


def _liaison_key(word: str) -> str:
    """Exclude only local, explicit consonant movement into vowel onset ㅇ.

    This is an exclusion in an experimental reviewer, not a new pronunciation
    equivalence in the production comparator. It preserves consonants: 봇이 /
    보시 match; 봇이 / 보이 do not. Plain coda neutralization before a
    consonant excludes 맡게 / 맞게, without dropping their shared consonant.
    Cluster codas and ㅎ liaison are left unmodeled.
    """
    syllables = [list(divmod(ord(character) - 0xAC00, 28)) for character in word]
    for index in range(len(syllables) - 1):
        body, coda_index = syllables[index]
        next_body, _ = syllables[index + 1]
        coda = CODAS[coda_index]
        onset, vowel = divmod(next_body, 21)
        if onset != ONSETS.index("ㅇ") or coda not in ONSETS or coda in "ㅇㅎ":
            continue
        moved = {"ㄷ": "ㅈ", "ㅌ": "ㅊ"}.get(coda, coda) if vowel == 20 else coda
        syllables[index][1] = 0
        syllables[index + 1][0] = ONSETS.index(moved) * 21 + vowel
    for index, (_, coda_index) in enumerate(syllables):
        next_is_vowel = index + 1 < len(syllables) and syllables[index + 1][0] // 21 == ONSETS.index("ㅇ")
        if next_is_vowel:
            continue
        coda = CODAS[coda_index]
        neutral = ("ㄷ" if coda in "ㄷㅅㅆㅈㅊㅌㅎ" else
                   "ㄱ" if coda in "ㄱㄲㅋ" else "ㅂ" if coda in "ㅂㅍ" else coda)
        syllables[index][1] = CODAS.index(neutral)
    return phonetic_key("".join(chr(0xAC00 + body * 28 + coda) for body, coda in syllables))


def _particle_only_change(expected: str, heard: str) -> bool:
    def stems(word: str) -> set[str]:
        return {word[:-len(particle)] for particle in _PARTICLES
                if word.endswith(particle) and len(word) > len(particle)}
    return bool(stems(expected) & stems(heard))


def _eligible(word: str) -> bool:
    if len(word) != 2 or len(phonetic_key(word)) >= 6:
        return False
    if word in _FUNCTION_WORDS or word.endswith(("요", "의")) or _NUMBER.fullmatch(word):
        return False
    for particle in _PARTICLES:
        if word.endswith(particle):
            stem = word[:-len(particle)]
            if stem in _COUNTERS or _NUMBER.fullmatch(stem):
                return False
    if CODAS[(ord(word[0]) - 0xAC00) % 28] == "ㅎ":
        return False
    return True


def short_word_review_candidates(
    expected: str,
    recognized: str,
    dictionary: list[dict[str, Any]] | None = None,
) -> list[dict[str, Any]]:
    """Return soft review candidates without modifying text or scoring audio.

    ``expected`` is exact TTS input, so offsets refer to that unchanged string.
    Four matching Korean syllables on each side localize the difference. A
    larger replacement, sentence edge, insertion/deletion, numeral, particle,
    common function word, or local liaison is insufficient evidence here.
    Spaces are ignored for alignment, including ASR's 한보이 versus 한 봇이.
    """
    source_symbols = list(_ALPHANUMERIC.finditer(expected))
    left = "".join(match.group().casefold() for match in source_symbols)
    normalized_heard = comparison_pronunciation(recognized, dictionary or [])
    right = "".join(match.group().casefold() for match in _ALPHANUMERIC.finditer(normalized_heard))
    if not left or not right:
        return []
    source_positions = {match.start(): index for index, match in enumerate(source_symbols)}
    operations = SequenceMatcher(None, left, right, autojunk=False).get_opcodes()
    candidates = []
    for word_match in _KOREAN_WORD.finditer(expected):
        word = word_match.group()
        if not _eligible(word):
            continue
        begin = source_positions[word_match.start()]
        end = begin + len(word)
        changes = [(kind, i, j, k, l) for kind, i, j, k, l in operations
                   if kind != "equal" and i < end and j > begin]
        if not changes or any(kind != "replace" or i < begin or j > end or j - i != l - k
                              for kind, i, j, k, l in changes):
            continue
        first = changes[0]
        heard_begin = first[3] - (first[1] - begin)
        heard_end = heard_begin + len(word)
        width = _CONTEXT_CHARACTERS
        if begin < width or end + width > len(left) or heard_begin < width or heard_end + width > len(right):
            continue
        before, after = left[begin - width:begin], left[end:end + width]
        if not _KOREAN_WORD.fullmatch(before + after):
            continue
        if before != right[heard_begin - width:heard_begin] or after != right[heard_end:heard_end + width]:
            continue
        heard_word = right[heard_begin:heard_end]
        if not _KOREAN_WORD.fullmatch(heard_word):
            continue
        if _particle_only_change(word, heard_word) or _NUMBER.fullmatch(heard_word):
            continue
        if phonetic_key(word) == phonetic_key(heard_word) or _liaison_key(word) == _liaison_key(heard_word):
            continue
        candidates.append({
            "kind": "short-word-review", "status": "warning",
            "policy": SHORT_WORD_REVIEW_POLICY, "activation": "research-only",
            "automaticFailure": False, "reason": "짧은 낱말의 문맥상 판독 차이",
            "expectedStart": word_match.start(), "expectedEnd": word_match.end(),
            "text": word, "heardText": heard_word,
            "leftContext": before, "rightContext": after,
        })
    return candidates
