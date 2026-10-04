"""Word-internal closure correction: only over-long, dead-silent stop closures change."""

from types import SimpleNamespace

import numpy as np
import pytest

from local_tts_engine.course.audio import normalize_word_closures, room_tone
from local_tts_engine.course.settings import CLOSURE_CAP_MS, CLOSURE_FLOOR_DB
from local_tts_engine.course_pilot import generate_candidate_audio

RATE = 24_000


def speech_with_gap(gap_start: float, gap_ms: int, seconds: float = 0.64) -> np.ndarray:
    at = np.arange(round(RATE * seconds)) / RATE
    audio = (0.2 * np.sin(2 * np.pi * 190 * at)).astype(np.float32)
    begin = round(gap_start * RATE)
    audio[begin:begin + round(gap_ms * RATE / 1000)] = 0
    return audio


def quiet_run_ms(audio: np.ndarray) -> int:
    hop = RATE // 200
    peak = np.percentile(np.abs(audio), 99.5)
    frames = len(audio) // hop
    levels = np.sqrt(np.mean(audio[:frames * hop].reshape(frames, hop).astype(np.float64) ** 2, axis=1))
    quiet = 20 * np.log10(levels / peak + 1e-12) < -35
    best = run = 0
    for flag in quiet:
        run = run + 1 if flag else 0
        best = max(best, run)
    return best * 5


TONE = room_tone(np.random.default_rng(0).normal(0, 1e-3, RATE).astype(np.float32), RATE, RATE)
WORD = [{"text": "바깥과", "startMs": 0, "endMs": 640}]


def test_an_over_long_closure_inside_a_word_is_shortened_and_given_a_floor():
    # CH00 3:46: 165 ms of dead silence before 과 in 바깥과.
    audio = speech_with_gap(0.2, 165)
    corrected, record = normalize_word_closures(audio, RATE, WORD, TONE)
    assert record["status"] == "checked"
    assert record["capped"] == [{"word": "바깥과", "startMs": 200, "lengthMs": 165}]
    assert record["filled"] == 1
    assert len(audio) - len(corrected) == round(RATE * 0.045)
    assert abs(quiet_run_ms(corrected) - CLOSURE_CAP_MS) <= 5
    middle = corrected[round(RATE * 0.25):round(RATE * 0.27)]
    floor = np.percentile(np.abs(audio), 99.5) * 10 ** (CLOSURE_FLOOR_DB / 20)
    assert 0.5 * floor < np.sqrt(np.mean(middle ** 2)) < 1.5 * floor
    # Speech on either side is untouched.
    assert np.array_equal(corrected[:round(RATE * 0.2)], audio[:round(RATE * 0.2)])
    assert np.array_equal(corrected[-round(RATE * 0.2):], audio[-round(RATE * 0.2):])


def test_a_closure_within_the_speakers_range_keeps_its_length():
    audio = speech_with_gap(0.2, 100)
    corrected, record = normalize_word_closures(audio, RATE, WORD, TONE)
    assert len(corrected) == len(audio) and record["capped"] == []
    assert record["filled"] == 1  # 90 ms or more is lifted off digital silence


@pytest.mark.parametrize(("gap_start", "gap_ms", "words"), [
    (0.2, 250, WORD),                                   # longer than a closure: a pause
    (0.03, 165, WORD),                                  # at the word edge: a pause the aligner folded in
    (0.2, 165, [{"text": "초", "startMs": 0, "endMs": 640}]),   # one syllable
    (0.2, 165, [{"text": "Agent", "startMs": 0, "endMs": 640}]),  # not Korean
    (0.2, 165, []),                                     # no alignment
])
def test_pauses_edges_and_unaligned_audio_are_left_alone(gap_start, gap_ms, words):
    audio = speech_with_gap(gap_start, gap_ms)
    corrected, record = normalize_word_closures(audio, RATE, words, TONE)
    assert np.array_equal(corrected, audio)
    assert record["capped"] == [] and record["filled"] == 0


def test_without_room_tone_a_closure_is_only_shortened():
    assert room_tone(np.zeros(RATE, dtype=np.float32), RATE, RATE) is None
    audio = speech_with_gap(0.2, 165)
    corrected, record = normalize_word_closures(audio, RATE, WORD, None)
    assert record["filled"] == 0 and len(record["capped"]) == 1
    assert len(audio) - len(corrected) == round(RATE * 0.045)


@pytest.mark.parametrize("tone", [None, TONE])
def test_overlapping_words_cannot_fill_or_cut_the_same_closure_twice(tone):
    audio = speech_with_gap(0.2, 240, seconds=1)
    words = [{"text": "바깥과", "startMs": 0, "endMs": 700},
             {"text": "연결을", "startMs": 100, "endMs": 800}]
    single, _ = normalize_word_closures(audio, RATE, words[:1], tone)
    corrected, record = normalize_word_closures(audio, RATE, words, tone)
    assert np.array_equal(corrected, single)
    assert record["closures"] == 1 and record["removedMs"] == 120
    assert len(record["capped"]) == 1
    assert record["filled"] == int(tone is not None)
    # The 60 ms following the closure were deleted by a repeated cut before.
    assert np.array_equal(corrected[-round(RATE * 0.5):], audio[-round(RATE * 0.5):])


def test_korean_segments_are_corrected_before_their_positions_are_recorded():
    rate = 24_000

    def generate(**arguments):
        yield SimpleNamespace(audio=0.1 * np.sin(2 * np.pi * 200 * np.arange(rate) / rate),
                              sample_rate=rate, peak_memory_usage=1.0)

    seen = []

    def refine(audio, rate, text):
        seen.append(text)
        return audio[:-rate // 10], {"policy": "test", "status": "checked", "closures": 1, "filled": 0,
                                     "capped": [{"word": "바깥과", "startMs": 300, "lengthMs": 165}], "removedMs": 100}

    parts = ["바깥과 연결됩니다.", "다음을 봅니다."]
    result = generate_candidate_audio(generate, {"text": " ".join(parts)}, parts, refine=refine)
    assert seen == parts
    records = result["cleanup"]["recovery"]["parts"]
    assert [p["durationMs"] for p in records] == [900, 900]
    assert records[1]["startMs"] == 900 + 200
    closures = result["cleanup"]["wordClosures"]
    assert [c["startMs"] for c in closures["capped"]] == [300, 1100 + 300]
    assert closures["removedMs"] == 200
