import pytest

from local_tts_engine.short_word_review import short_word_review_candidates


@pytest.mark.parametrize("heard", ["한 보이", "한보이", "한 부위"])
def test_short_coda_loss_is_localized_between_matching_context(heard: str) -> None:
    source = "가장 작게 시작하고, 한 봇이 처음부터 끝까지 결과를 맡습니다."
    heard = source.replace("한 봇이", heard)
    [check] = short_word_review_candidates(source, heard)
    assert check["text"] == "봇이"
    assert check["heardText"] in {"보이", "부위"}
    assert source[check["expectedStart"]:check["expectedEnd"]] == "봇이"
    assert check["status"] == "warning"
    assert check["automaticFailure"] is False
    assert check["activation"] == "research-only"


def test_generic_short_word_substitution_has_no_term_specific_rule() -> None:
    [check] = short_word_review_candidates(
        "우선 하나의 모델 속도를 확인하고 다음으로 갑니다.",
        "우선 하나의 모드 속도를 확인하고 다음으로 갑니다.",
    )
    assert (check["text"], check["heardText"]) == ("모델", "모드")


@pytest.mark.parametrize(("source", "heard"), [
    ("봇이", "보시"), ("봇을", "보슬"), ("같이", "가치"),
    ("밭에", "바테"), ("굳이", "구지"), ("좋아", "조아"),
    ("봇이", "봇의"), ("모델", "모댈"), ("내가", "네가"),
    ("한개", "일개"), ("두개", "이개"), ("하나", "한나"),
    ("맡게", "맞게"), ("개를", "계를"), ("골의", "고래"),
    ("건의", "건희"), ("삼은", "사은"),
])
def test_spelling_liaison_particles_and_numbers_are_not_reviewed(source: str, heard: str) -> None:
    template = "지금부터 우리가 {} 처음부터 끝까지 확인합니다."
    assert short_word_review_candidates(template.format(source), template.format(heard)) == []


def test_asr_latin_spelling_of_a_registered_word_is_not_a_substitution() -> None:
    assert short_word_review_candidates(
        "가장 작게 시작하고 한 봇이 처음부터 끝까지 맡습니다.",
        "가장 작게 시작하고 한 bot이 처음부터 끝까지 맡습니다.",
        [{"from": "Bot", "to": "봇"}],
    ) == []


def test_spacing_and_correct_source_repetitions_do_not_create_candidates() -> None:
    source = "가장 작게 시작하고 한 봇이 처음부터 끝까지 맡습니다."
    assert short_word_review_candidates(source, source.replace("한 봇이", "한봇이")) == []
    assert short_word_review_candidates(source + source, source + source) == []


def test_sentence_edges_larger_edits_and_missing_context_do_not_claim_local_evidence() -> None:
    assert short_word_review_candidates("봇이 처음부터 끝까지 맡습니다.", "보이 처음부터 끝까지 맡습니다.") == []
    assert short_word_review_candidates(
        "가장 작게 시작하고 한 봇이 처음부터 끝까지 맡습니다.",
        "가장 크게 시작하면 그 보이 마지막까지 맡습니다.",
    ) == []


def test_repeated_calls_remain_soft_and_do_not_promote_the_result() -> None:
    source = "가장 작게 시작하고 한 봇이 처음부터 끝까지 맡습니다."
    for _ in range(4):
        [check] = short_word_review_candidates(source, source.replace("봇이", "보이"))
        assert check["status"] == "warning" and not check["automaticFailure"]
