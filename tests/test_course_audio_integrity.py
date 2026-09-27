"""Candidate and final-track defects that do not require a real model."""

from __future__ import annotations

import numpy as np
import pytest
import soundfile as sf

from local_tts_engine.course.candidates import CandidateAudioError, validate_candidate_audio
from local_tts_engine.course.clip_cache import read_cached_clip, write_cached_clip
from local_tts_engine.course.final_track import inspect_final_track
from local_tts_engine.course.settings import UNTRIMMED_AUDIO_STATS


@pytest.mark.parametrize("samples,code", [
    (np.array([], dtype=np.float32), "empty-audio"),
    (np.array([np.nan] * 24_000, dtype=np.float32), "invalid-samples"),
    (np.zeros(24_000, dtype=np.float32), "no-signal"),
])
def test_only_objectively_unusable_candidates_are_rejected(samples, code) -> None:
    with pytest.raises(CandidateAudioError) as error:
        validate_candidate_audio(samples, 24_000)
    assert error.value.code == code
    # A single strong harmonic is not grounds to reject speech; vowels can be
    # harmonic too. Content and naturalness need the later review/listening.
    tone = np.sin(2 * np.pi * 190 * np.arange(24_000) / 24_000).astype(np.float32)
    assert len(validate_candidate_audio(tone, 24_000)) == 24_000


def test_atomic_cache_marker_detects_an_overwritten_waveform(tmp_path) -> None:
    clip = tmp_path / "take.wav"
    tone = (0.1 * np.sin(2 * np.pi * 190 * np.arange(24_000) / 24_000)).astype(np.float32)
    write_cached_clip(clip, tone, 24_000, dict(UNTRIMMED_AUDIO_STATS))
    assert read_cached_clip(clip) is not None
    assert clip.with_suffix(".sha256").is_file()
    clip.with_suffix(".pending").write_text("interrupted\n", encoding="ascii")
    assert read_cached_clip(clip) is None
    clip.with_suffix(".pending").unlink()
    sf.write(clip, np.zeros(len(tone), dtype=np.float32), 24_000)
    assert read_cached_clip(clip) is None


def test_final_track_detects_a_missing_or_reordered_chunk(tmp_path) -> None:
    rate = 24_000
    t = np.arange(rate, dtype=np.float32) / rate
    first = (0.1 * np.sin(2 * np.pi * 190 * t)).astype(np.float32)
    second = (0.1 * np.sin(2 * np.pi * 310 * t)).astype(np.float32)
    first_path, second_path = tmp_path / "first.wav", tmp_path / "second.wav"
    sf.write(first_path, first, rate, subtype="PCM_24")
    sf.write(second_path, second, rate, subtype="PCM_24")
    pad = np.zeros(rate // 4, dtype=np.float32)
    native = tmp_path / "native.wav"
    final = tmp_path / "final.wav"
    sf.write(native, np.concatenate([pad, first, pad, second, pad]), rate, subtype="PCM_24")
    chunks = [
        {"key": "first", "audioPath": str(first_path), "startSample": len(pad), "endSample": len(pad) + rate},
        {"key": "second", "audioPath": str(second_path), "startSample": len(pad) * 2 + rate,
         "endSample": len(pad) * 2 + rate * 2},
    ]
    sf.write(final, np.concatenate([pad, first, pad, second, pad]), rate, subtype="PCM_24")
    assert inspect_final_track(native, final, chunks)["status"] == "ok"

    sf.write(final, np.concatenate([pad, first, pad, np.zeros_like(second), pad]), rate, subtype="PCM_24")
    missing = inspect_final_track(native, final, chunks)
    assert {issue["code"] for issue in missing["issues"]} == {"missing-speech"}

    sf.write(final, np.concatenate([pad, second, pad, first, pad]), rate, subtype="PCM_24")
    reordered = inspect_final_track(native, final, chunks)
    assert {issue["code"] for issue in reordered["issues"]} == {"waveform-changed"}

    invalid = np.concatenate([pad, first, pad, second, pad])
    invalid[10] = np.nan  # in the intro gap, outside every spoken chunk
    sf.write(final, invalid, rate, subtype="FLOAT")
    assert "invalid-final-samples" in {
        issue["code"] for issue in inspect_final_track(native, final, chunks)["issues"]
    }


def test_final_track_detects_partial_speech_loss_and_off_center_gap_signal(tmp_path) -> None:
    rate = 24_000
    t = np.arange(2 * rate, dtype=np.float32) / rate
    speech = (0.2 * np.sin(2 * np.pi * 200 * t)).astype(np.float32)
    gap = np.zeros(rate, dtype=np.float32)
    first_path, second_path = tmp_path / "first.wav", tmp_path / "second.wav"
    native, final = tmp_path / "native.wav", tmp_path / "final.wav"
    sf.write(first_path, speech, rate, subtype="PCM_24")
    sf.write(second_path, speech, rate, subtype="PCM_24")
    base = np.concatenate([speech, gap, speech])
    sf.write(native, base, rate, subtype="PCM_24")
    chunks = [
        {"key": "first", "audioPath": str(first_path), "startSample": 0, "endSample": 2 * rate},
        {"key": "second", "audioPath": str(second_path), "startSample": 3 * rate, "endSample": 5 * rate},
    ]

    missing = base.copy()
    missing[rate // 2:rate // 2 + rate // 3] = 0
    sf.write(final, missing, rate, subtype="PCM_24")
    assert "local-waveform-changed" in {
        issue["code"] for issue in inspect_final_track(native, final, chunks)["issues"]
    }

    dirty_gap = base.copy()
    dirty_gap[2 * rate + rate // 8:2 * rate + rate // 4] = 0.2
    sf.write(final, dirty_gap, rate, subtype="PCM_24")
    assert "unexpected-gap-speech" in {
        issue["code"] for issue in inspect_final_track(native, final, chunks)["issues"]
    }


def test_long_gap_does_not_dilute_a_short_quiet_intrusion(tmp_path) -> None:
    rate = 24_000
    speech = (0.1 * np.sin(2 * np.pi * 190 * np.arange(rate) / rate)).astype(np.float32)
    clip = tmp_path / "clip.wav"
    native, final = tmp_path / "native.wav", tmp_path / "final.wav"
    sf.write(clip, speech, rate, subtype="PCM_24")
    clean = np.concatenate([speech, np.zeros(5 * rate, dtype=np.float32), speech])
    sf.write(native, clean, rate, subtype="PCM_24")
    dirty = clean.copy()
    dirty[2 * rate:2 * rate + rate // 10] = 0.004
    sf.write(final, dirty, rate, subtype="PCM_24")
    chunks = [
        {"key": "first", "audioPath": str(clip), "startSample": 0, "endSample": rate},
        {"key": "second", "audioPath": str(clip), "startSample": 6 * rate, "endSample": 7 * rate},
    ]
    assert "unexpected-gap-speech" in {
        issue["code"] for issue in inspect_final_track(native, final, chunks)["issues"]
    }


def test_short_tail_intrusion_is_not_diluted_by_end_padding(tmp_path) -> None:
    rate = 24_000
    speech = (0.1 * np.sin(2 * np.pi * 190 * np.arange(rate) / rate)).astype(np.float32)
    clip = tmp_path / "clip.wav"
    native, final = tmp_path / "native.wav", tmp_path / "final.wav"
    sf.write(clip, speech, rate, subtype="PCM_24")
    clean = np.concatenate([speech, np.zeros(round(0.6 * rate), dtype=np.float32)])
    sf.write(native, clean, rate, subtype="PCM_24")
    dirty = clean.copy()
    dirty[rate + rate // 4:rate + rate // 4 + rate // 50] = 0.01
    sf.write(final, dirty, rate, subtype="PCM_24")
    assert "unexpected-tail-speech" in {
        issue["code"] for issue in inspect_final_track(native, final, [
            {"key": "clip", "audioPath": str(clip), "startSample": 0, "endSample": rate},
        ])["issues"]
    }


def test_quiet_spoken_span_is_still_compared_locally(tmp_path) -> None:
    rate = 24_000
    t = np.arange(3 * rate, dtype=np.float32) / rate
    speech = (0.1 * np.sin(2 * np.pi * 190 * t)).astype(np.float32)
    speech[rate:rate + rate // 4] *= 0.02  # 250ms, RMS around 0.0014
    clip, native, final = (tmp_path / name for name in ("clip.wav", "native.wav", "final.wav"))
    sf.write(clip, speech, rate, subtype="PCM_24")
    sf.write(native, speech, rate, subtype="PCM_24")
    missing = speech.copy()
    missing[rate:rate + rate // 4] = 0
    sf.write(final, missing, rate, subtype="PCM_24")
    assert "local-waveform-changed" in {
        issue["code"] for issue in inspect_final_track(native, final, [
            {"key": "clip", "audioPath": str(clip), "startSample": 0, "endSample": len(speech)},
        ])["issues"]
    }
