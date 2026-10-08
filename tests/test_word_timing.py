from local_tts_engine.word_timing import build_word_timings, map_chunk_words, source_words


def test_identical_and_replaced_words_keep_their_own_times() -> None:
    typed = "오늘은 Bob 과 2026년 을 봅니다.".split()
    spoken = ["오늘은", "밥", "과", "이천이십육년", "을", "봅니다"]
    times = [(0, 300), (300, 500), (500, 600), (600, 1400), (1400, 1500), (1500, 2000)]

    assert map_chunk_words(typed, spoken, times) == times


def test_a_word_spoken_as_two_gets_the_whole_time_of_both() -> None:
    # Runtime is spoken "Run time"; the words around it stay anchored.
    result = map_chunk_words(["Runtime", "은", "빠릅니다"], ["Run", "time", "은", "빠릅니다"],
                             [(0, 200), (200, 500), (500, 600), (600, 1100)])

    assert result == [(0, 500), (500, 600), (600, 1100)]


def test_words_spoken_as_fewer_share_the_stretch_by_length() -> None:
    typed = ["가", "나나나나나나나나나", "다"]
    result = map_chunk_words(typed, ["가", "합쳐진말", "다"], [(0, 100), (100, 400), (400, 500)])
    assert result[0] == (0, 100) and result[2] == (400, 500)
    assert result[1] == (100, 400)

    # Two typed words over one spoken token split that token's time by length.
    split = map_chunk_words(["가", "ab", "cdef", "다"], ["가", "에이비씨디이에프", "다"],
                            [(0, 100), (100, 700), (700, 800)])
    assert split[1] == (100, 300) and split[2] == (300, 700)


def test_repeated_words_and_punctuation_only_words() -> None:
    assert map_chunk_words(["오징어"] * 3, ["오징어"] * 3, [(0, 500), (600, 1100), (1200, 1900)]) == [
        (0, 500), (600, 1100), (1200, 1900)]
    assert map_chunk_words(["가", "—", "나"], ["가", "나"], [(0, 100), (100, 200)]) == [
        (0, 100), None, (100, 200)]


def test_source_words_are_character_ranges_of_the_typed_text() -> None:
    text = "첫 줄\n  둘째 줄"
    assert [text[start:end] for start, end in source_words(text)] == ["첫", "줄", "둘째", "줄"]


def _chunks() -> list[dict]:
    return [
        {"index": 1, "sourceText": "오늘은 Bob.", "ttsText": "오늘은 밥.", "startMs": 0, "selectedAudioPath": "a"},
        {"index": 2, "sourceText": "다음 줄입니다", "ttsText": "다음 줄입니다", "startMs": 2000, "selectedAudioPath": "b"},
    ]


def _aligned(path: str, _text: str) -> list[dict]:
    return {
        "a": [{"text": "오늘은", "startMs": 0, "endMs": 400}, {"text": "밥", "startMs": 400, "endMs": 800}],
        "b": [{"text": "다음", "startMs": 0, "endMs": 300}, {"text": "줄입니다", "startMs": 300, "endMs": 900}],
    }[path]


def test_candidate_timeline_offsets_each_chunk_and_points_into_the_typed_text() -> None:
    text = "오늘은 Bob.\n다음 줄입니다"

    result = build_word_timings(text, _chunks(), _aligned, aligner="test-aligner")

    assert result["status"] == "ok" and result["reason"] is None and result["aligner"] == "test-aligner"
    assert [text[start:end] for start, end, *_ in result["words"]] == ["오늘은", "Bob.", "다음", "줄입니다"]
    assert [word[2:] for word in result["words"]] == [[0, 400], [400, 800], [2000, 2300], [2300, 2900]]


def test_overlapping_aligner_words_never_move_playback_backwards() -> None:
    def overlapping(_path: str, _text: str) -> list[dict]:
        return [{"text": "가", "startMs": 100, "endMs": 400}, {"text": "나", "startMs": 90, "endMs": 95}]

    chunks = [{"index": 1, "sourceText": "가 나", "ttsText": "가 나", "startMs": 0, "selectedAudioPath": "a"}]
    words = build_word_timings("가 나", chunks, overlapping)["words"]

    assert words == [[0, 1, 100, 400], [2, 3, 100, 100]]


def test_one_bad_chunk_leaves_its_words_untimed_without_failing_the_rest() -> None:
    def flaky(path: str, text: str) -> list[dict]:
        if path == "a":
            raise RuntimeError("aligner failed")
        return _aligned(path, text)

    result = build_word_timings("오늘은 Bob.\n다음 줄입니다", _chunks(), flaky)

    assert result["status"] == "partial" and "1: RuntimeError" in result["reason"]
    assert [word[2:] for word in result["words"]] == [[None, None], [None, None], [2000, 2300], [2300, 2900]]


def test_aligned_words_that_differ_from_the_spoken_text_are_not_trusted() -> None:
    def wrong(_path: str, _text: str) -> list[dict]:
        return [{"text": "다른말", "startMs": 0, "endMs": 100}]

    result = build_word_timings("오늘은 Bob.", _chunks()[:1], wrong)

    assert result["status"] == "unavailable" and result["words"] == [[0, 3, None, None], [4, 8, None, None]]


def test_chunks_that_do_not_cover_the_typed_text_give_no_timeline() -> None:
    result = build_word_timings("오늘은 Bob. 다음 줄입니다", _chunks()[:1], _aligned)

    assert result["status"] == "unavailable" and result["reason"] == "chunk-text-mismatch"
    assert result["words"] == []
