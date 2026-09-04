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


def test_a_specific_dictionary_entry_overrides_the_naturalness_policy() -> None:
    dictionary = [{"from": "10개", "to": "십 개"}]

    assert apply_pronunciation("10개를 읽습니다", dictionary) == "십 개를 읽습니다"


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
    assert rules["A-2041"] == "에이 이공사일"
    assert rules["K-2314"] == "케이 이삼일사"
    assert rules["GPT-4"] == "지피티 포"
    # 2026-09-04 청취 승인. 한국 시청자 기준 엔-팔-엔으로 읽는다.
    # "엔에잇엔"은 na세네·N.A.S.N·na-den으로 무너졌고, 그 오독이 발음 거리
    # 0.091 로 일치 관문(0.15) 아래여서 검수를 그대로 통과했다. 이 표기는
    # 같은 오독을 0.444 로 만들어 관문 안으로 들여놓는다.
    # ASR 이 M8N 으로 적기도 하지만 그래도 0.111 이라 통과한다. 사용자가 세
    # 표기를 모두 듣고 이 표기를 골랐고, 수치가 아니라 그 판단이 기준이다.
    assert rules["n8n"] == "엔팔엔"
    assert rules["4o"] == "포오"
    assert rules["L01"] == "엘 공일"
    assert rules["HTTP"] == "에이치티티피"
    assert rules["API"] == "에이피아이"

    reading = apply_pronunciation("IBM과 Meta는 Qwen3.6-27B를 씁니다.", dictionary)
    assert reading == "아이비엠과 메타는 큐웬삼점육 이십칠비를 씁니다."


def test_model_name_joins_the_version_and_keeps_one_space_before_the_size() -> None:
    # 큐웬↔삼점육 and 이십칠↔비 are joined; only version and size are separated.
    assert apply_pronunciation("Qwen3.6-27B", []) == "큐웬삼점육 이십칠비"
    assert apply_pronunciation("Qwen3-27B", []) == "큐웬삼 이십칠비"
    assert apply_pronunciation("Qwen 3.6 - 27 B", []) == "큐웬삼점육 이십칠비"


def test_counted_units_are_separated_from_their_number() -> None:
    assert apply_pronunciation("같은 50개라도", []) == "같은 오십 개라도"
    assert apply_pronunciation("3가지 방법", []) == "세 가지 방법"
    assert apply_pronunciation("12페이지", []) == "십이 페이지"
    assert apply_pronunciation("6개월", []) == "육 개월"
    assert apply_pronunciation("8GB 메모리", []) == "팔 기가바이트 메모리"
    assert apply_pronunciation("4토큰, 5점, 4회차", []) == "사 토큰, 오 점, 사 회차"
    assert apply_pronunciation("5.62초, 1.3배", []) == "오점육이 초, 일점삼 배"


def test_page_148_uses_a_natural_counter_reading_before_asr_review() -> None:
    source = "방금 본 10개, 100개, 1000개 그래프도 모델 하나를 고정해 놓고 그린 거예요."

    report = pronunciation_preflight(source, [])

    assert report["ttsText"] == (
        "방금 본 열 개, 백 개, 천 개 그래프도 모델 하나를 고정해 놓고 그린 거예요."
    )
    assert report["requiredPronunciations"] == ["열 개", "백 개", "천 개"]
    assert report["naturalnessChecks"] == [
        {
            "source": "10개",
            "reading": "열 개",
            "number": 10,
            "counter": "개",
            "rule": "native-counter-under-100",
        }
    ]


def test_required_pronunciations_list_what_the_reader_must_be_heard_saying() -> None:
    report = pronunciation_preflight(
        "Runtime에서 Qwen3.6-27B로 50개를 처리합니다.",
        [{"from": "Runtime", "to": "런타임"}],
    )
    assert "런타임" in report["requiredPronunciations"]
    assert "큐웬삼점육 이십칠비" in report["requiredPronunciations"]
    assert "오십 개" in report["requiredPronunciations"]


def test_a_number_left_as_digits_is_read_rather_than_guessed_at() -> None:
    """Digits that survive every other rule used to reach the model unread, and
    a model guessing at a number is what produced 호십개. Sino-Korean is the
    default reading in lecture narration."""
    assert apply_pronunciation("50이라는 숫자", []) == "오십이라는 숫자"
    assert apply_pronunciation("설명서까지 160토큰이라고 했죠", []) == "설명서까지 백육십 토큰이라고 했죠"
    assert apply_pronunciation("오십 개면 8천 토큰입니다", []) == "오십 개면 팔천 토큰입니다"
    assert apply_pronunciation("4천억 개의 숫자", []) == "사천억 개의 숫자"
    assert apply_pronunciation("40 대 1입니다", []) == "사십 대 일입니다"
    assert apply_pronunciation("1, 2, 3, 4.", []) == "일, 이, 삼, 사."


def test_digits_inside_a_name_are_left_for_the_dictionary() -> None:
    # A digit bounded by letters belongs to an identifier, not a count.
    assert apply_pronunciation("n8n과 Zapier", []) == "n8n과 Zapier"
    assert apply_pronunciation("GPT-4o 세대", []) == "GPT-4o 세대"
    # And a dictionary entry containing digits still wins, because it runs first.
    assert apply_pronunciation("GPT-4o 세대", [{"from": "GPT-4o", "to": "지피티 사오"}]) == "지피티 사오 세대"


def test_a_decimal_is_not_split_into_two_readings() -> None:
    assert apply_pronunciation("버전 3.6입니다", []) == "버전 삼점육입니다"
    assert apply_pronunciation("Llama 3.1 405B", []) == "Llama 삼점일 사백오비"


def test_a_sentence_final_period_does_not_hide_the_number() -> None:
    assert apply_pronunciation("계단처럼 4.", []) == "계단처럼 사."


def test_thousands_separators_are_read_as_one_number() -> None:
    assert apply_pronunciation("157,838자", []) == "십오만칠천팔백삼십팔자"


def test_every_number_a_reader_must_say_is_listed_for_the_reviewer() -> None:
    report = pronunciation_preflight("설명서까지 160토큰, 50이라는 숫자", [])
    assert report["ttsText"] == "설명서까지 백육십 토큰, 오십이라는 숫자"
    assert "백육십 토큰" in report["requiredPronunciations"]
    assert "오십" in report["requiredPronunciations"]
    assert report["unresolvedNumbers"] == []


def test_fractions_are_not_misread_as_minutes() -> None:
    report = pronunciation_preflight("Context가 3분의 1, 즉 5분의 1보다 큽니다", [])

    assert report["ttsText"] == "Context가 삼분의 일, 즉 오분의 일보다 큽니다"
    assert report["requiredPronunciations"] == ["삼분의 일", "오분의 일"]


def test_a_contextual_dictionary_rule_owns_the_number_inside_it() -> None:
    report = pronunciation_preflight(
        "서류를 100장 주면 3장 주는 것보다 어렵습니다",
        [{"from": "3장 주는", "to": "세 장 주는"}],
    )

    assert report["ttsText"] == "서류를 백 장 주면 세 장 주는 것보다 어렵습니다"
    assert report["requiredPronunciations"] == ["세 장 주는", "백 장"]


def test_ch02_risky_number_and_identifier_corpus_has_explicit_readings() -> None:
    import json
    from pathlib import Path

    from local_tts_engine.course_pilot import LOCAL_PRONUNCIATION_PATH

    dictionary = json.loads(Path(LOCAL_PRONUNCIATION_PATH).read_text(encoding="utf-8"))
    source = (
        "Context는 3분의 1이고, 3살짜리와 상담 40건을 봅니다. "
        "1턴, 2턴, 3턴째에 4토큰과 5.62초를 기록합니다. "
        "주문 A-2041, HTTP 200, API, GPT-4와 GPT-4o도 확인합니다."
    )

    report = pronunciation_preflight(source, dictionary)

    assert report["ttsText"] == (
        "컨텍스트는 삼분의 일이고, 세 살짜리와 상담 마흔 건을 봅니다. "
        "한 턴, 두 턴, 세 턴째에 사 토큰과 오점육이 초를 기록합니다. "
        "주문 에이 이공사일, 에이치티티피 이백, 에이피아이, "
        "지피티 포와 지피티 포오도 확인합니다."
    )
    assert report["naturalnessWarnings"] == []
    assert report["unresolvedNumbers"] == []


# ─── quoted English the lecture reads aloud on purpose ───────────────────────
# Page 186 quotes a product FAQ in English and the model reads it correctly
# (0.019 phonetic distance measured on the produced clip). The term dictionary
# must not reach inside those sentences: "Do my 봇츠 share one computer?" is
# neither language, and no reader or ASR can make sense of it.

LITERAL_DICTIONARY = [
    {"from": "Bot", "to": "봇"},
    {"from": "Bots", "to": "봇츠"},
    {"from": "Account", "to": "어카운트"},
    {
        "from": "Do my Bots share one computer?",
        "to": "Do my Bots share one computer?",
        "literal": True,
    },
]


def test_a_quoted_english_sentence_is_left_exactly_as_written() -> None:
    spoken = apply_pronunciation(
        '질문이 "Do my Bots share one computer?" 봇들이 컴퓨터를 공유하냐는 겁니다.',
        LITERAL_DICTIONARY,
    )
    assert '"Do my Bots share one computer?"' in spoken


def test_terms_outside_the_quote_are_still_read_in_korean() -> None:
    spoken = apply_pronunciation(
        'Bot 하나가 "Do my Bots share one computer?"를 묻습니다. Account도 봅니다.',
        LITERAL_DICTIONARY,
    )
    assert spoken.startswith("봇 하나가")
    assert "어카운트도" in spoken
    assert "Do my Bots share one computer?" in spoken


def test_a_number_inside_a_protected_span_is_not_read_as_korean() -> None:
    dictionary = [
        {"from": "Start with 3 bots.", "to": "Start with 3 bots.", "literal": True},
    ]
    assert apply_pronunciation("화면에는 Start with 3 bots. 라고 적혀 있습니다.", dictionary) == (
        "화면에는 Start with 3 bots. 라고 적혀 있습니다."
    )


def test_a_protected_span_is_reported_as_a_deliberate_reading() -> None:
    report = pronunciation_preflight(
        '"Do my Bots share one computer?" 라고 적혀 있습니다.',
        LITERAL_DICTIONARY,
    )
    assert {"from": "Do my Bots share one computer?", "to": "Do my Bots share one computer?"} in [
        {"from": match["from"], "to": match["to"]} for match in report["dictionaryMatches"]
    ]


def test_several_protected_spans_come_back_in_the_right_places() -> None:
    dictionary = [
        {"from": "first one", "to": "first one", "literal": True},
        {"from": "second one", "to": "second one", "literal": True},
        {"from": "one", "to": "원"},
    ]
    assert apply_pronunciation("앞은 first one, 뒤는 second one, 그리고 one.", dictionary) == (
        "앞은 first one, 뒤는 second one, 그리고 원."
    )


def test_a_deliberately_english_span_is_not_an_unresolved_term() -> None:
    # The gate that refuses to start a course reads unresolvedAscii. A sentence
    # the course decided to read in English is a decision already made.
    report = pronunciation_preflight(
        '질문이 "Do my Bots share one computer?" 봇들이 묻는 겁니다.',
        LITERAL_DICTIONARY,
    )
    assert report["unresolvedAscii"] == []


def test_a_term_nobody_decided_how_to_read_is_still_reported() -> None:
    report = pronunciation_preflight("Guardrail이 무엇인지 보겠습니다.", LITERAL_DICTIONARY)
    assert report["unresolvedAscii"] == ["Guardrail"]


# ─── a hyphen joining alphanumerics is inside a token, not a boundary ────────
# "B" was plucked out of the order number B-3099, which both mispronounced it
# and disarmed the guard that stops A-2041 from being read 에이 이천사십일.


def test_a_letter_is_not_taken_out_of_an_identifier() -> None:
    dictionary = [{"from": "B", "to": "비"}]
    assert apply_pronunciation("주문 B-3099를 조회합니다.", dictionary) == (
        "주문 B-3099를 조회합니다."
    )


def test_a_standalone_letter_is_still_read() -> None:
    dictionary = [{"from": "B", "to": "비"}]
    assert apply_pronunciation("워커 B는 환불 불가라고 합니다.", dictionary) == (
        "워커 비는 환불 불가라고 합니다."
    )


def test_a_term_is_not_taken_out_of_a_hyphenated_compound() -> None:
    # Leaving Sub-Agent whole keeps it visible as an unresolved term instead of
    # silently becoming "Sub-에이전트", which is neither language.
    dictionary = [{"from": "Agent", "to": "에이전트"}]
    assert apply_pronunciation("Sub-Agent를 봅니다.", dictionary) == "Sub-Agent를 봅니다."


def test_sentence_punctuation_is_not_a_joiner() -> None:
    dictionary = [{"from": "Agent", "to": "에이전트"}]
    assert apply_pronunciation("이것이 Agent. 다음으로.", dictionary) == "이것이 에이전트. 다음으로."


def test_an_entry_that_contains_a_hyphen_still_matches() -> None:
    dictionary = [{"from": "GPT-4", "to": "지피티 포"}]
    assert apply_pronunciation("GPT-4랑 비교합니다.", dictionary) == "지피티 포랑 비교합니다."


def test_a_number_hyphenated_to_a_letter_is_left_for_the_identifier_guard() -> None:
    # Reading only the number half turned B-3099 into "B-삼천구십구". The guard
    # in korean_naturalness stops the run on such a token; the pronunciation
    # layer must not quietly half-answer it first.
    assert apply_pronunciation("주문 B-3099를 조회합니다.", []) == "주문 B-3099를 조회합니다."


def test_a_plain_number_range_is_still_read() -> None:
    # Only a letter on the far side of the hyphen means "identifier". A range of
    # digits is a number, and §21 is explicit that a number left as digits is a
    # number the model gets to guess at.
    assert apply_pronunciation("2020-2024년 사이입니다.", []) == "이천이십-이천이십사 년 사이입니다."
