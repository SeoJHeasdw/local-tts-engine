"""Automatic quality scoring for generated lecture speech.

The ASR transcript is an independent observation, not a replacement for the
caption source.  A candidate passes when it is close to the intended spoken
form and its waveform has no obvious silence, clipping, or pacing anomaly.
"""

from __future__ import annotations

import unicodedata
from pathlib import Path
from typing import Any

import numpy as np
import soundfile as sf

from .pronunciation import apply_pronunciation


ASR_REPOSITORY = "mlx-community/whisper-large-v3-turbo-asr-fp16"
ASR_LICENSE = "MIT"
MAX_AUTOMATIC_ATTEMPTS = 3
MAX_CHARACTER_ERROR_RATE = 0.12
MIN_SPEAKING_CHARACTERS_PER_SECOND = 1.0
MAX_SPEAKING_CHARACTERS_PER_SECOND = 11.0
MAX_SILENCE_RATIO = 0.62
MAX_CLIPPING_RATIO = 0.001


def comparison_text(text: str, dictionary: list[dict[str, Any]] | None = None) -> str:
    """Normalize spelling variants and retain only letters and numbers."""
    value = apply_pronunciation(text, dictionary or [])
    value = unicodedata.normalize("NFKC", value).casefold()
    return "".join(
        character
        for character in value
        if unicodedata.category(character).startswith(("L", "N"))
    )


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
    waveform = waveform_metrics(audio_path)
    duration_seconds = float(waveform["durationMs"]) / 1000
    pace = len(expected) / duration_seconds if duration_seconds else float("inf")
    failures: list[str] = []
    missing_pronunciations = [
        pronunciation
        for pronunciation in required_pronunciations
        if comparison_text(pronunciation, dictionary) not in recognized
    ]
    if not expected:
        failures.append("비교할 발음문 없음")
    if cer > MAX_CHARACTER_ERROR_RATE:
        failures.append("받아쓰기 불일치")
    if missing_pronunciations:
        failures.append("지정 발음 불일치")
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
    # Transcript fidelity dominates; acoustic failures are large tie-breakers.
    score = cer * 100 + len(failures) * 25 + abs(pace - 4.2) * 0.25
    return {
        "attempt": attempt,
        "seed": seed,
        "audioPath": str(audio_path.resolve()),
        "expectedText": expected_text,
        "recognizedText": recognized_text.strip(),
        "requiredPronunciations": list(required_pronunciations),
        "missingPronunciations": missing_pronunciations,
        "characterErrorRate": round(cer, 6),
        "speakingCharactersPerSecond": round(pace, 3),
        "waveform": waveform,
        "passed": not failures,
        "failures": failures,
        "score": round(score, 6),
    }


def choose_best_candidate(candidates: list[dict[str, Any]]) -> dict[str, Any]:
    """Prefer a passing candidate, then the lowest deterministic quality score."""
    if not candidates:
        raise ValueError("선택할 음성 후보가 없습니다.")
    return min(
        candidates,
        key=lambda candidate: (
            not bool(candidate.get("passed")),
            float(candidate.get("score", float("inf"))),
            int(candidate.get("attempt", 1)),
        ),
    )


def quality_summary(items: list[dict[str, Any]]) -> dict[str, Any]:
    """Summarize selected chunk decisions at slide granularity."""
    failed = [item for item in items if not item.get("selected", {}).get("passed")]
    slides = sorted(
        {
            (str(item.get("chapter", "")), str(item.get("slideId", "")), int(item.get("slideNumber", 0)))
            for item in failed
        },
        key=lambda value: value[2],
    )
    return {
        "ok": not failed,
        "passedChunks": len(items) - len(failed),
        "totalChunks": len(items),
        "retriedChunks": sum(len(item.get("candidates", [])) > 1 for item in items),
        "needsReview": [
            {"chapter": chapter, "slideId": slide_id, "slideNumber": number}
            for chapter, slide_id, number in slides
        ],
    }
