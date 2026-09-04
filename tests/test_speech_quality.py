"""How a generated take is judged, and what each verdict is allowed to cost.

The rule these tests defend: a different spelling of the same sound is never a
mispronunciation, and only evidence that survives every reading is allowed to
send the user back to a page.
"""

from pathlib import Path

import numpy as np
import pytest
import soundfile as sf

from local_tts_engine.speech_quality import (
    ASR_WINDOW_SECONDS,
    MAX_AUTOMATIC_ATTEMPTS,
    MAX_PHONETIC_ERROR_RATE,
    asr_reading_windows,
    better_evaluation,
    character_error_rate,
    check_pronunciation,
    choose_best_candidate,
    chunk_severity,
    comparison_text,
    evaluate_candidate,
    lexical_pronunciation_checks,
    phonetic_error_rate,
    quality_summary,
)

DICTIONARY = [
    {"from": "RAG", "to": "래그"},
    {"from": "Runtime", "to": "런타임"},
    {"from": "Qwen", "to": "큐웬"},
    {"from": "똑같이", "to": "똑까치"},
]


def write_tone(path: Path, *, seconds: float = 2.0, sample_rate: int = 24_000) -> Path:
    at = np.arange(round(seconds * sample_rate), dtype=np.float32) / sample_rate
    audio = np.sin(2 * np.pi * 220 * at).astype(np.float32) * 0.1
    sf.write(path, audio, sample_rate)
    return path


@pytest.fixture
def clip_for(tmp_path: Path):
    """A stand-in clip long enough that the text reads at a natural pace.

    Waveform checks are exercised on their own; the transcript tests should not
    trip a pacing failure just because the fixture is short.
    """
    counter = 0

    def make(text: str) -> Path:
        nonlocal counter
        counter += 1
        return write_tone(
            tmp_path / f"voice-{counter}.wav",
            seconds=max(1.0, len(text) / 4.2),
        )

    return make


@pytest.fixture
def clip(clip_for) -> Path:
    return clip_for("여덟 자 남짓")


def test_comparison_text_normalizes_asr_spelling() -> None:
    dictionary = [{"from": "RAG", "to": "래그"}]
    assert comparison_text("RAG가 답합니다.", dictionary) == comparison_text(
        "래그가 답합니다", dictionary
    )


def test_character_error_rate_detects_substitution() -> None:
    assert character_error_rate("런타임", "런팀") == 2 / 3


def test_phonetic_error_rate_ignores_spelling_and_keeps_real_differences() -> None:
    assert phonetic_error_rate("래그를 씁니다", "RAG를 씁니다", DICTIONARY) == 0.0
    assert phonetic_error_rate("런타임을 씁니다", "런팀을 씁니다", DICTIONARY) > 0.05


# ─── the 148페이지 regression ────────────────────────────────────────────────
# Whisper heard the reading correctly and wrote it in its own orthography.
# Reporting that as a mispronunciation is what made the page fail.

CH02_EXPECTED = (
    "도구 오십 개를 양쪽에 똑까치 줬습니다. "
    "왼쪽은 로컬에서 돌리는 이십칠 비, 큐웬삼점육 이십칠비입니다. 오십 개를 주면"
)
CH02_RECOGNIZED = (
    "도구 50개를 양쪽에 똑같이 줬습니다 "
    "왼쪽은 로컬에서 돌리는 27B, QN 3.6 27B입니다 50개를 주면"
)


def test_a_transcript_that_spells_the_model_name_differently_still_passes(clip_for) -> None:
    evaluation = evaluate_candidate(
        expected_text=CH02_EXPECTED,
        recognized_text=CH02_RECOGNIZED,
        audio_path=clip_for(CH02_EXPECTED),
        dictionary=DICTIONARY,
        required_pronunciations=("큐웬삼점육 이십칠비", "이십칠 비", "오십 개", "똑까치"),
    )
    assert evaluation["passed"], evaluation["failures"] + evaluation["warnings"]
    assert evaluation["missingPronunciations"] == []


def test_a_short_chunk_with_an_unmapped_acronym_is_not_a_failure(clip_for) -> None:
    """The gate that can fail a page reads pronunciation, not spelling.

    Whisper writes `QN 3.6 27B` for a reading the dictionary spells
    `큐웬삼점육 이십칠비`. In a short chunk that is a sixth of the characters, so
    an orthographic gate failed the page even though the audio was correct.
    """
    expected = "Qwen3.6-27B를 씁니다."
    evaluation = evaluate_candidate(
        expected_text=expected,
        recognized_text="QN 3.6 27B를 씁니다.",
        audio_path=clip_for(expected),
        dictionary=DICTIONARY,
    )
    assert evaluation["characterErrorRate"] > MAX_PHONETIC_ERROR_RATE
    assert evaluation["phoneticErrorRate"] <= MAX_PHONETIC_ERROR_RATE
    assert evaluation["failures"] == []


def test_a_dropped_sentence_is_still_a_failure(clip_for) -> None:
    expected = "런타임은 환경을 뜻합니다. 여기서는 로컬 맥을 기준으로 설명하겠습니다. 그 다음은 배포입니다."
    evaluation = evaluate_candidate(
        expected_text=expected,
        recognized_text="런타임은 환경을 뜻합니다 그 다음은 배포입니다",
        audio_path=clip_for(expected),
        dictionary=DICTIONARY,
    )
    assert "받아쓰기 불일치" in evaluation["failures"]


def test_a_single_wrong_word_cannot_hide_inside_a_long_chunk(clip_for) -> None:
    expected = (
        "사용자와 자원과 위험 수준에 따라 행동의 바깥선을 그려야 합니다. "
        "그래야 자율성을 안전하게 운영할 수 있습니다. 이 문장은 통째로 한 레슨이 됩니다."
    )
    recognized = expected.replace("운영할", "운전할")

    evaluation = evaluate_candidate(
        expected_text=expected,
        recognized_text=recognized,
        audio_path=clip_for(expected),
    )

    assert evaluation["phoneticErrorRate"] < MAX_PHONETIC_ERROR_RATE
    assert "단어 발음 확인 필요" in evaluation["warnings"]
    assert evaluation["lexicalChecks"] == [
        {
            "term": "운영할",
            "distance": pytest.approx(1 / 3),
            "expectedCount": 1,
            "heardCount": 0,
            "status": "warning",
            "reason": "단어 발음 확인 필요",
            "kind": "lexical",
        }
    ]


def test_spacing_only_asr_variation_does_not_create_a_local_warning() -> None:
    assert lexical_pronunciation_checks(
        "여기서는 실행하면 안 됩니다",
        "여기서는 실행하면 안됩니다",
    ) == []


def test_a_locally_missing_word_is_named_even_when_the_sentence_is_long() -> None:
    expected = (
        "승인 패킷에는 행동과 대상 주문과 금액 그리고 예상 영향이 함께 들어갑니다. "
        "이 정보가 있어야 사람이 안전하게 판단할 수 있습니다."
    )
    recognized = expected.replace("예상 영향이 ", "")

    checks = lexical_pronunciation_checks(expected, recognized)

    assert any(check["term"] == "영향이" and check["status"] == "failed" for check in checks)


def test_an_empty_transcript_is_a_failure(clip_for) -> None:
    evaluation = evaluate_candidate(
        expected_text="런타임은 환경을 뜻합니다.",
        recognized_text="",
        audio_path=clip_for("런타임은 환경을 뜻합니다."),
        dictionary=DICTIONARY,
    )
    assert "받아쓰기 불일치" in evaluation["failures"]


def test_a_slide_bullet_written_two_ways_is_not_a_mispronunciation(clip_for) -> None:
    """`str.isdigit` answers yes to ① and ² but `int` refuses them, which used to
    end a run. Dropping them instead was no better: the script keeps the
    decorative form and the transcript writes the plain one, so on a short chunk
    the difference alone crossed the failure threshold."""
    expected = "① 데이터를 수집합니다"
    evaluation = evaluate_candidate(
        expected_text=expected,
        recognized_text="1 데이터를 수집합니다",
        audio_path=clip_for(expected),
        dictionary=DICTIONARY,
    )
    assert evaluation["phoneticErrorRate"] == 0.0
    assert evaluation["failures"] == []


def test_a_term_read_as_something_else_is_reported(clip_for) -> None:
    evaluation = evaluate_candidate(
        expected_text="래그는 검색으로 답을 만듭니다",
        recognized_text="알에이지는 검색으로 답을 만듭니다",
        audio_path=clip_for("래그는 검색으로 답을 만듭니다"),
        dictionary=DICTIONARY,
        required_pronunciations=("래그",),
    )
    assert "지정 발음 불일치" in evaluation["failures"]


LONG_EXPECTED = (
    "런타임은 모델이 실제로 도는 환경을 뜻합니다. "
    "여기서는 로컬 맥에서 도는 경우를 기준으로 설명하겠습니다."
)


def test_a_slightly_clipped_term_is_a_warning_not_a_failure(clip_for) -> None:
    evaluation = evaluate_candidate(
        expected_text=LONG_EXPECTED,
        recognized_text=LONG_EXPECTED.replace("런타임", "런팀"),
        audio_path=clip_for(LONG_EXPECTED),
        dictionary=DICTIONARY,
        required_pronunciations=("런타임",),
    )
    assert evaluation["warnings"] == ["지정 발음 확인 필요"]
    assert evaluation["failures"] == []
    # A warning still stops the generator from settling on this take.
    assert not evaluation["passed"]


def test_a_term_said_twice_but_read_once_is_flagged(clip_for) -> None:
    expected = "도구 오십 개를 주고 다시 오십 개를 줍니다"
    evaluation = evaluate_candidate(
        expected_text=expected,
        recognized_text="도구 50개를 주고 다시 줍니다",
        audio_path=clip_for(expected),
        dictionary=DICTIONARY,
        required_pronunciations=("오십 개",),
    )
    assert "지정 발음 일부 누락" in evaluation["warnings"]


def test_check_pronunciation_reports_the_measurement_behind_its_verdict() -> None:
    check = check_pronunciation("래그", "래그를 씁니다", "RAG를 씁니다", DICTIONARY)
    assert check == {
        "term": "래그",
        "distance": 0.0,
        "expectedCount": 1,
        "heardCount": 1,
        "status": "ok",
    }


# ─── acoustic failures ───────────────────────────────────────────────────────

def test_silence_and_clipping_are_failures(tmp_path: Path) -> None:
    silent = tmp_path / "silent.wav"
    sf.write(silent, np.zeros(24_000, dtype=np.float32), 24_000)
    evaluation = evaluate_candidate(
        expected_text="아무 말이나 합니다",
        recognized_text="아무 말이나 합니다",
        audio_path=silent,
    )
    assert "음성 신호 부족" in evaluation["failures"]

    clipped = tmp_path / "clipped.wav"
    sf.write(clipped, np.ones(24_000, dtype=np.float32), 24_000)
    evaluation = evaluate_candidate(
        expected_text="아무 말이나 합니다",
        recognized_text="아무 말이나 합니다",
        audio_path=clipped,
    )
    assert "클리핑" in evaluation["failures"]


def test_an_unreadably_fast_take_is_a_failure(tmp_path: Path) -> None:
    short = write_tone(tmp_path / "short.wav", seconds=0.5)
    evaluation = evaluate_candidate(
        expected_text="여기에는 아주 긴 문장이 들어 있어서 반 초 만에 읽을 수 없습니다 정말입니다",
        recognized_text="여기에는 아주 긴 문장이 들어 있어서 반 초 만에 읽을 수 없습니다 정말입니다",
        audio_path=short,
    )
    assert "지나치게 빠른 발화" in evaluation["failures"]


# ─── choosing between takes ──────────────────────────────────────────────────

def test_a_clean_take_beats_a_warned_take_which_beats_a_failed_take(clip_for) -> None:
    expected = "런타임과 래그를 함께 봅니다. 둘은 서로 다른 층에 있는 개념입니다."
    audio = clip_for(expected)

    def take(recognized: str, attempt: int) -> dict:
        return evaluate_candidate(
            expected_text=expected,
            recognized_text=recognized,
            audio_path=audio,
            dictionary=DICTIONARY,
            required_pronunciations=("런타임", "래그"),
            attempt=attempt,
        )

    failed = take(expected.replace("래그", "알에이지"), 1)
    warned = take(expected.replace("런타임", "런팀"), 2)
    clean = take(expected.replace("래그", "RAG"), 3)
    assert choose_best_candidate([failed, warned, clean]) is clean
    assert choose_best_candidate([failed, warned]) is warned
    assert better_evaluation(failed, warned) is warned


def test_choosing_from_nothing_is_an_error() -> None:
    with pytest.raises(ValueError):
        choose_best_candidate([])


def test_a_warning_every_seed_reproduced_becomes_work_for_a_person() -> None:
    warned = {"warnings": ["지정 발음 확인 필요"], "failures": [], "recognizedText": "런팀"}
    other = {"warnings": ["지정 발음 확인 필요"], "failures": [], "recognizedText": "런팀"}
    assert chunk_severity([warned, other], warned) == "failed"


def test_a_warning_that_came_and_went_stays_a_warning() -> None:
    warned = {"warnings": ["지정 발음 확인 필요"], "failures": [], "recognizedText": "런팀"}
    clean = {"warnings": [], "failures": [], "recognizedText": "런타임"}
    assert chunk_severity([warned, clean], warned) == "warning"
    assert chunk_severity([warned, clean], clean) == "ok"


def test_a_single_warned_attempt_is_not_yet_evidence_of_a_pattern() -> None:
    warned = {"warnings": ["지정 발음 확인 필요"], "failures": [], "recognizedText": "런팀"}
    assert chunk_severity([warned], warned) == "warning"


def test_a_failure_is_a_failure_however_many_seeds_were_tried() -> None:
    failed = {"warnings": [], "failures": ["받아쓰기 불일치"], "recognizedText": "x"}
    assert chunk_severity([failed], failed) == "failed"


# ─── the run summary ─────────────────────────────────────────────────────────

def slide(number: int, severity: str, candidates: int = 1) -> dict:
    return {
        "chapter": "ch02",
        "slideId": f"slide-{number}",
        "slideNumber": number,
        "severity": severity,
        "candidates": [{}] * candidates,
        "selected": {"passed": severity == "ok"},
    }


def test_summary_separates_regeneration_from_a_listening_suggestion() -> None:
    summary = quality_summary([
        slide(10, "ok"),
        slide(11, "warning", candidates=2),
        slide(12, "failed", candidates=4),
    ])
    assert not summary["ok"]
    assert not summary["clean"]
    assert summary["passedChunks"] == 1
    assert summary["warnedChunks"] == 1
    assert summary["retriedChunks"] == 2
    assert summary["needsReview"] == [{"chapter": "ch02", "slideId": "slide-12", "slideNumber": 12}]
    assert summary["listenSuggested"] == [{"chapter": "ch02", "slideId": "slide-11", "slideNumber": 11}]


def test_a_run_with_only_listening_suggestions_is_still_a_successful_run() -> None:
    summary = quality_summary([slide(10, "ok"), slide(11, "warning")])
    assert summary["ok"]
    assert not summary["clean"]
    assert summary["needsReview"] == []


def test_summary_reads_older_records_that_only_knew_pass_and_fail() -> None:
    summary = quality_summary([
        {"chapter": "ch02", "slideId": "old", "slideNumber": 9, "selected": {"passed": False}, "candidates": []},
    ])
    assert summary["needsReview"] == [{"chapter": "ch02", "slideId": "old", "slideNumber": 9}]


def test_the_attempt_budget_is_shared_with_the_app() -> None:
    # electron-app/main.mjs mirrors this value; a change here needs a change there.
    assert MAX_AUTOMATIC_ATTEMPTS == 4


# ─── the 304페이지 regression: one ASR window per reading ────────────────────
# A 31-second take of page 304 lost "에이전트 수가 아니라 평가로 확인된" on all
# four seeds. Read in two pieces the same audio contained it every time, so the
# clip was correct and the reading was not. Because every seed dropped the same
# clause, chunk_severity promoted the warning to a failed page — the exact
# shape of a real misreading. Keeping each reading inside one window is what
# separates the two.


def speech_with_gaps(
    pattern: list[tuple[float, bool]],
    sample_rate: int = 24_000,
) -> np.ndarray:
    """Build audio from (seconds, is_speech) pairs so cut points are known."""
    pieces = []
    for seconds, speaking in pattern:
        length = round(seconds * sample_rate)
        if speaking:
            at = np.arange(length, dtype=np.float32) / sample_rate
            pieces.append(np.sin(2 * np.pi * 220 * at).astype(np.float32) * 0.2)
        else:
            pieces.append(np.zeros(length, dtype=np.float32))
    return np.concatenate(pieces)


def test_a_clip_that_fits_the_window_is_still_read_in_one_piece() -> None:
    audio = speech_with_gaps([(20.0, True)])
    assert asr_reading_windows(audio, 24_000) == [(0, len(audio))]


def test_a_clip_just_over_the_window_is_split() -> None:
    audio = speech_with_gaps([(14.0, True), (0.6, False), (14.0, True)])
    windows = asr_reading_windows(audio, 24_000)
    assert len(windows) == 2


def test_no_window_is_ever_longer_than_the_asr_can_read() -> None:
    audio = speech_with_gaps([(20.0, True), (0.5, False)] * 5)
    for begin, end in asr_reading_windows(audio, 24_000):
        assert (end - begin) / 24_000 <= ASR_WINDOW_SECONDS


def test_windows_cover_the_clip_exactly_once() -> None:
    audio = speech_with_gaps([(15.0, True), (0.4, False)] * 4)
    windows = asr_reading_windows(audio, 24_000)
    assert windows[0][0] == 0
    assert windows[-1][1] == len(audio)
    assert all(left[1] == right[0] for left, right in zip(windows, windows[1:]))


def test_a_cut_lands_in_the_silence_between_sentences() -> None:
    # Speech, a clear pause at 18s, then more speech. The cut belongs in the
    # pause, not mid-word at the 24-second limit.
    audio = speech_with_gaps([(18.0, True), (1.0, False), (14.0, True)])
    windows = asr_reading_windows(audio, 24_000)
    cut_seconds = windows[0][1] / 24_000
    assert 18.0 <= cut_seconds <= 19.0


def test_unbroken_speech_is_still_cut_before_the_window_closes() -> None:
    # No silence to aim for. A seam mid-word costs one word; overrunning the
    # window can cost a whole clause, so the cut still happens.
    audio = speech_with_gaps([(40.0, True)])
    windows = asr_reading_windows(audio, 24_000)
    assert len(windows) > 1
    for begin, end in windows:
        assert (end - begin) / 24_000 <= ASR_WINDOW_SECONDS


def test_splitting_never_loops_on_silence_at_the_start_of_the_search() -> None:
    audio = speech_with_gaps([(15.0, True), (10.0, False), (15.0, True), (10.0, False)])
    windows = asr_reading_windows(audio, 24_000)
    assert all(end > begin for begin, end in windows)
    assert windows[-1][1] == len(audio)


def test_an_empty_clip_asks_for_one_reading() -> None:
    assert asr_reading_windows(np.zeros(0, dtype=np.float32), 24_000) == [(0, 0)]


# ─── a long required pronunciation must not blind the lexical gate ───────────
# Adding compound terms to the dictionary (에이전트 런타임, 컨텍스트 윈도우)
# made those readings long enough to absorb a lost syllable under the match
# gate, while simultaneously excluding their component words from the lexical
# gate that could still see it. The entry meant to protect a term was removing
# its only remaining check.

COMPOUND_DICTIONARY = [
    {"from": "Agent Runtime", "to": "에이전트 런타임"},
    {"from": "Guardrail", "to": "가드레일"},
]


def test_a_syllable_lost_inside_a_compound_term_is_still_reported() -> None:
    expected = "범용 에이전트 런타임에 필요한 능력을 붙입니다. 그 위에 지시를 얹습니다."
    recognized = "범용 에이전트 런임에 필요한 능력을 붙입니다. 그 위에 지시를 얹습니다."
    # The compound itself is too long to notice: 17 jamo losing one syllable.
    assert check_pronunciation(
        "에이전트 런타임", expected, recognized, COMPOUND_DICTIONARY
    )["status"] == "ok"
    # The lexical gate reads the component word and does notice.
    reported = lexical_pronunciation_checks(
        expected, recognized, COMPOUND_DICTIONARY, ("에이전트 런타임",)
    )
    assert any(check["term"].startswith("런타임") for check in reported)


def test_a_single_word_term_still_suppresses_its_duplicate_lexical_check() -> None:
    # 가드레일 is one word, so both checks would look at exactly the same thing
    # and report it twice. That exclusion is the one worth keeping.
    expected = "그래서 대화도 가드레일도 최종 답변도 중앙에 남습니다."
    recognized = "그래서 대화도 과드레일도 최종 답변도 중앙에 남습니다."
    reported = lexical_pronunciation_checks(
        expected, recognized, COMPOUND_DICTIONARY, ("가드레일",)
    )
    assert not any(check["term"].startswith("가드레일") for check in reported)
