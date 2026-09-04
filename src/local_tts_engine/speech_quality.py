"""Automatic quality scoring for generated lecture speech.

The ASR transcript is an independent observation, not a replacement for the
caption source.  A candidate is accepted when the sound it contains matches the
sound the script asked for and its waveform shows no silence, clipping, or
pacing anomaly.

Two rules keep this layer honest.

*Compare sound, not spelling.*  Whisper writes ``27B`` where the speaker said
``이십칠 비``.  Every text comparison therefore happens in pronunciation space
(:mod:`.korean_phonetics`), so a different spelling of the same sound can never
be reported as a mispronunciation.

*Separate "this is wrong" from "I am not sure".*  A term the reader clearly
never said is a failure and the page is marked for regeneration.  A term heard
imperfectly is a warning: the generator still tries another seed, but if every
seed lands in the same place the user is shown the segment to listen to instead
of being told the production failed.
"""

from __future__ import annotations

import re
import unicodedata
from pathlib import Path
from typing import Any

import numpy as np
import soundfile as sf

from .korean_phonetics import (
    count_pronunciation_matches,
    phonetic_variants,
    pronunciation_distance,
)
from .pronunciation import apply_pronunciation


ASR_REPOSITORY = "mlx-community/whisper-large-v3-turbo-asr-fp16"
ASR_LICENSE = "MIT"
MAX_AUTOMATIC_ATTEMPTS = 4
# The gate that can fail a page reads pronunciation, not spelling. Measured on
# this course: a transcript differing only in how it writes a term sits at or
# below 0.03, while a dropped clause or a genuinely different reading starts at
# 0.35. Orthographic distance does not separate the two — an unmapped acronym in
# a short chunk reaches 0.15 there — which is what made correct pages fail.
MAX_PHONETIC_ERROR_RATE = 0.10
MIN_SPEAKING_CHARACTERS_PER_SECOND = 1.0
MAX_SPEAKING_CHARACTERS_PER_SECOND = 11.0
MAX_SILENCE_RATIO = 0.62
MAX_CLIPPING_RATIO = 0.001

# Whisper reads a fixed 30-second window.  Handed a longer clip it still returns
# a transcript, but material near the window boundary can silently vanish: the
# 31-second take of page 304 lost "에이전트 수가 아니라 평가로 확인된" on all four
# seeds, while the same audio read in two pieces contained it every time.  Four
# identical drops look exactly like a model that consistently misreads, so the
# severity promotion in :func:`chunk_severity` turned an ASR artefact into a
# failed page.  Every reading therefore stays inside one window.
#
# Measured on the CH03 L02 clips, whole-clip versus windowed phonetic distance:
#
#     304p (false alarm)    0.090–0.119  →  0.005   every take
#     307p (silent miss)    0.069        →  0.009
#     306p (real defect)    0.127–0.138  →  0.127–0.141
#     310p (real defect)    0.107–0.224  →  0.098–0.117
#
# The artefact disappears and the real defects are untouched.  Splitting the
# reading — not the generated audio — keeps clip hashes, pacing and breath
# unchanged, which is why MAX_CHUNK_CHARS is deliberately left alone.
ASR_WINDOW_SECONDS = 30.0
# Leave headroom below the window: a cut lands on the quietest frame in range,
# not exactly where asked, and the encoder pads what it receives.
MAX_ASR_READING_SECONDS = 24.0
# Below this a clip is read whole. Between it and MAX_ASR_READING_SECONDS the
# split would buy nothing, and an extra seam costs an extra chance to drop a
# word at a boundary.
MIN_ASR_SPLIT_SECONDS = 26.0
# A cut may be pulled back this far to reach a silence; beyond that the search
# gives up and cuts on the limit, which is still inside the window.
ASR_CUT_SEARCH_RATIO = 0.4

# Below this, two transcripts describe the same sound and any remaining
# difference is spelling.  Above the warning bound, the reader said something
# else entirely.  Between them the evidence is genuinely ambiguous, which is
# what a human ear is for.
PRONUNCIATION_MATCH_DISTANCE = 0.15
PRONUNCIATION_WARNING_DISTANCE = 0.34

# Whole-utterance PER is intentionally tolerant of ASR spelling differences,
# but that means one wrong word can disappear inside a 300-character chunk.
# A second local gate checks sufficiently long Hangul words as substrings. It is
# looser than an explicitly required pronunciation, because inflection and ASR
# normalization can legitimately vary at word boundaries.
MIN_LEXICAL_KEY_LENGTH = 6
LEXICAL_WARNING_DISTANCE = 0.24
LEXICAL_FAILURE_DISTANCE = 0.55
HANGUL_WORD_PATTERN = re.compile(r"[가-힣]+")

FAILURE_PENALTY = 25.0
WARNING_PENALTY = 6.0
TARGET_CHARACTERS_PER_SECOND = 4.2


def comparison_text(text: str, dictionary: list[dict[str, Any]] | None = None) -> str:
    """Normalize spelling variants and retain only letters and numbers."""
    value = apply_pronunciation(text, dictionary or [])
    value = unicodedata.normalize("NFKC", value).casefold()
    return "".join(
        character
        for character in value
        if unicodedata.category(character).startswith(("L", "N"))
    )


def pronunciation_keys(text: str, dictionary: list[dict[str, Any]] | None = None) -> tuple[str, ...]:
    """Return the pronunciation keys for text after dictionary normalization."""
    return phonetic_variants(apply_pronunciation(text, dictionary or []))


def edit_distance(left: str, right: str) -> int:
    """Return Levenshtein distance using one row of memory."""
    if len(left) < len(right):
        left, right = right, left
    previous = list(range(len(right) + 1))
    for left_index, left_character in enumerate(left, start=1):
        current = [left_index]
        for right_index, right_character in enumerate(right, start=1):
            current.append(
                min(
                    current[-1] + 1,
                    previous[right_index] + 1,
                    previous[right_index - 1] + (left_character != right_character),
                )
            )
        previous = current
    return previous[-1]


def character_error_rate(expected: str, recognized: str) -> float:
    """Return normalized character edit distance (0 is an exact match)."""
    if not expected:
        return 0.0 if not recognized else 1.0
    return edit_distance(expected, recognized) / len(expected)


def phonetic_error_rate(
    expected_text: str,
    recognized_text: str,
    dictionary: list[dict[str, Any]] | None = None,
) -> float:
    """Return the best whole-utterance distance in pronunciation space."""
    expected_keys = pronunciation_keys(expected_text, dictionary)
    recognized_keys = pronunciation_keys(recognized_text, dictionary)
    if not expected_keys or not expected_keys[0]:
        return 0.0 if not any(recognized_keys) else 1.0
    return min(
        edit_distance(expected, recognized) / len(expected)
        for expected in expected_keys
        if expected
        for recognized in recognized_keys or ("",)
    )


def check_pronunciation(
    term: str,
    expected_text: str,
    recognized_text: str,
    dictionary: list[dict[str, Any]] | None = None,
) -> dict[str, Any]:
    """Judge whether one required pronunciation is actually audible.

    Returns the measured distance alongside a verdict, so a manifest records why
    a page was flagged rather than only that it was.
    """
    term_keys = [key for key in pronunciation_keys(term, dictionary) if key]
    recognized_keys = [key for key in pronunciation_keys(recognized_text, dictionary) if key] or [""]
    expected_keys = [key for key in pronunciation_keys(expected_text, dictionary) if key] or [""]
    if not term_keys:
        return {"term": term, "distance": 0.0, "expectedCount": 0, "heardCount": 0, "status": "ok"}

    distance = min(
        pronunciation_distance(term_key, recognized_key)
        for term_key in term_keys
        for recognized_key in recognized_keys
    )
    expected_count = max(
        count_pronunciation_matches(term_key, expected_key, PRONUNCIATION_MATCH_DISTANCE)
        for term_key in term_keys
        for expected_key in expected_keys
    )
    heard_count = max(
        count_pronunciation_matches(term_key, recognized_key, PRONUNCIATION_MATCH_DISTANCE)
        for term_key in term_keys
        for recognized_key in recognized_keys
    )

    if distance > PRONUNCIATION_WARNING_DISTANCE:
        status, reason = "failed", "지정 발음 불일치"
    elif distance > PRONUNCIATION_MATCH_DISTANCE:
        status, reason = "warning", "지정 발음 확인 필요"
    elif heard_count < expected_count:
        status, reason = "warning", "지정 발음 일부 누락"
    else:
        status, reason = "ok", ""
    record = {
        "term": term,
        "distance": round(distance, 6),
        "expectedCount": expected_count,
        "heardCount": heard_count,
        "status": status,
    }
    if reason:
        record["reason"] = reason
    return record


def lexical_pronunciation_checks(
    expected_text: str,
    recognized_text: str,
    dictionary: list[dict[str, Any]] | None = None,
    excluded_pronunciations: tuple[str, ...] | list[str] = (),
) -> list[dict[str, Any]]:
    """Find a local word omission or substitution hidden by whole-text PER.

    Explicit dictionary and numeric pronunciations keep their stricter checks;
    their component words are excluded here to avoid duplicate verdicts.
    Only non-OK records are returned so manifests stay compact.
    """
    expected_value = apply_pronunciation(expected_text, dictionary or [])
    recognized_value = apply_pronunciation(recognized_text, dictionary or [])
    expected_keys = phonetic_variants(expected_value)
    recognized_keys = phonetic_variants(recognized_value) or ("",)
    # Only a single-word required pronunciation suppresses the lexical check,
    # because only then do the two checks look at the same thing. A multi-word
    # reading is long enough to absorb a lost syllable inside the match gate
    # (에이전트 런타임 → 에이전트 런임 is 0.118, passing), while the lexical
    # check on 런타임 alone reads 0.200 and warns. Excluding the parts of a
    # compound therefore removed the only check that could see the error.
    excluded: set[str] = set()
    for pronunciation in excluded_pronunciations:
        words = HANGUL_WORD_PATTERN.findall(
            apply_pronunciation(pronunciation, dictionary or [])
        )
        if len(words) == 1:
            excluded.add(words[0])
    checks: list[dict[str, Any]] = []
    seen: set[str] = set()
    for term in HANGUL_WORD_PATTERN.findall(expected_value):
        if term in seen or any(
            term.startswith(excluded_term) or excluded_term.startswith(term)
            for excluded_term in excluded
        ):
            continue
        seen.add(term)
        term_keys = tuple(key for key in phonetic_variants(term) if key)
        if not term_keys or max(map(len, term_keys)) < MIN_LEXICAL_KEY_LENGTH:
            continue
        distance = min(
            pronunciation_distance(term_key, recognized_key)
            for term_key in term_keys
            for recognized_key in recognized_keys
        )
        expected_count = max(
            count_pronunciation_matches(term_key, expected_key, PRONUNCIATION_MATCH_DISTANCE)
            for term_key in term_keys
            for expected_key in expected_keys or ("",)
        )
        heard_count = max(
            count_pronunciation_matches(term_key, recognized_key, PRONUNCIATION_MATCH_DISTANCE)
            for term_key in term_keys
            for recognized_key in recognized_keys
        )
        if distance > LEXICAL_FAILURE_DISTANCE:
            status, reason = "failed", "단어 누락 또는 오독"
        elif distance > LEXICAL_WARNING_DISTANCE:
            status, reason = "warning", "단어 발음 확인 필요"
        elif heard_count < expected_count:
            status, reason = "warning", "단어 일부 누락"
        else:
            continue
        checks.append(
            {
                "term": term,
                "distance": round(distance, 6),
                "expectedCount": expected_count,
                "heardCount": heard_count,
                "status": status,
                "reason": reason,
                "kind": "lexical",
            }
        )
    return checks


def waveform_metrics(audio_path: Path) -> dict[str, float | int]:
    """Measure inexpensive acoustic failure signals from a mono mixdown."""
    audio, sample_rate = sf.read(audio_path, dtype="float32", always_2d=True)
    samples = np.mean(audio, axis=1, dtype=np.float32)
    duration_seconds = len(samples) / sample_rate if sample_rate else 0.0
    if not len(samples):
        return {
            "durationMs": 0,
            "peak": 0.0,
            "rms": 0.0,
            "silenceRatio": 1.0,
            "clippingRatio": 0.0,
        }
    peak = float(np.max(np.abs(samples)))
    rms = float(np.sqrt(np.mean(samples**2) + 1e-12))
    frame = max(1, round(sample_rate * 0.02))
    usable = len(samples) - (len(samples) % frame)
    framed = samples[:usable].reshape(-1, frame) if usable else samples.reshape(1, -1)
    frame_rms = np.sqrt(np.mean(framed**2, axis=1) + 1e-12)
    silence_threshold = max(5e-4, float(frame_rms.max()) * 0.0125)
    return {
        "durationMs": round(duration_seconds * 1000),
        "peak": round(peak, 6),
        "rms": round(rms, 6),
        "silenceRatio": round(float(np.mean(frame_rms < silence_threshold)), 6),
        "clippingRatio": round(float(np.mean(np.abs(samples) >= 0.999)), 8),
    }


def _frame_energy(samples: "np.ndarray", sample_rate: int, frame: int) -> "np.ndarray":
    """Return per-frame RMS for the leading whole frames of ``samples``."""
    usable = len(samples) - (len(samples) % frame)
    if not usable:
        return np.zeros(0, dtype=np.float32)
    framed = samples[:usable].reshape(-1, frame)
    return np.sqrt(np.mean(framed**2, axis=1) + 1e-12)


def asr_reading_windows(
    samples: "np.ndarray",
    sample_rate: int,
    max_seconds: float = MAX_ASR_READING_SECONDS,
    min_split_seconds: float = MIN_ASR_SPLIT_SECONDS,
) -> list[tuple[int, int]]:
    """Split a clip into sample ranges that each fit inside one ASR window.

    Cuts land on the longest silent stretch inside the last part of each
    window, so a seam falls between sentences rather than inside a word.  A
    clip with no usable silence is cut on the limit: a seam mid-word costs one
    word, while overrunning the window can cost a whole clause.

    Returns one whole-clip range when the audio is short enough, so the common
    case reads exactly as it did before.
    """
    total = len(samples)
    if not total or not sample_rate:
        return [(0, total)]
    if total / sample_rate <= min_split_seconds:
        return [(0, total)]

    frame = max(1, round(sample_rate * 0.02))
    energy = _frame_energy(samples, sample_rate, frame)
    if not len(energy):
        return [(0, total)]
    quiet = energy < max(5e-4, float(energy.max()) * 0.0125)

    limit = max(frame, int(max_seconds * sample_rate))
    windows: list[tuple[int, int]] = []
    start = 0
    while total - start > limit:
        earliest = start + int(limit * (1.0 - ASR_CUT_SEARCH_RATIO))
        cut = _quietest_cut(quiet, frame, earliest, start + limit)
        # A silence at the very start of the search range would make no
        # progress; falling back to the limit always advances.
        windows.append((start, cut if cut > start else start + limit))
        start = windows[-1][1]
    windows.append((start, total))
    return windows


def _quietest_cut(quiet: "np.ndarray", frame: int, earliest: int, latest: int) -> int:
    """Return the sample index at the middle of the longest silent run in range."""
    low = max(0, earliest // frame)
    high = min(len(quiet), latest // frame)
    best: tuple[int, int] | None = None
    run_start: int | None = None
    for index in range(low, high):
        if quiet[index]:
            if run_start is None:
                run_start = index
            continue
        if run_start is not None:
            if best is None or index - run_start > best[1] - best[0]:
                best = (run_start, index)
            run_start = None
    if run_start is not None and (best is None or high - run_start > best[1] - best[0]):
        best = (run_start, high)
    if best is None:
        return latest
    return ((best[0] + best[1]) // 2) * frame


def evaluate_candidate(
    *,
    expected_text: str,
    recognized_text: str,
    audio_path: Path,
    dictionary: list[dict[str, Any]] | None = None,
    required_pronunciations: tuple[str, ...] | list[str] = (),
    attempt: int = 1,
    seed: int | None = None,
) -> dict[str, Any]:
    """Score one TTS candidate and return a serializable quality record."""
    expected = comparison_text(expected_text, dictionary)
    recognized = comparison_text(recognized_text, dictionary)
    cer = character_error_rate(expected, recognized)
    per = phonetic_error_rate(expected_text, recognized_text, dictionary)
    waveform = waveform_metrics(audio_path)
    duration_seconds = float(waveform["durationMs"]) / 1000
    pace = len(expected) / duration_seconds if duration_seconds else float("inf")
    required_checks = [
        check_pronunciation(term, expected_text, recognized_text, dictionary)
        for term in required_pronunciations
    ]
    lexical_checks = lexical_pronunciation_checks(
        expected_text,
        recognized_text,
        dictionary,
        required_pronunciations,
    )
    checks = [*required_checks, *lexical_checks]
    failures: list[str] = []
    warnings: list[str] = []
    if not expected:
        failures.append("비교할 발음문 없음")
    if per > MAX_PHONETIC_ERROR_RATE:
        failures.append("받아쓰기 불일치")
    if float(waveform["rms"]) < 0.001:
        failures.append("음성 신호 부족")
    if float(waveform["silenceRatio"]) > MAX_SILENCE_RATIO:
        failures.append("과도한 무음")
    if float(waveform["clippingRatio"]) > MAX_CLIPPING_RATIO:
        failures.append("클리핑")
    if pace < MIN_SPEAKING_CHARACTERS_PER_SECOND:
        failures.append("지나치게 느린 발화")
    if pace > MAX_SPEAKING_CHARACTERS_PER_SECOND:
        failures.append("지나치게 빠른 발화")
    for check in checks:
        reason = str(check.get("reason") or "")
        if check["status"] == "failed" and reason not in failures:
            failures.append(reason)
        elif check["status"] == "warning" and reason not in warnings:
            warnings.append(reason)
    unheard = [check["term"] for check in checks if check["status"] != "ok"]
    # Pronunciation fidelity dominates; a warning nudges seed selection without
    # ever being enough on its own to call the production broken.
    score = (
        per * 100
        + len(failures) * FAILURE_PENALTY
        + len(warnings) * WARNING_PENALTY
        + sum(float(check["distance"]) for check in checks)
        + abs(pace - TARGET_CHARACTERS_PER_SECOND) * 0.25
    )
    return {
        "attempt": attempt,
        "seed": seed,
        "audioPath": str(audio_path.resolve()),
        "expectedText": expected_text,
        "recognizedText": recognized_text.strip(),
        "requiredPronunciations": list(required_pronunciations),
        "pronunciationChecks": checks,
        "lexicalChecks": lexical_checks,
        "missingPronunciations": unheard,
        "characterErrorRate": round(cer, 6),
        "phoneticErrorRate": round(per, 6),
        "speakingCharactersPerSecond": round(pace, 3),
        "waveform": waveform,
        "passed": not failures and not warnings,
        "failures": failures,
        "warnings": warnings,
        "score": round(score, 6),
    }


def better_evaluation(left: dict[str, Any], right: dict[str, Any]) -> dict[str, Any]:
    """Return the more favourable of two readings of the same audio.

    A second ASR pass exists to rule out decoder noise, so when two transcripts
    of one clip disagree the clip is credited with the better of them.  Only
    evidence that survives every reading is allowed to flag a page.
    """
    return min((left, right), key=_candidate_rank)


def _candidate_rank(candidate: dict[str, Any]) -> tuple[int, int, float, int]:
    return (
        len(candidate.get("failures", [])),
        len(candidate.get("warnings", [])),
        float(candidate.get("score", float("inf"))),
        int(candidate.get("attempt", 1)),
    )


def choose_best_candidate(candidates: list[dict[str, Any]]) -> dict[str, Any]:
    """Prefer the candidate with the least severe evidence against it."""
    if not candidates:
        raise ValueError("선택할 음성 후보가 없습니다.")
    return min(candidates, key=_candidate_rank)


def chunk_severity(candidates: list[dict[str, Any]], selected: dict[str, Any]) -> str:
    """Classify one chunk from the selected candidate and the attempts behind it.

    A warning that every seed reproduced is not decoder noise; it is the model
    consistently saying something else, which a human should see.  A warning
    that came and went across seeds is left as a warning.
    """
    if selected.get("failures"):
        return "failed"
    warnings = selected.get("warnings") or []
    if not warnings:
        return "ok"
    evaluated = [candidate for candidate in candidates if candidate.get("recognizedText") is not None]
    if len(evaluated) > 1 and all(
        set(warnings) <= set(candidate.get("warnings") or []) for candidate in evaluated
    ):
        return "failed"
    return "warning"


def quality_summary(items: list[dict[str, Any]]) -> dict[str, Any]:
    """Summarize selected chunk decisions at slide granularity."""

    def slides(records: list[dict[str, Any]]) -> list[dict[str, Any]]:
        ordered = sorted(
            {
                (
                    str(record.get("chapter", "")),
                    str(record.get("slideId", "")),
                    int(record.get("slideNumber", 0)),
                )
                for record in records
            },
            key=lambda value: value[2],
        )
        return [
            {"chapter": chapter, "slideId": slide_id, "slideNumber": number}
            for chapter, slide_id, number in ordered
        ]

    def severity_of(item: dict[str, Any]) -> str:
        # Records written before severity existed only distinguished pass from
        # fail, and a failure then meant "regenerate this page".
        recorded = item.get("severity")
        if recorded:
            return str(recorded)
        return "ok" if item.get("selected", {}).get("passed", True) else "failed"

    failed = [item for item in items if severity_of(item) == "failed"]
    warned = [item for item in items if severity_of(item) == "warning"]
    clean = len(items) - len(failed) - len(warned)
    return {
        "ok": not failed,
        "clean": not failed and not warned,
        "passedChunks": clean,
        "warnedChunks": len(warned),
        "totalChunks": len(items),
        "retriedChunks": sum(len(item.get("candidates", [])) > 1 for item in items),
        "needsReview": slides(failed),
        "listenSuggested": slides(warned),
    }
