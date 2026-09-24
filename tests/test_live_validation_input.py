"""The bounded live probe uses the configured deck, even after moving repos."""
import importlib.util
import json
from pathlib import Path

import pytest

SPEC = importlib.util.spec_from_file_location(
    "validate_prosody_live", Path(__file__).parents[1] / "scripts/validate_prosody_live.py"
)
live = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(live)


def test_live_probe_copies_dictionary_from_explicit_source_and_keeps_sample_text(tmp_path):
    source = tmp_path / "separate/course"
    dictionary = source / "deck/narration/pronunciation.ko.json"
    dictionary.parent.mkdir(parents=True)
    content = '[{"from":"API","to":"에이피아이"}]'
    dictionary.write_text(content)
    output = tmp_path / "results"
    text = 'API를 확인합니다. "Do my Bots share one computer?"'
    prepared = live.prepare_input(output, source, (("sample-01", text),))
    assert (prepared / "deck/narration/pronunciation.ko.json").read_text() == content
    assert (prepared / "deck/script/course/ch00.md").read_text() == f"## sample-01\n### 1\n{text}\n"
    assert dictionary.read_text() == content


@pytest.mark.parametrize("samples", [[], [{"name": "x", "text": "문장"}] * 17,
    [{"name": "../../escape", "text": "문장"}],
    [{"name": "x", "text": "문장"}, {"name": "x", "text": "다른 문장"}],
    [{"name": "x", "text": "문장\n## 다른 슬라이드"}],
])
def test_live_probe_rejects_unbounded_or_ambiguous_sample_input(tmp_path, samples):
    path = tmp_path / "samples.json"
    path.write_text(json.dumps(samples))
    with pytest.raises(ValueError):
        live.load_samples(path)


def test_course_recheck_does_not_require_the_unrelated_default_pause_probe():
    assert live.review_passed([{"passed": True}])
    assert not live.review_passed([])
    assert not live.review_passed([{"passed": False}])
    assert live.review_passed([{"passed": True}], {"status": "detected"})
    assert not live.review_passed([{"passed": True}], {"status": "not-detected"})


def test_saved_review_reads_fresh_english_evidence_and_preserves_the_original(tmp_path):
    import numpy as np
    import soundfile as sf
    path = tmp_path / "english.wav"
    rate = 24000
    sf.write(path, .1 * np.sin(2 * np.pi * 220 * np.arange(rate * 4) / rate), rate)
    original_bytes = path.read_bytes()
    text = "Do not use separate Bots."
    previous = {"audioPath": str(path), "expectedText": text, "recognizedText": text,
                "attempt": 2, "seed": 1}
    prepared = {"ttsText": text, "requiredPronunciations": []}
    routing = {"sampleRate": rate, "segments": [{"language": "English", "text": text,
        "startSample": 0, "endSample": rate * 4, "startMs": 0, "durationMs": 4000}]}
    seen = []
    def read(path, temperature, language):
        seen.append((temperature, language))
        return "Do use separate Bots."
    result = live.review_content(previous, prepared, routing, [], read)
    assert seen == [(0.0, "en"), (0.2, "en")]
    assert not result["passed"]
    assert result["englishChecks"][0]["wordEdits"][0]["expectedWord"] == "not"
    assert result["speakingCharactersPerSecond"] is None
    assert previous["recognizedText"] == text
    assert path.read_bytes() == original_bytes


def test_saved_review_refuses_changed_tts_input_before_reading_audio():
    previous = {"expectedText": "기존 발음문", "audioPath": "not-read.wav"}
    with pytest.raises(ValueError, match="합성 입력이 변경"):
        live.review_content(previous, {"ttsText": "새 발음문"}, None, [],
                            lambda *args: pytest.fail("Must not transcribe stale input"))


def test_saved_review_uses_quiet_windows_for_long_korean_audio(tmp_path):
    import numpy as np
    import soundfile as sf
    path = tmp_path / "long.wav"
    rate = 8000
    text = "문장을 읽습니다. " * 14
    sf.write(path, np.ones(rate * 35, dtype=np.float32) * .05, rate)
    seen = []
    def read(piece, temperature, language):
        info = sf.info(piece)
        assert info.duration <= 26
        assert language == "ko"
        seen.append(info.duration)
        return "문장을 읽습니다. " * 7
    result = live.review_content({"expectedText": text, "audioPath": str(path), "attempt": 1},
                                {"ttsText": text, "requiredPronunciations": []}, None, [], read)
    assert len(seen) == 2
    assert sum(seen) == 35
    assert result["passed"]


@pytest.fixture
def heard_acceptance(tmp_path):
    import hashlib
    audio = tmp_path / "voice.wav"
    audio.write_bytes(b"the original waveform")
    text = "계정 하나에 봇과 그룹 채팅이 있습니다."
    check = {"kind": "lexical", "term": "하나에", "status": "warning",
             "reason": "단어 일부 누락", "expectedCount": 1}
    evaluation = {"audioPath": str(audio), "expectedText": text,
        "recognizedText": text.replace("하나에", "하나의"), "attempt": 2,
        "passed": False, "warnings": [check["reason"]], "failures": [],
        "pronunciationChecks": [check], "contentChecks": [], "englishChecks": []}
    annotation = {"id": "heard-1", "disposition": "accepted-asr-variation", "scope": {
        "chunkKey": "sample-03", "attempt": 2, "expectedText": text,
        "audioSha256": hashlib.sha256(audio.read_bytes()).hexdigest()},
        "finding": {**check, "expectedStart": 3, "expectedEnd": 6},
        "expectedExcerpt": "계정 하나에 봇과", "recognizedExcerpt": "계정 하나의 봇과"}
    return evaluation, annotation


def test_listening_acceptance_unlocks_only_extra_prosody_and_keeps_automatic_judgment(heard_acceptance):
    import copy
    evaluation, annotation = heard_acceptance
    original = copy.deepcopy(evaluation)
    temporary, ids = live.listening_prosody_input(evaluation, "sample-03", [annotation], [])
    assert temporary["passed"] and not temporary["warnings"]
    assert ids == ["heard-1"]
    assert evaluation == original and evaluation["passed"] is False


@pytest.mark.parametrize("change", ["audio", "text", "attempt", "chunk", "heard"])
def test_listening_acceptance_cannot_leak_to_another_voice_or_reading(heard_acceptance, change):
    evaluation, annotation = heard_acceptance
    chunk = "sample-03"
    if change == "audio":
        Path(evaluation["audioPath"]).write_bytes(b"different waveform, same filename")
    elif change == "text":
        evaluation["expectedText"] += " 다른 문장입니다."
    elif change == "attempt":
        evaluation["attempt"] = 3
    elif change == "chunk":
        chunk = "sample-04"
    else:
        evaluation["recognizedText"] = "계정 하늘에 봇과 그룹 채팅이 있습니다."
    assert live.listening_prosody_input(evaluation, chunk, [annotation], []) == (None, [])


@pytest.mark.parametrize("change", ["other-term", "content", "english", "waveform", "unknown-warning", "clean"])
def test_an_accepted_word_does_not_clear_other_evidence(heard_acceptance, change):
    evaluation, annotation = heard_acceptance
    if change == "other-term":
        evaluation["pronunciationChecks"].append({**evaluation["pronunciationChecks"][0], "term": "봇이"})
    elif change == "content":
        evaluation["contentChecks"] = [{"status": "warning", "text": "다른 말"}]
    elif change == "english":
        evaluation["englishChecks"] = [{"passed": False}]
    elif change == "waveform":
        evaluation["failures"] = ["클리핑"]
    elif change == "unknown-warning":
        evaluation["warnings"].append("다른 경고")
    else:
        evaluation["passed"] = True
    assert live.listening_prosody_input(evaluation, "sample-03", [annotation], []) == (None, [])
