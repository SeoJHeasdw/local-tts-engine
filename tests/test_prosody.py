"""Acoustic evidence, timing uncertainty, and the retry contract for pauses."""

from pathlib import Path
from types import SimpleNamespace

import numpy as np
import pytest
import soundfile as sf

from local_tts_engine.prosody import (
    BOUNDARY_WARNING, PAUSE_WARNING, boundary_pause_checks, boundary_targets, interior_silences,
    lead_term_readings, modifies_next, pause_checks,
)
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


# ─── 낱말 사이 끊김: 발음층이 만든 한 덩어리 안, 치환된 영어 용어 바로 앞 ───

TERM_TEXT = "놓치고 있는 에이아이 에이전트의 핵심."
TERM_DICTIONARY = [{"from": "AI", "to": "에이아이"}, {"from": "Agent", "to": "에이전트"},
                   {"from": "한 끗이", "to": "한 끄시"}]
TERM_READINGS = ["에이아이", "에이전트"]


def term_words(gap_ms: int = 300) -> list[dict]:
    # 있는 ends at 1.0 s; 에이아이 starts after the gap.
    start = 1000 + gap_ms
    return [word("놓치고", 0, 500), word("있는", 500, 1000), word("에이아이", start, start + 600),
            word("에이전트의", start + 600, start + 1300), word("핵심", start + 1300, start + 1700)]


def test_only_unpunctuated_boundaries_around_substituted_units_are_targets():
    assert lead_term_readings(TERM_DICTIONARY) == ["에이아이", "에이전트"]
    targets = boundary_targets("구십구 퍼센트가 " + TERM_TEXT, ["구십구 퍼센트", *TERM_READINGS],
                               lead_term_readings(TERM_DICTIONARY))
    assert [(t["boundary"], t["kind"], t["reading"]) for t in targets] == [
        (0, "inside-reading", "구십구 퍼센트"),
        (3, "before-term", "에이아이"),
        (4, "before-term", "에이전트"),
    ]
    # A speaker may pause at punctuation; a number reading has no lead-in rule.
    assert boundary_targets("그런데, 에이아이가 맡습니다", ["에이아이"], ["에이아이"]) == []
    assert boundary_targets("씁니다. 에이아이가 맡습니다", ["에이아이"], ["에이아이"]) == []
    assert [t["kind"] for t in boundary_targets("걸린 시간은 사 초.", ["사 초"])] == ["inside-reading"]
    # Without the dictionary nothing is known to be an English term.
    assert boundary_targets(TERM_TEXT, TERM_READINGS) == []


@pytest.mark.parametrize(("text", "expected"), [
    # A modifier or compound head leaves the term inside one noun phrase.
    ("고르던 에이전트", True), ("필요한 컨텍스트를", True), ("다른 에이전트끼리", True),
    ("같은 런의", True), ("붙인 엘엘엠", True), ("상담 에이전트에게", True), ("모델의 컨텍스트", True),
    ("이 에이전트는", True), ("판단하는 에이전트", True), ("에이전트라는 개념", True),
    # Where a Korean phrase may end, the pause is the speaker's.
    ("만들면 에이전틱", False), ("그런데 에이전트는", False), ("결국 에이전트는", False),
    ("경로는 워크플로로", False), ("결과를 엘엘엠에", False), ("있으므로 엘엘엠을", False),
    ("사람처럼 에이전트가", False), ("승인은 런타임이", False),
])
def test_only_a_term_inside_a_noun_phrase_has_its_lead_in_checked(text, expected):
    readings = ["에이전트", "에이전틱", "컨텍스트", "런", "엘엘엠", "워크플로", "런타임", "개념"]
    targets = boundary_targets(text, readings, readings)
    assert bool([t for t in targets if t["kind"] == "before-term"]) is expected


def test_modifier_forms_that_need_a_morphological_analyzer_stay_undecided():
    # -는 after an open syllable may be a topic particle (경로는) or a verb (가는).
    assert not modifies_next("가는") and not modifies_next("경로는")
    assert modifies_next("있는") and modifies_next("하는")
    # Digits and Latin letters are not judged.
    assert not modifies_next("2025년") and not modifies_next("RAG")


@pytest.mark.parametrize(("gap", "flagged"), [(300, True), (150, False)])
def test_a_pause_announcing_a_substituted_term_is_measured_on_the_waveform(tmp_path, gap, flagged):
    path = audio_with_pause(tmp_path / "term.wav", 1.0, 1.0 + gap / 1000, seconds=3.2)
    targets = boundary_targets(TERM_TEXT, TERM_READINGS, TERM_READINGS)
    checks = boundary_pause_checks(TERM_TEXT, term_words(gap), path, targets)["checks"]
    assert bool(checks) == flagged
    if flagged:
        assert checks[0]["term"] == "있는 에이아이"
        assert checks[0]["pauseDurationMs"] == gap
        assert checks[0]["reason"] == BOUNDARY_WARNING


@pytest.mark.parametrize(("gap", "flagged"), [(200, True), (100, False)])
def test_a_stop_closure_inside_a_number_reading_is_not_a_pause(tmp_path, gap, flagged):
    # 사 ends at 1.2 s; the 초 closure or pause follows.
    path = audio_with_pause(tmp_path / "count.wav", 1.2, 1.2 + gap / 1000, seconds=2.2)
    text = "걸린 시간은 사 초."
    words = [word("걸린", 0, 400), word("시간은", 400, 1000), word("사", 1000, 1200),
             word("초", 1200 + gap, 1800)]
    checks = boundary_pause_checks(text, words, path, boundary_targets(text, ["사 초"]))["checks"]
    assert bool(checks) == flagged
    if flagged:
        assert checks[0]["kind"] == "inside-reading" and checks[0]["term"] == "사 초"


def test_unusable_alignment_cannot_request_a_retry(tmp_path):
    path = audio_with_pause(tmp_path / "term.wav", 1.0, 1.3, seconds=3.2)
    targets = boundary_targets(TERM_TEXT, TERM_READINGS, TERM_READINGS)
    assert boundary_pause_checks(TERM_TEXT, [], path, targets)["status"] == "alignment-unavailable"
    mismatch = boundary_pause_checks(TERM_TEXT, term_words()[:-1], path, targets)
    assert mismatch["status"] == "alignment-mismatch" and not mismatch["checks"]
    overlapping = term_words()
    overlapping[2] = word("에이아이", 900, 1900)
    assert not boundary_pause_checks(TERM_TEXT, overlapping, path, targets)["checks"]


def test_a_boundary_pause_requests_another_seed_but_ranks_below_content_evidence(tmp_path):
    path = audio_with_pause(tmp_path / "term.wav", 1.0, 1.35, seconds=3.2)
    original = evaluate_candidate(expected_text=TERM_TEXT, recognized_text=TERM_TEXT, audio_path=path,
                                  required_pronunciations=TERM_READINGS)
    assert original["passed"]
    aligned = []
    reviewed = review_candidate_prosody(
        original, lambda path, temperature: [],
        lambda path, text: aligned.append(text) or term_words(350), dictionary=TERM_DICTIONARY,
    )
    assert aligned == [TERM_TEXT]
    assert reviewed["warnings"] == [BOUNDARY_WARNING] and not reviewed["passed"]
    assert reviewed["boundaryPauses"]["checks"][0]["pauseDurationMs"] == 350
    assert original["passed"]  # Content evidence is not mutated.
    clean = {**original, "attempt": 2, "score": original["score"] + 1}
    content = {**original, "attempt": 3, "passed": False, "warnings": ["지정 발음 확인 필요"]}
    assert choose_best_candidate([reviewed, clean])["attempt"] == 2
    assert choose_best_candidate([content, reviewed]) is reviewed
    # Every seed pausing there is still a rhythm warning, not a misreading.
    assert chunk_severity([reviewed, reviewed], reviewed) == "warning"


def test_a_take_without_boundary_targets_does_not_load_the_aligner(tmp_path):
    path = audio_with_pause(tmp_path / "plain.wav", 1.0, 1.35, seconds=3.2)
    text = "놓치고 있는 사람의 핵심."
    original = evaluate_candidate(expected_text=text, recognized_text=text, audio_path=path)
    def refuse(path, text):
        raise AssertionError("aligner loaded without a boundary to check")
    reviewed = review_candidate_prosody(original, lambda path, temperature: [], refuse, dictionary=TERM_DICTIONARY)
    assert reviewed["passed"]
    assert reviewed["boundaryPauses"]["status"] == "no-targets"


def test_a_take_with_only_a_content_warning_is_still_timed(tmp_path):
    # CH00 slide 10: every seed read 셋뿐 back as 3분, a warning on all four takes.
    # That reader artifact must not also blind the rhythm checks for the chunk.
    path = audio_with_pause(tmp_path / "term.wav", 1.0, 1.35, seconds=3.2)
    original = evaluate_candidate(expected_text=TERM_TEXT, recognized_text=TERM_TEXT, audio_path=path,
                                  required_pronunciations=TERM_READINGS)
    warned = {**original, "passed": False, "warnings": ["단어 일부 누락"]}
    reviewed = review_candidate_prosody(warned, lambda path, temperature: [],
                                        lambda path, text: term_words(350), dictionary=TERM_DICTIONARY)
    assert reviewed["warnings"] == ["단어 일부 누락", BOUNDARY_WARNING]
    assert reviewed["boundaryPauses"]["checks"][0]["term"] == "있는 에이아이"
    calm = {**warned, "attempt": 2}
    assert choose_best_candidate([reviewed, calm])["attempt"] == 2
