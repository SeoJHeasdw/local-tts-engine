"""Acoustic evidence, timing uncertainty, and the retry contract for pauses."""

from pathlib import Path
from types import SimpleNamespace

import numpy as np
import pytest
import soundfile as sf

from local_tts_engine.prosody import PAUSE_WARNING, interior_silences, pause_checks
from local_tts_engine.speech_quality import (
    choose_best_candidate, chunk_severity, evaluate_candidate, read_timed_words,
    review_candidate_prosody,
)


def audio_with_pause(path: Path, start: float = 0.8, end: float = 1.2, seconds: float = 2.5) -> Path:
    rate = 24_000
    at = np.arange(round(rate * seconds)) / rate
    audio = (0.15 * np.sin(2 * np.pi * 190 * at)).astype(np.float32)
    audio[round(start * rate):round(end * rate)] = 0
    sf.write(path, audio, rate)
    return path


def word(text, start, end, **kwargs):
    return {"text": text, "startMs": start, "endMs": end, "probability": 0.98, **kwargs}


WORDS = [word("똑", 0, 750), word("똑한", 1200, 1700), word("모델입니다", 1700, 2500)]
EXPECTED = "똑똑한 모델입니다"


def test_spacing_only_and_an_actual_pause_are_different(tmp_path):
    smooth = audio_with_pause(tmp_path / "smooth.wav", 0.8, 0.8)
    paused = audio_with_pause(tmp_path / "paused.wav")
    assert pause_checks(EXPECTED, WORDS, interior_silences(smooth))["checks"] == []
    checks = pause_checks(EXPECTED, WORDS, interior_silences(paused))["checks"]
    assert len(checks) == 1
    assert checks[0]["term"] == "똑똑한"
    assert checks[0]["pauseDurationMs"] == 400


@pytest.mark.parametrize("text", ["똑 똑한 모델입니다", "똑, 똑한 모델입니다", "똑. 똑한 모델입니다", "똑\n똑한 모델입니다"])
def test_source_boundaries_are_not_internal_pauses(tmp_path, text):
    assert not pause_checks(text, WORDS, interior_silences(audio_with_pause(tmp_path / "a.wav")))["checks"]


def test_one_timed_word_can_also_contain_a_pause(tmp_path):
    words = [word("똑똑한", 0, 1700), WORDS[-1]]
    assert pause_checks(EXPECTED, words, interior_silences(audio_with_pause(tmp_path / "a.wav")))["checks"]


@pytest.mark.parametrize("text", ["“똑똑”한 모델입니다", "'똑똑'한 모델입니다", "‘똑똑’한 모델입니다"])
def test_a_quoted_term_and_its_particle_remain_one_spoken_word(tmp_path, text):
    checks = pause_checks(text, WORDS, interior_silences(audio_with_pause(tmp_path / "a.wav")))["checks"]
    assert len(checks) == 1 and checks[0]["term"] == "똑똑한"


def test_short_stop_closures_and_edge_silence_are_preserved(tmp_path):
    assert not interior_silences(audio_with_pause(tmp_path / "stop.wav", 0.8, 0.92))
    assert not interior_silences(audio_with_pause(tmp_path / "head.wav", 0, 0.8))
    assert not interior_silences(audio_with_pause(tmp_path / "tail.wav", 1.8, 2.5))


@pytest.mark.parametrize("words", [
    [],
    [word("똑", 0, 750, probability=0.2), *WORDS[1:]],
    [word("똑", -1, 750), *WORDS[1:]],
    [word("똑", 0, float("nan")), *WORDS[1:]],
    [word("똑", 0, 1400), *WORDS[1:]],
    [word("똑", 0, 750, window=0), word("똑한", 1200, 1700, window=1), WORDS[-1]],
    [word("다른", 0, 1700), WORDS[-1]],
])
def test_unreliable_or_unmatched_timing_cannot_request_a_retry(tmp_path, words):
    assert not pause_checks(EXPECTED, words, interior_silences(audio_with_pause(tmp_path / "a.wav")))["checks"]


def test_identical_repeated_words_are_mapped_to_their_own_occurrence(tmp_path):
    words = [word("똑똑한", 0, 1700), word("똑똑한", 1700, 2500)]
    checks = pause_checks("똑똑한 똑똑한", words, interior_silences(audio_with_pause(tmp_path / "a.wav")))["checks"]
    assert len(checks) == 1 and checks[0]["startMs"] == 0


def test_timing_beyond_the_real_audio_duration_cannot_flag_a_word(tmp_path):
    path = audio_with_pause(tmp_path / "a.wav")
    words = [word("똑똑한", 0, 7000), word("모델입니다", 7000, 8000)]
    assert not pause_checks(EXPECTED, words, interior_silences(path), duration_ms=2500)["checks"]


def test_two_confirming_timings_request_a_retry_even_with_perfect_transcription(tmp_path):
    path = audio_with_pause(tmp_path / "a.wav")
    original = evaluate_candidate(expected_text=EXPECTED, recognized_text="똑 똑한 모델입니다", audio_path=path)
    assert original["passed"] and original["phoneticErrorRate"] == 0
    calls = []
    def read(path, temperature):
        calls.append(temperature)
        return WORDS
    reviewed = review_candidate_prosody(original, read, lambda path, text: WORDS)
    assert calls == [0.0]
    assert reviewed["prosody"]["confirmation"] == "independent-alignment-and-waveform"
    assert reviewed["warnings"] == [PAUSE_WARNING]
    assert not reviewed["passed"]
    assert original["passed"]  # Content evidence is not mutated.
    assert chunk_severity([reviewed, reviewed], reviewed) == "warning"


def test_a_timing_hallucination_does_not_become_an_automatic_retry(tmp_path):
    original = evaluate_candidate(expected_text=EXPECTED, recognized_text=EXPECTED, audio_path=audio_with_pause(tmp_path / "a.wav"))
    reviewed = review_candidate_prosody(original, lambda path, temperature: WORDS, lambda path, text: [])
    assert reviewed["passed"]
    assert reviewed["prosody"]["unconfirmedChecks"]


def test_missing_independent_confirmation_cannot_trigger_a_retry(tmp_path):
    original = evaluate_candidate(expected_text=EXPECTED, recognized_text=EXPECTED, audio_path=audio_with_pause(tmp_path / "a.wav"))
    reviewed = review_candidate_prosody(original, lambda path, temperature: WORDS)
    assert reviewed["passed"]
    assert reviewed["prosody"]["confirmation"] == "unavailable"


def test_real_boundary_disagreement_does_not_turn_a_word_gap_into_an_error(tmp_path):
    # Live 2026-09-06: Whisper attaches the preceding 건 to 도구의; the
    # independently generated Qwen alignment places 도구의 after the pause.
    text = "중요한 건 도구의 개수가 아니라 실행 환경입니다"
    primary = [word("중요한", 5760, 6200), word("건", 6200, 6420), word("도구의", 6420, 7140), word("개수가", 7140, 7540), word("아니라", 7540, 7920), word("실행", 7920, 8300), word("환경입니다", 8300, 8960)]
    independent = [word("중요한", 5760, 6240), word("건", 6240, 6560), word("도구의", 6800, 7200), word("개수가", 7200, 7600), word("아니라", 7600, 7920), word("실행", 7920, 8320), word("환경입니다", 8320, 8960)]
    path = audio_with_pause(tmp_path / "gap.wav", 6.52, 6.82, seconds=9.03)
    original = evaluate_candidate(expected_text=text, recognized_text=text, audio_path=path)
    reviewed = review_candidate_prosody(original, lambda path, temperature: primary, lambda path, text: independent)
    assert reviewed["passed"]
    assert reviewed["prosody"]["unconfirmedChecks"][0]["term"] == "도구의"


def test_an_aligner_cannot_hide_a_pause_by_omitting_the_word_tail(tmp_path):
    path = audio_with_pause(tmp_path / "tail.wav")
    original = evaluate_candidate(expected_text=EXPECTED, recognized_text=EXPECTED, audio_path=path)
    # The forced aligner ends the word at the pause, leaving the audible second
    # half unassigned before the next word. This is the live probe's failure.
    independent = [word("똑똑한", 0, 800), word("모델입니다", 1900, 2500)]
    reviewed = review_candidate_prosody(original, lambda path, temperature: WORDS, lambda path, text: independent)
    assert not reviewed["passed"]
    assert reviewed["prosody"]["checks"][0]["confirmationEvidence"] == "unassigned-voiced-tail"
    assert reviewed["prosody"]["checks"][0]["unassignedVoicedMs"] >= 80
    assert reviewed["prosody"]["unconfirmedChecks"] == []


def test_an_aligner_cannot_hide_a_pause_by_omitting_the_word_head(tmp_path):
    text = "먼저 똑똑한 모델입니다"
    path = audio_with_pause(tmp_path / "head.wav", 1.2, 1.6, seconds=3)
    primary = [word("먼저", 0, 500), word("똑똑한", 500, 2000), word("모델입니다", 2000, 3000)]
    independent = [word("먼저", 0, 500), word("똑똑한", 1600, 2000), word("모델입니다", 2000, 3000)]
    original = evaluate_candidate(expected_text=text, recognized_text=text, audio_path=path)
    reviewed = review_candidate_prosody(original, lambda path, temperature: primary, lambda path, text: independent)
    assert reviewed["prosody"]["checks"][0]["confirmationEvidence"] == "unassigned-voiced-head"


@pytest.mark.parametrize("kind", ["silence", "noise", "brief-signal"])
def test_an_unassigned_gap_needs_sustained_voiced_speech(tmp_path, kind):
    path = audio_with_pause(tmp_path / "gap.wav")
    samples, rate = sf.read(path, dtype="float32")
    region = slice(round(1.2 * rate), round(1.7 * rate))
    if kind == "noise":
        samples[region] = np.random.default_rng(17).normal(0, 0.05, samples[region].shape)
    elif kind == "silence":
        samples[region] = 0
    else:
        samples[round(1.22 * rate):round(1.7 * rate)] = 0
    sf.write(path, samples, rate)
    original = evaluate_candidate(expected_text=EXPECTED, recognized_text=EXPECTED, audio_path=path)
    independent = [word("똑똑한", 0, 800), word("모델입니다", 1900, 2500)]
    reviewed = review_candidate_prosody(original, lambda path, temperature: WORDS, lambda path, text: independent)
    assert reviewed["passed"]


def test_pronunciation_failures_do_not_pay_for_a_timing_pass(tmp_path):
    original = evaluate_candidate(expected_text=EXPECTED, recognized_text="전혀 다른 소리", audio_path=audio_with_pause(tmp_path / "a.wav"))
    def forbidden(*args):
        pytest.fail("A failed pronunciation candidate should be regenerated directly")
    assert review_candidate_prosody(original, forbidden)["failures"] == original["failures"]


def test_pronunciation_accuracy_wins_over_smoother_wrong_words():
    correct = {"attempt": 1, "failures": [], "warnings": [PAUSE_WARNING], "score": 100}
    wrong = {"attempt": 2, "failures": [], "warnings": ["지정 발음 확인 필요"], "score": 1}
    assert choose_best_candidate([wrong, correct]) is correct


def test_long_clip_word_times_are_offset_and_reader_settings_are_explicit(tmp_path):
    path = audio_with_pause(tmp_path / "long.wav", 20, 21, seconds=35)
    calls = []
    class Reader:
        def generate(self, path, **kwargs):
            calls.append((path, kwargs))
            return SimpleNamespace(segments=[{"words": [{"word": " 똑똑한", "start": 0.1, "end": 0.5, "probability": 0.9}]}])
    words = read_timed_words(Reader(), path, 0.2)
    assert len(words) == 2
    assert words[0]["startMs"] == 100
    assert words[1]["startMs"] > 20_000
    assert words[1]["window"] == 1
    assert all(kwargs["word_timestamps"] and kwargs["return_timestamps"] for _, kwargs in calls)
    assert all(kwargs["temperature"] == 0.2 for _, kwargs in calls)
    assert all(not Path(p).exists() for p, _ in calls)


def test_invalid_model_timestamps_preserve_text_but_cannot_be_used(tmp_path):
    class Reader:
        def generate(self, *args, **kwargs):
            return SimpleNamespace(segments=[{"words": [
                {"word": "똑", "start": float("nan"), "end": 0.7},
                {"word": "똑한", "end": 1.7},
                {"word": "모델입니다", "start": 1.7, "end": 2.5, "probability": 0.98},
            ]}])
    path = audio_with_pause(tmp_path / "a.wav")
    words = read_timed_words(Reader(), path, 0.0)
    assert [w["text"] for w in words] == ["똑", "똑한", "모델입니다"]
    assert not pause_checks(EXPECTED, words, interior_silences(path))["checks"]
