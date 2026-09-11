import pytest

from local_tts_engine.korean_naturalness import (
    APPROVED_COUNTER_READINGS,
    NATIVE_COUNTER_LIMITS,
    apply_korean_naturalness,
    korean_native_counter_integer,
    korean_naturalness_preflight,
)


@pytest.mark.parametrize(
    ("number", "reading"),
    [
        (1, "한"),
        (4, "네"),
        (10, "열"),
        (11, "열한"),
        (20, "스무"),
        (21, "스물한"),
        (34, "서른네"),
        (99, "아흔아홉"),
    ],
)
def test_native_counter_integer(number: int, reading: str) -> None:
    assert korean_native_counter_integer(number) == reading


@pytest.mark.parametrize("number", [0, 100])
def test_native_counter_integer_rejects_values_outside_its_policy(number: int) -> None:
    with pytest.raises(ValueError, match="범위"):
        korean_native_counter_integer(number)


def test_high_confidence_counters_use_native_korean_below_one_hundred() -> None:
    assert apply_korean_naturalness("도구 10개, 사람 4명, 세부 방법 3가지") == (
        "도구 열 개, 사람 네 명, 세부 방법 세 가지"
    )


def test_hundreds_stay_for_the_sino_korean_number_layer() -> None:
    assert apply_korean_naturalness("100개, 1000개") == "100개, 1000개"


def test_approved_fifty_counter_reading_is_preserved() -> None:
    report = korean_naturalness_preflight("같은 50개라도")

    assert report["text"] == "같은 오십 개라도"
    assert report["checks"][0]["rule"] == "approved-override"


def test_months_are_not_mistaken_for_the_object_counter() -> None:
    assert apply_korean_naturalness("6개월 뒤") == "6개월 뒤"


def test_digits_inside_an_identifier_are_not_treated_as_a_count() -> None:
    assert apply_korean_naturalness("v10개발판") == "v10개발판"


def test_context_dependent_counters_are_left_untouched() -> None:
    assert apply_korean_naturalness("1번, 1장, 1시간") == "1번, 1장, 한 시간"


def test_particles_and_suffixes_survive_the_rewrite() -> None:
    assert apply_korean_naturalness("10개일 때 20개짜리") == "열 개일 때 스무 개짜리"


def test_age_case_turn_and_clock_counters_use_native_korean() -> None:
    assert apply_korean_naturalness("3살, 40건, 2턴, 12시") == (
        "세 살, 마흔 건, 두 턴, 열두 시"
    )


def test_context_specific_multiplier_readings_do_not_change_larger_values() -> None:
    assert apply_korean_naturalness("1배, 2배, 3배, 4배, 15배") == (
        "한 배, 두 배, 세 배, 네 배, 15배"
    )


def test_missing_counter_spacing_is_repaired() -> None:
    report = korean_naturalness_preflight("인자 몇개짜리와 두어가지 예시")

    assert report["text"] == "인자 몇 개짜리와 두어 가지 예시"
    assert {item["rule"] for item in report["checks"]} == {"counter-spacing"}


def test_an_unmapped_letter_number_identifier_is_marked_for_later_review() -> None:
    report = korean_naturalness_preflight("주문 B-3099와 B3099를 조회합니다")

    assert report["warnings"] == [
        "B-3099: 발음 사전 미등록 — 제작 후 읽기 확인",
        "B3099: 발음 사전 미등록 — 제작 후 읽기 확인",
    ]


def test_structured_model_and_memory_tokens_are_left_for_pronunciation_rules() -> None:
    report = korean_naturalness_preflight("Qwen3.6-27B, 27B, 8GB")

    assert report["warnings"] == []


def test_every_supported_counter_value_is_resolved_and_idempotent() -> None:
    for counter, limit in NATIVE_COUNTER_LIMITS.items():
        for number in range(1, limit + 1):
            source = f"{number}{counter}"
            reading = apply_korean_naturalness(source)
            assert not any(character.isascii() and character.isdigit() for character in reading)
            assert apply_korean_naturalness(reading) == reading
            if (counter, number) not in APPROVED_COUNTER_READINGS:
                assert reading == f"{korean_native_counter_integer(number)} {counter}"
