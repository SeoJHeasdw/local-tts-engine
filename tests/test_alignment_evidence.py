"""Acoustic residuals cannot become falsely reassigned or discarded words."""

import hashlib
import json

import numpy as np
import pytest
import soundfile as sf

from local_tts_engine.course.alignment_evidence import measure_speech_evidence


RATE = 16_000


def _write(path, samples):
    sf.write(path, np.asarray(samples, dtype=np.float32), RATE, subtype="FLOAT")
    return path


def _sine(seconds, amplitude=0.006):
    time = np.arange(round(RATE * seconds)) / RATE
    return amplitude * np.sin(2 * np.pi * 180 * time)


def test_weak_residual_is_a_candidate_and_original_bytes_are_preserved(tmp_path):
    rng = np.random.default_rng(81)
    samples = np.r_[_sine(0.5, 0.12), np.zeros(RATE // 4), rng.normal(0, 0.006, RATE // 10)]
    path = _write(tmp_path / "original.wav", samples)
    before = hashlib.sha256(path.read_bytes()).hexdigest()
    voice, tail = measure_speech_evidence(path, [
        {"startMs": 0, "endMs": 500},
        {"startMs": 750, "endMs": 850},
    ])
    assert voice["periodicVoiceMs"] > 400
    assert not voice["weakNonSpeechCandidate"]
    assert tail["periodicVoiceMs"] == 0
    assert tail["rmsDb"] < -40
    assert tail["weakNonSpeechCandidate"]
    assert hashlib.sha256(path.read_bytes()).hexdigest() == before


def test_faint_voiced_syllable_is_not_treated_as_breath(tmp_path):
    path = _write(tmp_path / "quiet-voice.wav", _sine(0.12, 0.003))
    result = measure_speech_evidence(path, [{"startMs": 0, "endMs": 120}])[0]
    assert result["rmsDb"] < -40
    assert result["periodicVoiceMs"] > 0
    assert not result["weakNonSpeechCandidate"]


def test_stereo_phase_cancellation_cannot_erase_voiced_evidence(tmp_path):
    voice = _sine(0.12, 0.003)
    path = _write(tmp_path / "stereo.wav", np.column_stack((voice, -voice)))
    result = measure_speech_evidence(path, [{"startMs": 0, "endMs": 120}])[0]
    assert result["periodicVoiceMs"] > 0
    assert not result["weakNonSpeechCandidate"]


@pytest.mark.parametrize("seconds,amplitude", [(0.30, 0.006), (0.12, 0.08), (0.03, 0.006)])
def test_length_or_energy_evidence_prevents_weak_classification(tmp_path, seconds, amplitude):
    noise = np.random.default_rng(81).normal(0, amplitude, round(RATE * seconds))
    path = _write(tmp_path / "noise.wav", noise)
    result = measure_speech_evidence(path, [{"startMs": 0, "endMs": seconds * 1000}])[0]
    assert not result["weakNonSpeechCandidate"]


def test_silent_evidence_is_finite_json(tmp_path):
    path = _write(tmp_path / "silence.wav", np.zeros(RATE // 10))
    result = measure_speech_evidence(path, [{"startMs": 0, "endMs": 100}])[0]
    assert result["periodicVoiceMs"] == 0
    json.dumps(result, allow_nan=False)


@pytest.mark.parametrize("span", [
    {"startMs": -1, "endMs": 90},
    {"startMs": 50, "endMs": 40},
    {"startMs": 0, "endMs": 200},
    {"startMs": 0, "endMs": float("nan")},
    {"startMs": float("inf"), "endMs": 80},
])
def test_invalid_spans_are_errors_not_absence_of_speech(tmp_path, span):
    path = _write(tmp_path / "voice.wav", _sine(0.1))
    with pytest.raises(ValueError):
        measure_speech_evidence(path, [span])


def test_non_finite_audio_cannot_be_classified_as_weak(tmp_path):
    samples = np.zeros(RATE // 10)
    samples[100] = np.nan
    path = _write(tmp_path / "nonfinite.wav", samples)
    with pytest.raises(ValueError, match="non-finite"):
        measure_speech_evidence(path, [{"startMs": 0, "endMs": 100}])
