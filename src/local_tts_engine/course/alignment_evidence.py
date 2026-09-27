"""Measure acoustic evidence without assigning words or altering audio.

Energy-only silence detection can leave short, quiet breath/noise islands. A
weak non-speech *candidate* remains unassigned evidence, never proof of silence
or permission to discard a sound. In particular, unvoiced consonants need no
periodicity. Callers must retain the original energy audit alongside this data.
"""

from __future__ import annotations

import math
from pathlib import Path
from typing import Any

import numpy as np
import soundfile as sf

from ..prosody import _periodic_voice_ms


SPEECH_EVIDENCE_POLICY = "short-quiet-aperiodic-candidate-v1"
# These conservative limits identify review candidates, not speech labels.
# 80 ms supplies multiple 40 ms periodicity frames; the 150 ms upper bound
# prevents treating an ordinary phrase as a weak trailing sound. -40 dBFS RMS
# requires low average energy even if a peak triggered -38 dB silencedetect.
WEAK_CANDIDATE_MIN_MS = 80
WEAK_CANDIDATE_MAX_MS = 150
WEAK_CANDIDATE_MAX_RMS_DB = -40
PERIODIC_RMS_FLOOR = 5e-4


def _finite_time(value: Any, name: str) -> float:
    result = float(value)
    if not math.isfinite(result):
        raise ValueError(f"{name} must be finite")
    return result


def measure_speech_evidence(
    audio_path: Path,
    spans: list[dict[str, Any]],
) -> list[dict[str, Any]]:
    """Return RMS/periodicity for absolute track spans, reading only those spans.

    Every channel is measured separately so opposite-phase stereo cannot be
    mistaken for silence. The strongest RMS and largest periodic duration are
    retained. A span with any measurable periodic voice is never marked weak.
    The shared prosody detector is a signal-presence test, not a recognizer.
    """
    measured: list[dict[str, Any]] = []
    with sf.SoundFile(Path(audio_path), mode="r") as audio:
        rate = int(audio.samplerate)
        duration_ms = len(audio) * 1000 / rate
        for span in spans:
            start = _finite_time(span["startMs"], "startMs")
            end = _finite_time(span["endMs"], "endMs")
            # The waveform detector may print rounded milliseconds. Permit at
            # most one sample at the file edge, never a missing sound region.
            if start < 0 or end <= start or end > duration_ms + 1000 / rate:
                raise ValueError("speech evidence span lies outside the audio")
            first = round(start * rate / 1000)
            last = min(len(audio), round(end * rate / 1000))
            if last <= first:
                raise ValueError("speech evidence span contains no audio samples")
            audio.seek(first)
            samples = audio.read(last - first, dtype="float32", always_2d=True)
            if len(samples) != last - first or not np.isfinite(samples).all():
                raise ValueError("speech evidence audio is incomplete or non-finite")
            channel_rms = np.sqrt(np.mean(samples.astype(np.float64) ** 2, axis=0))
            rms = float(np.max(channel_rms))
            # Finite JSON is useful even for an entirely silent span.
            rms_db = 20 * math.log10(max(rms, 1e-8))
            periodic_ms = max(
                _periodic_voice_ms(
                    samples[:, channel], rate, 0, len(samples) * 1000 / rate,
                    PERIODIC_RMS_FLOOR,
                )
                for channel in range(samples.shape[1])
            )
            measured.append({
                "startMs": start,
                "endMs": end,
                "rmsDb": round(rms_db, 3),
                "periodicVoiceMs": periodic_ms,
                "weakNonSpeechCandidate": (
                    WEAK_CANDIDATE_MIN_MS <= end - start <= WEAK_CANDIDATE_MAX_MS
                    and rms_db <= WEAK_CANDIDATE_MAX_RMS_DB
                    and periodic_ms == 0
                ),
            })
    return measured
