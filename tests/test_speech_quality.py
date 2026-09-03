from pathlib import Path

import numpy as np
import soundfile as sf

from local_tts_engine.speech_quality import (
    character_error_rate,
    choose_best_candidate,
    comparison_text,
    evaluate_candidate,
    quality_summary,
)


def write_tone(path: Path, *, seconds: float = 2.0, sample_rate: int = 24_000) -> None:
    at = np.arange(round(seconds * sample_rate), dtype=np.float32) / sample_rate
    audio = np.sin(2 * np.pi * 220 * at).astype(np.float32) * 0.1
    sf.write(path, audio, sample_rate)


def test_comparison_text_normalizes_asr_spelling() -> None:
    dictionary = [{"from": "RAG", "to": "래그"}]
    assert comparison_text("RAG가 답합니다.", dictionary) == comparison_text(
        "래그가 답합니다", dictionary
    )


def test_character_error_rate_detects_substitution() -> None:
    assert character_error_rate("런타임", "런팀") == 2 / 3


def test_evaluate_and_choose_candidate(tmp_path: Path) -> None:
    audio = tmp_path / "voice.wav"
    write_tone(audio)
    failed = evaluate_candidate(
        expected_text="런타임을 확인합니다",
        recognized_text="런팀을 확인합니다",
        audio_path=audio,
        required_pronunciations=("런타임",),
        attempt=1,
        seed=1,
    )
    passed = evaluate_candidate(
        expected_text="런타임을 확인합니다",
        recognized_text="런타임을 확인합니다",
        audio_path=audio,
        required_pronunciations=("런타임",),
        attempt=2,
        seed=2,
    )

    assert not failed["passed"]
    assert passed["passed"]
    assert choose_best_candidate([failed, passed]) is passed


def test_quality_summary_lists_only_failed_slides() -> None:
    summary = quality_summary([
        {
            "chapter": "ch02",
            "slideId": "good",
            "slideNumber": 10,
            "selected": {"passed": True},
            "candidates": [{"passed": True}],
        },
        {
            "chapter": "ch02",
            "slideId": "bad",
            "slideNumber": 11,
            "selected": {"passed": False},
            "candidates": [{"passed": False}, {"passed": False}],
        },
    ])

    assert not summary["ok"]
    assert summary["retriedChunks"] == 1
    assert summary["needsReview"] == [
        {"chapter": "ch02", "slideId": "bad", "slideNumber": 11}
    ]
