"""Conservative, acoustic checks for pauses inside a spoken Korean word.

ASR spacing is not evidence of a pause. A finding needs an actual quiet interval,
speech on both sides, and a complete word mapped from the timed transcript to
the requested text. Sentence/word boundaries and unmatched readings are excluded.
This is a pause detector, not a general score for naturalness or intonation.
"""

from __future__ import annotations

import math
import re
import unicodedata
from difflib import SequenceMatcher
from pathlib import Path
from typing import Any

import numpy as np
import soundfile as sf


PROSODY_POLICY = "ko-intraword-pause-v3"
MIN_INTERNAL_PAUSE_MS = 250
WORD_EDGE_GUARD_MS = 100
MIN_TIMING_PROBABILITY = 0.8
MIN_UNASSIGNED_VOICED_MS = 80
PAUSE_WARNING = "단어 내부 끊김 확인 필요"


def interior_silences(audio_path: Path) -> list[dict[str, int]]:
    """Find quiet runs; never cut or otherwise change the supplied audio."""
    audio, rate = sf.read(audio_path, dtype="float32", always_2d=True)
    samples = np.mean(audio, axis=1, dtype=np.float32)
    frame = max(1, round(rate * 0.01))
    usable = len(samples) // frame * frame
    if not usable or not np.isfinite(samples).all():
        return []
    rms = np.sqrt(np.mean(samples[:usable].reshape(-1, frame) ** 2, axis=1))
    voiced = rms >= max(5e-4, float(rms.max()) * 0.0125)
    active = np.flatnonzero(voiced)
    if not len(active):
        return []
    quiet = ~voiced
    edges = np.diff(np.r_[False, quiet, False].astype(np.int8))
    result = []
    for start, end in zip(np.flatnonzero(edges == 1), np.flatnonzero(edges == -1)):
        start_ms, end_ms = round(start * frame * 1000 / rate), round(end * frame * 1000 / rate)
        if start <= active[0] or end > active[-1]:
            continue
        if end_ms - start_ms >= MIN_INTERNAL_PAUSE_MS:
            result.append({"startMs": start_ms, "endMs": end_ms, "durationMs": end_ms - start_ms})
    return result


def _compact(text: str) -> str:
    return "".join(c for c in unicodedata.normalize("NFKC", text).casefold() if c.isalnum())


def _periodic_voice_ms(samples: np.ndarray, rate: int, start_ms: float, end_ms: float, threshold: float) -> int:
    """Measure sustained periodic signal, so breath/noise alone cannot confirm.

    This is a signal-presence test, not a pitch or naturalness score. Overlapping
    40ms frames count by their 10ms hop, conservatively excluding the frame tail.
    """
    region = samples[max(0, round(start_ms * rate / 1000)):round(end_ms * rate / 1000)]
    frame, hop = max(1, round(rate * 0.04)), max(1, round(rate * 0.01))
    lags = np.arange(max(1, round(rate / 500)), min(frame - 1, round(rate / 60)) + 1)
    voiced = 0
    for offset in range(0, len(region) - frame + 1, hop):
        x = region[offset:offset + frame].astype(np.float64)
        x -= x.mean()
        if float(np.sqrt(np.mean(x * x))) < threshold:
            continue
        correlation = np.correlate(x, x, mode="full")[frame - 1:]
        energy = np.r_[0.0, np.cumsum(x * x)]
        denominator = np.sqrt(energy[frame - lags] * (energy[frame] - energy[lags]))
        if float(np.max(correlation[lags] / np.maximum(denominator, 1e-12))) >= 0.55:
            voiced += 1
    return round(voiced * hop * 1000 / rate)


def _unassigned_speech_checks(
    primary: list[dict[str, Any]], words: list[dict[str, Any]], audio_path: Path,
) -> list[dict[str, Any]]:
    """Corroborate speech an independent aligner left outside all word spans.

    A forced aligner can end 똑똑하게 at a pause and omit the following syllables.
    Its empty word gap is then contradicted by sustained voiced audio that the
    independent ASR assigned to the same word. Speech belonging to an adjacent
    aligned word, edge padding, silence, or breath alone is not evidence.
    """
    if not primary or not words:
        return []
    audio, rate = sf.read(audio_path, dtype="float32", always_2d=True)
    samples = np.mean(audio, axis=1, dtype=np.float32)
    frame = max(1, round(rate * 0.01))
    usable = len(samples) // frame * frame
    if not usable or not np.isfinite(samples).all():
        return []
    rms = np.sqrt(np.mean(samples[:usable].reshape(-1, frame) ** 2, axis=1))
    threshold = max(5e-4, float(rms.max()) * 0.0125)
    duration_ms = len(samples) * 1000 / rate
    spans = []
    for word in words:
        try:
            start, end = float(word["startMs"]), float(word["endMs"])
        except (KeyError, TypeError, ValueError):
            return []
        if not (math.isfinite(start) and math.isfinite(end) and 0 <= start < end <= duration_ms + 20):
            return []
        if spans and start < spans[-1][2]:
            return []
        spans.append((_compact(str(word.get("text", ""))), start, end))
    results = []
    for check in primary:
        for index, (term, start, end) in enumerate(spans):
            if term != check["term"] or end <= check["startMs"] or start >= check["endMs"]:
                continue
            regions = []
            # Require a real neighboring word: an unaligned clip edge cannot
            # establish whether extra sound belongs to this word or another.
            if index + 1 < len(spans) and end <= check["pauseStartMs"] + WORD_EDGE_GUARD_MS:
                regions.append((
                    "unassigned-voiced-tail", max(check["pauseEndMs"], end),
                    min(check["endMs"], spans[index + 1][1] - WORD_EDGE_GUARD_MS),
                ))
            if index > 0 and start >= check["pauseEndMs"] - WORD_EDGE_GUARD_MS:
                regions.append((
                    "unassigned-voiced-head", max(check["startMs"], spans[index - 1][2] + WORD_EDGE_GUARD_MS),
                    min(check["pauseStartMs"], start),
                ))
            for evidence, begin, finish in regions:
                if finish - begin < MIN_UNASSIGNED_VOICED_MS:
                    continue
                voiced_ms = _periodic_voice_ms(samples, rate, begin, finish, threshold)
                if voiced_ms >= MIN_UNASSIGNED_VOICED_MS:
                    results.append({**check, "confirmationEvidence": evidence, "unassignedVoicedMs": voiced_ms})
                    break
            else:
                continue
            break
    return results


def confirm_pause_checks(
    primary: dict[str, Any], expected_text: str, words: list[dict[str, Any]],
    pauses: list[dict[str, int]], audio_path: Path, duration_ms: int,
) -> dict[str, Any]:
    """Combine two word timings with waveform coverage, preserving uncertainty."""
    second = pause_checks(expected_text, words, pauses, duration_ms=duration_ms)
    def identity(check):
        return check["term"], check["pauseStartMs"], check["pauseEndMs"]
    direct = {identity(check) for check in second["checks"]}
    confirmed = {
        identity(check): {**check, "confirmationEvidence": "both-word-spans"}
        for check in primary["checks"] if identity(check) in direct
    }
    residual = _unassigned_speech_checks(
        [check for check in primary["checks"] if identity(check) not in confirmed], words, audio_path,
    )
    confirmed.update({identity(check): check for check in residual})
    return {
        **primary, "policy": PROSODY_POLICY,
        "checks": [confirmed[identity(c)] for c in primary["checks"] if identity(c) in confirmed],
        "secondOpinion": True, "secondStatus": second["status"],
        "confirmation": "independent-alignment-and-waveform" if words else "unavailable",
        "confirmationWords": words,
        "unconfirmedChecks": [c for c in primary["checks"] if identity(c) not in confirmed],
    }


def pause_checks(
    expected_text: str,
    words: list[dict[str, Any]],
    pauses: list[dict[str, int]],
    *,
    duration_ms: int | None = None,
) -> dict[str, Any]:
    """Compare measured silence against complete, confidently timed words.

    ``words`` use clip-relative startMs/endMs and optional probability. The
    production caller supplies Whisper probabilities; stored forced alignments
    may omit them for offline inspection. Exact character mapping deliberately
    skips ambiguous number, foreign-term and ASR spelling substitutions.
    """
    base: dict[str, Any] = {"policy": PROSODY_POLICY, "checks": [], "mappedWords": 0}
    if not pauses:
        return {**base, "status": "checked", "timingRequired": False}
    if not words:
        return {**base, "status": "timing-unavailable", "timingRequired": True}

    expected = unicodedata.normalize("NFKC", expected_text).casefold()
    positions = [i for i, c in enumerate(expected) if c.isalnum()]
    # Quoting a term does not detach its Korean particle: “프롬프트화”라고 is
    # heard as 프롬프트화라고. Whitespace and actual pause punctuation still
    # separate tokens; quotation marks inside a word do not.
    token_spans = [
        match for match in re.finditer(r'''[가-힣](?:[가-힣]|["'“”‘’](?=[가-힣]))+''', expected)
        if len(_compact(match.group())) >= 2
    ]
    owners = {i: n for n, match in enumerate(token_spans) for i in range(match.start(), match.end())}
    expected_keys = _compact(expected)
    texts = [_compact(str(word.get("text", ""))) for word in words]
    heard_keys = "".join(texts)
    matcher = SequenceMatcher(None, expected_keys, heard_keys, autojunk=False)
    if matcher.ratio() < 0.9:
        return {**base, "status": "text-unmatched", "timingRequired": True}
    mapping = {
        block.b + offset: block.a + offset
        for block in matcher.get_matching_blocks()
        for offset in range(block.size)
    }
    groups: dict[int, list[dict[str, Any]]] = {}
    cursor = 0
    previous_end = 0.0
    for index, (word, text) in enumerate(zip(words, texts)):
        mapped = [mapping.get(i) for i in range(cursor, cursor + len(text))]
        cursor += len(text)
        try:
            start, end = float(word["startMs"]), float(word["endMs"])
            probability = float(word.get("probability", 1.0))
        except (KeyError, TypeError, ValueError):
            continue
        valid_time = all(math.isfinite(x) for x in (start, end, probability))
        valid_time = valid_time and 0 <= start < end and start >= previous_end
        if duration_ms is not None:
            valid_time = valid_time and end <= duration_ms + 20
        previous_end = max(previous_end, end) if math.isfinite(end) else previous_end
        if not text or not valid_time or probability < MIN_TIMING_PROBABILITY or None in mapped:
            continue
        if mapped != list(range(mapped[0], mapped[0] + len(text))):
            continue
        ids = {owners.get(positions[i]) for i in mapped}
        if len(ids) != 1 or None in ids:
            continue
        owner = ids.pop()
        groups.setdefault(owner, []).append({
            "text": text, "startMs": start, "endMs": end, "index": index,
            "window": word.get("window", 0),
        })

    checks = []
    for owner, parts in groups.items():
        term = _compact(token_spans[owner].group())
        if "".join(part["text"] for part in parts) != term:
            continue
        if len({part["window"] for part in parts}) != 1:
            continue  # A read-window seam is not a reliable word boundary.
        if [p["index"] for p in parts] != list(range(parts[0]["index"], parts[0]["index"] + len(parts))):
            continue
        base["mappedWords"] += 1
        start, end = parts[0]["startMs"], parts[-1]["endMs"]
        for pause in pauses:
            if start + WORD_EDGE_GUARD_MS <= pause["startMs"] and pause["endMs"] <= end - WORD_EDGE_GUARD_MS:
                checks.append({
                    "kind": "intraword-pause", "term": term, "status": "warning",
                    "reason": PAUSE_WARNING,
                    "startMs": round(start), "endMs": round(end),
                    "pauseStartMs": pause["startMs"], "pauseEndMs": pause["endMs"],
                    "pauseDurationMs": pause["durationMs"],
                })
    return {**base, "status": "checked" if base["mappedWords"] else "text-unmatched", "timingRequired": True, "checks": checks}
