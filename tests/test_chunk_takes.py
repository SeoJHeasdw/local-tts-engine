"""What a page costs to generate, and when the machine stops trying.

The generator reads back every chunk but only pays for another seed where a
reading actually went wrong. These tests pin that bargain: a lecture where
everything reads correctly must not cost more than one take per chunk.
"""

import pytest

from local_tts_engine.course_pilot import CourseChunk, CourseEntry, resolve_chunk_take


def entry(text: str = "래그를 설명합니다", **overrides) -> CourseEntry:
    fields = {
        "chapter": "ch02",
        "slide_id": "rag-open",
        "slide_number": 148,
        "step": 1,
        "source_text": text,
        "tts_text": text,
    }
    fields.update(overrides)
    return CourseEntry(**fields)


def chunk(*entries: CourseEntry) -> CourseChunk:
    return CourseChunk(entries or (entry(),))


def take(attempt: int) -> dict:
    return {"attempt": attempt, "sampleRate": 24_000, "frames": 24_000}


def reader(verdicts: list[dict]):
    """A stand-in reviewer that hands back one prepared verdict per attempt."""
    calls: list[int] = []

    def review(_chunk, candidate):
        calls.append(int(candidate["attempt"]))
        verdict = dict(verdicts[len(calls) - 1])
        verdict.setdefault("failures", [])
        verdict.setdefault("warnings", [])
        verdict.setdefault("recognizedText", f"take-{candidate['attempt']}")
        verdict["attempt"] = candidate["attempt"]
        verdict["passed"] = not verdict["failures"] and not verdict["warnings"]
        verdict.setdefault("score", len(verdict["failures"]) * 25 + len(verdict["warnings"]) * 6)
        return verdict

    review.calls = calls
    return review


def synthesizer():
    made: list[int] = []

    def synthesize(_chunk, attempt):
        made.append(attempt)
        return take(attempt)

    synthesize.made = made
    return synthesize


def test_a_chunk_that_reads_correctly_costs_exactly_one_take() -> None:
    synthesize = synthesizer()
    review = reader([{}])
    result = resolve_chunk_take(chunk(), attempt_limit=4, synthesize=synthesize, review=review)

    assert synthesize.made == [1]
    assert review.calls == [1]
    assert result["severity"] == "ok"
    assert result["selected"]["attempt"] == 1


def test_a_bad_first_take_is_retried_and_the_good_one_wins() -> None:
    synthesize = synthesizer()
    review = reader([{"failures": ["받아쓰기 불일치"]}, {}])
    result = resolve_chunk_take(chunk(), attempt_limit=4, synthesize=synthesize, review=review)

    assert synthesize.made == [1, 2]
    assert result["selected"]["attempt"] == 2
    assert result["severity"] == "ok"
    assert result["record"]["selected"]["attempt"] == 2


def test_retries_stop_at_the_budget_and_the_least_bad_take_is_kept() -> None:
    synthesize = synthesizer()
    review = reader([
        {"failures": ["받아쓰기 불일치", "과도한 무음"], "score": 60},
        {"failures": ["받아쓰기 불일치"], "score": 30},
        {"failures": ["받아쓰기 불일치", "클리핑"], "score": 55},
    ])
    result = resolve_chunk_take(chunk(), attempt_limit=3, synthesize=synthesize, review=review)

    assert synthesize.made == [1, 2, 3]
    assert result["selected"]["attempt"] == 2
    assert result["severity"] == "failed"


def test_a_warning_reproduced_by_every_seed_becomes_work_for_a_person() -> None:
    review = reader([
        {"warnings": ["지정 발음 확인 필요"]},
        {"warnings": ["지정 발음 확인 필요"]},
    ])
    result = resolve_chunk_take(chunk(), attempt_limit=2, synthesize=synthesizer(), review=review)

    assert result["severity"] == "failed"
    assert result["record"]["selected"]["warnings"] == ["지정 발음 확인 필요"]


def test_a_warning_only_one_seed_produced_stays_a_suggestion_to_listen() -> None:
    review = reader([
        {"warnings": ["지정 발음 확인 필요"]},
        {"warnings": ["지나치게 느린 발화 아님"]},
    ])
    result = resolve_chunk_take(chunk(), attempt_limit=2, synthesize=synthesizer(), review=review)
    assert result["severity"] == "warning"


def test_turning_the_reader_off_generates_one_take_and_claims_nothing() -> None:
    synthesize = synthesizer()
    result = resolve_chunk_take(chunk(), attempt_limit=4, synthesize=synthesize, review=None)

    assert synthesize.made == [1]
    assert result["severity"] == "ok"
    assert result["record"]["selected"] == {"passed": True, "attempt": 1, "disabled": True}
    assert result["record"]["candidates"] == []


def test_the_record_carries_the_page_and_the_risky_tokens_behind_it() -> None:
    risky = entry(
        "Runtime을 봅니다",
        tts_text="런타임을 봅니다",
        unresolved_tokens=("UnknownSDK",),
    )
    result = resolve_chunk_take(
        chunk(risky), attempt_limit=1, synthesize=synthesizer(), review=reader([{}])
    )
    record = result["record"]
    assert record["slideNumber"] == 148
    assert record["chapter"] == "ch02"
    assert record["slideId"] == "rag-open"
    assert record["guarded"] is True
    assert record["unresolvedTokens"] == ["UnknownSDK"]


def test_a_chunk_whose_text_was_never_rewritten_is_not_marked_risky() -> None:
    result = resolve_chunk_take(
        chunk(), attempt_limit=1, synthesize=synthesizer(), review=reader([{}])
    )
    assert result["record"]["guarded"] is False


def test_generating_zero_takes_is_refused() -> None:
    with pytest.raises(ValueError):
        resolve_chunk_take(chunk(), attempt_limit=0, synthesize=synthesizer(), review=None)
