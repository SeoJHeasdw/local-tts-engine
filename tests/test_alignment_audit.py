import copy
import json
import math
import shutil
import struct
import subprocess
import wave
from pathlib import Path
from unittest.mock import patch

import pytest

from local_tts_engine.course.alignment_audit import (
    audit_timeline,
    detect_silences,
    voiced_spans,
)


def word(text: str, start: float, end: float) -> dict:
    return {"text": text, "startMs": start, "endMs": end}


def entry(step: int, start: float, end: float, words: list[dict], **extra) -> dict:
    return {
        "slideId": "sample", "step": step, "startMs": start, "endMs": end,
        "gapAfterMs": 0, "transitionAtMs": end, "alignment": {"words": words}, **extra,
    }


def test_voiced_spans_clip_and_merge_silence_without_mutating_input():
    silences = [
        {"startMs": 550, "endMs": 900},
        {"startMs": 200, "endMs": 600},
        {"startMs": -100, "endMs": 100},
    ]
    original = copy.deepcopy(silences)
    assert voiced_spans(silences, 50, 1100) == [
        {"startMs": 100, "endMs": 200}, {"startMs": 900, "endMs": 1100},
    ]
    assert silences == original
    assert voiced_spans([], 0, 80) == []
    assert voiced_spans([], 0, 81) == [{"startMs": 0, "endMs": 81}]
    assert voiced_spans([], 0, 80, min_duration_ms=0) == [{"startMs": 0, "endMs": 80}]


def test_audit_flags_collapsed_words_but_identifies_voiced_short_syllables():
    timeline = {"entries": [entry(0, 0, 1200, [
        word("한", 100, 150), word("서브에이전트", 200, 230),
        word("한", 300, 330), word("쉼", 600, 650), word("끝입니다", 700, 1100),
    ])]}
    report = audit_timeline(timeline, [{"startMs": 0, "endMs": 1100}], [
        {"startMs": 550, "endMs": 680}, {"startMs": 1100, "endMs": 1200},
    ])
    assert report["summary"]["tinyWords"] == 4
    assert report["summary"]["collapsedWords"] == 3
    assert report["summary"]["plausibleShortSyllables"] == 1
    assert [issue["text"] for issue in report["findings"]["collapsedWords"]] == ["서브에이전트", "한", "쉼"]
    assert report["status"] == "warning"
    assert report["blocksAudioGeneration"] is False


def test_multisyllable_plausibility_detects_exact_eighty_ms_without_changing_legacy_counts():
    timeline = {"entries": [entry(0, 0, 1000, [
        word("단어", 0, 80), word("말입니다", 100, 300), word("정상", 400, 520),
        word("한", 600, 680), word("Extraordinary", 700, 780), word("끝", 800, 1000),
    ])]}
    report = audit_timeline(timeline, [{"startMs": 0, "endMs": 1000}], [])
    assert report["summary"]["tinyWords"] == 0
    assert report["summary"]["collapsedWords"] == 0
    assert report["summary"]["legacyAlignmentIssues"] == 0
    assert report["summary"]["implausibleWords"] == 2
    assert report["status"] == "warning"
    first, second = report["findings"]["implausibleWords"]
    assert first == {
        "step": "sample:0", "wordIndex": 0, "text": "단어", "startMs": 0, "endMs": 80,
        "durationMs": 80, "hangulSyllables": 2, "millisecondsPerSyllable": 40,
        "minimumExpectedDurationMs": 120,
    }
    assert second["text"] == "말입니다"
    assert second["hangulSyllables"] == 4


def test_multisyllable_plausibility_preserves_single_syllable_exception_and_latin_spelling():
    timeline = {"entries": [entry(0, 0, 1000, [
        word("한", 0, 50), word("Agent", 100, 180), word("정상", 200, 320), word("끝", 400, 1000),
    ])]}
    report = audit_timeline(timeline, [{"startMs": 0, "endMs": 1000}], [])
    assert report["summary"]["plausibleShortSyllables"] == 1
    assert report["summary"]["implausibleWords"] == 0
    assert report["status"] == "passed"


@pytest.mark.parametrize("transition,expected", [(780, 0), (1220, 0), (1220.01, 1), (779.99, 1)])
def test_transition_has_twenty_millisecond_silence_tolerance(transition, expected):
    timeline = {"entries": [
        entry(0, 0, 1000, [word("첫째", 100, 800)], transitionAtMs=transition),
        entry(1, 1000, 2000, [word("둘째", 1200, 1900)]),
    ]}
    report = audit_timeline(timeline, [], [{"startMs": 800, "endMs": 1200}])
    assert report["summary"]["transitions"] == expected
    if expected:
        assert report["findings"]["transitions"][0]["alignedFirstWordMs"] == 1200


def test_caption_tail_counts_only_voice_and_keeps_stricter_warning_separate():
    timeline = {"entries": [entry(0, 0, 2500, [word("말입니다", 0, 2100)])]}
    silences = [{"startMs": 1200, "endMs": 1900}, {"startMs": 2100, "endMs": 2500}]
    report = audit_timeline(timeline, [{"startMs": 0, "endMs": 1100}], silences)
    assert report["summary"]["earlyCaptions"] == 0
    assert report["summary"]["earlyCaptionsOver20Ms"] == 1
    assert report["findings"]["captionCoverage"][0]["voiceAfterCueMs"] == 300
    report = audit_timeline(timeline, [{"startMs": 0, "endMs": 600}], silences)
    assert report["summary"]["earlyCaptions"] == 1
    assert report["findings"]["captions"][0]["voiceAfterCueMs"] == 800


def test_only_last_caption_in_step_is_tested_and_trailing_voice_is_not_lost():
    timeline = {"entries": [entry(0, 0, 2000, [word("문장입니다", 0, 2000)])]}
    report = audit_timeline(timeline, [
        {"startMs": 0, "endMs": 500}, {"startMs": 600, "endMs": 1500},
    ], [])
    assert report["summary"]["earlyCaptions"] == 1
    assert report["findings"]["captions"][0]["cueEndMs"] == 1500
    assert report["findings"]["captions"][0]["voiceAfterCueMs"] == 500


def test_end_alignment_gate_is_stricter_than_legacy_report_and_input_is_unchanged():
    timeline = {"entries": [
        entry(0, 0, 1000, [word("문장입니다", 0, 650)]),
        entry(1, 1000, 2000, [word("다음입니다", 1100, 1749)]),
    ]}
    captions = [{"startMs": 0, "endMs": 900}, {"startMs": 1000, "endMs": 2000}]
    silences = [{"startMs": 900, "endMs": 1100}]
    original = copy.deepcopy((timeline, captions, silences))
    report = audit_timeline(timeline, captions, silences)
    assert report["summary"]["alignmentEndWithin250Ms"] == 1
    assert report["summary"]["alignmentEndWithin250MsRate"] == 0.5
    assert report["summary"]["alignmentEndBeyond250Ms"] == 1
    assert report["summary"]["legacyAlignmentIssues"] == 0
    assert report["findings"]["alignmentEnd"][0]["endDeltaMs"] == -251
    assert (timeline, captions, silences) == original
    json.dumps(report, allow_nan=False)


def test_end_gate_includes_gap_and_supports_snake_case_manifest_fields():
    timeline = {"entries": [{
        "slide_id": "sample", "step": 0, "start_ms": 0, "end_ms": 1000,
        "gap_after_ms": 500, "alignment": {"words": [word("끝입니다", 0, 900)]},
    }]}
    report = audit_timeline(timeline, [], [{"startMs": 1300, "endMs": 1500}])
    assert report["stepMeasurements"][0]["waveformEndMs"] == 1300
    assert report["summary"]["alignmentEndBeyond250Ms"] == 1
    assert report["summary"]["missingCaptionSteps"] == 1


def test_empty_timeline_is_not_claimed_as_passed():
    report = audit_timeline({"entries": []}, [], [])
    assert report["status"] == "not-checked"
    assert report["summary"]["alignmentEndWithin250MsRate"] is None


def test_captions_not_generated_are_distinct_from_checked_but_missing_captions():
    timeline = {"entries": [entry(0, 0, 1000, [word("끝입니다", 0, 1000)])]}
    pending = audit_timeline(timeline, None, [])
    assert pending["captionAuditStatus"] == "not-run"
    assert pending["summary"]["missingCaptionSteps"] == 0
    assert pending["findings"]["captionCoverage"] == []
    assert pending["status"] == "passed"
    missing = audit_timeline(timeline, [], [])
    assert missing["captionAuditStatus"] == "checked"
    assert missing["summary"]["missingCaptionSteps"] == 1
    assert missing["status"] == "warning"
    present = audit_timeline(timeline, [{"startMs": 0, "endMs": 1000}], [])
    assert present["captionAuditStatus"] == "checked"
    assert present["status"] == "passed"


def test_detect_silences_checks_decode_failure_and_handles_final_silence(tmp_path: Path):
    audio = tmp_path / "readonly.wav"
    audio.write_bytes(b"unchanged")
    log = "silence_start: 0\nsilence_end: 1.125\nsilence_start: 2.5 silence_end: 3.2"
    with patch("local_tts_engine.course.alignment_audit.subprocess.run") as run:
        run.return_value = subprocess.CompletedProcess([], 0, "", log)
        assert detect_silences(audio) == [
            {"startMs": 0, "endMs": 1125}, {"startMs": 2500, "endMs": 3200},
        ]
        assert "silencedetect=noise=-38dB:d=0.12" in run.call_args.args[0]
        run.return_value = subprocess.CompletedProcess([], 1, "", "Invalid data")
        with pytest.raises(RuntimeError, match="silence detection failed"):
            detect_silences(audio)
        run.return_value = subprocess.CompletedProcess([], 0, "", "silence_start: 1.0")
        with pytest.raises(RuntimeError, match="incomplete final silence"):
            detect_silences(audio)
    assert audio.read_bytes() == b"unchanged"


def test_detect_silences_rejects_missing_audio_and_nonfinite_timing(tmp_path: Path):
    with pytest.raises(FileNotFoundError):
        detect_silences(tmp_path / "absent.wav")
    with pytest.raises(ValueError, match="finite"):
        voiced_spans([], 0, float("nan"))
    with pytest.raises(ValueError, match="precedes"):
        voiced_spans([{"startMs": 1000, "endMs": 900}], 0, 1500)


@pytest.mark.skipif(not shutil.which("ffmpeg"), reason="FFmpeg is not installed")
def test_real_ffmpeg_silence_measurement_keeps_original_audio(tmp_path: Path):
    audio = tmp_path / "waveform.wav"
    sample_rate = 16000
    samples = [
        0 if i < sample_rate // 2 or i >= sample_rate else int(12000 * math.sin(2 * math.pi * 440 * i / sample_rate))
        for i in range(24000)
    ]
    with wave.open(str(audio), "wb") as output:
        output.setparams((1, 2, sample_rate, 0, "NONE", "not compressed"))
        output.writeframes(struct.pack(f"<{len(samples)}h", *samples))
    original = audio.read_bytes()
    spans = detect_silences(audio)
    assert len(spans) == 2
    assert spans[0]["startMs"] == 0
    assert spans[0]["endMs"] == pytest.approx(500, abs=2)
    assert spans[1]["startMs"] == pytest.approx(1000, abs=2)
    assert spans[1]["endMs"] == pytest.approx(1500, abs=2)
    assert audio.read_bytes() == original
