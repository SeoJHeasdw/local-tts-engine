"""Atomic clip cache writes and full-file validation before reuse."""

from __future__ import annotations

import hashlib
import json
import os
import tempfile
from pathlib import Path
from typing import Any

import numpy as np
import soundfile as sf

from .settings import AUDIO_TRIM_STAT_KEYS, UNTRIMMED_AUDIO_STATS


def _sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as source:
        for block in iter(lambda: source.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def _sidecars(path: Path) -> tuple[Path, Path]:
    return path.with_suffix(".json"), path.with_suffix(".sha256")


def read_cached_clip(path: Path) -> tuple[int, int, dict[str, Any]] | None:
    """Reject truncated, silent, invalid or mismatched cache data.

    Historical caches have no checksum marker; their complete PCM is still read
    and inspected before use. New writes additionally bind the WAV bytes to a
    checksum, so a later partial overwrite cannot become a cache hit.
    """
    metadata_path, checksum_path = _sidecars(path)
    if path.with_suffix(".pending").exists():
        return None
    if not path.is_file() or not metadata_path.is_file():
        return None
    try:
        metadata = json.loads(metadata_path.read_text(encoding="utf-8"))
        if not isinstance(metadata, dict):
            return None
        if any(not isinstance(metadata.get(key), int) or metadata[key] < 0 for key in AUDIO_TRIM_STAT_KEYS):
            return None
        if checksum_path.is_file():
            fingerprints = checksum_path.read_text(encoding="ascii").split()
            if (len(fingerprints) not in (1, 2) or fingerprints[0] != _sha256(path)
                    or (len(fingerprints) == 2 and fingerprints[1] != _sha256(metadata_path))):
                return None
        with sf.SoundFile(path) as clip:
            if clip.channels != 1 or not 8_000 <= clip.samplerate <= 192_000 or clip.frames < round(clip.samplerate * 0.1):
                return None
            frames, square_sum = 0, 0.0
            while True:
                block = clip.read(65_536, dtype="float32")
                if not len(block):
                    break
                if not np.all(np.isfinite(block)):
                    return None
                frames += len(block)
                square_sum += float(np.dot(block.astype(np.float64), block.astype(np.float64)))
            if frames != clip.frames or (square_sum / frames) ** 0.5 < 0.001:
                return None
            return clip.samplerate, clip.frames, {**UNTRIMMED_AUDIO_STATS, **metadata}
    except (OSError, ValueError, RuntimeError, json.JSONDecodeError, UnicodeError, ZeroDivisionError):
        return None


def write_cached_clip(path: Path, audio: np.ndarray, sample_rate: int,
                      metadata: dict[str, Any]) -> None:
    """Publish WAV, trim sidecar and checksum with recoverable ordering."""
    path.parent.mkdir(parents=True, exist_ok=True)
    metadata_path, checksum_path = _sidecars(path)
    pending_path = path.with_suffix(".pending")
    pending_path.write_text("writing\n", encoding="ascii")
    temporary: list[Path] = []

    def staged(suffix: str) -> Path:
        handle = tempfile.NamedTemporaryFile(prefix=f".{path.stem}-", suffix=suffix,
                                             dir=path.parent, delete=False)
        handle.close()
        result = Path(handle.name)
        temporary.append(result)
        return result

    try:
        wav = staged(".wav")
        sf.write(wav, audio, sample_rate, subtype="PCM_24")
        sidecar = staged(".json")
        sidecar.write_text(json.dumps(metadata, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
        checksum = staged(".sha256")
        checksum.write_text(f"{_sha256(wav)} {_sha256(sidecar)}\n", encoding="ascii")
        # The checksum is the commit marker. A process stopped between the
        # replaces leaves a mismatch and regenerates this take on the next run.
        os.replace(wav, path)
        os.replace(sidecar, metadata_path)
        os.replace(checksum, checksum_path)
        pending_path.unlink()
    finally:
        for temporary_path in temporary:
            temporary_path.unlink(missing_ok=True)
