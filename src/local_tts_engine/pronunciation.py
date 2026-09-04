"""Deterministic Korean text preparation for speech synthesis.

The course keeps ``source_text`` unchanged for captions.  This module produces a
separate pronunciation-only string and a small preflight report.  Rules here are
deliberately deterministic: generation retries can improve delivery, but they
must never be responsible for deciding how a technical term or number is read.

A dictionary entry marked ``"literal": true`` protects the span it matches from
every later rule.  The lecture quotes English documentation aloud, and those
sentences are read correctly as English — measured at a 0.019 phonetic distance
on page 186.  Without protection the term dictionary reaches inside them and
produces "Do my 봇츠 share one computer?", which is neither language.
"""

from __future__ import annotations

import re
from typing import Any

from .korean_naturalness import korean_naturalness_preflight


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
    r"(?<![\d.])(\d+(?:,\d{3})*(?:\.\d+)?)\s*"
    r"(킬로바이트|메가바이트|기가바이트|테라바이트|개월|페이지|퍼센트|달러|"
    r"시간|회차|단계|토큰|가지|개|건|명|번|장|살|턴|초|분(?!의)|일|주|년|"
    r"원|점|회|배|시|%|KB|MB|GB|TB)"
    r"(?![A-Za-z])",
    re.IGNORECASE,
)
PARAMETER_SIZE_PATTERN = re.compile(
    r"(?<![A-Za-z0-9])(\d+)\s*B(?![A-Za-z0-9])",
    re.IGNORECASE,
)
DECIMAL_NUMBER_PATTERN = re.compile(r"(?<![\d.])(\d+)\.(\d+)(?![\d.])")
FRACTION_NUMBER_PATTERN = re.compile(
    r"(?<![\d.])(\d+(?:,\d{3})*)\s*분의\s*(\d+(?:,\d{3})*)(?![\d.])"
)
# Anything still written as digits after every other rule and the dictionary
# have run. A number left as digits is a number the model gets to guess at, and
# guessing is what produced "호십개" in the first place. Sino-Korean is the
# default reading in lecture narration; the handful of counters that want a
# native reading ("한 턴") are dictionary overrides, which run before this.
# A digit run hyphenated to a letter belongs to an identifier (B-3099), and the
# dictionary already refuses to touch those. Reading the number half anyway
# produced "B-삼천구십구". A hyphen between two digit runs is still read, so a
# plain range keeps its Sino-Korean reading rather than being left for the model
# to guess at.
BARE_NUMBER_PATTERN = re.compile(
    r"(?<![A-Za-z0-9])(?<!\d\.)(?<![A-Za-z]-)"
    r"(\d+(?:,\d{3})*)"
    r"(?![A-Za-z0-9])(?!\.\d)(?!-[A-Za-z])"
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


def korean_spoken_number(value: str) -> str:
    """Render an integer or decimal in the deterministic lecture style."""
    normalized = value.replace(",", "")
    if "." not in normalized:
        return korean_sino_integer(normalized)
    integer, decimal = normalized.split(".", 1)
    return f"{korean_sino_integer(integer)}점{korean_decimal_part(decimal)}"


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
        return f"{korean_spoken_number(value)} {spoken_unit}"

    output = QWEN_MODEL_PATTERN.sub(qwen_name, text)
    output = PARAMETER_SIZE_PATTERN.sub(
        lambda match: f"{korean_sino_integer(match.group(1))}비",
        output,
    )
    output = FRACTION_NUMBER_PATTERN.sub(
        lambda match: (
            f"{korean_sino_integer(match.group(1))}분의 "
            f"{korean_sino_integer(match.group(2))}"
        ),
        output,
    )
    output = COUNTED_NUMBER_PATTERN.sub(counted_number, output)
    output = DECIMAL_NUMBER_PATTERN.sub(
        lambda match: f"{korean_sino_integer(match.group(1))}점{korean_decimal_part(match.group(2))}",
        output,
    )
    return output


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
    """Match a term only where it stands on its own.

    A hyphen joining two alphanumerics is part of one token, not a boundary.
    Without that rule ``B`` is plucked out of the order number ``B-3099``,
    which both mispronounces it and disarms the identifier guard that exists to
    stop ``A-2041`` from being read as 에이 이천사십일. The same rule keeps
    ``Agent`` out of ``Multi-Agent``, so an unmapped compound stays visible as
    an unresolved term instead of becoming ``Multi-에이전트``.

    Sentence punctuation is not a joiner: ``Agent.`` still matches, because the
    guard only rejects a hyphen with an alphanumeric on its far side.
    """
    source = str(item["from"])
    escaped = re.escape(source)
    if re.search(r"[A-Za-z0-9]", source):
        if source[0].isalnum():
            escaped = rf"(?<![A-Za-z0-9])(?<![A-Za-z0-9]-){escaped}"
        if source[-1].isalnum():
            escaped = rf"{escaped}(?![A-Za-z0-9])(?!-[A-Za-z0-9])"
    flags = 0 if item.get("caseSensitive") else re.IGNORECASE
    return re.compile(escaped, flags)


# Private-use code points stand in for protected spans while the rest of the
# rules run.  They are category ``Co``: no pattern in this module matches them,
# so a protected span cannot be split, read as a number, or partially replaced.
PROTECTED_PLACEHOLDER_START = 0xE000


def _protect_literal_spans(
    text: str,
    dictionary: list[dict[str, Any]],
) -> tuple[str, list[str]]:
    """Swap every ``literal`` entry's match for a placeholder the rules ignore."""
    kept: list[str] = []

    def swap(match: re.Match[str]) -> str:
        kept.append(replacement)
        return chr(PROTECTED_PLACEHOLDER_START + len(kept) - 1)

    output = text
    for item in dictionary:
        if not item.get("literal"):
            continue
        replacement = str(item["to"])
        output = _dictionary_pattern(item).sub(swap, output)
    return output, kept


def _restore_literal_spans(text: str, kept: list[str]) -> str:
    """Put the protected spans back once every other rule has run."""
    for index, span in enumerate(kept):
        text = text.replace(chr(PROTECTED_PLACEHOLDER_START + index), span)
    return text


def _apply_dictionary(
    text: str,
    dictionary: list[dict[str, Any]],
) -> tuple[str, list[str]]:
    """Dictionary, naturalness, and structural normalization before fallback.

    Source-specific dictionary decisions run first.  That lets an explicit
    course rule override a general counter-reading policy.  The naturalness
    layer then chooses high-confidence Korean readings before the remaining
    numeric structures fall back to deterministic Sino-Korean.

    Returns the rewritten text and the protected spans still standing in as
    placeholders, which the caller restores after the numeric fallback.
    """
    merged = merge_pronunciation_dictionaries(dictionary)
    output, protected = _protect_literal_spans(text, merged)
    for item in merged:
        if item.get("literal"):
            continue
        output = _dictionary_pattern(item).sub(str(item["to"]), output)
    output = str(korean_naturalness_preflight(output)["text"])
    return normalize_structured_tokens(output), protected


def apply_pronunciation(text: str, dictionary: list[dict[str, Any]]) -> str:
    """Apply structural normalization and token-aware pronunciation replacements."""
    output, protected = _apply_dictionary(text, dictionary)
    output = _restore_literal_spans(read_remaining_numbers(output), protected)
    return re.sub(r"[ \t]+", " ", output).strip()


def pronunciation_preflight(
    source_text: str,
    dictionary: list[dict[str, Any]],
) -> dict[str, Any]:
    """Return synthesis text and unresolved risky tokens for manifests and UI."""
    merged = merge_pronunciation_dictionaries(dictionary)
    dictionary_text, protected_spans = _protect_literal_spans(source_text, merged)
    for item in merged:
        if item.get("literal"):
            continue
        dictionary_text = _dictionary_pattern(item).sub(str(item["to"]), dictionary_text)
    naturalness = korean_naturalness_preflight(dictionary_text)
    tts_text = apply_pronunciation(source_text, dictionary)
    matched: list[dict[str, str]] = []
    dictionary_spans: list[tuple[int, int]] = []
    required: list[str] = []
    for item in merged:
        item_matches = list(_dictionary_pattern(item).finditer(source_text))
        if item_matches:
            matched.append({"from": str(item["from"]), "to": str(item["to"])})
            required.append(str(item["to"]))
            dictionary_spans.extend(match.span() for match in item_matches)

    def covered_by_dictionary(match: re.Match[str]) -> bool:
        start, end = match.span()
        return any(start >= item_start and end <= item_end for item_start, item_end in dictionary_spans)

    if QWEN_MODEL_PATTERN.search(source_text):
        matched.append({"from": "Qwen<version>-<size>B", "to": "큐웬<버전> <크기>비"})
    counted_matches = list(COUNTED_NUMBER_PATTERN.finditer(source_text))
    counted = [match.group(0) for match in counted_matches]
    for match in QWEN_MODEL_PATTERN.finditer(source_text):
        required.append(apply_pronunciation(match.group(0), dictionary))
    for match in FRACTION_NUMBER_PATTERN.finditer(source_text):
        if not covered_by_dictionary(match):
            required.append(apply_pronunciation(match.group(0), dictionary))
    for match in counted_matches:
        if not covered_by_dictionary(match):
            required.append(apply_pronunciation(match.group(0), dictionary))
    for match in PARAMETER_SIZE_PATTERN.finditer(source_text):
        required.append(apply_pronunciation(match.group(0), dictionary))
    for match in DECIMAL_NUMBER_PATTERN.finditer(source_text):
        required.append(apply_pronunciation(match.group(0), dictionary))
    for match in BARE_NUMBER_PATTERN.finditer(_apply_dictionary(source_text, dictionary)[0]):
        required.append(korean_sino_integer(match.group(1)))
    # A deliberately English span is an answered question, not a term nobody
    # decided how to read, so the unresolved lists are measured with those
    # spans still standing in as placeholders.
    unresolved_text, _ = _protect_literal_spans(tts_text, merged)
    return {
        "sourceText": source_text,
        "ttsText": tts_text,
        "changed": source_text != tts_text,
        "dictionaryMatches": matched,
        "naturalnessChecks": naturalness["checks"],
        "naturalnessWarnings": naturalness["warnings"],
        "normalizedNumbers": counted,
        "requiredPronunciations": list(dict.fromkeys(required)),
        "unresolvedAscii": sorted(
            set(ASCII_TOKEN_PATTERN.findall(unresolved_text)), key=str.casefold
        ),
        "unresolvedNumbers": sorted(set(NUMBER_TOKEN_PATTERN.findall(unresolved_text))),
    }
