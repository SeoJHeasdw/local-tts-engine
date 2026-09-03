from local_tts_engine.pronunciation import (
    apply_pronunciation,
    korean_sino_integer,
    merge_pronunciation_dictionaries,
    pronunciation_preflight,
)


def test_user_reported_terms_are_deterministic() -> None:
    dictionary = [
        {"from": "Runtime", "to": "런타임"},
        {"from": "Context", "to": "컨텍스트"},
        {"from": "RAG", "to": "래그"},
    ]
    source = "Runtime과 Context, RAG, 27B와 Qwen3.6-27B를 같은 50개라도 비교합니다."

    assert apply_pronunciation(source, dictionary) == (
        "런타임과 컨텍스트, 래그, 이십칠비와 큐웬삼점육 이십칠비를 같은 오십 개라도 비교합니다."
    )


def test_ascii_dictionary_rules_are_case_insensitive_and_token_aware() -> None:
    dictionary = [{"from": "Runtime", "to": "런타임"}]

    assert apply_pronunciation("runtime RuntimeError", dictionary) == "런타임 RuntimeError"


def test_later_dictionary_really_overrides_and_longer_term_wins() -> None:
    merged = merge_pronunciation_dictionaries(
        [
            {"from": "RAG", "to": "랙"},
            {"from": "Agent", "to": "에이전트"},
        ],
        [
            {"from": "RAG", "to": "래그"},
            {"from": "Multi-Agent", "to": "멀티 에이전트"},
        ],
    )

    assert apply_pronunciation("RAG와 Multi-Agent", merged) == "래그와 멀티 에이전트"


def test_korean_sino_integer_handles_course_scale_values() -> None:
    assert korean_sino_integer(0) == "영"
    assert korean_sino_integer(50) == "오십"
    assert korean_sino_integer(2026) == "이천이십육"
    assert korean_sino_integer(157_838) == "십오만칠천팔백삼십팔"


def test_standalone_decimal_has_no_spaces_around_point() -> None:
    assert apply_pronunciation("버전 3.6입니다.", []) == "버전 삼점육입니다."


def test_preflight_reports_only_tokens_left_after_normalization() -> None:
    report = pronunciation_preflight(
        "Runtime과 UnknownSDK, Qwen3.6-27B, 50개",
        [{"from": "Runtime", "to": "런타임"}],
    )

    assert report["ttsText"] == "런타임과 UnknownSDK, 큐웬삼점육 이십칠비, 오십 개"
    assert report["unresolvedAscii"] == ["UnknownSDK"]
    assert report["unresolvedNumbers"] == []


def test_production_dictionary_covers_every_term_the_user_reported() -> None:
    """The shipped dictionary is the contract, not just the code that reads it."""
    import json
    from pathlib import Path

    from local_tts_engine.course_pilot import LOCAL_PRONUNCIATION_PATH

    dictionary = json.loads(Path(LOCAL_PRONUNCIATION_PATH).read_text(encoding="utf-8"))
    rules = {item["from"]: item["to"] for item in dictionary}
    assert rules["Runtime"] == "런타임"
    assert rules["Context"] == "컨텍스트"
    assert rules["RAG"] == "래그"
    assert rules["IBM"] == "아이비엠"
    assert rules["Meta"] == "메타"

    reading = apply_pronunciation("IBM과 Meta는 Qwen3.6-27B를 씁니다.", dictionary)
    assert reading == "아이비엠과 메타는 큐웬삼점육 이십칠비를 씁니다."


def test_model_name_joins_the_version_and_keeps_one_space_before_the_size() -> None:
    # 큐웬↔삼점육 and 이십칠↔비 are joined; only version and size are separated.
    assert apply_pronunciation("Qwen3.6-27B", []) == "큐웬삼점육 이십칠비"
    assert apply_pronunciation("Qwen3-27B", []) == "큐웬삼 이십칠비"
    assert apply_pronunciation("Qwen 3.6 - 27 B", []) == "큐웬삼점육 이십칠비"


def test_counted_units_are_separated_from_their_number() -> None:
    assert apply_pronunciation("같은 50개라도", []) == "같은 오십 개라도"
    assert apply_pronunciation("3가지 방법", []) == "삼 가지 방법"
    assert apply_pronunciation("12페이지", []) == "십이 페이지"
    assert apply_pronunciation("8GB 메모리", []) == "팔 기가바이트 메모리"


def test_required_pronunciations_list_what_the_reader_must_be_heard_saying() -> None:
    report = pronunciation_preflight(
        "Runtime에서 Qwen3.6-27B로 50개를 처리합니다.",
        [{"from": "Runtime", "to": "런타임"}],
    )
    assert "런타임" in report["requiredPronunciations"]
    assert "큐웬삼점육 이십칠비" in report["requiredPronunciations"]
    assert "오십 개" in report["requiredPronunciations"]
