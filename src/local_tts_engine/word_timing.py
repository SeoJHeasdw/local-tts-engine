"""Word times of the *typed* text, so a candidate can be followed while it plays.

The forced aligner places each whitespace token of the pronunciation text
(``ttsText``). The listener reads the text they typed, whose words can differ:
``Bob`` is spoken 밥, ``2026년`` 이천이십육년, ``1 개`` 한 개. Tokens that are
identical on both sides anchor the mapping; inside each stretch between anchors
the stretch's time span is shared out among the typed words. A display aid
only: a failure here is recorded and never fails a generation.
"""
from __future__ import annotations

from difflib import SequenceMatcher
import re
from typing import Any, Callable

from .course.alignment import alignment_tokens, clean_alignment_token

WORD_TIMING_SCHEMA = 1
_WORD = re.compile(r"\S+")

Span = tuple[int, int]
AlignChunk = Callable[[str, str], list[dict[str, Any]]]


def source_words(text: str) -> list[tuple[int, int]]:
    """Character range of each whitespace-separated word of the typed text."""
    return [match.span() for match in _WORD.finditer(text)]


def _key(token: str) -> str:
    return clean_alignment_token(token).casefold()


def map_chunk_words(source_tokens: list[str], tts_tokens: list[str],
                    spans: list[Span]) -> list[Span | None]:
    """Time range of every typed word of one chunk (``None`` when nothing is spoken).

    ``tts_tokens`` are the cleaned tokens the aligner placed and ``spans`` their
    times. Typed words made only of punctuation are never spoken.
    """
    if len(tts_tokens) != len(spans):
        raise ValueError("정렬 토큰 수와 시각 수가 다릅니다.")
    keys = [_key(token) for token in source_tokens]
    spoken = [index for index, key in enumerate(keys) if key]
    result: list[Span | None] = [None] * len(source_tokens)
    heard = [token.casefold() for token in tts_tokens]
    matcher = SequenceMatcher(None, [keys[index] for index in spoken], heard, autojunk=False)
    for tag, i1, i2, j1, j2 in matcher.get_opcodes():
        if j1 == j2 or i1 == i2:
            # Typed words with no spoken token (read as nothing), or spoken
            # tokens with no typed word: nothing to attribute.
            continue
        if tag == "equal" or i2 - i1 == j2 - j1:
            for offset in range(i2 - i1):
                result[spoken[i1 + offset]] = spans[j1 + offset]
            continue
        # Different word counts: share the stretch's time by typed word length.
        start, end = spans[j1][0], spans[j2 - 1][1]
        weights = [max(1, len(keys[spoken[index]])) for index in range(i1, i2)]
        total, cursor = sum(weights), start
        for index, weight in zip(range(i1, i2), weights):
            following = cursor + round((end - start) * weight / total)
            result[spoken[index]] = (cursor, following)
            cursor = following
        result[spoken[i2 - 1]] = (result[spoken[i2 - 1]][0], end)
    return result


def build_word_timings(source_text: str, chunks: list[dict[str, Any]],
                       align_chunk: AlignChunk, *, aligner: str | None = None) -> dict[str, Any]:
    """Typed-word times in the final candidate audio.

    ``chunks`` are the selected chunks in play order (``sourceText``, ``ttsText``,
    ``startMs``, ``selectedAudioPath``). ``align_chunk(audio_path, text)`` returns
    the aligner's ``{"text", "startMs", "endMs"}`` per token, relative to that
    chunk's audio. Each word is ``[start, end, startMs, endMs]``: its character
    range in ``source_text`` and its time range, ``null`` when it is not spoken.
    """
    ranges = source_words(source_text)
    words: list[list[int | None]] = []
    failures: list[str] = []
    cursor = 0
    for chunk in chunks:
        tokens = chunk["sourceText"].split()
        mine = ranges[cursor:cursor + len(tokens)]
        if len(mine) != len(tokens) or [source_text[a:b] for a, b in mine] != tokens:
            return {"schemaVersion": WORD_TIMING_SCHEMA, "status": "unavailable",
                    "reason": "chunk-text-mismatch", "aligner": aligner, "words": []}
        cursor += len(tokens)
        times: list[Span | None] = [None] * len(tokens)
        try:
            aligned = align_chunk(chunk["selectedAudioPath"], chunk["ttsText"])
            expected = alignment_tokens(chunk["ttsText"])
            if [clean_alignment_token(str(item.get("text", ""))) for item in aligned] != expected:
                raise ValueError("정렬 단어가 발음문과 다릅니다.")
            offset = int(chunk["startMs"])
            relative = map_chunk_words(tokens, expected, [
                (int(item["startMs"]), int(item["endMs"])) for item in aligned])
            times = [None if span is None else (span[0] + offset, span[1] + offset)
                     for span in relative]
        except Exception as error:  # a display aid must never fail the voice
            failures.append(f"{chunk.get('index', '?')}: {type(error).__name__}: {error}")
        for (start, end), span in zip(mine, times):
            words.append([start, end, *(span if span else (None, None))])
    if cursor != len(ranges):
        return {"schemaVersion": WORD_TIMING_SCHEMA, "status": "unavailable",
                "reason": "chunk-text-mismatch", "aligner": aligner, "words": []}
    # Aligner words can overlap by a few milliseconds; play order must not go back.
    last = 0
    for word in words:
        if word[2] is not None:
            word[2] = last = max(word[2], last)
            word[3] = max(word[3], word[2])
    timed = sum(word[2] is not None for word in words)
    status = "ok" if not failures else "partial" if timed else "unavailable"
    return {"schemaVersion": WORD_TIMING_SCHEMA, "status": status,
            "reason": "; ".join(failures) or None, "aligner": aligner, "words": words}
