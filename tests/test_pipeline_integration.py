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

pytestmark = pytest.mark.filterwarnings("ignore::DeprecationWarning")


ONE_SLIDE = {
    "slides": {"ch00": ["intro"]},
    "scripts": {"ch00": "## intro\n### 1\n오늘은 래그를 봅니다.\n"},
}

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
    # Every chunk was still read back — checking is not what costs money.
    assert len(lecture.asr.calls) == 3


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
    assert [temperature for _, temperature in lecture.asr.calls] == [0.0, 0.2]
    assert manifest["quality"]["summary"]["clean"] is True


def test_turning_the_reviewer_off_generates_once_and_claims_nothing(studio) -> None:
    lecture = studio(**THREE_SLIDES, readings={"정리하겠습니다.": "완전히 관계없는 문장입니다"})
    manifest = lecture.run(start_page=1, end_page=3, automatic_quality=False)

    assert len(lecture.tts.calls) == 3
    assert lecture.asr.calls == []
    assert manifest["quality"]["enabled"] is False
    assert manifest["quality"]["model"] is None
    assert manifest["quality"]["summary"]["needsReview"] == []


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
    # A clip too quiet to trim used to return a partial record, raising KeyError
    # here and writing that same partial record into the clip cache.
    lecture = studio(**THREE_SLIDES, silent_for={"정리하겠습니다."})
    manifest = lecture.run(start_page=1, end_page=3, quality_attempts=1)

    for chunk in manifest["chunks"]:
        for key in ("trimmedHeadMs", "trimmedTailMs", "shortenedSilenceCount", "shortenedSilenceMs"):
            assert isinstance(chunk[key], int), chunk["key"]
    silent = next(c for c in manifest["quality"]["chunks"] if c["slideId"] == "outro")
    assert "음성 신호 부족" in silent["selected"]["failures"]
    assert silent["severity"] == "failed"


def test_a_silent_clip_does_not_poison_the_cache_for_the_next_run(studio, tmp_path) -> None:
    lecture = studio(**THREE_SLIDES, silent_for={"정리하겠습니다."})
    output = tmp_path / "cached"
    lecture.run(start_page=1, end_page=3, output_dir=output, use_cache=True, quality_attempts=1)

    sidecars = list((output / "clips/native").glob("*.json"))
    assert sidecars, "클립 사이드카가 있어야 캐시가 동작한다"
    for sidecar in sidecars:
        assert set(json.loads(sidecar.read_text(encoding="utf-8"))) == {
            "trimmedHeadMs", "trimmedTailMs", "shortenedSilenceCount", "shortenedSilenceMs",
        }

    # Reading those sidecars back must not raise.
    before = len(lecture.tts.calls)
    manifest = lecture.run(start_page=1, end_page=3, output_dir=output, use_cache=True, quality_attempts=1)
    assert len(lecture.tts.calls) == before, "캐시가 있으면 다시 생성하지 않는다"
    assert manifest["stats"]["cacheHits"] == 3


def test_a_lecture_that_came_out_entirely_silent_says_so(studio) -> None:
    """Normalizing a track with no signal made ffmpeg fail on `measured_I=-inf`,
    which told the user nothing about what actually went wrong."""
    lecture = studio(**ONE_SLIDE, silent_for={"오늘은 래그를 봅니다."})
    with pytest.raises(RuntimeError, match="정규화할 음성 신호가 없습니다"):
        lecture.run(start_page=1, end_page=1, quality_attempts=1)


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


def test_an_unmapped_letter_number_identifier_stops_before_generation(studio) -> None:
    lecture = studio(
        slides={"ch00": ["identifier"]},
        scripts={"ch00": "## identifier\n### 1\n주문 B-3099를 조회합니다.\n"},
    )

    with pytest.raises(ValueError, match="영문·숫자 식별자"):
        lecture.run(start_page=1, end_page=1)

    assert lecture.tts.calls == []


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
