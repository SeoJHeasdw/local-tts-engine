"""How an English word may be written in Hangul, and which Hangul is a misreading.

The transcript of a Korean narration writes a well-read English word in Hangul
about as often as in English. These tests pin the line between "another
spelling of the right sound" and "a different sound".
"""

import pytest

from local_tts_engine import english_reading
from local_tts_engine.english_reading import hangul_reading, reading_lattice, reading_match, compose


def exact(word: str, heard: str) -> bool:
    match = reading_match(word, heard)
    assert match is not None
    return match[0] == 0


def test_the_first_reading_follows_the_loanword_orthography() -> None:
    assert hangul_reading("traditional") == "트러디셔널"
    assert hangul_reading("Migration") == "마이그레이션"
    assert hangul_reading("Liberty") == "리버티"
    assert hangul_reading("plan") == "플랜", "모음 사이 l은 ㄹㄹ"
    assert hangul_reading("agents") == "에이전츠"
    assert compose("".join(segment[0] for segment in reading_lattice("B AA1 T".split()))) == "밧"


def test_spellings_a_transcript_uses_for_the_same_sound_are_accepted() -> None:
    for heard in ("트래디셔널", "트러디셔널", "트라디셔널"):
        assert exact("traditional", f"지금도 {heard} 웹스피어 위에서"), heard
    for heard in ("웹스피어", "웹스피얼", "웨브스피어"):
        assert exact("WebSphere", heard), "합성어는 낱말마다 읽고, 미국식 r은 ㄹ로도 적힌다"
    assert exact("Liberty", "리벌티"), "r 음색 모음 뒤 ㄹ"
    assert exact("policy", "폴리시") and exact("Context", "컨텍스트") and exact("memory", "메모리")


def test_a_different_sound_is_not_another_spelling() -> None:
    assert not exact("traditional", "트러지셔널")
    assert not exact("WebSphere", "웹스비얼")
    assert not exact("plan", "플랫 모드")
    assert not exact("Success", "빌드 서퀘스인 것까지")
    assert not exact("Jakarta", "자케이타 E20")
    assert not exact("calling", "툴 컬링은"), "AO는 ㅓ로 적지 않는다"
    assert not exact("Bob", "법은"), "AA의 ㅓ는 비음 앞(컨텍스트)에서만"
    assert not exact("Bob", "봅은") and not exact("Bob", "붑은"), "한 음절 낱말의 AA는 미국식 ㅏ만"
    assert exact("policy", "폴리시"), "여러 음절 낱말은 철자 o의 ㅗ도 쓴다"


def test_a_final_stop_after_a_short_vowel_is_a_final_consonant() -> None:
    assert exact("bot", "봇") and not exact("bot", "보트"), "보트는 boat다"
    assert exact("boat", "보트")
    assert exact("web", "웹") and exact("Bob", "밥"), "유성 파열음은 받침도 쓰인다"
    assert not exact("agent", "멀티 에이전스라고"), "자음 뒤 t는 받침이 될 수 없다"


def test_words_the_dictionary_lacks_are_read_from_words_it_has() -> None:
    assert exact("Readme", "리드미") and exact("handoff", "핸드오프")
    assert exact("Orchestrator", "오케스트레이터는"), "orchestrate + or"
    assert exact("OpenAI", "오픈 AI와"), "대문자 조각은 글자 이름, 남은 로마자도 글자 이름으로 읽는다"
    assert reading_match("Grok", "그록") is None


def test_every_reading_found_is_counted_once() -> None:
    assert reading_match("Bob", "밥은 README를 읽고 밥을 먹습니다") == (0.0, 2)


def test_no_dictionary_means_no_hangul_judgment(monkeypatch: pytest.MonkeyPatch, tmp_path) -> None:
    monkeypatch.setattr(english_reading, "CMUDICT_PATH", tmp_path / "missing.dict")
    english_reading._cmudict.cache_clear()
    english_reading.reading_lattices.cache_clear()
    assert reading_match("traditional", "트래디셔널") is None
