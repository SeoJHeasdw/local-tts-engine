"""Reject unusable individual TTS takes without masking shared input failures."""

from __future__ import annotations

import numpy as np


class CandidateAudioError(RuntimeError):
    """A seed produced no usable waveform; a different seed may recover."""

    def __init__(self, code: str, message: str, *, seed: int | None = None,
                 cache_hash: str | None = None):
        super().__init__(message)
        self.code = code
        self.seed = seed
        self.cache_hash = cache_hash


class CandidateAttemptsExhausted(RuntimeError):
    """All allowed seeds failed before an audible candidate was available."""

    def __init__(self, chunk_key: str, failures: list[dict]):
        self.chunk_key = chunk_key
        self.failures = failures
        super().__init__(
            f"{chunk_key}의 음성 후보 {len(failures)}회가 모두 생성에 실패했습니다: "
            + ", ".join(f"{item['attempt']}회 {item['reason']}" for item in failures)
        )


def validate_candidate_audio(audio: np.ndarray, sample_rate: int) -> np.ndarray:
    """Check only objectively broken waveforms, before trimming or caching.

    A harmonic vowel is not distinguishable from a synthetic tone by a simple
    spectrum threshold. Tonality therefore stays with the existing listening
    review rather than becoming an automatic retry rule.
    """
    if not isinstance(sample_rate, int) or not 8_000 <= sample_rate <= 192_000:
        raise CandidateAudioError("invalid-sample-rate", "음성 후보의 샘플레이트가 잘못됐습니다.")
    samples = np.asarray(audio, dtype=np.float32).reshape(-1)
    if not len(samples):
        raise CandidateAudioError("empty-audio", "음성 후보가 비어 있습니다.")
    if not np.all(np.isfinite(samples)):
        raise CandidateAudioError("invalid-samples", "음성 후보에 NaN 또는 Infinity가 있습니다.")
    if len(samples) < round(0.1 * sample_rate):
        raise CandidateAudioError("too-short", "음성 후보가 100ms보다 짧습니다.")
    if float(np.sqrt(np.mean(samples.astype(np.float64) ** 2))) < 0.001:
        raise CandidateAudioError("no-signal", "음성 후보에 충분한 음성 신호가 없습니다.")
    return samples
