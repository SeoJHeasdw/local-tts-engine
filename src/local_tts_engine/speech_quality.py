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

# Below this, two transcripts describe the same sound and any remaining
# difference is spelling.  Above the warning bound, the reader said something
# else entirely.  Between them the evidence is genuinely ambiguous, which is
# what a human ear is for.
PRONUNCIATION_MATCH_DISTANCE = 0.15
PRONUNCIATION_WARNING_DISTANCE = 0.34

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
    checks = [
        check_pronunciation(term, expected_text, recognized_text, dictionary)
        for term in required_pronunciations
    ]
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
