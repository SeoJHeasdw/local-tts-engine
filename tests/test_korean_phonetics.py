"""The layer that decides whether two spellings describe the same sound.

These cases are drawn from real disagreements between the lecture script and
Whisper's transcript, because that is the only place the rules have to hold.
"""

from local_tts_engine.korean_phonetics import (
    count_pronunciation_matches,
    decompose_syllable,
    phonetic_key,
    phonetic_variants,
    pronunciation_distance,
    spell_latin_letters,
)


def test_syllables_decompose_into_their_jamo() -> None:
    assert decompose_syllable("각") == "ㄱㅏㄱ"
    assert decompose_syllable("가") == "ㄱㅏ"
    # A cluster coda splits so a transcript that resolved it across a syllable
    # boundary still lines up.
    assert decompose_syllable("읽") == "ㅇㅣㄹㄱ"


def test_latin_runs_are_read_as_korean_letter_names() -> None:
    assert spell_latin_letters("QN") == "큐엔"
    assert spell_latin_letters("27B") == "27비"
    assert spell_latin_letters("IBM 발표") == "아이비엠 발표"


def test_tense_consonants_and_merged_vowels_fold_together() -> None:
    # A transcript writing the standard orthography and a dictionary writing the
    # spoken form describe one sound.
    assert phonetic_key("깨") == phonetic_key("게")
    assert phonetic_key("해") == phonetic_key("헤")


def test_aspirated_consonants_stay_distinct() -> None:
    # Folding these would hide exactly the misreading this layer exists to catch.
    assert phonetic_key("타") != phonetic_key("다")
    assert phonetic_key("카") != phonetic_key("가")


def test_the_model_name_whisper_wrote_is_one_jamo_from_the_intended_reading() -> None:
    intended = phonetic_key("큐웬삼점육 이십칠비")
    heard = phonetic_key(spell_latin_letters("QN 삼점육 이십칠비입니다"))
    assert pronunciation_distance(intended, heard) < 0.1


def test_a_real_misreading_stays_far_away() -> None:
    intended = phonetic_key("런타임")
    assert pronunciation_distance(intended, phonetic_key("그래서 런팀을 봅니다")) > 0.2
    assert pronunciation_distance(intended, phonetic_key("그래서 알에이지를 봅니다")) > 0.4


def test_distance_is_zero_when_the_term_is_present_verbatim() -> None:
    assert pronunciation_distance(phonetic_key("래그"), phonetic_key("래그는 검색입니다")) == 0.0


def test_an_empty_pattern_costs_nothing_and_empty_text_costs_everything() -> None:
    assert pronunciation_distance("", phonetic_key("아무 말")) == 0.0
    assert pronunciation_distance(phonetic_key("래그"), "") == 1.0


def test_repeated_terms_are_counted_separately() -> None:
    term = phonetic_key("오십 개")
    once = phonetic_key("도구 오십 개를 줬습니다")
    twice = phonetic_key("도구 오십 개를 줬고 오십 개를 더 줬습니다")
    assert count_pronunciation_matches(term, once, 0.15) == 1
    assert count_pronunciation_matches(term, twice, 0.15) == 2
    assert count_pronunciation_matches(term, phonetic_key("도구를 줬습니다"), 0.15) == 0


def test_variants_offer_both_readings_of_a_leftover_latin_token() -> None:
    variants = phonetic_variants("27B")
    assert len(variants) == 2
    assert any("ㅂㅣ" in variant for variant in variants)


def test_digits_left_in_a_transcript_are_still_readable() -> None:
    assert phonetic_key("3") == phonetic_key("삼")


def test_numerals_that_int_refuses_are_read_not_crashed() -> None:
    # str.isdigit is True for ① and ²; feeding either to int() raises.
    assert phonetic_key("① 첫째") == phonetic_key("일 첫째")
    assert phonetic_key("3m²") == phonetic_key("삼m이")
    # A numeral with no compatibility mapping is dropped rather than guessed at.
    assert phonetic_key("٣") == ""


def test_decorative_characters_read_as_the_plain_ones_a_speaker_says() -> None:
    # Korean decks use these constantly and an ASR writes the plain form. The
    # rest of the comparison stack normalizes the same way, so this key must
    # too — otherwise a correctly read slide fails on a bullet marker.
    assert phonetic_key("① 데이터를 수집합니다") == phonetic_key("1 데이터를 수집합니다")
    assert phonetic_key("Ａ안과 Ｂ안") == phonetic_key("A안과 B안")
    assert phonetic_key("면적 3㎡") == phonetic_key("면적 3m2")
    assert phonetic_key("Ⅳ장") == phonetic_key("IV장")


def test_a_jamo_written_any_of_three_ways_is_one_sound() -> None:
    """Compatibility (ㄱ), conjoining (U+1100), and halfwidth (U+FFA1) are the
    same letter. Leaving them apart would mean a bare jamo never matches the one
    a syllable decomposes into."""
    assert phonetic_key("ㄱ") == "ㄱ"
    assert phonetic_key("\u1100") == "ㄱ"
    assert phonetic_key("\uffa1") == "ㄱ"
    assert phonetic_key("\u1161") == "ㅏ"
    assert phonetic_key("\u11a8") == "ㄱ"
    assert decompose_syllable("악").endswith(phonetic_key("ㄱ"))


def test_hangul_written_apart_is_recomposed_before_reading() -> None:
    # macOS stores filenames and sometimes text decomposed; NFC puts it back.
    assert phonetic_key("\u1100\u1161") == phonetic_key("가")


def test_an_enclosed_syllable_is_read_as_the_syllable_inside_it() -> None:
    # NFKC expands ㈜ into (주); the fold runs before decomposition, so the
    # Hangul it produces is still read rather than passed through whole.
    assert phonetic_key("㈜삼성") == phonetic_key("(주)삼성")
    assert "ㅈ" in phonetic_key("㈜")
