"""The whole generation pipeline, driven end to end with stand-in models.

Everything here is real except the three models: real deck parsing, real WAV
files, real ffmpeg loudness normalization, real manifest assembly. What the
fakes control is what the reader claims to have heard, which is exactly the
input the review layer is supposed to react to.

Read `tests/conftest.py` for the harness.
"""

from __future__ import annotations

import json
from pathlib import Path

import pytest
import soundfile as sf
import numpy as np

pytestmark = pytest.mark.filterwarnings("ignore::DeprecationWarning")


ONE_SLIDE = {
    "slides": {"ch00": ["intro"]},
    "scripts": {"ch00": "## intro\n### 1\n오늘은 래그를 봅니다.\n"},
}


def test_source_contract_survives_voice_generation_and_export(studio) -> None:
    from local_tts_engine.export_udemy import timeline_from_course_manifest

    lecture = studio(**ONE_SLIDE)
    contract = {"schemaVersion": 1, "fingerprint": "frozen-source", "selected": [
        {"slideId": "intro", "chapter": "ch00", "slideNumber": 1, "step": 1}
    ]}
    (lecture.root / "production-input.json").write_text(
        json.dumps({"sourceContract": contract}), encoding="utf-8"
    )
    manifest = lecture.run(start_page=1, end_page=1)
    timeline = timeline_from_course_manifest(manifest, {"name": "pilot"}, {"provider": "qwen3-local"})
    assert manifest["sourceContract"] == contract
    assert timeline["sourceContract"] == contract

THREE_SLIDES = {
    "slides": {"ch00": ["intro", "middle", "outro"]},
    "scripts": {
        "ch00": (
            "## intro\n### 1\n오늘은 래그를 봅니다.\n"
            "## middle\n### 1\n검색으로 근거를 찾습니다.\n"
            "## outro\n### 1\n정리하겠습니다.\n"
        )
    },
}


def test_a_lecture_that_reads_correctly_costs_one_take_per_chunk(studio) -> None:
    lecture = studio(**THREE_SLIDES)
    manifest = lecture.run(start_page=1, end_page=3)

    assert len(manifest["chunks"]) == 3
    assert lecture.tts.calls and len(lecture.tts.calls) == 3
    assert manifest["stats"]["generatedCandidates"] == 3
    assert manifest["quality"]["summary"]["clean"] is True
    assert manifest["quality"]["summary"]["needsReview"] == []
    assert all(chunk["selectedAttempt"] == 1 for chunk in manifest["chunks"])
    # Each selected clip and the delivered normalized track are read separately.
    assert len(lecture.asr.calls) == 6
    assert manifest["quality"]["finalTrack"]["integrity"]["status"] == "ok"
    assert manifest["quality"]["finalTrack"]["transcript"]["status"] == "ok"
    assert manifest["quality"]["finalTrack"]["humanApproved"] is False


def test_final_normalized_track_gets_its_own_content_warning(studio, monkeypatch) -> None:
    lecture = studio(**ONE_SLIDE)
    original_read = lecture.asr.generate

    def changed_final_read(path, **kwargs):
        if "final--" in str(path) and not kwargs.get("return_timestamps"):
            from types import SimpleNamespace
            return SimpleNamespace(text="오늘은 전혀 다른 말입니다")
        return original_read(path, **kwargs)

    monkeypatch.setattr(lecture.asr, "generate", changed_final_read)
    manifest = lecture.run(start_page=1, end_page=1)

    assert manifest["quality"]["summary"]["clean"] is True
    final = manifest["quality"]["finalTrack"]
    assert final["integrity"]["status"] == "ok"
    assert final["transcript"]["status"] == "needs-review"
    assert final["transcript"]["needsReview"] == [
        {"chapter": "ch00", "slideId": "intro", "slideNumber": 1}
    ]
    assert "받아쓰기 불일치" in final["transcript"]["chunks"][0]["newConcerns"]
    assert final["humanApproved"] is False


def test_final_track_keeps_different_transcript_when_warning_label_is_unchanged(studio, monkeypatch) -> None:
    lecture = studio(**ONE_SLIDE)
    original_read = lecture.asr.generate

    def changed_read(path, **kwargs):
        if not kwargs.get("return_timestamps"):
            from types import SimpleNamespace
            return SimpleNamespace(text=(
                "오늘은 기록을 봅니다" if "final--" in str(path)
                else "오늘은 검색을 봅니다"
            ))
        return original_read(path, **kwargs)

    monkeypatch.setattr(lecture.asr, "generate", changed_read)
    manifest = lecture.run(start_page=1, end_page=1, quality_attempts=1)

    selected = manifest["quality"]["chunks"][0]["selected"]
    final = manifest["quality"]["finalTrack"]["transcript"]["chunks"][0]
    assert selected["failures"] == final["failures"] == ["받아쓰기 불일치"]
    assert selected["warnings"] == final["warnings"] == ["단어 발음 확인 필요"]
    assert selected["recognizedText"] != final["recognizedText"]
    assert final["newConcerns"] == ["선택 후보와 완성 음성의 받아쓰기 차이"]


def test_an_exact_english_reading_does_not_retry_a_korean_term_inside_it(studio, monkeypatch) -> None:
    literal = "Do my Bots share one computer?"
    text = f"영어 표현도 함께 보겠습니다. {literal} 실행 환경입니다."
    lecture = studio(
        slides={"ch00": ["english"]}, scripts={"ch00": f"## english\n### 1\n{text}\n"},
        dictionary=[
            {"from": literal, "to": literal, "literal": True},
            {"from": "Bots", "to": "봇츠"},
        ],
        readings={text: text.replace("Bots", "bots")},
    )
    from types import SimpleNamespace
    readings = iter(["영어 표현도 함께 보겠습니다.", literal.lower(), "실행 환경입니다."] * 2)
    languages = []
    def read_segment(path, **kwargs):
        if kwargs.get("return_timestamps"):
            return SimpleNamespace(text="", segments=[])
        languages.append(kwargs["language"])
        return SimpleNamespace(text=next(readings))
    monkeypatch.setattr(lecture.asr, "generate", read_segment)
    manifest = lecture.run(start_page=1, end_page=1)
    assert len(lecture.tts.calls) == 3
    assert [call["lang_code"] for call in lecture.tts.calls] == ["Korean", "English", "Korean"]
    assert "ref_text" not in lecture.tts.calls[1]
    assert lecture.tts.calls[0]["ref_text"] == lecture.tts.calls[2]["ref_text"]
    assert languages == ["ko", "en", "ko"] * 2
    assert manifest["chunks"][0]["voiceRouting"]["englishReferenceMode"] == "speaker-only"
    assert manifest["quality"]["summary"]["clean"]
    assert manifest["quality"]["chunks"][0]["selected"]["requiredPronunciations"] == [literal]


@pytest.mark.parametrize("internal_pause", [False, True])
def test_a_recall_pause_at_step_end_waits_before_the_answer(studio, internal_pause) -> None:
    from local_tts_engine.export_udemy import timeline_from_course_manifest

    question = "어느 사용 방식인지 고르세요.\n[2s]"
    if internal_pause:
        question = "먼저 화면을 보세요.\n[1s]\n" + question
    lecture = studio(
        slides={"ch00": ["recall"]},
        scripts={"ch00": f"## recall\n### 0\n{question}\n### 1\n정답은 첫 번째입니다.\n"},
    )
    manifest = lecture.run(start_page=1, end_page=1)
    assert [e["step"] for e in manifest["entries"]] == [0, 1]
    assert manifest["quality"]["summary"]["clean"]
    assert len(manifest["chunks"]) == (3 if internal_pause else 2)
    before, answer = manifest["chunks"][-2:]
    assert answer["startMs"] - before["endMs"] == 2000
    assert all("[" not in e["source_text"] and "[" not in e["tts_text"] for e in manifest["entries"])
    pauses = manifest["entries"][0]["forcedPauses"]
    assert [p["durationMs"] for p in pauses] == ([1000, 2000] if internal_pause else [2000])
    assert pauses[-1]["nextSpeechStartMs"] == manifest["entries"][1]["speechStartMs"]
    # The explicit wait is part of the assembled waveform, not a TTS request
    # that an automatic silence check can trim or reject.
    audio, rate = sf.read(manifest["audioPath"])
    middle = audio[round((before["endMs"] + 100) * rate / 1000):round((answer["startMs"] - 100) * rate / 1000)]
    assert np.max(np.abs(middle)) < 1e-6
    timeline = timeline_from_course_manifest(manifest, {"name": "recall"}, {"provider": "qwen3-local"})
    assert timeline["entries"][0]["forcedPauses"] == pauses


def test_a_trailing_pause_without_a_following_step_still_stops_before_tts(studio) -> None:
    lecture = studio(slides={"ch00": ["recall"]}, scripts={"ch00": "## recall\n### 0\n골라 보세요.\n[2s]\n"})
    with pytest.raises(ValueError, match="뒤에는 이어서"):
        lecture.run(start_page=1, end_page=1)
    assert not lecture.tts.calls


@pytest.mark.parametrize("first_step", [False, True])
def test_a_leading_pause_waits_before_speech_in_the_actual_track(studio, first_step) -> None:
    question = "" if first_step else "### 0\n몇 개일까요?\n"
    lecture = studio(slides={"ch00": ["count"]}, scripts={"ch00":
        f"## count\n{question}### 1\n[1.6s]\n여든일곱 개입니다.\n"})
    manifest = lecture.run(start_page=1, end_page=1)
    answer = manifest["chunks"][-1]
    before = 1300 if first_step else manifest["chunks"][0]["endMs"]
    assert answer["startMs"] - before == 1600
    audio, rate = sf.read(manifest["audioPath"])
    silence = audio[round((before + 100) * rate / 1000):round((answer["startMs"] - 100) * rate / 1000)]
    assert np.max(np.abs(silence)) < 1e-6
    assert all("[" not in call["text"] for call in lecture.tts.calls)
    assert all("[" not in entry["source_text"] for entry in manifest["entries"])
    if not first_step:
        assert manifest["entries"][0]["forcedPauses"] == [{"durationMs": 1600,
            "nextSpeechStartMs": manifest["entries"][1]["speechStartMs"]}]


def test_a_misread_chunk_is_retried_until_it_reads_correctly(studio) -> None:
    lecture = studio(
        **THREE_SLIDES,
        readings={"검색으로 근거를 찾습니다.": ["전혀 다른 말을 하고 있습니다", "검색으로 근거를 찾습니다"]},
    )
    manifest = lecture.run(start_page=1, end_page=3)

    # Only the chunk that went wrong paid for a second take.
    assert len(lecture.tts.calls) == 4
    retried = next(c for c in manifest["quality"]["chunks"] if c["slideId"] == "middle")
    assert retried["selected"]["attempt"] == 2
    assert retried["severity"] == "ok"
    assert manifest["quality"]["summary"]["ok"] is True
    assert manifest["quality"]["summary"]["retriedChunks"] == 1


@pytest.mark.parametrize("always_paused", [False, True])
@pytest.mark.parametrize("short_alignment", [False, True])
def test_a_correctly_spelled_but_broken_word_is_retried_before_export(studio, monkeypatch, always_paused, short_alignment):
    from local_tts_engine import course_pilot

    lecture = studio(slides={"ch00": ["intro"]}, scripts={"ch00": "## intro\n### 1\n똑똑한 모델입니다.\n"})
    generate = lecture.tts.generate
    count = 0
    def with_pause(**kwargs):
        nonlocal count
        count += 1
        for result in generate(**kwargs):
            if always_paused or count == 1:
                cut = round(0.8 * result.sample_rate)
                result.audio = np.concatenate([result.audio[:cut], np.zeros(round(0.4 * result.sample_rate), dtype=np.float32), result.audio[cut:]])
            yield result
    lecture.tts.generate = with_pause
    timings = []
    def timed_words(model, path, temperature):
        timings.append(temperature)
        return [
            {"text": "똑", "startMs": 0, "endMs": 620, "probability": 0.98},
            {"text": "똑한", "startMs": 1100, "endMs": 2000, "probability": 0.98},
            {"text": "모델입니다", "startMs": 2000, "endMs": 3000, "probability": 0.98},
        ]
    monkeypatch.setattr(course_pilot, "read_timed_words", timed_words)
    confirmations = []
    closure_alignments = []
    original_confirmation = course_pilot.read_independent_word_times
    def confirm(path, text):
        # Closure correction aligns every fresh take once, before it is cached;
        # the pause confirmation this test is about aligns the cached clip.
        if Path(path).name == "segment.wav":
            closure_alignments.append(str(path))
            return original_confirmation(path, text)
        confirmations.append(str(path))
        words = original_confirmation(path, text)
        if short_alignment:
            words[0]["endMs"] = 500
        return words
    monkeypatch.setattr(course_pilot, "read_independent_word_times", confirm)
    manifest = lecture.run(start_page=1, end_page=1, quality_attempts=2)
    assert count == 2
    assert len(closure_alignments) == 2
    record = manifest["quality"]["chunks"][0]
    assert record["candidates"][0]["phoneticErrorRate"] == 0
    assert record["candidates"][0]["prosody"]["checks"][0]["term"] == "똑똑한"
    if short_alignment:
        assert record["candidates"][0]["prosody"]["checks"][0]["confirmationEvidence"] == "unassigned-voiced-tail"
    assert manifest["quality"]["summary"]["retriedChunks"] == 1
    assert manifest["quality"]["summary"]["needsReview"] == []
    if always_paused:
        assert record["severity"] == "warning"
        assert manifest["quality"]["summary"]["listenSuggested"]
        assert timings == [0.0, 0.0]
        assert len(confirmations) == 2
    else:
        assert record["selected"]["attempt"] == 2
        assert record["severity"] == "ok"
        assert manifest["quality"]["summary"]["clean"]
        assert manifest["chunks"][0]["durationMs"] == record["selected"]["waveform"]["durationMs"]
        assert timings == [0.0]
        assert len(confirmations) == 1


def test_a_chunk_that_never_reads_correctly_is_reported_not_raised(studio) -> None:
    lecture = studio(**THREE_SLIDES, readings={"정리하겠습니다.": "완전히 관계없는 문장입니다"})
    manifest = lecture.run(start_page=1, end_page=3, quality_attempts=3)

    assert len(lecture.tts.calls) == 5  # two clean chunks, three takes of the bad one
    summary = manifest["quality"]["summary"]
    assert summary["ok"] is False
    assert summary["needsReview"] == [{"chapter": "ch00", "slideId": "outro", "slideNumber": 3}]
    # The lecture still finished: audio, timeline and preview all exist.
    assert Path(manifest["audioPath"]).is_file()
    assert Path(manifest["previewPath"]).is_file()
    assert len(manifest["entries"]) == 3


def test_a_reading_the_asr_only_doubted_once_is_settled_by_the_second_opinion(studio) -> None:
    # The first pass mishears; the second, differently decoded, does not. A take
    # is only blamed for evidence that survives every reading of it.
    lecture = studio(
        **ONE_SLIDE,
        readings={"오늘은 래그를 봅니다.": [["오늘은 전혀 다른 말입니다", "오늘은 래그를 봅니다"]]},
    )
    manifest = lecture.run(start_page=1, end_page=1)

    assert len(lecture.tts.calls) == 1
    assert [temperature for _, temperature in lecture.asr.calls] == [0.0, 0.2, 0.0, 0.2]
    assert manifest["quality"]["summary"]["clean"] is True
    evidence = manifest["quality"]["chunks"][0]["selected"]["transcriptReview"]
    assert evidence["selectedReading"] == 2
    assert evidence["readings"][0]["passed"] is False
    assert evidence["readings"][1]["passed"] is True


@pytest.mark.parametrize("defect", ["negation", "repetition"])
def test_local_content_defects_trigger_a_retry_and_clean_take_is_selected(studio, defect):
    text = ("오늘은 도구를 안전하게 사용하는 방법을 설명합니다. 먼저 권한과 실행 환경을 확인합니다. "
            "승인이 없으면 실행을 안 합니다. 다음으로 결과를 확인합니다.")
    misread = text.replace("안 합니다", "합니다") if defect == "negation" else text.replace("다음으로", "다음으로 다음으로")
    lecture = studio(slides={"ch00": ["local-content"]},
                     scripts={"ch00": f"## local-content\n### 1\n{text}\n"},
                     readings={text: [misread, text]})
    manifest = lecture.run(start_page=1, end_page=1)
    record = manifest["quality"]["chunks"][0]
    assert len(lecture.tts.calls) == 2
    assert record["selected"]["attempt"] == 2
    assert record["severity"] == "ok"
    first = record["candidates"][0]
    assert first["phoneticErrorRate"] < .1
    assert first["contentChecks"]
    assert len(first["transcriptReview"]["readings"]) == 2


def test_turning_the_reviewer_off_generates_once_and_claims_nothing(studio) -> None:
    lecture = studio(**THREE_SLIDES, readings={"정리하겠습니다.": "완전히 관계없는 문장입니다"})
    manifest = lecture.run(start_page=1, end_page=3, automatic_quality=False)

    assert len(lecture.tts.calls) == 3
    assert lecture.asr.calls == []
    assert manifest["quality"]["enabled"] is False
    assert manifest["quality"]["model"] is None
    assert manifest["quality"]["summary"]["needsReview"] == []
    assert manifest["quality"]["summary"]["clean"] is False
    assert manifest["quality"]["summary"]["passedChunks"] == 0
    assert manifest["quality"]["summary"]["notCheckedChunks"] == 3
    assert all(item["qualityPassed"] is None and item["qualitySeverity"] == "not-checked"
               for item in manifest["chunks"])


# ─── the manifest a lecture is assembled from ────────────────────────────────

def test_the_timeline_is_continuous_and_matches_the_rendered_audio(studio) -> None:
    lecture = studio(**THREE_SLIDES)
    manifest = lecture.run(start_page=1, end_page=3)

    entries = manifest["entries"]
    assert entries[0]["startMs"] == manifest["timing"]["startPadMs"]
    for earlier, later in zip(entries, entries[1:]):
        assert earlier["endMs"] == later["startMs"], "화면 사이에 빈 구간이 생기면 안 된다"
    assert entries[-1]["endMs"] == manifest["durationMs"]

    rendered = sf.info(manifest["audioPath"])
    measured_ms = round(rendered.frames * 1000 / rendered.samplerate)
    assert abs(measured_ms - manifest["durationMs"]) <= 2
    assert rendered.samplerate == 48_000


def test_every_clip_record_carries_the_full_trim_contract(studio) -> None:
    lecture = studio(**THREE_SLIDES)
    manifest = lecture.run(start_page=1, end_page=3, quality_attempts=1)

    for chunk in manifest["chunks"]:
        for key in ("trimmedHeadMs", "trimmedTailMs", "shortenedSilenceCount", "shortenedSilenceMs"):
            assert isinstance(chunk[key], int), chunk["key"]


def test_a_damaged_cached_clip_is_regenerated_without_reusing_it(studio, tmp_path) -> None:
    lecture = studio(**THREE_SLIDES)
    output = tmp_path / "cached"
    lecture.run(start_page=1, end_page=3, output_dir=output, use_cache=True, quality_attempts=1)

    sidecars = list((output / "clips/native").glob("*.json"))
    assert sidecars, "클립 사이드카가 있어야 캐시가 동작한다"
    for sidecar in sidecars:
        assert set(json.loads(sidecar.read_text(encoding="utf-8"))) == {
            "trimmedHeadMs", "trimmedTailMs", "shortenedSilenceCount", "shortenedSilenceMs", "wordClosures",
        }

    damaged = sorted((output / "clips/native").glob("*.wav"))[1]
    info = sf.info(damaged)
    sf.write(damaged, np.zeros(info.frames, dtype=np.float32), info.samplerate)
    before = len(lecture.tts.calls)
    manifest = lecture.run(start_page=1, end_page=3, output_dir=output, use_cache=True, quality_attempts=1)
    assert len(lecture.tts.calls) == before + 1
    assert manifest["stats"]["cacheHits"] == 2
    assert manifest["stats"]["invalidCacheEntries"] == 1


def test_a_lecture_that_came_out_entirely_silent_says_so(studio) -> None:
    """No all-silent selection reaches normalization or becomes a cache hit."""
    lecture = studio(**ONE_SLIDE, silent_for={"오늘은 래그를 봅니다."})
    with pytest.raises(RuntimeError, match="음성 후보 1회가 모두 생성에 실패"):
        lecture.run(start_page=1, end_page=1, quality_attempts=1)
    failure = json.loads((lecture.root / "out/quality-failure.json").read_text(encoding="utf-8"))
    assert failure["status"] == "failed"
    assert failure["generationFailures"][0]["code"] == "no-signal"
    assert isinstance(failure["generationFailures"][0]["seed"], int)
    assert len(failure["generationFailures"][0]["hash"]) == 64


def test_failed_retry_cannot_pass_an_older_success_manifest_to_export(studio) -> None:
    from local_tts_engine.course.run_state import require_current_course_manifest

    lecture = studio(**ONE_SLIDE)
    output = lecture.root / "same-output"
    first = lecture.run(start_page=1, end_page=1, output_dir=output, quality_attempts=1)
    require_current_course_manifest(output, first)
    lecture.tts.silent_for.add("오늘은 래그를 봅니다.")

    with pytest.raises(RuntimeError, match="모두 생성에 실패"):
        lecture.run(start_page=1, end_page=1, output_dir=output, quality_attempts=1)

    old_manifest = json.loads((output / "manifest.json").read_text(encoding="utf-8"))
    assert old_manifest["runId"] == first["runId"]
    assert json.loads((output / "run-state.json").read_text(encoding="utf-8"))["status"] == "failed"
    with pytest.raises(RuntimeError, match="완료되지 않았거나"):
        require_current_course_manifest(output, old_manifest)


def test_without_content_review_records_actual_audio_retry_budget(studio, monkeypatch) -> None:
    from local_tts_engine import course_pilot
    from local_tts_engine.course.candidates import CandidateAudioError

    lecture = studio(**ONE_SLIDE)
    real_generate = course_pilot.generate_candidate_audio
    attempts = 0

    def first_take_empty(*args, **kwargs):
        nonlocal attempts
        attempts += 1
        if attempts == 1:
            raise CandidateAudioError("empty-audio", "첫 후보가 비었습니다.")
        return real_generate(*args, **kwargs)

    monkeypatch.setattr(course_pilot, "generate_candidate_audio", first_take_empty)
    manifest = lecture.run(start_page=1, end_page=1, automatic_quality=False, quality_attempts=4)

    assert attempts == 2
    assert manifest["chunks"][0]["selectedAttempt"] == 2
    assert manifest["quality"]["enabled"] is False
    assert manifest["quality"]["maxAttempts"] == 4
    assert manifest["quality"]["chunks"][0]["generationFailures"][0]["attempt"] == 1
    assert manifest["quality"]["summary"]["retriedChunks"] == 1
    assert lecture.asr.calls == []


def test_the_manifest_records_which_reader_judged_the_run(studio) -> None:
    lecture = studio(**ONE_SLIDE)
    manifest = lecture.run(start_page=1, end_page=1)

    quality = manifest["quality"]
    assert quality["enabled"] is True
    assert "whisper" in quality["model"]
    assert quality["license"] == "MIT"
    assert quality["secondOpinion"] is True
    assert quality["maxAttempts"] == 4
    assert quality["lexicalGate"] == {
        "enabled": True,
        "minimumKeyLength": 6,
        "warningDistance": 0.24,
        "failureDistance": 0.55,
    }
    # The reviewer is resident with the generator, so the run reports a
    # process-wide peak rather than the generator's own figure.
    assert manifest["performance"]["residentReviewer"] is True
    assert manifest["performance"]["peakProcessMetalMemoryGb"] == 13.4


def test_captions_keep_the_script_while_speech_uses_the_pronunciation(studio) -> None:
    lecture = studio(
        slides={"ch00": ["intro"]},
        scripts={"ch00": "## intro\n### 1\nRuntime에서 Qwen3.6-27B를 씁니다.\n"},
        dictionary=[{"from": "Runtime", "to": "런타임"}],
    )
    manifest = lecture.run(start_page=1, end_page=1)

    entry = manifest["entries"][0]
    assert entry["source_text"] == "Runtime에서 Qwen3.6-27B를 씁니다."
    assert entry["tts_text"] == "런타임에서 큐웬삼점육 이십칠비를 씁니다."
    assert lecture.tts.calls[0]["text"] == entry["tts_text"]


def test_a_transcript_spelling_a_term_its_own_way_is_not_a_mispronunciation(studio) -> None:
    """The 148페이지 regression, through the whole pipeline.

    The reader says the model name correctly and Whisper writes it as `QN 3.6
    27B`. That must finish as a clean run, in one take.
    """
    lecture = studio(
        slides={"ch00": ["intro"]},
        scripts={"ch00": "## intro\n### 1\n왼쪽은 로컬에서 돌리는 Qwen3.6-27B입니다. 도구 50개를 똑같이 줬습니다.\n"},
        dictionary=[{"from": "똑같이", "to": "똑까치"}],
        readings={
            "왼쪽은 로컬에서 돌리는 큐웬삼점육 이십칠비입니다. 도구 오십 개를 똑까치 줬습니다.":
                "왼쪽은 로컬에서 돌리는 QN 3.6 27B입니다 도구 50개를 똑같이 줬습니다",
        },
    )
    manifest = lecture.run(start_page=1, end_page=1)

    assert len(lecture.tts.calls) == 1, "정확히 읽은 청크를 다시 만들면 안 된다"
    assert manifest["quality"]["summary"]["clean"] is True
    assert manifest["quality"]["chunks"][0]["severity"] == "ok"


def test_natural_counter_reading_reaches_tts_manifest_and_asr_gate(studio) -> None:
    source = "방금 본 10개, 100개, 1000개 그래프입니다."
    spoken = "방금 본 열 개, 백 개, 천 개 그래프입니다."
    lecture = studio(
        slides={"ch00": ["scale"]},
        scripts={"ch00": f"## scale\n### 1\n{source}\n"},
        readings={spoken: "방금 본 10개, 100개, 1000개 그래프입니다."},
    )

    manifest = lecture.run(start_page=1, end_page=1)

    assert lecture.tts.calls[0]["text"] == spoken
    assert manifest["entries"][0]["source_text"] == source
    assert manifest["entries"][0]["tts_text"] == spoken
    assert manifest["naturalness"]["checks"][0]["changes"] == ["10개 → 열 개"]
    assert manifest["quality"]["summary"]["clean"] is True


def test_an_unmapped_letter_number_identifier_generates_and_keeps_review_evidence(studio) -> None:
    lecture = studio(
        slides={"ch00": ["identifier"]},
        scripts={"ch00": "## identifier\n### 1\n주문 B-3099를 조회합니다.\n"},
    )

    manifest = lecture.run(start_page=1, end_page=1)
    assert lecture.tts.calls[0]["text"] == "주문 B-3099를 조회합니다."
    assert manifest["entries"][0]["source_text"] == "주문 B-3099를 조회합니다."
    assert "B-3099" in manifest["entries"][0]["unresolved_tokens"]
    assert "B-3099" in manifest["naturalness"]["warnings"][0]["messages"][0]
    assert manifest["chunks"][0]["endMs"] > manifest["chunks"][0]["startMs"]
    assert Path(manifest["audioPath"]).is_file()
    assert manifest["cachePolicy"] == "disabled"
    assert manifest["stats"]["cacheHits"] == 0


def test_one_wrong_word_in_a_long_chunk_gets_another_take(studio) -> None:
    expected = (
        "사용자와 자원과 위험 수준에 따라 행동의 바깥선을 그려야 합니다. "
        "그래야 자율성을 안전하게 운영할 수 있습니다. 이 문장은 통째로 한 레슨이 됩니다."
    )
    misread = expected.replace("운영할", "운전할")
    lecture = studio(
        slides={"ch00": ["local-word"]},
        scripts={"ch00": f"## local-word\n### 1\n{expected}\n"},
        readings={expected: [misread, expected]},
    )

    manifest = lecture.run(start_page=1, end_page=1)

    assert len(lecture.tts.calls) == 2
    assert manifest["chunks"][0]["selectedAttempt"] == 2
    assert manifest["quality"]["summary"]["clean"] is True


def test_a_forced_pause_splits_the_audio_and_rejoins_the_visual_step(studio) -> None:
    lecture = studio(
        slides={"ch00": ["camera"]},
        scripts={"ch00": "## camera\n### 1\n들어갑니다.\n\n[2s]\n\n자, 이제 안입니다.\n"},
    )
    manifest = lecture.run(start_page=1, end_page=1)

    assert len(manifest["chunks"]) == 2, "강제 무음은 음성 조각을 나눈다"
    assert len(manifest["entries"]) == 1, "화면 스텝은 하나로 다시 합쳐진다"
    entry = manifest["entries"][0]
    assert entry["source_text"] == "들어갑니다. 자, 이제 안입니다."
    assert entry["forcedPauses"] == [
        {"durationMs": 2_000, "nextSpeechStartMs": entry["forcedPauses"][0]["nextSpeechStartMs"]}
    ]
    gap = manifest["chunks"][1]["startMs"] - manifest["chunks"][0]["endMs"]
    assert gap == 2_000


def test_a_page_range_generates_exactly_those_pages(studio) -> None:
    lecture = studio(**THREE_SLIDES)
    manifest = lecture.run(start_page=2, end_page=3)

    assert [entry["slide_id"] for entry in manifest["entries"]] == ["middle", "outro"]
    assert manifest["pageRange"] == {"start": 2, "end": 3, "totalPages": 3, "mode": "bundle"}


def test_a_target_length_it_cannot_reach_says_so(studio) -> None:
    lecture = studio(**ONE_SLIDE)
    with pytest.raises(RuntimeError, match="목표 길이에 도달하지 못했습니다"):
        lecture.run(target_seconds=600.0)


def test_a_preview_stops_near_the_target_length(studio) -> None:
    lecture = studio(**THREE_SLIDES)
    manifest = lecture.run(target_seconds=4.0)

    assert len(manifest["entries"]) < 3
    assert manifest["pageRange"]["mode"] == "preview"
    # A chunk dropped for being past the target takes its verdict with it.
    assert len(manifest["quality"]["chunks"]) == len(manifest["chunks"])


def test_a_page_range_outside_the_lecture_is_refused_before_any_audio(studio) -> None:
    lecture = studio(**THREE_SLIDES)
    with pytest.raises(ValueError, match="시작 페이지는"):
        lecture.run(start_page=9, end_page=9)
    with pytest.raises(ValueError, match="끝 페이지는"):
        lecture.run(start_page=1, end_page=9)
    assert lecture.tts.calls == []


def test_the_manifest_a_run_produces_is_consumable_by_the_deck_export(studio) -> None:
    """The generator and the deck contract meet here.

    `export_udemy` is what turns a manifest into the timeline captions and
    capture read. Feeding it a manifest an actual run produced — rather than a
    hand-written one — is the only way a change to the generator's output can be
    caught before a lecture is half rendered.
    """
    from local_tts_engine.export_udemy import timeline_from_course_manifest

    lecture = studio(**THREE_SLIDES)
    manifest = lecture.run(start_page=1, end_page=3)

    timeline = timeline_from_course_manifest(
        manifest, {"name": "integration"}, {"provider": "qwen3-local"}
    )

    assert timeline["totalMs"] == manifest["durationMs"]
    assert timeline["startPadMs"] == manifest["timing"]["startPadMs"]
    assert [entry["slideNumber"] for entry in timeline["entries"]] == [1, 2, 3]
    for entry in timeline["entries"]:
        assert entry["alignment"]["words"], "자막은 단어 시각을 필요로 한다"
        assert entry["speechStartMs"] >= entry["startMs"]
        assert entry["speechEndMs"] <= entry["endMs"]
        assert entry["gapAfterMs"] >= 0
    assert timeline["entries"][-1]["endMs"] == manifest["durationMs"]


def test_word_timings_stay_inside_the_clip_that_produced_them(studio) -> None:
    lecture = studio(**THREE_SLIDES)
    manifest = lecture.run(start_page=1, end_page=3)

    for entry in manifest["entries"]:
        words = entry["alignment"]["words"]
        assert words[0]["startMs"] >= entry["startMs"]
        assert words[-1]["endMs"] <= manifest["durationMs"]
        for earlier, later in zip(words, words[1:]):
            assert earlier["endMs"] <= later["startMs"]


def test_a_retry_shifts_the_timeline_to_the_take_that_was_kept(studio) -> None:
    """Selecting a different seed changes the clip length, so every absolute
    position downstream has to be rebuilt rather than kept from the first take."""
    lecture = studio(
        **THREE_SLIDES,
        readings={"검색으로 근거를 찾습니다.": ["전혀 다른 말입니다", "검색으로 근거를 찾습니다"]},
    )
    manifest = lecture.run(start_page=1, end_page=3)

    kept = next(c for c in manifest["chunks"] if c["selectedAttempt"] == 2)
    info = sf.info(kept["audioPath"])
    assert round(info.frames * 1000 / info.samplerate) == kept["durationMs"]
    assert kept["endMs"] - kept["startMs"] == kept["durationMs"]
    for earlier, later in zip(manifest["entries"], manifest["entries"][1:]):
        assert earlier["endMs"] == later["startMs"]
    assert manifest["entries"][-1]["endMs"] == manifest["durationMs"]
