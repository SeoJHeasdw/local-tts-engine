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
    # Each switch pauses as long as the text between the segments calls for: a
    # Korean sentence end (290ms) and then an English sentence end (370ms).
    assert [following["startSample"] - previous["endSample"] for previous, following in zip(segments, segments[1:])] == [
        290 * 24, 370 * 24]
    for previous, following in zip(segments, segments[1:]):
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


@pytest.mark.parametrize(("expected", "recognized"), [
    ("We'll use a tool.", "Well, use a tool."),
    ("We're done.", "Were done."),
    ("I'll call the tool.", "Ill call the tool."),
    ("Do not use separate Bots.", "Do use separate bots."),
    (QUOTE, f"{QUOTE} 구독해주세요"),
    (QUOTE, ""),
])
def test_english_check_cannot_hide_contractions_negation_or_extra_korean(expected, recognized):
    check = english_reading_check(expected, recognized)
    assert not check['passed']
    assert check['editCount'] >= 1
    assert check['wordErrorRate'] > 0


def test_english_check_records_missing_repeated_and_replaced_words_in_order():
    missing = english_reading_check("Do not use separate Bots.", "Do use separate Bots.")
    assert missing['wordEdits'] == [{
        'kind': 'deletion', 'expectedWord': 'not', 'recognizedWord': '',
        'expectedWordIndex': 1, 'recognizedWordIndex': 1,
    }]
    repeated = english_reading_check(QUOTE, "Do my my bots share one computer?")
    assert repeated['editCount'] == 1
    assert repeated['wordEdits'][0]['kind'] == 'insertion'
    assert repeated['wordEdits'][0]['recognizedWord'] == 'my'
    replaced = english_reading_check(QUOTE, "Do my bots share two computers?")
    assert [(edit['expectedWord'], edit['recognizedWord']) for edit in replaced['wordEdits']] == [
        ('one', 'two'), ('computer', 'computers'),
    ]
    assert replaced['editCount'] == 2 and replaced['wordErrorRate'] == round(2 / 6, 6)


@pytest.mark.parametrize(("expected", "recognized"), [
    # Seen on every seed of a long English narration (2026-09-28).
    ("It runs on traditional WebSphere.", "It runs on traditional web sphere."),
    ("It has grown for more than ten years.", "It has grown for more than 10 years."),
    ("The first build fails with 3 errors.", "The first build fails with three errors."),
    ("This time, all 42 tests pass.", "This time, all forty-two tests pass."),
    ("It shipped in 2006.", "It shipped in twenty oh six."),
])
def test_english_check_records_spelling_only_differences_without_failing(expected, recognized):
    check = english_reading_check(expected, recognized)
    assert check['passed'] and check['editCount'] == 0
    assert check['spellingVariants']


@pytest.mark.parametrize(("expected", "recognized"), [
    ("All 42 tests pass.", "All 43 tests pass."),
    ("It fails with 3 errors.", "It fails with thirty errors."),
    ("We'll ship it.", "Well ship it."),
    ("It runs on WebSphere.", "It runs on web spear."),
])
def test_english_spelling_tolerance_keeps_real_word_errors(expected, recognized):
    check = english_reading_check(expected, recognized)
    assert not check['passed'] and check['editCount'] >= 1
    assert not check['spellingVariants']


@pytest.mark.parametrize(("expected", "recognized"), [
    ("The balance is -3 dollars.", "The balance is 3 dollars."),
    ("The balance is -3 dollars.", "The balance is plus three dollars."),
    ("The threshold is 50%.", "The threshold is fifty."),
    ("The threshold is 0.75.", "The threshold is zero point seven six."),
    ("The threshold is 0.75.", "The threshold is seventy five."),
])
def test_english_numeric_sign_unit_and_decimal_value_cannot_disappear(expected, recognized):
    check = english_reading_check(expected, recognized)
    assert not check["passed"] and check["editCount"] > 0


@pytest.mark.parametrize(("expected", "recognized"), [
    ("The balance is -3 dollars.", "The balance is minus three dollars."),
    ("The balance is −3 dollars.", "The balance is negative three dollars."),
    ("The threshold is 50%.", "The threshold is fifty percent."),
    ("The threshold is 50 %.", "The threshold is fifty per cent."),
    ("The threshold is 0.75.", "The threshold is zero point seven five."),
    ("The threshold is +0.75%.", "The threshold is plus zero point seven five percent."),
    ("The value is 1,234.5.", "The value is one thousand two hundred thirty four point five."),
])
def test_english_numeric_spelling_variants_keep_the_complete_spoken_meaning(expected, recognized):
    check = english_reading_check(expected, recognized)
    assert check["passed"] and check["editCount"] == 0
    assert check["spellingVariants"]


def test_complete_candidate_keeps_a_numeric_sign_loss_warning_despite_zero_korean_distance(tmp_path):
    from local_tts_engine.speech_quality import apply_english_checks, evaluate_candidate

    rate = 24_000
    audio = tmp_path / "english-number.wav"
    sf.write(audio, 0.1 * np.sin(2 * np.pi * 190 * np.arange(rate) / rate), rate, subtype="PCM_24")
    expected, recognized = "The balance is -3 dollars.", "The balance is 3 dollars."
    result = evaluate_candidate(expected_text=expected, recognized_text=recognized, audio_path=audio,
        speech_parts=[{"text": expected, "language": "English", "durationMs": 1000}])
    result = apply_english_checks(result, [english_reading_check(expected, recognized)])
    assert result["phoneticErrorRate"] == 0
    assert not result["passed"]
    assert "영어 구절 받아쓰기 확인 필요" in result["warnings"]


@pytest.mark.parametrize(("expected", "recognized", "passed"), [
    ("The threshold is .75.", "The threshold is 75.", False),
    ("The threshold is -.75.", "The threshold is .75.", False),
    ("The threshold is - .75.", "The threshold is .75.", False),
    ("The threshold is .75.", "The threshold is 0.75.", True),
    ("The threshold is -.75.", "The threshold is minus point seven five.", True),
    ("The threshold is - .75.", "The threshold is minus zero point seven five.", True),
    ("The threshold is .75 %.", "The threshold is zero point seven five percent.", True),
])
def test_leading_decimal_preserves_its_point_and_optional_separated_sign(expected, recognized, passed):
    check = english_reading_check(expected, recognized)
    assert check["passed"] is passed
    assert (check["editCount"] == 0) is passed


@pytest.mark.parametrize(("expected", "recognized", "passed"), [
    ("The threshold is 0.75.", "The threshold is zero point seven five.", True),
    ("The threshold is .75.", "The threshold is point seven five.", True),
    ("The threshold is -.75%.", "The threshold is minus point seven five percent.", True),
    ("The threshold is -.75%.", "The threshold is point seven five percent.", False),
    ("The threshold is 0.75.", "The threshold is zero point seven six.", False),
])
def test_whole_candidate_uses_english_numeric_evidence_without_changing_the_transcript(tmp_path, expected, recognized, passed):
    from local_tts_engine.speech_quality import apply_english_checks, evaluate_candidate

    rate = 24_000
    audio = tmp_path / "number.wav"
    sf.write(audio, 0.1 * np.sin(2 * np.pi * 190 * np.arange(rate) / rate), rate, subtype="PCM_24")
    result = evaluate_candidate(expected_text=expected, recognized_text=recognized, audio_path=audio,
        speech_parts=[{"language": "English", "text": expected, "durationMs": 1000}])
    result = apply_english_checks(result, [english_reading_check(expected, recognized)])
    assert result["passed"] is passed
    assert result["recognizedText"] == recognized
    if passed:
        assert result["phoneticErrorRate"] == 0
        assert result["comparisonRecognizedText"] == expected


def test_mixed_numeric_spelling_cannot_hide_a_korean_word_loss(tmp_path):
    from local_tts_engine.speech_quality import apply_english_checks, evaluate_candidate

    rate = 24_000
    audio = tmp_path / "mixed-number.wav"
    sf.write(audio, 0.1 * np.sin(2 * np.pi * 190 * np.arange(3 * rate) / rate), rate, subtype="PCM_24")
    english, heard = '"The threshold is 0.75."', '"The threshold is zero point seven five."'
    parts = [{"language": "Korean", "text": "기준입니다", "durationMs": 1000},
             {"language": "English", "text": english, "durationMs": 1000},
             {"language": "Korean", "text": "반드시 확인합니다", "durationMs": 1000}]
    expected = f"기준입니다 {english} 반드시 확인합니다"
    check = english_reading_check(english, heard)
    good = evaluate_candidate(expected_text=expected, recognized_text=f"기준입니다 {heard} 반드시 확인합니다",
        audio_path=audio, speech_parts=parts)
    assert apply_english_checks(good, [check])["passed"]
    bad = evaluate_candidate(expected_text=expected, recognized_text=f"기준입니다 {heard}",
        audio_path=audio, speech_parts=parts)
    assert not apply_english_checks(bad, [check])["passed"]
    assert "반드시 확인합니다" not in bad["comparisonRecognizedText"]


def test_english_check_normalizes_only_typography_and_preserves_evidence():
    check = english_reading_check('“We’ll use a tool.”', "WE'LL USE A TOOL!", startMs=120, durationMs=900)
    assert check['passed'] and check['editCount'] == 0
    assert check['expectedWords'] == check['recognizedWords'] == ["we'll", 'use', 'a', 'tool']
    assert check['recognizedText'] == "WE'LL USE A TOOL!"
    assert check['startMs'] == 120 and check['durationMs'] == 900
    assert not english_reading_check('...', '')['passed']


@pytest.mark.parametrize('text', [
    f'질문은 "{QUOTE}".',
    f'"{QUOTE}", "Should each bot use one?" 다음입니다.',
    f'질문은 "{QUOTE}" "Should each bot use one?"입니다.',
    f'("{QUOTE}")라고 묻습니다.',
])
def test_quote_punctuation_never_becomes_an_isolated_korean_generation(text):
    parts = speech_segments(text, DICTIONARY)
    assert len(parts) == 2 or len(parts) == 3
    assert all(any(char.isalnum() for char in part['text']) for part in parts)
    assert ''.join(''.join(part['text'].split()) for part in parts) == ''.join(text.split())
    assert sum(part['language'] == 'English' for part in parts) == 1


def test_english_quote_followed_by_punctuation_does_not_synthesize_a_phantom_syllable():
    calls = []

    def generate(**kwargs):
        calls.append((kwargs['text'], kwargs['lang_code']))
        yield SimpleNamespace(audio=np.full(2400, .05, dtype=np.float32), sample_rate=24000, peak_memory_usage=1.)

    text = f'질문은 "{QUOTE}".'
    result = generate_candidate_audio(generate, {'text': text, 'lang_code': 'Korean'},
                                      voice_router=EnglishVoiceRouter(DICTIONARY))
    assert calls == [('질문은', 'Korean'), (f'"{QUOTE}".', 'English')]
    assert len(result['cleanup']['voiceRouting']['segments']) == 2


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


CLAUSE = "We all know that consistent effort is key to success,"
MIXED = f"Today는 새로운 project를 시작합니다. {CLAUSE} 하지만 rest와 relaxation도 중요합니다."


def test_an_english_clause_in_korean_text_goes_to_the_english_voice_in_three_parts() -> None:
    from local_tts_engine.english_voice import speech_segments

    segments = speech_segments(MIXED, [])

    assert [segment["language"] for segment in segments] == ["Korean", "English", "Korean"]
    assert segments[1]["text"] == CLAUSE
    assert " ".join(segment["text"] for segment in segments).split() == MIXED.split()


def test_gaps_follow_what_the_text_puts_between_two_languages() -> None:
    from local_tts_engine.english_voice import language_gap_ms

    assert language_gap_ms("좋은 날입니다.", "Korean") == 290
    assert language_gap_ms("Have a nice day!", "English") == 370
    assert language_gap_ms('"Do my Bots share one computer?"', "English") == 370
    assert language_gap_ms("success,", "English") == 200
    assert language_gap_ms("새로운", "Korean") == 120


def test_identity_records_the_gaps_so_a_changed_policy_changes_the_clip() -> None:
    from local_tts_engine.english_voice import routing_identity

    identity = routing_identity(MIXED, [])

    assert identity["policy"] == "english-speaker-only-v2"
    assert identity["gaps"] == {"word": 120, "clause": 200, "sentence": {"English": 370, "Korean": 290}}
    assert [s["language"] for s in identity["segments"]] == ["Korean", "English", "Korean"]
    assert routing_identity("한국어 문장입니다.", []) == {}


def test_single_english_terms_inside_korean_stay_with_the_korean_voice() -> None:
    from local_tts_engine.english_voice import speech_segments

    assert speech_segments("새로운 project를 coffee 한 잔과 digital transformation이 좋습니다", []) == [
        {"text": "새로운 project를 coffee 한 잔과 digital transformation이 좋습니다", "language": "Korean"}]


def test_pronunciation_leaves_an_unquoted_english_clause_alone_but_reads_the_korean_around_it() -> None:
    article = [{"from": "A", "to": "에이"}]
    text = "계획을 세웁니다. Have a wonderful and productive day, 그리고 A 팀이 갑니다."

    reading = apply_pronunciation(text, article)

    assert "Have a wonderful and productive day," in reading
    assert "에이 팀" in reading


def test_a_registered_term_list_keeps_its_korean_reading() -> None:
    # No grammar words, so this is a list of terms and not English prose.
    dictionary = [{"from": "Authorization", "to": "어서라이제이션"}, {"from": "Attention Budget", "to": "어텐션 버짓"}]

    assert apply_pronunciation("Authentication과 Authorization, Attention Budget과 입니다.", dictionary) \
        == "Authentication과 어서라이제이션, 어텐션 버짓과 입니다."


def test_a_registered_term_that_is_a_whole_english_phrase_keeps_its_korean_reading() -> None:
    dictionary = [{"from": "Agent to Agent", "to": "에이전트 투 에이전트"}, {"from": "Guardrails", "to": "가드레일즈"}]

    assert apply_pronunciation("에이투에이는 Agent to Agent입니다.", dictionary) == "에이투에이는 에이전트 투 에이전트입니다."
    # An entry on one word inside a longer English phrase does not turn it into a term.
    assert apply_pronunciation("그 아래 Guardrails and approvals를 보세요.", dictionary) \
        == "그 아래 Guardrails and approvals를 보세요."
