from pathlib import Path
from types import SimpleNamespace

import numpy as np
import pytest
import soundfile as sf

from local_tts_engine.course_pilot import (
    CourseChunk, CourseEntry, generate_candidate_audio, resolve_chunk_take,
)
from local_tts_engine.speech_quality import MAX_AUTOMATIC_ATTEMPTS
from local_tts_engine.english_voice import (
    EnglishVoiceRouter, english_reading_check, read_routed_transcript,
    routing_identity, speech_segments, without_lora,
)
from local_tts_engine.pronunciation import apply_pronunciation

QUOTE = "Do my Bots share one computer?"
DICTIONARY = [{"from": QUOTE, "to": QUOTE, "literal": True}, {"from": "Bots", "to": "봇츠"}]


def test_mixed_speech_preserves_text_and_routes_only_the_english_sentence():
    text = f'질문이 "{QUOTE}" 봇들이 컴퓨터를 공유하냐는 겁니다.'
    parts = speech_segments(text, DICTIONARY)
    assert [p["language"] for p in parts] == ["Korean", "English", "Korean"]
    assert "".join(p["text"].replace(" ", "") for p in parts) == text.replace(" ", "")
    assert parts[1]["text"] == f'"{QUOTE}"'
    assert routing_identity("에이전트와 도구입니다.", DICTIONARY) == {}
    assert routing_identity("API를 씁니다. Yes입니다.", DICTIONARY) == {}


@pytest.mark.parametrize("text", [
    '질문은 "Do these Bots share a computer?"입니다.',
    'Do these Bots share a computer?',
    '문장은 “Do these Bots share a computer?”입니다.',
])
def test_new_english_prose_is_protected_from_term_and_number_conversion(text):
    prepared = apply_pronunciation(text, DICTIONARY)
    assert "봇츠" not in prepared
    assert "Bots" in prepared
    assert any(p["language"] == "English" for p in speech_segments(prepared, DICTIONARY))


def test_nested_literal_protection_does_not_leave_placeholders():
    text = f'질문은 "{QUOTE}"이고 답은 다음입니다.'
    assert apply_pronunciation(text, DICTIONARY) == text
    assert apply_pronunciation("Bots", DICTIONARY) == "봇츠"
    assert apply_pronunciation("Agents-as-Tools", [{"from": "Agents-as-Tools", "to": "에이전츠 애즈 툴즈"}]) == "에이전츠 애즈 툴즈"


def test_english_disables_every_adapter_until_lazy_generation_finishes_and_restores_after_failure():
    layers = [SimpleNamespace(lora_a=1, lora_b=2, scale=.6), SimpleNamespace(lora_a=1, lora_b=2, scale=1.2)]
    model = SimpleNamespace(named_modules=lambda: [(str(i), layer) for i, layer in enumerate(layers)])
    router = EnglishVoiceRouter(DICTIONARY, model)
    arguments = {"text": QUOTE, "ref_audio": "reference.wav", "ref_text": "한국어 참조", "lang_code": "Korean"}
    def generate(**kwargs):
        assert all(layer.scale == 0 for layer in layers)
        assert kwargs["lang_code"] == "English"
        assert kwargs["ref_audio"] == "reference.wav"
        assert "ref_text" not in kwargs
        yield "first"
        assert all(layer.scale == 0 for layer in layers)
        raise RuntimeError("failed midway")
    with pytest.raises(RuntimeError, match="failed midway"):
        list(router.generate(generate, arguments, "English"))
    assert [layer.scale for layer in layers] == [.6, 1.2]
    assert arguments["ref_text"] == "한국어 참조"


def test_language_parts_use_measured_sample_offsets_and_recovery_can_coexist(tmp_path):
    calls = []
    def generate(**kwargs):
        calls.append(kwargs)
        # Distinct non-silent signals make order and preservation observable.
        audio = np.full(2400 + len(calls) * 240, .03 * len(calls), dtype=np.float32)
        yield SimpleNamespace(audio=audio, sample_rate=24000, peak_memory_usage=1.)
    text = f"설명입니다. {QUOTE} 이어집니다."
    result = generate_candidate_audio(generate, {"text": text, "lang_code": "Korean", "ref_audio": "ref", "ref_text": "참조"},
        parts=["설명입니다.", f"{QUOTE} 이어집니다."], voice_router=EnglishVoiceRouter(DICTIONARY))
    route = result["cleanup"]["voiceRouting"]
    segments = route["segments"]
    assert [c["lang_code"] for c in calls] == ["Korean", "English", "Korean"]
    assert segments[-1]["endSample"] == len(result["audio"])
    for previous, following in zip(segments, segments[1:]):
        assert following["startSample"] - previous["endSample"] == 2880
        assert np.all(result["audio"][previous["endSample"]:following["startSample"]] == 0)
    assert "recovery" in result["cleanup"]
    path = tmp_path / "mixed.wav"
    sf.write(path, result["audio"], 24000, subtype="FLOAT")
    read_calls = []
    def reader(file, temperature, language):
        index = len(read_calls)
        audio, rate = sf.read(file, dtype="float32")
        start, end = segments[index]["startSample"], segments[index]["endSample"]
        assert np.allclose(audio, result["audio"][start:end], atol=1 / 32768)
        read_calls.append(language)
        return segments[index]["text"]
    recognized, checks = read_routed_transcript(path, route, reader, 0.)
    assert recognized == f'설명입니다. "{QUOTE}" 이어집니다.'
    assert read_calls == ["ko", "en", "ko"]
    assert len(checks) == 1 and checks[0]["passed"]


def test_english_word_check_detects_short_omission_without_judging_accent():
    assert english_reading_check(QUOTE, "do my bots share one computer")['passed']
    assert not english_reading_check("Do not use separate Bots.", "Do use separate bots.")['passed']


def test_korean_only_keeps_the_original_single_call_and_metadata():
    args = {"text": "질문이 있습니다.", "lang_code": "Korean", "ref_text": "참조", "ref_audio": "ref"}
    calls = []
    def generate(**kwargs):
        calls.append(kwargs)
        yield SimpleNamespace(audio=np.ones(24000, dtype=np.float32) * .1, sample_rate=24000, peak_memory_usage=1.)
    result = generate_candidate_audio(generate, args, voice_router=EnglishVoiceRouter(DICTIONARY))
    assert calls == [args]
    assert "voiceRouting" not in result["cleanup"]


def test_english_letters_do_not_trigger_the_korean_speaking_rate_limit(tmp_path):
    from local_tts_engine.speech_quality import evaluate_candidate
    path = tmp_path / "english.wav"
    at = np.arange(48000 * 2, dtype=np.float32) / 48000
    sf.write(path, np.sin(2 * np.pi * 180 * at) * .1, 48000)
    result = evaluate_candidate(expected_text=QUOTE, recognized_text=QUOTE, audio_path=path,
        dictionary=DICTIONARY, speech_parts=[{"language":"English","text":QUOTE,"durationMs":2000}])
    assert result["passed"]
    assert result["speakingCharactersPerSecond"] is None
    assert result["englishSpeakingRates"][0]["wordsPerSecond"] == 3


def test_mixed_asr_english_remains_protected_when_punctuation_is_missing():
    from local_tts_engine.speech_quality import phonetic_error_rate
    expected = f'질문이 "{QUOTE}" 봇들이 공유합니다.'
    recognized = '질문이 "do my bots share one computer" 봇들이 공유합니다.'
    assert phonetic_error_rate(expected, recognized, DICTIONARY) == 0


def test_english_evidence_buys_the_same_four_seeds_korean_does():
    """영어도 한국어와 같은 재시도 구조를 쓴다.

    영어 구간의 낱말 불일치와 문장 안 영어 용어의 지정 발음 불일치는 둘 다
    후보를 통과시키지 않는다. 통과하지 못한 후보는 다음 시드를 사고, 네 번 모두
    같은 경고가 나오면 사람이 볼 일로 올라간다 — 한국어 오독과 같은 길이다.
    """
    made, seen = [], []

    def synthesize(_chunk, attempt):
        made.append(attempt)
        return {"attempt": attempt, "sampleRate": 24_000, "frames": 24_000}

    def review(_chunk, candidate):
        seen.append(candidate["attempt"])
        warnings = ["영어 구절 받아쓰기 확인 필요", "지정 발음 확인 필요"]
        return {"attempt": candidate["attempt"], "failures": [], "warnings": warnings,
                "recognizedText": f"take-{candidate['attempt']}", "passed": False, "score": 12}

    entry = CourseEntry(chapter="ch02", slide_id="anthropic", slide_number=194, step=1,
                        source_text="Anthropic은 남깁니다", tts_text="Anthropic은 남깁니다")
    result = resolve_chunk_take(CourseChunk((entry,)), attempt_limit=MAX_AUTOMATIC_ATTEMPTS,
                                synthesize=synthesize, review=review)
    assert made == seen == [1, 2, 3, 4]
    # 네 시드가 같은 말을 하면 디코더 잡음이 아니라 모델이 계속 그렇게 읽는 것이다.
    assert result["severity"] == "failed"


def test_one_good_english_seed_stops_the_retries():
    made = []

    def synthesize(_chunk, attempt):
        made.append(attempt)
        return {"attempt": attempt, "sampleRate": 24_000, "frames": 24_000}

    def review(_chunk, candidate):
        clean = candidate["attempt"] == 2
        return {"attempt": candidate["attempt"], "failures": [],
                "warnings": [] if clean else ["영어 구절 받아쓰기 확인 필요"],
                "recognizedText": "take", "passed": clean, "score": 0 if clean else 12}

    entry = CourseEntry(chapter="ch02", slide_id="quote", slide_number=195, step=1,
                        source_text='문장은 "Do my Bots share one computer?" 입니다',
                        tts_text='문장은 "Do my Bots share one computer?" 입니다')
    result = resolve_chunk_take(CourseChunk((entry,)), attempt_limit=MAX_AUTOMATIC_ATTEMPTS,
                                synthesize=synthesize, review=review)
    assert made == [1, 2] and result["severity"] == "ok"
