"""How an English word sounds when a Korean transcript writes it in Hangul.

Whisper often writes an English word inside Korean speech in Hangul even when
it was read well (``traditional WebSphere`` → ``트래디셔널 웹스피어``). Asking
only "did the transcript spell it in English" therefore calls a good reading
unheard. This module turns the word's American pronunciation (CMU Pronouncing
Dictionary) into the Hangul a Korean transcript may write for it, following the
loanword orthography for English (외래어 표기법 제3장 제1절), and measures how
far the transcript is from any of those spellings.

Every rule is a fixed table. Where a transcript legitimately spells one sound
several ways — a reduced vowel follows the English letter (트래디셔널/트러디셔널),
a final stop may take a 받침 or a 으 syllable (웹/웨브), an American r may be
written (웹스피어/웹스피얼) — the reading carries each spelling as an
alternative instead of relying on a looser threshold. The comparison stays in
the jamo key of :mod:`.korean_phonetics`, so the same folds apply.
"""

from __future__ import annotations

import itertools
import re
from functools import lru_cache
from pathlib import Path

from .korean_phonetics import (
    CODAS, HANGUL_START, NUCLEI, ONSETS, _count_non_overlapping, phonetic_key, spell_latin_letters,
)

# cmusphinx/cmudict 7479086. BSD 계열 라이선스는 같은 폴더의 LICENSE(docs/DECISIONS.md).
CMUDICT_PATH = Path(__file__).parent / "data/cmudict/cmudict.dict"
# 발음이 여럿인 낱말·합성어는 이만큼의 읽기까지만 본다.
MAX_READINGS = 8
# 사전에 없는 낱말의 흔한 어미. 어간(또는 어간+e)의 발음에 붙인다(scoped, orchestrator,
# retryable, serverless).
SUFFIXES = (
    ("able", ("AH0", "B", "AH0", "L")), ("less", ("L", "AH0", "S")),
    ("ing", ("IH0", "NG")), ("ers", ("ER0", "Z")), ("ors", ("ER0", "Z")), ("er", ("ER0",)),
    ("or", ("ER0",)), ("ed", ("D",)), ("es", ("IH0", "Z")), ("s", ("Z",)), ("ly", ("L", "IY0")),
)

VOWELS = frozenset({"AA", "AE", "AH", "AO", "AW", "AY", "EH", "ER", "EY", "IH", "IY", "OW", "OY", "UH", "UW"})

# 각 영어 모음의 중성. 여러 개면 받아쓰기가 쓰는 표기들이다. AA는 미국식 [ɑ]라 ㅏ가
# 원칙이고 여러 음절 낱말은 철자 o의 관용 표기 ㅗ(폴리시·모델)도, 비음 앞에서는 ㅓ도
# 쓴다(컨텍스트·커먼).
PLAIN_VOWELS: dict[str, tuple[str, ...]] = {
    "AA": ("ㅏ", "ㅗ"), "AE": ("ㅐ",), "AH": ("ㅓ",), "AO": ("ㅗ", "ㅏ"), "AW": ("ㅏㅇㅜ",),
    "AY": ("ㅏㅇㅣ",), "EH": ("ㅔ",), "ER": ("ㅓ",), "EY": ("ㅔㅇㅣ",), "IH": ("ㅣ",),
    "IY": ("ㅣ",), "OW": ("ㅗ", "ㅗㅇㅜ"), "OY": ("ㅗㅇㅣ",), "UH": ("ㅜ",), "UW": ("ㅜ",),
}
# 강세 없는 약모음은 영어 철자를 따라 적힌다(트래디셔널·트러디셔널, 오픈·오펀, 메모리).
REDUCED_VOWELS: dict[str, tuple[str, ...]] = {
    "AH": ("ㅓ", "ㅏ", "ㅗ", "ㅜ", "ㅡ", "ㅣ", "ㅔ"),
    "ER": ("ㅓ", "ㅏ", "ㅗ"),
    "IH": ("ㅣ", "ㅡ", "ㅓ", "ㅔ"),
}
# [j]·[ʃ] 뒤에서는 이중모음이 된다(뮤직·셔). [w] 뒤는 워·와·위 쪽이다.
Y_GLIDE = {"ㅏ": "ㅑ", "ㅐ": "ㅒ", "ㅓ": "ㅕ", "ㅔ": "ㅖ", "ㅗ": "ㅛ", "ㅜ": "ㅠ"}
W_GLIDE = {"ㅏ": "ㅘ", "ㅐ": "ㅙ", "ㅓ": "ㅝ", "ㅔ": "ㅞ", "ㅗ": "ㅝ", "ㅣ": "ㅟ"}

ONSET = {
    "P": "ㅍ", "B": "ㅂ", "T": "ㅌ", "D": "ㄷ", "K": "ㅋ", "G": "ㄱ", "F": "ㅍ", "V": "ㅂ",
    "TH": "ㅅ", "DH": "ㄷ", "S": "ㅅ", "Z": "ㅈ", "SH": "ㅅ", "ZH": "ㅈ", "CH": "ㅊ",
    "JH": "ㅈ", "M": "ㅁ", "N": "ㄴ", "L": "ㄹ", "R": "ㄹ", "HH": "ㅎ",
}
# 모음이 뒤따르지 않는 자음. 무성·유성 파열음은 받침과 '으' 음절이 모두 쓰인다(웹·웨브, 밥).
CODA: dict[str, tuple[str, ...]] = {
    "P": ("ㅍㅡ", "ㅂ"), "T": ("ㅌㅡ", "ㅅ"), "K": ("ㅋㅡ", "ㄱ"),
    "B": ("ㅂㅡ", "ㅂ"), "D": ("ㄷㅡ", "ㅅ"), "G": ("ㄱㅡ", "ㄱ"),
    "F": ("ㅍㅡ",), "V": ("ㅂㅡ",), "TH": ("ㅅㅡ",), "DH": ("ㄷㅡ",), "S": ("ㅅㅡ",),
    "Z": ("ㅈㅡ", "ㅅㅡ"), "SH": ("ㅅㅣ", "ㅅㅠ"), "ZH": ("ㅈㅣ",), "CH": ("ㅊㅣ",), "JH": ("ㅈㅣ",),
    "M": ("ㅁ",), "N": ("ㄴ",), "NG": ("ㅇ",), "L": ("ㄹ",), "HH": ("ㅎㅡ", ""),
}
# 모음 뒤 r은 적지 않는 것이 원칙이고, 미국식 r을 받아쓰기가 ㄹ로 적기도 한다(파트·팔트).
# 높은 모음 뒤에서는 '어'가 된다(스피어·케어·투어).
R_AFTER_LOW = ("", "ㄹ", "ㄹㅡ")
R_AFTER_HIGH = ("ㅇㅓ", "ㅇㅓㄹ", "")
LOW_VOWELS = frozenset({"AA", "AO", "ER", "AH"})
# 짧은 모음 뒤 어말 무성 파열음은 받침으로만 적는다(봇·캣·북). 보트는 boat다.
# 사전은 bot도 talk처럼 AO로 적는다. 철자가 au·aw·al·ough가 아닌 AO만 짧다.
SHORT_VOWELS = frozenset({"AA", "AE", "AH", "EH", "IH", "UH"})
LONG_AO_SPELLING = re.compile(r"au|aw|al|ough")
STOPS = frozenset({"P", "T", "K", "B", "D", "G"})
# [kw]·[gw]·[hw]는 한 음절(쿼·과·화)이다. 다른 자음 뒤 w는 따로 적는다(트위스트).
W_CLUSTER_ONSETS = frozenset({"K", "G", "HH"})
VOWEL_LETTERS = re.compile(r"[aeiouy]+")


def _vowel_letters(spelling: str, count: int) -> list[str] | None:
    """The letters that spell each of ``count`` vowel sounds, or None when they do not line up."""
    groups = VOWEL_LETTERS.findall(spelling.lower())
    if len(groups) == count + 1 and groups[-1] == "e":
        # 어말 묵음 e(module·archive).
        groups.pop()
    return groups if len(groups) == count else None


def _glide(nucleus: str, table: dict[str, str]) -> str:
    return table.get(nucleus[0], nucleus[0]) + nucleus[1:]


def _vowel_alternatives(phoneme: str, stress: str, glide: str | None) -> tuple[str, ...]:
    reduced = stress == "0" and phoneme in REDUCED_VOWELS
    plain = REDUCED_VOWELS[phoneme] if reduced else PLAIN_VOWELS[phoneme]
    if glide == "Y":
        # 셔·션이 원칙이고 서·선으로도 적힌다.
        return tuple(dict.fromkeys([_glide(value, Y_GLIDE) for value in plain] + list(plain)))
    if glide == "W":
        return tuple(dict.fromkeys(_glide(value, W_GLIDE) for value in plain))
    return plain


def reading_lattice(phonemes: list[str], spelling: str = "") -> list[tuple[str, ...]]:
    """Turn one ARPAbet pronunciation into Hangul jamo segments.

    Each segment lists the spellings a transcript may use for that stretch of
    sound; the first is the loanword-orthography form.
    """
    short = SHORT_VOWELS if LONG_AO_SPELLING.search(spelling.lower()) else SHORT_VOWELS | {"AO"}
    symbols = [re.sub(r"\d", "", phoneme) for phoneme in phonemes]
    stresses = [re.sub(r"\D", "", phoneme) for phoneme in phonemes]
    vowel_count = sum(symbol in VOWELS for symbol in symbols)
    monosyllable = vowel_count == 1
    letters = _vowel_letters(spelling, vowel_count)
    vowel_index = 0
    segments: list[tuple[str, ...]] = []
    onset = ""
    glide: str | None = None
    ends_in_vowel = False
    index = 0
    while index < len(symbols):
        symbol = symbols[index]
        following = symbols[index + 1] if index + 1 < len(symbols) else None
        after = symbols[index + 2] if index + 2 < len(symbols) else None
        if symbol in VOWELS:
            nuclei = _vowel_alternatives(symbol, stresses[index], glide)
            written = letters[vowel_index] if letters else spelling.lower()
            vowel_index += 1
            # 한 음절 낱말은 미국식 ㅏ만 인정한다(Bob은 밥, 봅이 아니다). 여러 음절 낱말의 ㅗ는
            # 철자가 o일 때의 관용 표기다. 철자 a는 ㅏ다(Jarvis는 자비스, 조비스가 아니다).
            # [w] 뒤는 철자 a도 워로 적는다(워치·월렛).
            if symbol == "AA" and (monosyllable or (spelling and glide != "W" and "o" not in written)):
                nuclei = tuple(nucleus for nucleus in nuclei if not nucleus.startswith(("ㅗ", "ㅛ")))
            if symbol == "AA" and following in {"N", "M"}:
                nuclei += ("ㅓ",)
            segments.append(tuple((onset or "ㅇ") + nucleus for nucleus in nuclei))
            onset, glide, ends_in_vowel = "", None, True
            if symbol == "ER" and following in VOWELS:
                # r 음색 모음 뒤 모음은 r을 초성으로 받는다(바운더리·필터링).
                onset = "ㄹ"
            elif symbol == "ER" and following != "R":
                # 미국식 r을 받침 ㄹ로 적기도 한다(리버티·리벌티).
                segments.append(("", "ㄹ"))
            if following == "R" and (after is None or after not in VOWELS):
                segments.append(R_AFTER_LOW if symbol in LOW_VOWELS else R_AFTER_HIGH)
                index += 1
        elif symbol in {"W", "Y"}:
            if following in VOWELS:
                glide = symbol
            # 모음 앞이 아닌 반모음은 소리로 적을 것이 없다.
        elif following in VOWELS or (following in {"W", "Y"} and after in VOWELS
                                      and (following == "Y" or symbol in W_CLUSTER_ONSETS)):
            if symbol == "R" and index and symbols[index - 1] in VOWELS and symbols[index - 1] not in LOW_VOWELS:
                # 높은 모음 뒤 r은 '어'를 끼워 적기도 한다(엔지니어링·페어런트).
                segments.append(("", "ㅇㅓ"))
            # 모음 사이의 l은 ㄹㄹ(폴리시·플랜).
            onset = "ㄹㄹ" if symbol == "L" and ends_in_vowel else ONSET.get(symbol, "")
            if symbol == "NG":
                segments.append(("ㅇ",))
                onset = ""
            if symbol == "SH":
                glide = "Y"
            if following in {"W", "Y"}:
                glide = following
                index += 1
        else:
            if symbol == "T" and following == "S" and after not in VOWELS:
                # ts는 츠(에이전츠), 따로 적은 트스도 있다. 스는 t가 빠진 것이다.
                segments.append(("ㅊㅡ", "ㅌㅡㅅㅡ"))
                index += 1
            elif symbol == "D" and following == "Z" and after not in VOWELS:
                segments.append(("ㅈㅡ", "ㄷㅡㅈㅡ"))
                index += 1
            elif symbol == "R":
                segments.append(("ㄹㅡ",))
            elif following is None and symbol in {"P", "T", "K"} and index and symbols[index - 1] in short:
                segments.append(CODA[symbol][1:])
            elif symbol in STOPS and not (index and symbols[index - 1] in VOWELS):
                # 받침은 모음 뒤에만 선다(에이전트의 t는 에이전ㅅ일 수 없다).
                segments.append(CODA[symbol][:1])
            else:
                segments.append(CODA.get(symbol, ("",)))
            ends_in_vowel = segments[-1][0].endswith(("ㅡ", "ㅣ", "ㅠ"))
        index += 1
    return [segment for segment in segments if segment != ("",)]


@lru_cache(maxsize=1)
def _cmudict() -> dict[str, tuple[tuple[str, ...], ...]]:
    entries: dict[str, list[tuple[str, ...]]] = {}
    try:
        lines = CMUDICT_PATH.read_text(encoding="utf-8").splitlines()
    except OSError:
        return {}
    for line in lines:
        if line.startswith(";;;"):
            continue
        head, _, rest = line.partition(" ")
        phonemes = tuple(rest.split("#", 1)[0].split())
        if phonemes:
            entries.setdefault(re.sub(r"\(\d+\)$", "", head), []).append(phonemes)
    return {word: tuple(values) for word, values in entries.items()}


def _pronunciations(word: str) -> list[tuple[str, ...]]:
    """Dictionary pronunciations of one lower-case word, trying common endings."""
    dictionary = _cmudict()
    if word in dictionary:
        return list(dictionary[word])
    for suffix, tail in SUFFIXES:
        stem = word[: -len(suffix)]
        if not word.endswith(suffix) or len(stem) < 3:
            continue
        # scoped → scope, running → run
        for base in (stem, stem + "e", stem[:-1] if stem[-1] == stem[-2] else ""):
            if base in dictionary:
                return [pronunciation + tail for pronunciation in dictionary[base]]
    return []


def _piece_lattices(piece: str) -> list[list[tuple[str, ...]]]:
    """Lattices for one piece of a word: its pronunciations, or letter names for an acronym."""
    lattices = [reading_lattice(list(pronunciation), piece) for pronunciation in _pronunciations(piece.lower())]
    if piece.isupper():
        lattices.append([(phonetic_key(spell_latin_letters(piece)),)])
    return lattices


def _compounds(pieces: list[list[list[tuple[str, ...]]]]) -> list[list[tuple[str, ...]]]:
    if not pieces or not all(pieces):
        return []
    return [[segment for lattice in combination for segment in lattice]
            for combination in itertools.islice(itertools.product(*pieces), MAX_READINGS)]


@lru_cache(maxsize=4096)
def reading_lattices(word: str) -> tuple[list[tuple[str, ...]], ...]:
    """Return a jamo lattice for each plausible reading, or none for an unknown word.

    A compound is read part by part without carrying a consonant across the
    join (Web·Sphere → 웹스피어), which is how Korean writes compounds. Every
    split into two dictionary words is also a reading (plug·in → 플러그인,
    hand·off → 핸드오프, read·me); the dictionary's own reading comes first.
    """
    lattices = _piece_lattices(word)
    camel = re.findall(r"[A-Z]?[a-z]+|[A-Z]+(?![a-z])|[a-z]+", word)
    if len(camel) > 1:
        lattices += _compounds([_piece_lattices(part) for part in camel])
    lowered = word.lower()
    for cut in range(2, len(lowered) - 1):
        lattices += _compounds([_piece_lattices(lowered[:cut]), _piece_lattices(lowered[cut:])])
    unique = {repr(lattice): lattice for lattice in lattices if lattice}
    return tuple(list(unique.values())[:MAX_READINGS])


# 합성어의 두 글자 조각은 전치사만 낱말로 본다(plug·in, in·box, pop·up). re·de·co는 접두사다.
COMPOUND_PARTICLES = frozenset({"in", "on", "up"})
MIN_COMPOUND_LETTERS = 5


def _bare(pronunciation: tuple[str, ...]) -> tuple[str, ...]:
    return tuple(re.sub(r"\d", "", phoneme) for phoneme in pronunciation)


def _keeps_its_vowel(phonemes: tuple[str, ...]) -> bool:
    """Whether a stretch of a word has a vowel said in full, not reduced to a schwa."""
    return any(phoneme[-1] in "12" or (phoneme[-1] == "0" and phoneme[:-1] not in REDUCED_VOWELS)
               for phoneme in phonemes)


def _sounds_like_two_words(whole: list[tuple[str, ...]], head: str, tail: str) -> bool:
    """Whether a pronunciation of the word is ``head`` then ``tail``, each said as a word.

    Both halves keep a full vowel (check·point, time·line). A half reduced to
    a schwa is an ending or part of a name (Jack·son, New·ton, sup·port). A
    particle is the exception: the dictionary reduces it (plug·in).
    """
    dictionary = _cmudict()
    for pronunciation in whole:
        for first in {_bare(value) for value in dictionary[head]}:
            cut = len(first)
            if not any(first + _bare(value) == _bare(pronunciation) for value in dictionary[tail]):
                continue
            if _keeps_its_vowel(pronunciation[:cut]) and (
                    _keeps_its_vowel(pronunciation[cut:]) or tail in COMPOUND_PARTICLES):
                return True
    return False


def compound_parts(word: str, is_word=None) -> tuple[str, str] | None:
    """Split a compound written as one word into its two words, or None.

    A word the dictionary knows is a compound when it is said as its two parts
    one after the other (check·point, plug·in) — car·pet and tar·get are not.
    A word the dictionary lacks (runtime, webhook) is one when both parts are
    dictionary words that ``is_word`` also accepts. An ending is not a word
    (test·ing, retry·able), and a word that splits two different ways
    (han·doff, hand·off) is left alone.
    """
    lowered = word.lower()
    if len(lowered) < MIN_COMPOUND_LETTERS or not lowered.isalpha() or not lowered.isascii():
        return None
    dictionary = _cmudict()
    whole = _pronunciations(lowered)
    endings = {suffix for suffix, _ in SUFFIXES}
    cuts: list[int] = []
    for cut in range(2, len(lowered) - 1):
        head, tail = lowered[:cut], lowered[cut:]
        if head not in dictionary or tail not in dictionary or tail in endings:
            continue
        short = [part for part in (head, tail) if len(part) < 3]
        if any(part not in COMPOUND_PARTICLES for part in short):
            continue
        if whole:
            if _sounds_like_two_words(whole, head, tail):
                cuts.append(cut)
        elif not short and (is_word is None or (is_word(head) and is_word(tail))):
            cuts.append(cut)
    # time·stamp와 times·tamp는 같은 소리다. 앞 낱말의 복수형으로 가른 쪽을 버린다.
    cuts = [cut for cut in cuts if not (lowered[cut - 1] == "s" and cut - 1 in cuts)]
    if len(cuts) == 1:
        return word[:cuts[0]], word[cuts[0]:]
    if not cuts and not whole and lowered.endswith("s"):
        # 낱말 목록에는 복수형이 드물다(webhooks → web hooks).
        singular = compound_parts(word[:-1], is_word)
        return (singular[0], singular[1] + word[-1]) if singular else None
    return None


def _scan(lattice: list[tuple[str, ...]], text_key: str) -> tuple[float, int, list[int]]:
    """Match any path of ``lattice`` anywhere in ``text_key``.

    Sellers' approximate substring match over a lattice instead of a string:
    the text may start and end anywhere for free, and each segment may be
    matched by any of its spellings. Returns the best cost divided by the
    length of the loanword-orthography path, that length, and every text
    position where an exact match ends.
    """
    # 각 노드는 자모 하나와 앞 노드들. -1은 시작점이다.
    nodes: list[tuple[str, tuple[int, ...]]] = []
    entry: list[int] = [-1]
    for alternatives in lattice:
        exits: list[int] = []
        for spelling in (_jamo_key(value) for value in alternatives):
            previous = entry
            for symbol in spelling:
                nodes.append((symbol, tuple(previous)))
                previous = [len(nodes) - 1]
            exits.extend(previous)
        entry = list(dict.fromkeys(exits))
    length = sum(len(_jamo_key(alternatives[0])) for alternatives in lattice)
    if not nodes or not length:
        return 1.0, 0, []

    def value(column: list[int], node: int) -> int:
        return 0 if node < 0 else column[node]

    column: list[int] = []
    for symbol, predecessors in nodes:
        column.append(min(value(column, node) for node in predecessors) + 1)
    best = min(value(column, node) for node in entry)
    exact: list[int] = []
    for position, character in enumerate(text_key):
        current: list[int] = []
        for index, (symbol, predecessors) in enumerate(nodes):
            cost = column[index] + 1
            for node in predecessors:
                cost = min(cost, value(column, node) + (symbol != character), value(current, node) + 1)
            current.append(cost)
        column = current
        cost = min(value(column, node) for node in entry)
        best = min(best, cost)
        if cost == 0:
            exact.append(position)
    return best / length, length, exact


@lru_cache(maxsize=None)
def _jamo_key(jamo: str) -> str:
    """Fold a jamo spelling the way :func:`phonetic_key` folds a transcript."""
    return phonetic_key(jamo)


def reading_match(word: str, text: str) -> tuple[float, int] | None:
    """How close ``text`` comes to a Hangul reading of ``word``, and how often it says one exactly.

    Returns ``(distance, count)``, or None for a word the dictionary cannot read.
    A distance of 0 means some reading is written jamo for jamo.
    """
    lattices = reading_lattices(word)
    if not lattices:
        return None
    best, count = 1.0, 0
    # 받아쓰기에 남은 로마자는 글자 이름으로도 읽는다(오픈 AI → 오픈에이아이).
    for key in dict.fromkeys((phonetic_key(text), phonetic_key(spell_latin_letters(text)))):
        ends: set[int] = set()
        stride = len(key) + 1
        for lattice in lattices:
            distance, length, exact = _scan(lattice, key)
            best = min(best, distance)
            ends.update(exact)
            stride = min(stride, max(1, length // 2))
        count = max(count, _count_non_overlapping(sorted(ends), stride))
    return best, count


def compose(jamo: str) -> str:
    """Write a jamo sequence as Hangul syllables, for reports and tests."""
    output: list[str] = []
    index = 0
    while index < len(jamo):
        onset = jamo[index]
        if onset in ONSETS and index + 1 < len(jamo) and jamo[index + 1] in NUCLEI:
            nucleus = jamo[index + 1]
            index += 2
            coda = ""
            if (index < len(jamo) and jamo[index] in CODAS
                    and not (index + 1 < len(jamo) and jamo[index + 1] in NUCLEI)):
                coda = jamo[index]
                index += 1
            output.append(chr(HANGUL_START + (ONSETS.index(onset) * 21 + NUCLEI.index(nucleus)) * 28
                              + CODAS.index(coda or " ")))
        else:
            output.append(onset)
            index += 1
    return "".join(output)


def hangul_reading(word: str) -> str | None:
    """The loanword-orthography reading of ``word`` (first pronunciation), or None."""
    lattices = reading_lattices(word)
    if not lattices:
        return None
    return compose("".join(alternatives[0] for alternatives in lattices[0]))
