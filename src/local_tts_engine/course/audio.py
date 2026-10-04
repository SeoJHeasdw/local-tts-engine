"""Measured audio trimming, word-internal closure correction and inter-chunk timing."""

from __future__ import annotations

import math
import re
from typing import Any

import numpy as np

from .settings import (
    CLOSURE_CAP_MS,
    CLOSURE_FILL_FROM_MS,
    CLOSURE_FLOOR_DB,
    CLOSURE_MAX_MS,
    CLOSURE_POLICY,
    CLOSURE_QUIET_DB,
    CLOSURE_VOICED_EDGE_MS,
    CLOSURE_WORD_MARGIN_MS,
    EDGE_FADE_MS,
    EDGE_PAD_MS,
    MAX_INTERNAL_SILENCE_MS,
    SLIDE_GAP_MS,
    STEP_GAP_MS,
    TARGET_INTERNAL_SILENCE_MS,
    UNTRIMMED_AUDIO_STATS,
)
from .types import CourseChunk, CourseEntry

HANGUL_SYLLABLE = re.compile(r"[가-힣]")


def milliseconds_to_samples(milliseconds: int, sample_rate: int) -> int:
    """밀리초를 샘플 수로 변환한다 (반올림)."""
    return round(milliseconds * sample_rate / 1000)


def gap_after(current: CourseEntry, following: CourseEntry) -> int:
    """두 연속 엔트리 사이에 삽입할 무음 갭(ms)을 결정한다.

    같은 슬라이드 내 전환은 짧게(STEP_GAP_MS),
    슬라이드 간 전환은 길게(SLIDE_GAP_MS) 설정한다.
    """
    if following.pause_before_ms:
        return following.pause_before_ms
    if current.chapter == following.chapter and current.slide_id == following.slide_id:
        return STEP_GAP_MS
    return SLIDE_GAP_MS


def chunk_gap_after(current: CourseChunk, following: CourseChunk) -> int:
    """두 연속 청크 사이에 삽입할 갭(ms)을 결정한다.

    청크의 마지막·첫 번째 엔트리를 기준으로 gap_after를 위임한다.
    """
    return gap_after(current.entries[-1], following.entries[0])


def trim_and_fade_audio(audio: np.ndarray, sample_rate: int) -> tuple[np.ndarray, dict[str, int]]:
    """Remove generated edge silence while preserving a short natural breath.

    처리 단계:
        1. RMS 기반 유성음 구간 감지 → 앞뒤 무음 트리밍 (EDGE_PAD_MS 여백 보존)
        2. 내부 과도 무음 압축: MAX_INTERNAL_SILENCE_MS 초과 구간을
           TARGET_INTERNAL_SILENCE_MS 로 줄임 (엣지 근처는 보호)
        3. 앞뒤 sin²/cos² 페이드 적용으로 클릭 노이즈 방지

    Returns:
        (처리된 오디오 배열, 처리 통계 딕셔너리)
        통계: trimmedHeadMs, trimmedTailMs, shortenedSilenceCount, shortenedSilenceMs
    """
    samples = np.asarray(audio, dtype=np.float32).reshape(-1)
    # 20ms 프레임, 10ms 홉으로 RMS 계산
    frame = max(1, milliseconds_to_samples(20, sample_rate))
    hop = max(1, milliseconds_to_samples(10, sample_rate))
    if len(samples) < frame:
        return samples, dict(UNTRIMMED_AUDIO_STATS)

    starts = np.arange(0, len(samples) - frame + 1, hop)
    rms = np.sqrt(
        np.array([np.mean(samples[start : start + frame] ** 2) for start in starts])
        + 1e-12  # 수치 안정성을 위한 epsilon
    )
    # 임계값: RMS 최대값의 1.25% 또는 고정 하한(5e-4) 중 큰 값
    threshold = max(5e-4, float(rms.max()) * 0.0125)
    voiced = np.flatnonzero(rms >= threshold)
    if not len(voiced):
        return samples, dict(UNTRIMMED_AUDIO_STATS)

    # 유성음 구간 앞뒤로 EDGE_PAD_MS 여백을 두고 트리밍
    pad = milliseconds_to_samples(EDGE_PAD_MS, sample_rate)
    start = max(0, int(starts[voiced[0]]) - pad)
    end = min(len(samples), int(starts[voiced[-1]]) + frame + pad)
    trimmed = samples[start:end].copy()

    # Qwen occasionally inserts a second-long pause between otherwise adjacent
    # sentences. Keep normal rhetorical pauses, but compact the rare outliers.
    # 트리밍 후 배열에서 다시 RMS를 계산해 내부 과도 무음 구간을 찾는다.
    starts = np.arange(0, max(0, len(trimmed) - frame + 1), hop)
    rms = np.sqrt(
        np.array([np.mean(trimmed[at : at + frame] ** 2) for at in starts])
        + 1e-12
    )
    silent = rms < threshold
    # 연속 무음 프레임의 시작/종료 인덱스를 런-렝스 인코딩 방식으로 수집
    runs: list[tuple[int, int]] = []
    run_start: int | None = None
    for index, is_silent in enumerate(silent):
        if is_silent and run_start is None:
            run_start = index
        if run_start is not None and (not is_silent or index == len(silent) - 1):
            run_end = index if not is_silent else index + 1
            silence_start = int(starts[run_start])
            silence_end = min(len(trimmed), int(starts[run_end - 1]) + frame)
            duration_ms = round((silence_end - silence_start) * 1000 / sample_rate)
            # 조건: 엣지 보호 구간 안쪽 & 길이가 임계값 초과인 구간만 압축 대상
            if (
                silence_start > milliseconds_to_samples(EDGE_PAD_MS, sample_rate)
                and silence_end < len(trimmed) - milliseconds_to_samples(EDGE_PAD_MS, sample_rate)
                and duration_ms > MAX_INTERNAL_SILENCE_MS
            ):
                runs.append((silence_start, silence_end))
            run_start = None

    shortened_ms = 0
    if runs:
        # 압축 대상 구간들을 TARGET_INTERNAL_SILENCE_MS 로 줄여 이어 붙인다.
        compacted: list[np.ndarray] = []
        cursor = 0
        target_silence = milliseconds_to_samples(TARGET_INTERNAL_SILENCE_MS, sample_rate)
        for silence_start, silence_end in runs:
            compacted.append(trimmed[cursor:silence_start])
            keep = min(target_silence, silence_end - silence_start)
            compacted.append(trimmed[silence_start : silence_start + keep])
            shortened_ms += round((silence_end - silence_start - keep) * 1000 / sample_rate)
            cursor = silence_end
        compacted.append(trimmed[cursor:])
        trimmed = np.concatenate(compacted)

    # sin²(0→π/2) 페이드인, cos²(0→π/2) 페이드아웃 적용
    fade = min(milliseconds_to_samples(EDGE_FADE_MS, sample_rate), len(trimmed) // 2)
    if fade:
        phase = np.linspace(0.0, np.pi / 2.0, fade, endpoint=True, dtype=np.float32)
        trimmed[:fade] *= np.sin(phase) ** 2
        trimmed[-fade:] *= np.cos(phase) ** 2

    return trimmed, {
        "trimmedHeadMs": round(start * 1000 / sample_rate),
        "trimmedTailMs": round((len(samples) - end) * 1000 / sample_rate),
        "shortenedSilenceCount": len(runs),
        "shortenedSilenceMs": shortened_ms,
    }


def room_tone(reference: np.ndarray, reference_rate: int, rate: int, window_ms: int = 250) -> np.ndarray | None:
    """Return the quietest stretch of the speaker's recording at unit RMS.

    Digital silence cannot stand in for a room, so a reference without any
    audible floor yields ``None`` and closures are then only shortened.
    """
    mono = np.asarray(reference, dtype=np.float32)
    if mono.ndim > 1:
        mono = mono.mean(axis=1)
    window = round(reference_rate * window_ms / 1000)
    if window < 1 or len(mono) < window:
        return None
    starts = range(0, len(mono) - window + 1, max(1, window // 4))
    best = min(starts, key=lambda start: float(np.mean(mono[start:start + window] ** 2)))
    tone = mono[best:best + window].astype(np.float64)
    if reference_rate != rate:
        target = np.linspace(0, len(tone) - 1, max(1, round(len(tone) * rate / reference_rate)))
        tone = np.interp(target, np.arange(len(tone)), tone)
    tone -= tone.mean()
    level = float(np.sqrt(np.mean(tone ** 2)))
    if level < 1e-6:
        return None
    return (tone / level).astype(np.float32)


def normalize_word_closures(
    samples: np.ndarray,
    rate: int,
    words: list[dict[str, Any]],
    tone: np.ndarray | None,
) -> tuple[np.ndarray, dict[str, Any]]:
    """Bring over-long, dead-silent stop closures inside words to the speaker's range.

    Only silence strictly inside a word is touched: a word of two or more Hangul
    syllables, 30 ms inside its aligned span, with the word's own sound on both
    sides, and at most 240 ms long. A closure longer than 120 ms keeps its first
    and last 60 ms. A closure of 90 ms or more is lifted to the speaker's floor
    with her room tone. Pauses between words and everything audible stay as they are.
    """
    samples = np.asarray(samples, dtype=np.float32).reshape(-1)
    record: dict[str, Any] = {"policy": CLOSURE_POLICY, "closures": 0, "filled": 0, "capped": [], "removedMs": 0}
    hop = max(1, round(rate * 0.005))
    frames = len(samples) // hop
    peak = float(np.percentile(np.abs(samples), 99.5)) if len(samples) else 0.0
    if not words or frames < 2 or peak <= 0:
        return samples, {**record, "status": "not-applicable"}
    levels = np.sqrt(np.mean(samples[:frames * hop].reshape(frames, hop).astype(np.float64) ** 2, axis=1))
    quiet = 20 * np.log10(levels / peak + 1e-12) < CLOSURE_QUIET_DB
    edge = CLOSURE_VOICED_EDGE_MS // 5
    runs: list[tuple[int, int, str]] = []
    for word in words:
        text = str(word.get("text", ""))
        if len(HANGUL_SYLLABLE.findall(text)) < 2:
            continue
        try:
            start, end = float(word["startMs"]), float(word["endMs"])
        except (KeyError, TypeError, ValueError):
            continue
        if not (math.isfinite(start) and math.isfinite(end)):
            continue
        first = max(0, math.ceil((start + CLOSURE_WORD_MARGIN_MS) / 5))
        last = min(frames, math.floor((end - CLOSURE_WORD_MARGIN_MS) / 5))
        flags = quiet[first:last]
        begin = None
        for index in range(len(flags) + 1):
            silent = index < len(flags) and bool(flags[index])
            if silent and begin is None:
                begin = index
            if silent or begin is None:
                continue
            length_ms = (index - begin) * 5
            voiced_before = begin > 0 and int(np.count_nonzero(~flags[max(0, begin - edge):begin])) >= 3
            voiced_after = index < len(flags) and int(np.count_nonzero(~flags[index:index + edge])) >= 3
            if 25 <= length_ms <= CLOSURE_MAX_MS and voiced_before and voiced_after:
                runs.append(((first + begin) * hop, (first + index) * hop, text))
            begin = None
    # Overlapping aligner words can describe the same physical closure. Apply
    # its fill and cut once; repeating a cut at the original coordinates would
    # cut later speech after the first cut shifted the samples.
    unique_runs: dict[tuple[int, int], tuple[int, int, str]] = {}
    for begin, end, text in runs:
        unique_runs.setdefault((begin, end), (begin, end, text))
    runs = list(unique_runs.values())
    record["closures"] = len(runs)

    out = samples.copy()
    target = peak * 10 ** (CLOSURE_FLOOR_DB / 20)
    fade = max(1, round(rate * 0.01))
    cuts: list[tuple[int, int]] = []
    for begin, end, text in runs:
        length = end - begin
        if tone is not None and len(tone) and length >= rate * CLOSURE_FILL_FROM_MS / 1000:
            # Lift each 5 ms frame to the speaker's closure floor, never above it.
            need = np.sqrt(np.maximum(target ** 2 - levels[begin // hop:end // hop] ** 2, 0.0))
            gain = np.repeat(np.convolve(need, np.ones(4) / 4, mode="same"), hop)
            gain = np.pad(gain, (0, max(0, length - len(gain))), mode="edge")[:length]
            ramp = np.ones(length)
            span = min(fade, length // 2)
            ramp[:span] = np.sin(np.linspace(0, np.pi / 2, span)) ** 2
            ramp[length - span:] = np.cos(np.linspace(0, np.pi / 2, span)) ** 2
            noise = np.resize(np.roll(tone, -(begin % len(tone))), length)
            out[begin:end] += (noise * gain * ramp).astype(np.float32)
            record["filled"] += 1
        if length > rate * CLOSURE_CAP_MS / 1000:
            keep = round(rate * CLOSURE_CAP_MS / 2000)
            cuts.append((begin + keep, end - keep))
            record["capped"].append({"word": text, "startMs": round(begin * 1000 / rate),
                                     "lengthMs": round(length * 1000 / rate)})
    merged_cuts: list[tuple[int, int]] = []
    for begin, end in sorted(cuts):
        if merged_cuts and begin <= merged_cuts[-1][1]:
            merged_cuts[-1] = (merged_cuts[-1][0], max(end, merged_cuts[-1][1]))
        else:
            merged_cuts.append((begin, end))
    for begin, end in reversed(merged_cuts):
        blend = min(round(rate * 0.004), begin, len(out) - end)
        joined = out[begin - blend:begin] * np.linspace(1, 0, blend) + out[end - blend:end] * np.linspace(0, 1, blend)
        out = np.concatenate([out[:begin - blend], joined.astype(np.float32), out[end:]])
    record["removedMs"] = round((len(samples) - len(out)) * 1000 / rate)
    return out, {**record, "status": "checked"}
