import pytest

from local_tts_engine.language_spans import english_runs, is_english_sentence


def spans(text: str) -> list[str]:
    return [text[start:end] for start, end in english_runs(text)]


def test_an_english_clause_inside_a_korean_sentence_is_one_span() -> None:
    text = ("We all know that consistent effort is key to success, "
            "하지만 때로는 충분한 rest와 relaxation도 그만큼 중요합니다.")

    assert spans(text) == ["We all know that consistent effort is key to success,"]


def test_a_sentence_between_korean_sentences_is_a_span_without_its_neighbours() -> None:
    text = "요즘은 digital transformation이 빠릅니다. Have a wonderful and productive day! 내일 봐요."

    assert spans(text) == ["Have a wonderful and productive day!"]


@pytest.mark.parametrize("text", [
    "Authentication과 Authorization, Attention Budget과 knowledge cutoff입니다.",  # terms, no grammar
    "RAG, LLM, API 같은 용어입니다.",                                              # acronym list
    "Continuous learning과 new skills 습득은 중요합니다.",                          # two words each
    "Docker Compose 를 씁니다.",                                                  # two words
])
def test_term_lists_and_short_phrases_are_not_prose(text: str) -> None:
    assert spans(text) == []


def test_an_english_word_glued_to_a_korean_ending_joins_the_run_before_it() -> None:
    assert spans("It is a great idea라고 생각합니다") == ["It is a great idea"]
    # A comma closes the clause: the next word starts the Korean side again.
    assert spans("We all know that effort is key to success, Today는 맑습니다") == [
        "We all know that effort is key to success,"]


def test_numbers_belong_to_the_korean_at_the_start_and_to_the_name_at_the_end() -> None:
    assert spans("2026 Have a wonderful day 년") == ["Have a wonderful day"]
    assert spans("Claude Code is Opus 5 모델입니다") == ["Claude Code is Opus 5"]


def test_protected_placeholders_end_a_run() -> None:
    protected = ""
    assert spans(f"We use {protected} every day to build things") == ["every day to build things"]


def test_english_sentence_rule_is_unchanged() -> None:
    assert is_english_sentence("It is a plain sentence")
    assert not is_english_sentence("Two words")
    assert not is_english_sentence("Mixed 문장 with words here")
