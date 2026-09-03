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
