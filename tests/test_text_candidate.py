from pathlib import Path
import json
import shutil
import sys
from types import ModuleType, SimpleNamespace

import numpy as np
import pytest
import soundfile as sf

from local_tts_engine.english_voice import speech_segments
from local_tts_engine.course.candidates import CandidateAudioError as CourseCandidateAudioError
from local_tts_engine.pronunciation import apply_pronunciation
from local_tts_engine.text_candidate import (
    CandidateAudioError,
    _read_local_independent_word_times,
    candidate_seed,
    generate_candidate,
    load_text,
    plan_text_chunks,
    resolve_text_chunk_take,
    validate_candidate_audio,
)


def test_load_text_normalizes_whitespace_and_applies_pronunciation(tmp_path: Path) -> None:
    source = tmp_path / "input.txt"
    source.write_text("똑같이\n  연결합니다.", encoding="utf-8")

    display, tts = load_text(source)

    assert display == "똑같이\n연결합니다."
    assert tts != display
    assert "똑까치" in tts
    assert "\n" in tts


def test_load_text_rejects_empty_and_oversized_input(tmp_path: Path) -> None:
    source = tmp_path / "input.txt"
    source.write_text("   ", encoding="utf-8")
    with pytest.raises(ValueError):
        load_text(source)

    source.write_text("... !?", encoding="utf-8")
    with pytest.raises(ValueError):
        load_text(source)

    source.write_text("가" * 20_001, encoding="utf-8")
    with pytest.raises(ValueError):
        load_text(source)


def test_chunk_plan_keeps_quotes_identifiers_and_all_spoken_words() -> None:
    quote = '"The model must keep A-2041 and foo.bar together, even when a sentence is long."'
    source = ("첫 문장입니다. " * 35) + quote + " 다음은 B-3102를 설명합니다. " + ("마지막 문장입니다. " * 30)

    chunks = plan_text_chunks(source, [])

    assert len(chunks) > 3
    assert all(chunk["sourceText"] and chunk["ttsText"] for chunk in chunks)
    assert sum(chunk["sourceText"].count("첫 문장입니다.") for chunk in chunks) == 35
    assert sum(chunk["sourceText"].count("마지막 문장입니다.") for chunk in chunks) == 30
    assert sum(quote in chunk["sourceText"] for chunk in chunks) == 1
    assert any(part["language"] == "English" for chunk in chunks
               for part in speech_segments(chunk["ttsText"], []))
    assert sum("B-3102" in chunk["sourceText"] for chunk in chunks) == 1
    assert max(len(chunk["sourceText"]) for chunk in chunks) <= 300
    assert " ".join(" ".join(chunk["sourceText"] for chunk in chunks).split()) == " ".join(source.split())


def test_long_unpunctuated_input_uses_spaces_without_cutting_identifier() -> None:
    identifier = "service_api_request_2041"
    source = " ".join([identifier] * 28)

    chunks = plan_text_chunks(source, [])

    assert len(chunks) >= 2
    assert all(identifier in chunk["sourceText"] for chunk in chunks)
    assert sum(chunk["sourceText"].count(identifier) for chunk in chunks) == 28
    assert max(len(chunk["sourceText"]) for chunk in chunks) <= 300


def test_chunk_plan_keeps_approved_multiword_reading_together() -> None:
    dictionary = [{"from": "Artificial Analysis", "to": "아티피셜 어낼리시스"}]
    source = ("단어 " * 43) + "Artificial Analysis" + (" 단어" * 40)

    chunks = plan_text_chunks(source, dictionary)

    assert sum("Artificial Analysis" in chunk["sourceText"] for chunk in chunks) == 1
    assert sum("아티피셜 어낼리시스" in chunk["ttsText"] for chunk in chunks) == 1


@pytest.mark.parametrize(("phrase", "reading"), [
    ("1 개가 있습니다", "한 개가 있습니다"),
    ("2 시간입니다", "두 시간입니다"),
    ("1 분의 2입니다", "일분의 이입니다"),
    ("12 KB입니다", "십이 킬로바이트입니다"),
    ("Qwen 3.5 7 B입니다", "큐웬삼점오 칠비입니다"),
])
def test_chunk_boundaries_preserve_whole_input_pronunciation(phrase: str, reading: str) -> None:
    # Without boundary protection, the ~220-character split landed between
    # "1" and "개", so the TTS and its ASR expectation both used "일 개".
    source = ("가 " * 109) + phrase + " " + ("나 " * 75)

    chunks = plan_text_chunks(source, [])
    combined_reading = " ".join(" ".join(chunk["ttsText"] for chunk in chunks).split())
    whole_reading = " ".join(apply_pronunciation(source, []).split())

    assert len(chunks) > 1
    assert sum(phrase in chunk["sourceText"] for chunk in chunks) == 1
    assert reading in combined_reading
    assert combined_reading == whole_reading


def test_short_tail_of_english_passage_keeps_english_voice_and_spelling() -> None:
    sentence = ("This explains the workflow and its purpose " * 20)[:214].rstrip(" .") + "."
    source = sentence + " Tool."
    dictionary = [{"from": "Tool", "to": "툴"}]

    chunks = plan_text_chunks(source, dictionary)

    assert chunks[-1]["sourceText"] == "Tool."
    assert chunks[-1]["ttsText"] == "Tool."
    assert chunks[-1]["unresolvedAscii"] == []
    assert " ".join(chunk["ttsText"] for chunk in chunks) == apply_pronunciation(source, dictionary)
    assert speech_segments(chunks[-1]["ttsText"], dictionary)[0]["language"] == "English"


def test_chunk_never_spans_a_paragraph_but_keeps_a_quoted_line_break() -> None:
    source = ("짧은 제목\n" + "첫 문단의 문장입니다. " * 3 + "\n" + "둘째 문단입니다.\n"
              + '인용은 "First line\nsecond line." 그대로 둡니다.')

    chunks = plan_text_chunks(source, [])

    assert [chunk["sourceText"] for chunk in chunks] == [
        "짧은 제목",
        "첫 문단의 문장입니다. 첫 문단의 문장입니다. 첫 문단의 문장입니다.",
        "둘째 문단입니다.",
        '인용은 "First line\nsecond line." 그대로 둡니다.',
    ]
    assert all(chunk["paragraphEnd"] for chunk in chunks)
    long_paragraph = plan_text_chunks("문장입니다. " * 60, [])
    assert len(long_paragraph) > 1
    assert [chunk["paragraphEnd"] for chunk in long_paragraph] == [False] * (len(long_paragraph) - 1) + [True]


def test_unbreakable_span_reports_input_error_instead_of_cutting_it() -> None:
    with pytest.raises(ValueError, match="경계"):
        plan_text_chunks("A" * 801, [])


def test_candidate_seed_is_stable_and_distinct_across_attempts_and_chunks() -> None:
    first = candidate_seed(42, 0, "읽을 말", 1)
    assert first == candidate_seed(42, 0, "읽을 말", 1)
    assert first != candidate_seed(42, 0, "읽을 말", 2)
    assert first != candidate_seed(42, 1, "읽을 말", 1)


@pytest.mark.parametrize("samples", [[], [0.0] * 1000, [float("nan")] * 1000,
                                      [float("inf")] * 1000])
def test_candidate_audio_rejects_empty_silent_or_nonfinite(samples: list[float]) -> None:
    with pytest.raises(CandidateAudioError):
        validate_candidate_audio({"sampleRate": 1000, "audio": samples})


def test_candidate_audio_accepts_valid_speech_signal() -> None:
    rate, audio = validate_candidate_audio({"sampleRate": 1000,
                                            "audio": np.full(1000, 0.08)})
    assert rate == 1000
    assert len(audio) == 1000


def test_chunk_take_retries_candidate_defect_and_content_failure() -> None:
    chunk = {"sourceText": "안녕하세요.", "ttsText": "안녕하세요."}
    generated = []

    def synthesize(_chunk: dict, attempt: int, seed: int) -> dict:
        generated.append((attempt, seed))
        if attempt == 1:
            raise CandidateAudioError("무음")
        return {"audioPath": f"take-{attempt}.wav", "durationMs": 1000}

    def review(_chunk: dict, candidate: dict) -> dict:
        return {"attempt": candidate["attempt"], "passed": candidate["attempt"] == 3,
                "failures": ["받아쓰기 불일치"] if candidate["attempt"] == 2 else [],
                "warnings": [], "score": 25.0 if candidate["attempt"] == 2 else 0.0}

    result = resolve_text_chunk_take(chunk, 0, 42, 4, synthesize, review)

    assert [item[0] for item in generated] == [1, 2, 3]
    assert result["selected"]["attempt"] == 3
    assert result["severity"] == "ok"
    assert result["attempts"][0]["status"] == "generation-failed"
    assert result["attempts"][1]["quality"]["passed"] is False
    assert result["attempts"][2]["quality"]["passed"] is True


def test_unreviewed_chunk_retries_only_audio_defect_without_claiming_quality() -> None:
    chunk = {"sourceText": "직접 적은 읽을 말", "ttsText": "직접 적은 읽을 말"}
    attempts = []

    def synthesize(_chunk: dict, attempt: int, _seed: int) -> dict:
        attempts.append(attempt)
        if attempt == 1:
            raise CandidateAudioError("빈 오디오")
        return {"audioPath": "take-2.wav"}

    result = resolve_text_chunk_take(chunk, 1, 99, 4, synthesize)

    assert attempts == [1, 2]
    assert result["selected"]["attempt"] == 2
    assert result["quality"] is None
    assert result["severity"] == "not-checked"


def test_full_text_candidate_assembles_real_sample_gaps_and_truthful_metadata(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch,
) -> None:
    # Exercise the command orchestration with deterministic fake generation;
    # no weights, ASR or audio normalizer are loaded by this test.
    mlx = ModuleType("mlx")
    mlx.__path__ = []
    core = ModuleType("mlx.core")
    core.random = SimpleNamespace(seed=lambda _seed: None)
    core.reset_peak_memory = lambda: None
    core.clear_cache = lambda: None
    monkeypatch.setitem(sys.modules, "mlx", mlx)
    monkeypatch.setitem(sys.modules, "mlx.core", core)
    mlx_audio = ModuleType("mlx_audio")
    mlx_audio.__path__ = []
    tts = ModuleType("mlx_audio.tts")
    tts.__path__ = []
    tts_utils = ModuleType("mlx_audio.tts.utils")
    tts_utils.load_model = lambda _path: SimpleNamespace(generate=lambda **_kwargs: None)
    audio_utils = ModuleType("mlx_audio.utils")
    audio_utils.get_model_path = lambda _repository: str(tmp_path)
    for name, module in (("mlx_audio", mlx_audio), ("mlx_audio.tts", tts),
                         ("mlx_audio.tts.utils", tts_utils), ("mlx_audio.utils", audio_utils)):
        monkeypatch.setitem(sys.modules, name, module)

    import local_tts_engine.text_candidate as target

    monkeypatch.setattr(target, "resolve_model_path", lambda _repository, _download: tmp_path)
    monkeypatch.setattr(target, "snapshot_revision", lambda _path: "test-revision")
    monkeypatch.setattr(target, "production_pronunciation", lambda: [])
    generated_texts = []
    failed_once = False

    def fake_generate(_generate, arguments: dict, **_kwargs) -> dict:
        nonlocal failed_once
        generated_texts.append(arguments["text"])
        if not failed_once:
            failed_once = True
            raise CourseCandidateAudioError("no-signal", "음성 후보에 충분한 음성 신호가 없습니다.")
        samples = np.full(1000, 0.08, dtype=np.float32)
        return {"sampleRate": 1000, "audio": samples, "cleanup": {
            "trimmedHeadMs": 0, "trimmedTailMs": 0,
            "shortenedSilenceCount": 0, "shortenedSilenceMs": 0,
        }, "generationMs": 1, "peakMemoryGb": 0.1}

    monkeypatch.setattr(target, "generate_candidate_audio", fake_generate)
    monkeypatch.setattr(target, "normalize_audio", lambda native, output: (
        shutil.copyfile(native, output), {"mode": "test"}
    )[1])
    monkeypatch.setattr(target, "probe_audio", lambda path: {
        "durationMs": round(sf.info(path).frames * 1000 / sf.info(path).samplerate),
    })
    text = tmp_path / "text.txt"
    text.write_text("안녕하세요. " * 50, encoding="utf-8")
    reference_text = tmp_path / "reference.txt"
    reference_text.write_text("참조 발화", encoding="utf-8")
    output = tmp_path / "voice.wav"

    metadata = generate_candidate(
        model_key="qwen3-tts", text_path=text, reference_path=tmp_path / "reference.wav",
        reference_text_path=reference_text, output_path=output,
        metadata_path=tmp_path / "voice.json", seed=42,
    )

    assert len(metadata["chunks"]) > 1
    assert len(generated_texts) == len(metadata["chunks"]) + 1
    assert generated_texts[0] == generated_texts[1]
    assert metadata["qualityReview"]["status"] == "not-checked"
    assert metadata["qualityReview"]["findings"] == []
    assert metadata["finalTrack"]["status"] == "ok"
    assert len(metadata["finalTrack"]["chunks"]) == len(metadata["chunks"])
    assert metadata["chunks"][0]["selectedAttempt"] == 2
    assert metadata["chunks"][0]["candidates"][0]["status"] == "generation-failed"
    assert all(chunk["selectedAttempt"] == 1 for chunk in metadata["chunks"][1:])
    assert all(chunk["quality"] is None for chunk in metadata["chunks"])
    # Korean sentence pause 420ms, of which each trimmed edge already keeps 65ms.
    assert metadata["chunks"][1]["startMs"] - metadata["chunks"][0]["endMs"] == 290
    assert metadata["durationMs"] == 1000 * len(metadata["chunks"]) + 290 * (len(metadata["chunks"]) - 1)

    text.write_text("First paragraph ends here.\nThe second one starts now.", encoding="utf-8")
    paragraphs = generate_candidate(
        model_key="qwen3-tts", text_path=text, reference_path=tmp_path / "reference.wav",
        reference_text_path=reference_text, output_path=tmp_path / "paragraphs.wav",
        metadata_path=tmp_path / "paragraphs.json", seed=42,
    )
    assert [chunk["sourceText"] for chunk in paragraphs["chunks"]] == [
        "First paragraph ends here.", "The second one starts now.",
    ]
    assert paragraphs["chunks"][1]["gapBeforeMs"] == 670
    assert paragraphs["chunks"][1]["startMs"] - paragraphs["chunks"][0]["endMs"] == 670
    assert paragraphs["cleanup"]["chunkGapMs"] == 370

    monkeypatch.setattr(target, "inspect_final_track", lambda *_args: {
        "status": "failed", "issues": [{"code": "missing-speech"}],
    })
    bad_metadata = tmp_path / "bad-voice.json"
    with pytest.raises(RuntimeError, match="무결성"):
        generate_candidate(
            model_key="qwen3-tts", text_path=text,
            reference_path=tmp_path / "reference.wav", reference_text_path=reference_text,
            output_path=tmp_path / "bad-voice.wav", metadata_path=bad_metadata, seed=42,
        )
    assert json.loads(bad_metadata.read_text(encoding="utf-8"))["finalTrack"]["status"] == "failed"


def test_independent_alignment_uses_only_the_prechecked_local_path(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch,
) -> None:
    mlx = ModuleType("mlx")
    mlx.__path__ = []
    core = ModuleType("mlx.core")
    core.clear_cache = lambda: None
    monkeypatch.setitem(sys.modules, "mlx", mlx)
    monkeypatch.setitem(sys.modules, "mlx.core", core)
    mlx_audio = ModuleType("mlx_audio")
    mlx_audio.__path__ = []
    stt = ModuleType("mlx_audio.stt")
    stt.__path__ = []
    stt_utils = ModuleType("mlx_audio.stt.utils")
    seen = []

    def load_model(path: Path) -> SimpleNamespace:
        seen.append(path)
        return SimpleNamespace(generate=lambda **_kwargs: SimpleNamespace(items=[
            SimpleNamespace(text="안녕", start_time=0.1, end_time=0.4),
        ]))

    stt_utils.load_model = load_model
    for name, module in (("mlx_audio", mlx_audio), ("mlx_audio.stt", stt),
                         ("mlx_audio.stt.utils", stt_utils)):
        monkeypatch.setitem(sys.modules, name, module)
    path = tmp_path / "installed-aligner"

    words = _read_local_independent_word_times(tmp_path / "voice.wav", "안녕", path)

    assert seen == [path]
    assert words == [{"text": "안녕", "startMs": 100, "endMs": 400}]


def test_text_voice_spends_takes_on_english_that_came_back_in_hangul() -> None:
    made: list[int] = []

    def synthesize(_chunk, attempt, seed):
        made.append(attempt)
        return {"audioPath": f"take-{attempt}.wav", "sampleRate": 24_000}

    def review(_chunk, candidate):
        heard = candidate["attempt"] == 2
        return {"attempt": candidate["attempt"], "passed": True, "failures": [], "warnings": [],
                "score": 1.0, "englishWordChecks": [{"word": "Liberty", "heard": heard, "ratio": 1.0 if heard else 0.5}]}

    take = resolve_text_chunk_take({"ttsText": "Liberty 서버"}, 0, 7, 4, synthesize, review)
    assert made == [1, 2]
    assert take["selected"]["attempt"] == 2
    assert take["severity"] == "ok"
