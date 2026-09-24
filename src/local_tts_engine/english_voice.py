"""Route deliberate English speech to the user-approved speaker-only voice.

This is an English voice policy, not an American accent guarantee. Korean speech
keeps its existing adapter and reference transcript. No second TTS model is loaded.
"""
from __future__ import annotations

from contextlib import contextmanager
import re
from typing import Any
import unicodedata

from .pronunciation import (
    QUOTED_ENGLISH_PATTERN, _dictionary_pattern, merge_pronunciation_dictionaries,
    is_english_sentence,
)

ENGLISH_VOICE_POLICY = "english-speaker-only-v1"
LANGUAGE_GAP_MS = 120
_HANGUL = re.compile(r"[가-힣ㄱ-ㅎㅏ-ㅣ]")
_WORD = re.compile(r"[A-Za-z]+(?:['’][A-Za-z]+)?")


def speech_segments(text: str, dictionary: list[dict[str, Any]]) -> list[dict[str, str]]:
    """Split protected/quoted English sentences, or a wholly English input.

    Unmapped Latin terms inside Korean do not trigger a voice change. Preserve
    every non-whitespace character, including quote punctuation, in order.
    """
    if not _HANGUL.search(text) and _WORD.search(text):
        return [{"text": text, "language": "English"}]
    intervals = []
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
    normalized = unicodedata.normalize("NFKC", text).casefold().replace("’", "'")
    return re.findall(r"[^\W_]+(?:'[^\W_]+)*", normalized)


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


def english_reading_check(expected: str, recognized: str, **timing) -> dict[str, Any]:
    """Record lexical differences; this cannot evaluate accent or naturalness."""
    expected_words, heard_words = english_words(expected), english_words(recognized)
    edits = _word_edits(expected_words, heard_words)
    return {"expectedText": expected, "recognizedText": recognized,
            "passed": bool(expected_words) and not edits,
            "expectedWords": expected_words, "recognizedWords": heard_words,
            "wordEdits": edits, "editCount": len(edits),
            "wordErrorRate": round(len(edits) / max(1, len(expected_words)), 6),
            **timing}


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
