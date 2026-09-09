import json
from pathlib import Path
from types import SimpleNamespace

import numpy as np
import pytest
import soundfile as sf

from local_tts_engine.course_pilot import (
    CourseChunk, CourseEntry, generate_candidate_audio, resolve_chunk_take,
)
from local_tts_engine.transcript_coverage import clause_omissions, omission_recovery_parts, saved_omissions
from local_tts_engine.speech_quality import evaluate_candidate, better_evaluation

FIXTURE = json.loads((Path(__file__).parent / "fixtures/ch02-l04-omission.json").read_text())
FINDING = FIXTURE["finding"]
EXPECTED = FINDING["expectedText"]
MISSING = "다음 요청에서는 개발자 지시와 도구를"


def test_saved_four_takes_identify_the_missing_clause_not_the_first_repeated_word():
    for candidate in FIXTURE["candidates"]:
        checks = clause_omissions(EXPECTED, candidate["recognizedText"])
        assert len(checks) == 1
        check = checks[0]
        assert check["text"] == MISSING
        assert check["wordCount"] == 5
        assert EXPECTED[check["expectedStart"]:check["expectedEnd"]] == MISSING


def test_omission_is_a_content_failure_on_first_reading_but_a_complete_second_reading_can_clear_it(tmp_path):
    rate = 24000
    wave = .1 * np.sin(2 * np.pi * 220 * np.arange(30 * rate) / rate)
    path = tmp_path / "reading.wav"
    sf.write(path, wave, rate)
    partial = evaluate_candidate(expected_text=EXPECTED, recognized_text=FINDING["recognizedText"], audio_path=path)
    assert "받아쓰기에서 구절 누락" in partial["failures"]
    assert partial["contentChecks"][0]["text"] == MISSING
    assert partial["passed"] is False
    complete = evaluate_candidate(expected_text=EXPECTED, recognized_text=EXPECTED, audio_path=path)
    assert complete["passed"] is True
    assert better_evaluation(partial, complete)["passed"] is True


def test_separate_deleted_clauses_keep_nonoverlapping_source_offsets():
    expected = ("원문을 확인합니다. 다음 요청에서는 개발자 지시와 도구를 불러옵니다. 결과를 저장합니다. "
                "이후 작업에서는 새로운 지시와 도구를 불러옵니다. 여기서 마칩니다.")
    checks = clause_omissions(expected, "원문을 확인합니다. 결과를 저장합니다. 여기서 마칩니다.")
    assert len(checks) == 2
    assert checks[0]["expectedEnd"] < checks[1]["expectedStart"]
    assert all(expected[c["expectedStart"]:c["expectedEnd"]] == c["text"] for c in checks)


@pytest.mark.parametrize("expected,heard", [
    ("지시와 도구를 붙여 볼 수 있습니다.", "지시와 도구를 붙여볼 수 있습니다"),
    ("이번에는 마케터 지시와 도구를 불러옵니다.", "이번에는 마케터 지시와 도구를 불러옵니다"),
    ("다음 요청에서는 개발자 지시와 도구를 불러옵니다.", "다음 요청에서는 개발자 지시와 도구를 불러옵니다."),
    ("에이전트를 설명하고 일곱 챕터를 봅니다.", "에이전트를 설명하고 7챕터를 봅니다"),
    ("이번 요청에서는 개발자 지시와 도구를 불러옵니다.", "이번 요청에서는 기획자 지시와 도구를 불러옵니다."),
    ("Do my Bots share one computer?", "Do my Bots share computer?"),
    ("먼저 아주 새로운 방법을 보여 드리겠습니다.", "먼저 전혀 다른 예시를 보여 드리겠습니다."),
])
def test_spacing_numbers_single_words_and_substitutions_do_not_become_clause_omissions(expected, heard):
    assert clause_omissions(expected, heard) == []


def test_recovery_keeps_every_word_and_punctuation_and_separates_the_repeated_clauses():
    parts = omission_recovery_parts(EXPECTED, clause_omissions(EXPECTED, FINDING["recognizedText"]))
    assert " ".join(parts) == EXPECTED
    assert len(parts) == 4
    assert parts[1] == "이번 요청에서는 마케터 지시와 도구를,"
    assert parts[2] == f"{MISSING} 불러옵니다."
    assert omission_recovery_parts(EXPECTED, [{"expectedStart": 0, "expectedEnd": 5, "text": "다른 문장"}]) == []


def run_retry(*, limit=4, clean=None, same_omission=True):
    chunk = CourseChunk((CourseEntry("ch02", "defaults-org-now", 196, 1, EXPECTED, EXPECTED),))
    checks = clause_omissions(EXPECTED, FINDING["recognizedText"])
    calls = []

    def generate(chunk, attempt, parts=None):
        calls.append((attempt, parts))
        return {"attempt": attempt}

    def review(chunk, candidate):
        attempt = candidate["attempt"]
        passed = attempt == clean
        content = checks if same_omission or attempt == 1 else []
        return {"attempt": attempt, "passed": passed, "score": attempt,
                "recognizedText": EXPECTED if passed else FINDING["recognizedText"],
                "failures": [] if passed else ["받아쓰기에서 구절 누락"], "warnings": [],
                "contentChecks": [] if passed else content}

    return resolve_chunk_take(chunk, attempt_limit=limit, synthesize=generate,
                              synthesize_recovery=generate, review=review), calls


def test_two_repeated_omissions_change_the_next_attempt_and_clean_recovery_stops():
    result, calls = run_retry(clean=3)
    assert [attempt for attempt, _ in calls] == [1, 2, 3]
    assert calls[0][1] is None and calls[1][1] is None
    assert " ".join(calls[2][1]) == EXPECTED
    assert result["selected"]["attempt"] == 3
    assert result["severity"] == "ok"
    assert result["record"]["selected"]["recovery"]["parts"] == calls[2][1]


def test_failed_recovery_stays_failed_and_never_exceeds_the_four_candidate_budget():
    result, calls = run_retry()
    assert [attempt for attempt, _ in calls] == [1, 2, 3, 4]
    assert calls[2][1] and calls[3][1]
    assert result["severity"] == "failed"
    assert result["record"]["selected"]["passed"] is False


def test_single_candidate_edit_and_nonrepeated_faults_do_not_trigger_recovery():
    _, calls = run_retry(limit=1)
    assert calls == [(1, None)]
    _, calls = run_retry(same_omission=False)
    assert all(parts is None for _, parts in calls)
    _, calls = run_retry(clean=2)
    assert calls == [(1, None), (2, None)]


def test_saved_failed_page_starts_manual_candidate_with_recovery_only_for_identical_text():
    checks = saved_omissions(EXPECTED, [FINDING])
    assert checks[0]["text"] == MISSING
    assert saved_omissions(EXPECTED + " 대본이 달라졌습니다.", [FINDING]) == []
    assert saved_omissions(EXPECTED, [{**FINDING, "attempts": 1}]) == []
    assert saved_omissions(EXPECTED, [{**FINDING, "severity": "ok"}]) == []
    chunk = CourseChunk((CourseEntry("ch02", "defaults-org-now", 196, 1, EXPECTED, EXPECTED),))
    seen = []
    def recover(chunk, attempt, parts):
        seen.append(parts)
        return {"attempt": attempt}
    result = resolve_chunk_take(chunk, attempt_limit=1, initial_omissions=checks,
        synthesize=lambda *args: pytest.fail("Known repeated omission used the original input"),
        synthesize_recovery=recover,
        review=lambda *args: {"attempt":1,"passed":True,"score":0,"warnings":[],"failures":[]})
    assert len(seen) == 1
    assert " ".join(seen[0]) == EXPECTED
    assert result["severity"] == "ok"


def test_recovery_stays_active_if_omission_is_fixed_but_a_pronunciation_warning_remains():
    chunk = CourseChunk((CourseEntry("ch02", "defaults-org-now", 196, 1, EXPECTED, EXPECTED),))
    checks = clause_omissions(EXPECTED, FINDING["recognizedText"])
    seen = []
    def synth(chunk, attempt, parts=None):
        seen.append(parts)
        return {"attempt":attempt}
    def review(chunk, candidate):
        attempt=candidate["attempt"]
        return {"attempt":attempt,"passed":False,"score":attempt,"recognizedText":"음성 판독",
                "contentChecks":checks if attempt < 3 else [], "warnings":["발음 확인"], "failures":[]}
    resolve_chunk_take(chunk,attempt_limit=4,synthesize=synth,synthesize_recovery=synth,review=review)
    assert seen[2] and seen[3] == seen[2]


def test_recovery_joins_real_pcm_preserves_text_and_measures_piece_times():
    parts = omission_recovery_parts(EXPECTED, clause_omissions(EXPECTED, FINDING["recognizedText"]))
    seen = []
    rate = 24000

    def generate(**arguments):
        seen.append(arguments)
        wave = .1 * np.sin(2 * np.pi * (200 + len(seen) * 100) * np.arange(rate) / rate)
        yield SimpleNamespace(audio=wave, sample_rate=rate, peak_memory_usage=1.0)

    result = generate_candidate_audio(generate, {"text": EXPECTED, "temperature": .75}, parts)
    assert [a["text"] for a in seen] == parts
    assert all(a["temperature"] == .75 for a in seen)
    assert len(result["audio"]) == 4 * rate + 3 * round(.2 * rate)
    records = result["cleanup"]["recovery"]["parts"]
    assert [p["startMs"] for p in records] == [0, 1200, 2400, 3600]
    assert [p["durationMs"] for p in records] == [1000] * 4
    assert np.max(np.abs(result["audio"][rate:rate+4800])) == 0


def test_empty_or_mixed_rate_recovery_piece_is_not_silently_omitted():
    with pytest.raises(RuntimeError, match="오디오가 생성되지"):
        generate_candidate_audio(lambda **kw: iter(()), {"text": "문장을 읽습니다."})
    def mixed(**arguments):
        for rate in (24000, 48000):
            yield SimpleNamespace(audio=np.ones(100), sample_rate=rate, peak_memory_usage=0)
    with pytest.raises(RuntimeError, match="샘플레이트"):
        generate_candidate_audio(mixed, {"text": "문장을 읽습니다."})
    with pytest.raises(ValueError, match="원래 발음문"):
        generate_candidate_audio(mixed, {"text": EXPECTED}, ["요청을 누락했습니다."])
