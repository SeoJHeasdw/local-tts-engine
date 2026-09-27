"""Read-only waveform checks for exported course timelines.

The thresholds intentionally retain the deck's ``align-check.py`` measurements.
This is an energy/silence audit, not a recognizer: it cannot prove which words
were spoken, or assign speech across an incorrect visual-step boundary.
"""

from __future__ import annotations

import math
import re
import subprocess
import unicodedata
from pathlib import Path
from typing import Any


_SILENCE_EVENT = re.compile(r"silence_(start|end):\s*(-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)")


def _number(value: Any, label: str) -> float:
    result = float(value)
    if not math.isfinite(result):
        raise ValueError(f"{label} must be finite")
    return result


def _time(record: dict[str, Any], camel: str, default: float = 0) -> float:
    snake = re.sub(r"(?<!^)(?=[A-Z])", "_", camel).lower()
    return _number(record.get(camel, record.get(snake, default)), camel)


def _normalized_silences(silences: list[dict[str, Any]]) -> list[dict[str, float]]:
    ordered = sorted(
        (max(0.0, _time(item, "startMs")), max(0.0, _time(item, "endMs")))
        for item in silences
    )
    merged: list[dict[str, float]] = []
    for start, end in ordered:
        if end < start:
            raise ValueError("silence end precedes its start")
        if end == start:
            continue
        if merged and start <= merged[-1]["endMs"]:
            merged[-1]["endMs"] = max(merged[-1]["endMs"], end)
        else:
            merged.append({"startMs": start, "endMs": end})
    return merged


def detect_silences(
    audio_path: Path,
    noise_db: float = -38,
    min_silence_seconds: float = 0.12,
) -> list[dict[str, float]]:
    """Measure silence with FFmpeg, without modifying or creating audio files.

    Failed decoding is an error, never an empty (all-voiced) successful result.
    Times retain sub-millisecond precision so a 20 ms tolerance is reproducible.
    """
    audio_path = Path(audio_path)
    if not audio_path.is_file():
        raise FileNotFoundError(audio_path)
    noise_db = _number(noise_db, "noise_db")
    min_silence_seconds = _number(min_silence_seconds, "min_silence_seconds")
    if min_silence_seconds <= 0:
        raise ValueError("min_silence_seconds must be positive")
    result = subprocess.run(
        [
            "ffmpeg", "-hide_banner", "-nostats", "-nostdin", "-i", str(audio_path),
            "-map", "0:a:0", "-vn", "-af",
            f"silencedetect=noise={noise_db:g}dB:d={min_silence_seconds:g}",
            "-f", "null", "-",
        ],
        capture_output=True,
        text=True,
        check=False,
    )
    if result.returncode:
        raise RuntimeError(f"FFmpeg silence detection failed ({result.returncode}): {result.stderr[-2000:]}")
    spans: list[dict[str, float]] = []
    start: float | None = None
    for event in _SILENCE_EVENT.finditer(result.stderr):
        value = max(0.0, float(event.group(2)) * 1000)
        if event.group(1) == "start":
            if start is not None:
                raise RuntimeError("FFmpeg returned consecutive silence starts without an end")
            start = value
        elif start is None:
            raise RuntimeError("FFmpeg returned a silence end without a start")
        else:
            spans.append({"startMs": start, "endMs": value})
            start = None
    if start is not None:
        raise RuntimeError("FFmpeg returned an incomplete final silence interval")
    return _normalized_silences(spans)


def voiced_spans(
    silences: list[dict[str, Any]],
    start_ms: float,
    end_ms: float,
    min_duration_ms: float = 80,
) -> list[dict[str, float]]:
    """Return non-silent spans clipped to a window, strictly longer than the floor.

    The strict comparison matches the original deck audit (> 0.08 seconds).
    A zero floor is useful for measuring all voiced time after a caption.
    """
    start_ms, end_ms = _number(start_ms, "start_ms"), _number(end_ms, "end_ms")
    min_duration_ms = _number(min_duration_ms, "min_duration_ms")
    if min_duration_ms < 0 or end_ms < start_ms:
        raise ValueError("invalid voiced window or minimum duration")
    current = start_ms
    spans: list[dict[str, float]] = []
    for silence in _normalized_silences(silences):
        start, end = silence["startMs"], silence["endMs"]
        if end <= start_ms or start >= end_ms:
            continue
        start, end = max(start, start_ms), min(end, end_ms)
        if start - current > min_duration_ms:
            spans.append({"startMs": current, "endMs": start})
        current = max(current, end)
    if end_ms - current > min_duration_ms:
        spans.append({"startMs": current, "endMs": end_ms})
    return spans


def _step(entry: dict[str, Any]) -> str:
    return f"{entry.get('slideId', entry.get('slide_id', ''))}:{entry['step']}"


def _speech_duration(silences: list[dict[str, Any]], start: float, end: float) -> float:
    return sum(span["endMs"] - span["startMs"] for span in voiced_spans(silences, start, max(start, end), 0))


def audit_timeline(
    timeline: dict[str, Any],
    captions: list[dict[str, Any]] | None,
    silences: list[dict[str, Any]],
) -> dict[str, Any]:
    """Build JSON-safe, warning-only validation and legacy-compatible counts.

    Word and cue timestamps are absolute track milliseconds. Step windows use
    startMs .. endMs + gapAfterMs, exactly as the original read-only audit does.
    ``captions`` counts >400 ms of voiced tail; ``captionCoverage`` uses >20 ms.
    None means caption generation has not run; [] means checked but missing.
    Empty captions are recorded separately instead of silently counting as good.
    A plausible short Korean monosyllable is reported, not phonetically approved.
    """
    silence = _normalized_silences(silences)
    entries = timeline.get("entries", [])
    findings: dict[str, list[dict[str, Any]]] = {
        "alignmentEnd": [], "transitions": [], "captions": [], "captionCoverage": [],
        "tinyWords": [], "collapsedWords": [], "implausibleWords": [], "legacyAlignment": [], "missingCaptions": [],
    }
    measurements: list[dict[str, Any]] = []
    for entry in entries:
        step = _step(entry)
        start, end = _time(entry, "startMs"), _time(entry, "endMs") + _time(entry, "gapAfterMs")
        spans = voiced_spans(silence, start, end)
        words = entry.get("alignment", {}).get("words", [])
        aligned_end = _time(words[-1], "endMs") if words else start
        waveform_end = spans[-1]["endMs"] if spans else start
        delta = aligned_end - waveform_end
        measurement = {
            "step": step, "startMs": start, "endMs": end,
            "alignmentEndMs": aligned_end, "waveformEndMs": waveform_end,
            "endDeltaMs": round(delta, 3), "within250Ms": abs(delta) <= 250,
            "voicedSpans": spans,
        }
        measurements.append(measurement)
        if abs(delta) > 250:
            findings["alignmentEnd"].append(measurement)
        tiny = []
        for word_index, word in enumerate(words):
            word_start, word_end = _time(word, "startMs"), _time(word, "endMs")
            duration = word_end - word_start
            token = str(word.get("text", ""))
            normalized = unicodedata.normalize("NFC", token)
            hangul_syllables = sum("가" <= char <= "힣" for char in normalized)
            # This separate plausibility warning catches a multisyllable word
            # collapsed to exactly 80 ms without altering legacy <80 ms counts.
            # Latin spelling is not a reliable syllable count, so exclude it.
            if hangul_syllables >= 2 and duration < hangul_syllables * 60:
                findings["implausibleWords"].append({
                    "step": step, "wordIndex": word_index, "text": token,
                    "startMs": word_start, "endMs": word_end, "durationMs": duration,
                    "hangulSyllables": hangul_syllables,
                    "millisecondsPerSyllable": round(duration / hangul_syllables, 3),
                    "minimumExpectedDurationMs": hangul_syllables * 60,
                })
            if duration >= 80:
                continue
            letters = "".join(c for c in normalized if c.isalnum())
            # Single-syllable Korean can be short. It still needs nonzero voiced
            # support; a 0-30 ms collapsed token is never excused by spelling.
            voiced_duration = _speech_duration(silence, word_start, word_end)
            short_syllable = (
                len(letters) == 1 and "가" <= letters <= "힣"
                and duration >= 40 and voiced_duration >= duration * 0.7
            )
            issue = {
                "step": step, "wordIndex": word_index, "text": token,
                "startMs": word_start, "endMs": word_end, "durationMs": duration,
                "voicedDurationMs": round(voiced_duration, 3),
                "plausibleShortSyllable": short_syllable,
            }
            tiny.append(issue)
            findings["tinyWords"].append(issue)
            if not short_syllable:
                findings["collapsedWords"].append(issue)
        if abs(delta) > 400 or tiny:
            findings["legacyAlignment"].append({
                "step": step, "alignEnd": round((aligned_end - start) / 1000, 2),
                "waveEnd": round((waveform_end - start) / 1000, 2),
                "tinyWords": [word["text"] for word in tiny],
            })
        step_cues = [cue for cue in (captions or []) if start <= _time(cue, "startMs") < end]
        if captions is not None and not step_cues and spans:
            findings["missingCaptions"].append({"step": step, "startMs": start, "endMs": end})
        if step_cues:
            last_start = max(_time(cue, "startMs") for cue in step_cues)
            # Preserve the original checker when two cues have equal starts.
            for cue in step_cues:
                if _time(cue, "startMs") != last_start:
                    continue
                cue_end = _time(cue, "endMs")
                tail = _speech_duration(silence, max(start, cue_end), end)
                issue = {
                    "step": step, "text": cue.get("text", ""),
                    "cueEndMs": cue_end, "voiceAfterCueMs": round(tail, 3),
                    "cueEnd": round(cue_end / 1000, 2), "voiceAfterCue": round(tail / 1000, 2),
                }
                if tail > 400:
                    findings["captions"].append(issue)
                if tail > 20:
                    findings["captionCoverage"].append(issue)
    for previous, following in zip(entries, entries[1:]):
        transition = _time(previous, "transitionAtMs", _time(previous, "endMs"))
        if any(span["startMs"] - 20 <= transition <= span["endMs"] + 20 for span in silence):
            continue
        before = [span for span in silence if span["endMs"] <= transition]
        after = [span for span in silence if span["startMs"] >= transition]
        words = following.get("alignment", {}).get("words", [])
        findings["transitions"].append({
            "from": _step(previous), "to": _step(following), "transitionMs": transition,
            "voiceSinceMs": before[-1]["endMs"] if before else None,
            "voiceUntilMs": after[0]["startMs"] if after else None,
            "alignedFirstWordMs": _time(words[0], "startMs") if words else None,
        })
    passed = sum(row["within250Ms"] for row in measurements)
    summary = {
        "steps": len(entries), "alignmentEndWithin250Ms": passed,
        "alignmentEndWithin250MsRate": passed / len(entries) if entries else None,
        "alignmentEndBeyond250Ms": len(findings["alignmentEnd"]),
        "transitionBoundaries": max(0, len(entries) - 1),
        "transitions": len(findings["transitions"]),
        "earlyCaptions": len(findings["captions"]),
        "earlyCaptionsOver20Ms": len(findings["captionCoverage"]),
        "missingCaptionSteps": len(findings["missingCaptions"]),
        "tinyWords": len(findings["tinyWords"]),
        "collapsedWords": len(findings["collapsedWords"]),
        "implausibleWords": len(findings["implausibleWords"]),
        "plausibleShortSyllables": len(findings["tinyWords"]) - len(findings["collapsedWords"]),
        "legacyAlignmentIssues": len(findings["legacyAlignment"]),
    }
    warning = any(findings[key] for key in (
        "alignmentEnd", "transitions", "captionCoverage", "collapsedWords", "implausibleWords", "missingCaptions",
    ))
    return {
        "schemaVersion": 1, "status": "not-checked" if not entries else "warning" if warning else "passed",
        "severity": "warning" if warning else None, "blocksAudioGeneration": False,
        "captionAuditStatus": "not-run" if captions is None else "checked",
        "method": "ffmpeg-silencedetect", "thresholds": {
            "noiseDb": -38, "minimumSilenceMs": 120, "minimumVoicedSpanMs": 80,
            "alignmentEndToleranceMs": 250, "transitionToleranceMs": 20,
            "legacyAlignmentEndToleranceMs": 400, "legacyCaptionVoicedTailMs": 400,
            "captionVoicedTailToleranceMs": 20, "shortWordThresholdMs": 80,
            "minimumPlausibleShortSyllableMs": 40, "targetAlignmentEndPassRate": 0.98,
            "minimumKoreanMultisyllableMsPerSyllable": 60,
        },
        "summary": summary, "findings": findings, "stepMeasurements": measurements,
        "limitations": [
            "Silence detection measures signal energy, not word identity or human listening approval.",
            "Step waveform windows follow startMs/endMs+gapAfterMs; moving these boundaries can move speech between steps.",
            "Compare unchanged audio and source contracts, and review word-to-speech attribution separately.",
            "Plausible short Korean monosyllables require voiced support but remain unverified phonetic candidates.",
            "Korean multisyllable words below 60 ms per Hangul syllable are timing plausibility warnings, not proven pronunciation errors.",
        ],
    }
