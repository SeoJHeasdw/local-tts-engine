"""Conservative Korean naturalness rules applied before TTS normalization.

Speech recognition can confirm that a synthesizer followed the pronunciation
text, but it cannot decide whether that pronunciation text was natural Korean.
In particular, Whisper commonly writes both ``열 개`` and ``십 개`` as
``10개``.  This module therefore resolves high-confidence counter readings
before synthesis and records every decision for the manifest.

Only counters whose meaning is stable without wider sentence context belong
here.  Ambiguous forms such as ``1번`` (item number one vs. one occurrence) and
``1장`` (chapter one vs. one sheet) remain in the pronunciation layer until a
more specific policy or dictionary entry handles them.
"""

from __future__ import annotations

import re
from typing import Any


# These are high-confidence bound nouns: a number below the configured limit
# normally takes a native-Korean attributive form. Units whose meaning changes
# by context (번, 장, 회, 단계) deliberately stay out.
NATIVE_COUNTER_LIMITS = {
    "개": 99,
    "가지": 99,
    "건": 99,
    "명": 99,
    "살": 99,
    "턴": 99,
    "시": 12,
    "시간": 12,
}

# A counter must end before a boundary or a grammatical suffix, not inside a
# different noun: 2시점 and 3명령어 are not two o'clock and three people.
# Particles and counter suffixes remain attached in the source (10개가,
# 3살짜리, 2턴째); their spelling is never rewritten by this rule.
KOREAN_COUNTER_BOUNDARY = (
    r"(?=$|[^A-Za-z가-힣]|"
    r"[이가은는을를에도와과의로]|으로|에서|부터|까지|보다|만큼|"
    r"이상|이하|미만|정도|쯤|짜리|째|씩|마다|만|뿐|당|치|경|예요|인|일|"
    r"라도|라면|라서|라는|라고|랑|면|며|였|여서|야|요|입니다|입니까|"
    r"처럼|동안|밖에|하고|든|나마|나(?=$|[^가-힣]))"
)

# 개월 must not be mistaken for 개. A number joined to an identifier also
# stays untouched until a complete dictionary entry answers its reading.
NATIVE_COUNTER_PATTERN = re.compile(
    r"(?<![A-Za-z0-9._+/#-])(?P<number>\d{1,2})\s*"
    r"(?P<counter>시간|가지|개(?!월)|건|명|살|턴|시|배)"
    + KOREAN_COUNTER_BOUNDARY
)

COUNTER_SPACING_PATTERN = re.compile(
    r"(?P<quantity>몇|두어|서너|너댓|대여섯|한두)"
    r"(?P<counter>시간|가지|개(?!월)|건|명|살|턴)"
    + KOREAN_COUNTER_BOUNDARY
)

# Letter-number identifiers require a pronunciation decision. Reading the
# digits as one cardinal number turned A-2041 into A-이천사십일. A concrete
# dictionary entry settles the reading. Unknown tokens remain review warnings
# and never prevent course production.
MIXED_IDENTIFIER_PATTERN = re.compile(
    r"(?<![A-Za-z0-9])"
    r"(?=[A-Za-z0-9._+/#-]*[A-Za-z])(?=[A-Za-z0-9._+/#-]*\d)"
    r"[A-Za-z0-9]+(?:[._+/#-][A-Za-z0-9]+)*"
    r"(?![A-Za-z0-9])"
)
SAFE_STRUCTURED_IDENTIFIER_PATTERNS = (
    re.compile(r"Qwen\d+(?:\.\d+)?-\d+B", re.IGNORECASE),
    re.compile(r"\d+B", re.IGNORECASE),
    re.compile(r"\d+(?:\.\d+)?(?:KB|MB|GB|TB)", re.IGNORECASE),
)

_NATIVE_ONES = (
    "",
    "한",
    "두",
    "세",
    "네",
    "다섯",
    "여섯",
    "일곱",
    "여덟",
    "아홉",
)
_NATIVE_TENS = (
    "",
    "열",
    "스물",
    "서른",
    "마흔",
    "쉰",
    "예순",
    "일흔",
    "여든",
    "아흔",
)

# This is an explicit production-language decision, not a general statement
# about Korean grammar.  The course owner approved 오십 개 while correcting the
# earlier model hallucination 호십개, so the naturalness layer must preserve it.
APPROVED_COUNTER_READINGS: dict[tuple[str, int], str] = {
    ("개", 50): "오십 개",
    ("배", 1): "한 배",
    ("배", 2): "두 배",
    ("배", 3): "세 배",
    ("배", 4): "네 배",
}


def korean_native_counter_integer(value: str | int) -> str:
    """Render 1..99 in the attributive native-Korean form used by counters."""
    number = int(str(value).strip())
    if not 1 <= number <= 99:
        raise ValueError(f"고유어 수 관형형 범위가 아닙니다: {value}")
    tens, ones = divmod(number, 10)
    if tens == 0:
        return _NATIVE_ONES[ones]
    # Exactly twenty is 스무 before a counter; compounds retain 스물-.
    if number == 20:
        return "스무"
    return f"{_NATIVE_TENS[tens]}{_NATIVE_ONES[ones]}"


def korean_naturalness_preflight(text: str) -> dict[str, Any]:
    """Rewrite high-confidence number+counter forms and return an audit trail."""
    checks: list[dict[str, Any]] = []

    def add_spacing(match: re.Match[str]) -> str:
        source = match.group(0)
        reading = f"{match.group('quantity')} {match.group('counter')}"
        checks.append(
            {
                "source": source,
                "reading": reading,
                "counter": match.group("counter"),
                "rule": "counter-spacing",
            }
        )
        return reading

    def replace(match: re.Match[str]) -> str:
        source = match.group(0)
        number = int(match.group("number"))
        counter = match.group("counter")
        if number == 0:
            return source
        override = APPROVED_COUNTER_READINGS.get((counter, number))
        limit = NATIVE_COUNTER_LIMITS.get(counter)
        if override is None and (limit is None or number > limit):
            return source
        reading = override or f"{korean_native_counter_integer(number)} {counter}"
        checks.append(
            {
                "source": source,
                "reading": reading,
                "number": number,
                "counter": counter,
                "rule": "approved-override" if override else "native-counter-under-100",
            }
        )
        return reading

    rewritten = COUNTER_SPACING_PATTERN.sub(add_spacing, text)
    rewritten = NATIVE_COUNTER_PATTERN.sub(replace, rewritten)
    identifiers = [match.group(0) for match in MIXED_IDENTIFIER_PATTERN.finditer(rewritten)]
    warnings = [
        f"{identifier}: 발음 사전 미등록 — 제작 후 읽기 확인"
        for identifier in identifiers
        if not any(pattern.fullmatch(identifier) for pattern in SAFE_STRUCTURED_IDENTIFIER_PATTERNS)
    ]
    return {
        "text": rewritten,
        "changed": rewritten != text,
        "checks": checks,
        "warnings": warnings,
    }


def apply_korean_naturalness(text: str) -> str:
    """Return the text selected by the Korean naturalness preflight."""
    return str(korean_naturalness_preflight(text)["text"])
