"""Deterministic Korean text preparation for speech synthesis.

The course keeps ``source_text`` unchanged for captions.  This module produces a
separate pronunciation-only string and a small preflight report.  Rules here are
deliberately deterministic: generation retries can improve delivery, but they
must never be responsible for deciding how a technical term or number is read.
"""

from __future__ import annotations

import re
from typing import Any


ASCII_TOKEN_PATTERN = re.compile(
    r"(?<![A-Za-z0-9])"
    r"[A-Za-z][A-Za-z0-9]*(?:[._+/#-][A-Za-z0-9]+)*"
    r"(?![A-Za-z0-9])"
)
NUMBER_TOKEN_PATTERN = re.compile(r"(?<![A-Za-z0-9])\d+(?:[.,]\d+)*(?![A-Za-z0-9])")
QWEN_MODEL_PATTERN = re.compile(
    r"(?<![A-Za-z0-9])Qwen\s*(\d+)(?:\.(\d+))?\s*(?:[-–—]\s*)?(\d+)\s*B(?![A-Za-z0-9])",
    re.IGNORECASE,
)
COUNTED_NUMBER_PATTERN = re.compile(
    r"(?<![\d.])(\d+)\s*"
    r"(개|명|번|가지|장|페이지|초|분|시간|일|주|개월|년|원|달러|퍼센트|%|KB|MB|GB|TB)"
    r"(?![A-Za-z])",
    re.IGNORECASE,
)
PARAMETER_SIZE_PATTERN = re.compile(
    r"(?<![A-Za-z0-9])(\d+)\s*B(?![A-Za-z0-9])",
    re.IGNORECASE,
)
DECIMAL_NUMBER_PATTERN = re.compile(r"(?<![\d.])(\d+)\.(\d+)(?![\d.])")
# Anything still written as digits after every other rule and the dictionary
# have run. A number left as digits is a number the model gets to guess at, and
# guessing is what produced "호십개" in the first place. Sino-Korean is the
# default reading in lecture narration; the handful of counters that want a
# native reading ("한 턴") are dictionary overrides, which run before this.
BARE_NUMBER_PATTERN = re.compile(
    r"(?<![A-Za-z0-9])(?<!\d\.)(\d+(?:,\d{3})*)(?![A-Za-z0-9])(?!\.\d)"
)

_DIGITS = ("영", "일", "이", "삼", "사", "오", "육", "칠", "팔", "구")
_SMALL_UNITS = ("", "십", "백", "천")
_LARGE_UNITS = ("", "만", "억", "조", "경")
_SPOKEN_UNITS = {
    "%": "퍼센트",
    "kb": "킬로바이트",
    "mb": "메가바이트",
    "gb": "기가바이트",
    "tb": "테라바이트",
}


def korean_sino_integer(value: str | int) -> str:
    """Render a non-negative integer using deterministic Sino-Korean numerals."""
    raw = str(value).replace(",", "").strip()
    if not raw.isdigit():
        raise ValueError(f"정수가 아닙니다: {value}")
    number = int(raw)
    if number == 0:
        return _DIGITS[0]
    if number >= 10 ** (4 * len(_LARGE_UNITS)):
        return " ".join(_DIGITS[int(digit)] for digit in raw)

    groups: list[str] = []
    group_index = 0
    while number:
        group = number % 10_000
        number //= 10_000
        if group:
            spoken: list[str] = []
            for position in range(3, -1, -1):
                digit = (group // (10**position)) % 10
                if not digit:
                    continue
                if digit != 1 or position == 0:
                    spoken.append(_DIGITS[digit])
                spoken.append(_SMALL_UNITS[position])
            groups.append("".join(spoken) + _LARGE_UNITS[group_index])
        group_index += 1
    return "".join(reversed(groups))


def korean_decimal_part(value: str) -> str:
    """Read digits after a decimal point one by one."""
    return "".join(_DIGITS[int(digit)] for digit in value)


def normalize_structured_tokens(text: str) -> str:
    """Normalize model versions and number+unit forms before dictionary rules."""

    def qwen_name(match: re.Match[str]) -> str:
        major, minor, size = match.groups()
        version = korean_sino_integer(major)
        if minor is not None:
            version += f"점{korean_decimal_part(minor)}"
        return f"큐웬{version} {korean_sino_integer(size)}비"

    def counted_number(match: re.Match[str]) -> str:
        value, unit = match.groups()
        spoken_unit = _SPOKEN_UNITS.get(unit.casefold(), unit)
        return f"{korean_sino_integer(value)} {spoken_unit}"

    output = QWEN_MODEL_PATTERN.sub(qwen_name, text)
    output = PARAMETER_SIZE_PATTERN.sub(
        lambda match: f"{korean_sino_integer(match.group(1))}비",
        output,
    )
    output = DECIMAL_NUMBER_PATTERN.sub(
        lambda match: f"{korean_sino_integer(match.group(1))}점{korean_decimal_part(match.group(2))}",
        output,
    )
    return COUNTED_NUMBER_PATTERN.sub(counted_number, output)


def read_remaining_numbers(text: str) -> str:
    """Read every digit run that survived the earlier rules as Sino-Korean.

    Applied last, so a dictionary entry containing digits still matches first.
    No spacing is inserted: the digits are replaced where they stand, which
    reads correctly whether a particle follows (50이라는 → 오십이라는) or a
    counter does (160토큰 → 백육십토큰).
    """
    return BARE_NUMBER_PATTERN.sub(
        lambda match: korean_sino_integer(match.group(1)), text
    )


def merge_pronunciation_dictionaries(
    *dictionaries: list[dict[str, Any]],
) -> list[dict[str, Any]]:
    """Merge dictionaries so a later source term genuinely overrides an earlier one."""
    merged: dict[str, dict[str, Any]] = {}
    order: list[str] = []
    for dictionary in dictionaries:
        for item in dictionary:
            source = str(item.get("from", ""))
            replacement = str(item.get("to", ""))
            if not source or not replacement:
                raise ValueError("발음 사전의 from과 to는 비어 있을 수 없습니다.")
            if source not in merged:
                order.append(source)
            merged[source] = {**item, "from": source, "to": replacement}
    # Longest-first prevents Agent from consuming the tail of Multi-Agent.
    position = {source: index for index, source in enumerate(order)}
    return sorted(merged.values(), key=lambda item: (-len(item["from"]), position[item["from"]]))


def _dictionary_pattern(item: dict[str, Any]) -> re.Pattern[str]:
    source = str(item["from"])
    escaped = re.escape(source)
    if re.search(r"[A-Za-z0-9]", source):
        if source[0].isalnum():
            escaped = rf"(?<![A-Za-z0-9]){escaped}"
        if source[-1].isalnum():
            escaped = rf"{escaped}(?![A-Za-z0-9])"
    flags = 0 if item.get("caseSensitive") else re.IGNORECASE
    return re.compile(escaped, flags)


def _apply_dictionary(text: str, dictionary: list[dict[str, Any]]) -> str:
    """Structural normalization and dictionary replacement, before the fallback.

    Kept separate so the preflight can see which digits the dictionary chose to
    leave alone, which is exactly the set the fallback will read.
    """
    output = normalize_structured_tokens(text)
    for item in merge_pronunciation_dictionaries(dictionary):
        output = _dictionary_pattern(item).sub(str(item["to"]), output)
    return output


def apply_pronunciation(text: str, dictionary: list[dict[str, Any]]) -> str:
    """Apply structural normalization and token-aware pronunciation replacements."""
    output = read_remaining_numbers(_apply_dictionary(text, dictionary))
    return re.sub(r"[ \t]+", " ", output).strip()


def pronunciation_preflight(
    source_text: str,
    dictionary: list[dict[str, Any]],
) -> dict[str, Any]:
    """Return synthesis text and unresolved risky tokens for manifests and UI."""
    tts_text = apply_pronunciation(source_text, dictionary)
    matched: list[dict[str, str]] = []
    required: list[str] = []
    for item in merge_pronunciation_dictionaries(dictionary):
        if _dictionary_pattern(item).search(source_text):
            matched.append({"from": str(item["from"]), "to": str(item["to"])})
            required.append(str(item["to"]))
    if QWEN_MODEL_PATTERN.search(source_text):
        matched.append({"from": "Qwen<version>-<size>B", "to": "큐웬<버전> <크기>비"})
    counted_matches = list(COUNTED_NUMBER_PATTERN.finditer(source_text))
    counted = [match.group(0) for match in counted_matches]
    for match in QWEN_MODEL_PATTERN.finditer(source_text):
        required.append(normalize_structured_tokens(match.group(0)))
    for match in counted_matches:
        required.append(normalize_structured_tokens(match.group(0)))
    for match in PARAMETER_SIZE_PATTERN.finditer(source_text):
        required.append(normalize_structured_tokens(match.group(0)))
    for match in DECIMAL_NUMBER_PATTERN.finditer(source_text):
        required.append(normalize_structured_tokens(match.group(0)))
    for match in BARE_NUMBER_PATTERN.finditer(_apply_dictionary(source_text, dictionary)):
        required.append(korean_sino_integer(match.group(1)))
    return {
        "sourceText": source_text,
        "ttsText": tts_text,
        "changed": source_text != tts_text,
        "dictionaryMatches": matched,
        "normalizedNumbers": counted,
        "requiredPronunciations": list(dict.fromkeys(required)),
        "unresolvedAscii": sorted(set(ASCII_TOKEN_PATTERN.findall(tts_text)), key=str.casefold),
        "unresolvedNumbers": sorted(set(NUMBER_TOKEN_PATTERN.findall(tts_text))),
    }
