"""Find short acoustic restart candidates inside independently aligned words.

This is a conservative listening warning, not a transcript or an audio cutter.
A short isolated onset must resemble the following onset, and both must belong
inside one Korean source word. Deliberate repeated source syllables are excluded.
"""
from __future__ import annotations

import re
from pathlib import Path
from typing import Any

import numpy as np
import soundfile as sf

RESTART_WARNING = "짧은 발음 반복 확인 필요"
RESTART_POLICY = "ko-acoustic-restart-v1"


def acoustic_restarts(path: Path) -> list[dict[str, Any]]:
    audio, rate = sf.read(path, dtype="float32", always_2d=True)
    samples = audio.mean(axis=1)
    if not len(samples) or not np.isfinite(samples).all():
        return []
    frame = max(1, round(rate * .01))
    usable = len(samples) // frame * frame
    if usable < frame * 30:
        return []
    rms = np.sqrt(np.mean(samples[:usable].reshape(-1, frame) ** 2, axis=1))
    active = rms > max(.001, float(rms.max()) * .03)
    # Fill only 10–20 ms holes so pitch cycles do not split a syllable.
    edges = np.flatnonzero(np.diff(np.r_[True, active, True]))
    for start, end in zip(edges[::2], edges[1::2]):
        if start > 0 and end < len(active) and end - start <= 2:
            active[start:end] = True
    edges = np.flatnonzero(np.diff(np.r_[False, active, False]))
    spans = list(zip(edges[::2], edges[1::2]))
    possible = []
    for i, ((start, end), (next_start, next_end)) in enumerate(zip(spans, spans[1:])):
        duration, gap = (end - start) * .01, (next_start - end) * .01
        preceding_gap = (start - spans[i - 1][1]) * .01 if i else start * .01
        if .06 <= duration <= .22 and .07 <= gap <= .24 and preceding_gap >= .08 and next_end - next_start >= 8:
            possible.append((start * .01, end * .01, next_start * .01, next_end * .01))
    if not possible:
        return []
    window = round(rate * .025)
    frames = np.lib.stride_tricks.sliding_window_view(samples, window)[::frame]
    taper = np.hanning(window + 1)[:-1]
    spectrum = np.fft.rfft(frames * taper, axis=1).T / taper.sum()
    frequencies = np.fft.rfftfreq(window, 1 / rate)
    times = (np.arange(len(frames)) * frame + window / 2) / rate
    upper = min(8000, rate / 2)
    mel = lambda f: 2595 * np.log10(1 + f / 700)
    bands = 700 * (10 ** (np.linspace(mel(80), mel(upper), 34) / 2595) - 1)
    weights = np.maximum(0, np.minimum(
        (frequencies[None, :] - bands[:-2, None]) / (bands[1:-1, None] - bands[:-2, None]),
        (bands[2:, None] - frequencies[None, :]) / (bands[2:, None] - bands[1:-1, None]),
    ))
    features = np.log(np.maximum(weights @ (abs(spectrum) ** 2), 1e-9))
    features -= features.mean(axis=0)
    features /= np.maximum(np.linalg.norm(features, axis=0), 1e-6)

    def shape(start, end):
        return np.array([np.interp(np.linspace(start, end, 12), times, row) for row in features])

    checks = []
    for start, end, next_start, next_end in possible:
        first = shape(start, end)
        durations = [d for d in (.08, .10, .12, .15, .18, .20, .24, .28) if next_start + d <= next_end]
        if not durations:
            continue
        score, duration = max((float(np.sum(first * shape(next_start, next_start + d)) / 12), d) for d in durations)
        first_peak = float(rms[round(start * 100):round(end * 100)].max())
        next_peak = float(rms[round(next_start * 100):round((next_start + duration) * 100)].max())
        # An abandoned, weak onset followed by a stronger restart. Equal-level
        # syllables separated by a stop closure are not evidence of stuttering.
        level_ratio = next_peak / max(first_peak, 1e-9)
        if score >= .72 and level_ratio >= 2:
            checks.append({"startMs": round(start * 1000), "endMs": round((next_start + duration) * 1000),
                           "restartMs": round(next_start * 1000), "similarity": round(score, 4), "levelRatio": round(level_ratio, 3)})
    return checks


def confirm_restarts(candidates: list[dict[str, Any]], words: list[dict[str, Any]], expected: str) -> list[dict[str, Any]]:
    checks = []
    source_words = re.findall(r"[가-힣]+", expected)
    for candidate in candidates:
        for word in words:
            term = str(word.get("text", "")).strip()
            if term not in source_words or not re.fullmatch(r"[가-힣]{2,}", term):
                continue
            # Similar adjacent source sounds (반복, 하나) can resemble a restart.
            # This narrow acoustic gate cannot distinguish them, so abstain.
            first, second = ord(term[0]) - 0xAC00, ord(term[1]) - 0xAC00
            if first // 588 == second // 588 or first // 28 % 21 == second // 28 % 21:
                continue
            if any(term.startswith(previous) for previous, current in zip(source_words, source_words[1:]) if current == term):
                continue
            # 똑똑한 / 하나하나처럼 원래 반복하는 말은 이 검사로 판단하지 않는다.
            if any(term[:n] == term[n:2*n] for n in range(1, len(term)//2 + 1)):
                continue
            try:
                start, end = float(word["startMs"]), float(word["endMs"])
            except (KeyError, TypeError, ValueError):
                continue
            if not np.isfinite([start, end]).all() or start < 0 or end <= start:
                continue
            if start <= candidate["startMs"] <= start + 100 and candidate["endMs"] <= end:
                checks.append({**candidate, "term": term, "kind": "short-restart", "status": "warning",
                               "reason": RESTART_WARNING, "confirmation": "independent-word-span"})
                break
    return checks
