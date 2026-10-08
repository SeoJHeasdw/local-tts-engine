"""Route deliberate English speech to the user-approved speaker-only voice.

This is an English voice policy, not an American accent guarantee. Korean speech
keeps its existing adapter and reference transcript. No second TTS model is loaded.
"""
from __future__ import annotations

from contextlib import contextmanager
import re
from typing import Any
import unicodedata

from .language_spans import english_runs
from .pronunciation import (
    QUOTED_ENGLISH_PATTERN, _dictionary_pattern, merge_pronunciation_dictionaries,
    is_english_sentence,
)

ENGLISH_VOICE_POLICY = "english-speaker-only-v2"
# Silence the script places between two language segments, on top of the room
# tone each trimmed segment keeps at its edges. How long depends on what the
# written text puts between them: nothing (a switch inside a clause), a comma,
# or a sentence end, which pauses like any sentence in that language.
LANGUAGE_GAP_MS = 120
CLAUSE_GAP_MS = 200
SENTENCE_GAP_MS = {"English": 370, "Korean": 290}
_HANGUL = re.compile(r"[가-힣ㄱ-ㅎㅏ-ㅣ]")
_WORD = re.compile(r"[A-Za-z]+(?:['’][A-Za-z]+)?")
_CLOSERS = "\"”’)」』"


def language_gap_ms(previous_text: str, previous_language: str) -> int:
    """Silence between a segment and the next one in the other language."""
    tail = previous_text.rstrip().rstrip(_CLOSERS)[-1:]
    if tail and tail in ".!?。！？…":
        return SENTENCE_GAP_MS["English" if previous_language == "English" else "Korean"]
    if tail and tail in ",;:，；：":
        return CLAUSE_GAP_MS
    return LANGUAGE_GAP_MS


def speech_segments(text: str, dictionary: list[dict[str, Any]]) -> list[dict[str, str]]:
    """Split protected/quoted English sentences, or a wholly English input.

    ``text`` is one chunk, so a chunk with no Korean is English as a whole; the
    text candidate planner keeps English sentences out of Korean chunks.
    Unmapped Latin terms inside Korean do not trigger a voice change. Preserve
    every non-whitespace character, including quote punctuation, in order.
    """
    if not _HANGUL.search(text) and _WORD.search(text):
        return [{"text": text, "language": "English"}]
    # English written without quotation marks: a clause or sentence of three or
    # more words (see .language_spans). Single English terms stay with the Korean voice.
    intervals = list(english_runs(text))
    for item in merge_pronunciation_dictionaries(dictionary):
        if not item.get("literal") or item.get("inline"):
            continue
        value = str(item["to"])
        if _HANGUL.search(value) or len(_WORD.findall(value)) < 2:
            continue
        for match in _dictionary_pattern({**item, "from": value}).finditer(text):
            start, end = match.span()
            if start and end < len(text) and (text[start - 1], text[end]) in (("\"", "\""), ("“", "”")):
                start, end = start - 1, end + 1
            intervals.append((start, end))
    # New quoted sentences are safe to route even before a literal dictionary
    # entry is added. Korean pronunciation replacements still take precedence.
    for match in QUOTED_ENGLISH_PATTERN.finditer(text):
        value = match.group(1)
        if is_english_sentence(value):
            intervals.append(match.span())
    merged: list[tuple[int, int]] = []
    for start, end in sorted(intervals):
        if merged and start < merged[-1][1]:
            merged[-1] = (merged[-1][0], max(end, merged[-1][1]))
        else:
            merged.append((start, end))
    if not merged:
        return [{"text": text, "language": "Korean"}]
    result, cursor = [], 0

    def append(value: str, language: str):
        if not value.strip():
            if result:
                result[-1]["text"] += value
            return
        # Quote separators and trailing punctuation carry no Korean speech.
        # Generating them alone can invent a syllable or a long empty clip.
        if not any(char.isalnum() for char in value):
            if result:
                result[-1]["text"] += value
            else:
                result.append({"text": value, "language": language})
        elif result and (result[-1]["language"] == language or
                         not any(char.isalnum() for char in result[-1]["text"])):
            result[-1]["text"] += value
            result[-1]["language"] = language
        else:
            result.append({"text": value, "language": language})

    for start, end in merged:
        append(text[cursor:start], "Korean")
        append(text[start:end], "English")
        cursor = end
    append(text[cursor:], "Korean")
    for segment in result:
        segment["text"] = segment["text"].strip()
    return result


def routing_identity(text: str, dictionary: list[dict[str, Any]]) -> dict[str, Any]:
    segments = speech_segments(text, dictionary)
    if not any(part["language"] == "English" for part in segments):
        return {}
    return {"policy": ENGLISH_VOICE_POLICY, "englishAdapter": None,
            "englishReferenceMode": "speaker-only", "gapMs": LANGUAGE_GAP_MS,
            "gaps": {"word": LANGUAGE_GAP_MS, "clause": CLAUSE_GAP_MS,
                     "sentence": dict(SENTENCE_GAP_MS)},
            "englishLoudness": "match-korean-active-rms-constant-gain",
            "accentTarget": "General American", "accentEnforced": False,
            "segments": segments}


@contextmanager
def without_lora(model: Any):
    """Disable adapter contributions for one synchronous generation, then restore.

    LoRA layers in the installed mlx-tune evaluate base(x) + scale * delta(x).
    Setting scale=0 keeps the base weights and avoids a second model in memory.
    The context surrounds iteration, since generation is a lazy iterator.
    """
    layers = []
    if model is not None:
        for _, module in model.named_modules():
            if all(hasattr(module, name) for name in ("lora_a", "lora_b", "scale")):
                layers.append((module, module.scale))
    try:
        for module, _ in layers:
            module.scale = 0.0
        yield
    finally:
        for module, scale in layers:
            module.scale = scale


class EnglishVoiceRouter:
    def __init__(self, dictionary: list[dict[str, Any]], adapter_model: Any = None):
        self.dictionary = dictionary
        self.adapter_model = adapter_model

    def identity(self, text: str) -> dict[str, Any]:
        return routing_identity(text, self.dictionary)

    def segments(self, text: str) -> list[dict[str, str]]:
        return speech_segments(text, self.dictionary)

    def generate(self, generate: Any, arguments: dict[str, Any], language: str):
        if language != "English":
            yield from generate(**arguments)
            return
        english = {**arguments, "lang_code": "English"}
        english.pop("ref_text", None)
        english.pop("instruct", None)
        with without_lora(self.adapter_model):
            yield from generate(**english)


def match_english_level(audio, rate, segments):
    """Match English to adjacent Korean using constant gain; leave Korean intact."""
    import numpy as np
    korean = [audio[s["startSample"]:s["endSample"]] for s in segments if s["language"] != "English"]
    if not korean:
        return
    def level(samples):
        frame = max(1, round(rate * .02))
        if len(samples) < frame:
            return 0.
        power = np.mean(samples[:len(samples) // frame * frame].reshape(-1, frame) ** 2, axis=1)
        active = power[power > max(1e-8, float(np.max(power)) * .01)]
        return float(np.sqrt(np.mean(active))) if len(active) else 0.
    target = level(np.concatenate(korean))
    if not target:
        return
    for segment in segments:
        if segment["language"] != "English":
            continue
        piece = audio[segment["startSample"]:segment["endSample"]]
        rms = level(piece)
        if rms:
            gain = min(target / rms, .89 / max(1e-8, float(np.max(np.abs(piece)))))
            piece *= gain
            segment["gainDb"] = round(20 * float(np.log10(gain)), 4)


def english_words(text: str) -> list[str]:
    """Comparison words, retaining contractions and unexpected other languages.

    Removing apostrophes equated ``we'll`` with ``well`` and ``we're`` with
    ``were``. Discarding non-ASCII letters also hid an extra Korean utterance
    after an otherwise correct English quote. Only typography is normalized.
    """
    normalized = unicodedata.normalize("NFKC", text).casefold().replace("’", "'").replace("−", "-")
    # A sign, decimal point or percent sign carries spoken numeric meaning.
    # Keep each complete number together before the ordinary word tokenizer
    # removes sentence punctuation and splits hyphenated English words.
    pattern = (r"(?<![\w.])(?:[+-][ \t]*)?(?:(?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d+)?|\.\d+)"
               r"(?:[ \t]*%)?"
               r"(?!\w)(?!\.\d)|[^\W_]+(?:'[^\W_]+)*")
    return [re.sub(r"\s+", "", token) for token in re.findall(pattern, normalized)]


def _word_edits(expected: list[str], heard: list[str]) -> list[dict[str, Any]]:
    """Minimum word edits with positions, retaining repeated-word evidence."""
    distances = [list(range(len(heard) + 1))]
    for i, expected_word in enumerate(expected, 1):
        row = [i]
        for j, heard_word in enumerate(heard, 1):
            row.append(min(distances[-1][j] + 1, row[-1] + 1,
                           distances[-1][j - 1] + (expected_word != heard_word)))
        distances.append(row)
    i, j = len(expected), len(heard)
    edits = []
    while i or j:
        if i and j and expected[i - 1] == heard[j - 1]:
            i, j = i - 1, j - 1
        elif i and j and distances[i][j] == distances[i - 1][j - 1] + 1:
            i, j = i - 1, j - 1
            edits.append({"kind": "substitution", "expectedWord": expected[i],
                          "recognizedWord": heard[j], "expectedWordIndex": i,
                          "recognizedWordIndex": j})
        elif i and distances[i][j] == distances[i - 1][j] + 1:
            i -= 1
            edits.append({"kind": "deletion", "expectedWord": expected[i],
                          "recognizedWord": "", "expectedWordIndex": i,
                          "recognizedWordIndex": j})
        else:
            j -= 1
            edits.append({"kind": "insertion", "expectedWord": "",
                          "recognizedWord": heard[j], "expectedWordIndex": i,
                          "recognizedWordIndex": j})
    return list(reversed(edits))


_ONES = ("zero one two three four five six seven eight nine ten eleven twelve thirteen "
         "fourteen fifteen sixteen seventeen eighteen nineteen").split()
_TENS = ("", "", "twenty", "thirty", "forty", "fifty", "sixty", "seventy", "eighty", "ninety")


def _cardinal(number: int) -> str:
    if number < 20:
        return _ONES[number]
    if number < 100:
        return _TENS[number // 10] + (_ONES[number % 10] if number % 10 else "")
    if number < 1000:
        return _ONES[number // 100] + "hundred" + (_cardinal(number % 100) if number % 100 else "")
    for size, name in ((10 ** 9, "billion"), (10 ** 6, "million"), (1000, "thousand")):
        if number >= size:
            return _cardinal(number // size) + name + (_cardinal(number % size) if number % size else "")
    raise AssertionError(number)


def _spoken_forms(word: str) -> set[str]:
    """Space-free spellings of how a word can sound; digits become words."""
    # A leading decimal point still denotes a fraction: .75 and -.75 are
    # 0.75 and -0.75, including a separated sign in source math prose.
    number_word = re.sub(r"^([+-]?)\.", r"\g<1>0.", word)
    match = re.fullmatch(r"([+-]?)([0-9]+(?:,[0-9]{3})*)(?:\.([0-9]+))?(%)?", number_word)
    if match is None:
        return {word}
    sign, integer, decimal, percent = match.groups()
    digits = integer.replace(",", "")
    if len(digits) > 12 or digits != str(int(digits)):
        return {word}
    number = int(digits)
    if decimal is not None:
        # Decimal digits are pronounced individually, unlike the cardinal
        # integer part. 0.75 is zero point seven five, never zero seventy-five.
        fractional = "".join(_ONES[int(digit)] for digit in decimal)
        forms = {_cardinal(number) + "point" + fractional}
        if number == 0:
            forms.add("point" + fractional)
    else:
        forms = {_cardinal(number)}
    if decimal is None and 1100 <= number <= 2099 and number % 100:
        # Years are also read in pairs: 1999 nineteen ninety-nine, 2006 twenty oh six.
        rest = number % 100
        forms.add(_cardinal(number // 100) + ("oh" + _ONES[rest] if rest < 10 else _cardinal(rest)))
    if sign:
        prefixes = ("minus", "negative") if sign == "-" else ("plus", "positive")
        forms = {prefix + form for prefix in prefixes for form in forms}
    if percent:
        forms = {form + "percent" for form in forms}
    return forms


def _same_sound(expected: list[str], heard: list[str]) -> bool:
    def spellings(words: list[str]) -> set[str]:
        joined = {""}
        for word in words:
            joined = {prefix + form for prefix in joined for form in _spoken_forms(word)}
        return joined
    return bool(expected or heard) and bool(spellings(expected) & spellings(heard))


def _spelling_runs(edits: list[dict[str, Any]]) -> tuple[list[dict[str, Any]], list[dict[str, str]]]:
    """Split edits into real ones and runs that only spell the same sound differently.

    Whisper writes ``ten`` as ``10``, ``3`` as ``three`` and ``WebSphere`` as
    ``Web Sphere``. Each of those is an edit between spellings, and on a long
    English passage they failed correct takes on every seed. A run of adjacent
    edits is excused only when both sides join to the same spoken string, so
    ``we'll``/``well`` and ``one``/``two`` stay edits.
    """
    runs: list[list[dict[str, Any]]] = []
    following = None
    for edit in edits:
        position = (edit["expectedWordIndex"], edit["recognizedWordIndex"])
        if runs and position == following:
            runs[-1].append(edit)
        else:
            runs.append([edit])
        following = (position[0] + (edit["kind"] != "insertion"),
                     position[1] + (edit["kind"] != "deletion"))
    real, variants = [], []
    for run in runs:
        expected = [edit["expectedWord"] for edit in run if edit["kind"] != "insertion"]
        heard = [edit["recognizedWord"] for edit in run if edit["kind"] != "deletion"]
        if _same_sound(expected, heard):
            variants.append({"expected": " ".join(expected), "recognized": " ".join(heard)})
        else:
            real.extend(run)
    return real, variants


def english_reading_check(expected: str, recognized: str, **timing) -> dict[str, Any]:
    """Record lexical differences; this cannot evaluate accent or naturalness."""
    expected_words, heard_words = english_words(expected), english_words(recognized)
    edits, variants = _spelling_runs(_word_edits(expected_words, heard_words))
    return {"expectedText": expected, "recognizedText": recognized,
            "passed": bool(expected_words) and not edits,
            "expectedWords": expected_words, "recognizedWords": heard_words,
            "wordEdits": edits, "editCount": len(edits), "spellingVariants": variants,
            "wordErrorRate": round(len(edits) / max(1, len(expected_words)), 6),
            **timing}


def comparison_transcript(recognized: str, speech_parts: list[dict[str, Any]] | None) -> str:
    """Fold only lexically verified English spellings for the Korean distance gate.

    Routed ASR wraps each English reading in quotes. The original transcript
    remains evidence; this comparison-only copy substitutes the source spelling
    when the English word check proves the reading equivalent, including the
    complete numeric sign, decimal and unit. A mismatched or ambiguous span is
    never excused by the Korean distance gate.
    """
    english = [part for part in speech_parts or [] if part.get("language") == "English"]
    if not english:
        return recognized
    quoted = list(re.finditer(r'"([^\"]*)"', recognized))
    if len(quoted) == len(english):
        result = recognized
        for match, part in reversed(list(zip(quoted, english))):
            if not english_reading_check(part["text"], match.group(1))["passed"]:
                continue
            source = part["text"].strip().strip('"“”')
            result = result[:match.start()] + f'"{source}"' + result[match.end():]
        return result
    if len(english) == len(speech_parts or []) == 1:
        source = english[0]["text"]
        if english_reading_check(source, recognized)["passed"]:
            return source
    return recognized


def _audio_parts(path, routing):
    import numpy as np
    import soundfile as sf
    audio, rate = sf.read(path, dtype="float32", always_2d=True)
    samples = np.mean(audio, axis=1, dtype=np.float32)
    if rate != routing["sampleRate"]:
        raise ValueError("언어별 음성 검수의 샘플레이트가 생성 기록과 다릅니다.")
    previous = 0
    for segment in routing["segments"]:
        start, end = int(segment["startSample"]), int(segment["endSample"])
        if not previous <= start < end <= len(samples):
            raise ValueError("언어별 음성 검수의 구간이 생성 음성 범위를 벗어났습니다.")
        yield segment, samples[start:end], rate
        previous = end


def read_routed_transcript(path, routing, read_once, temperature):
    """Read actual generated parts in their language, retaining English evidence."""
    import tempfile
    from pathlib import Path
    import soundfile as sf
    from .speech_quality import asr_reading_windows
    readings, checks = [], []
    with tempfile.TemporaryDirectory(prefix="tts-language-asr-") as scratch:
        for index, (segment, samples, rate) in enumerate(_audio_parts(path, routing)):
            language = "en" if segment["language"] == "English" else "ko"
            words = []
            for window, (start, end) in enumerate(asr_reading_windows(samples, rate)):
                piece = Path(scratch) / f"{index}-{window}.wav"
                sf.write(piece, samples[start:end], rate)
                words.append(read_once(str(piece), temperature, language).strip())
            reading = " ".join(words)
            # ASR often omits the source's quote marks and final punctuation.
            # Keep the English reading protected when the combined Korean
            # comparison later applies the pronunciation dictionary again.
            readings.append(f'"{reading.strip(chr(34))}"' if language == "en" else reading)
            if language == "en":
                checks.append(english_reading_check(segment["text"], reading,
                    startMs=segment["startMs"], durationMs=segment["durationMs"]))
    return " ".join(readings), checks


def read_routed_timings(model, path, temperature, routing):
    import tempfile
    from pathlib import Path
    import soundfile as sf
    from .speech_quality import read_timed_words
    words = []
    with tempfile.TemporaryDirectory(prefix="tts-language-timing-") as scratch:
        for index, (segment, samples, rate) in enumerate(_audio_parts(path, routing)):
            piece = Path(scratch) / f"{index}.wav"
            sf.write(piece, samples, rate)
            offset = round(segment["startSample"] * 1000 / rate)
            for word in read_timed_words(model, piece, temperature,
                                         language="en" if segment["language"] == "English" else "ko"):
                # Preserve invalid times so the prosody validator rejects them.
                words.append({**word,
                    "startMs": word["startMs"] + offset if word["startMs"] >= 0 else -1,
                    "endMs": word["endMs"] + offset if word["endMs"] >= 0 else -1})
    return words
