"""Generate alternative Qwen3-TTS takes for selected cached course chunks."""

from __future__ import annotations

import argparse
import json
import sys
import time
from pathlib import Path
from typing import Any

import numpy as np
import soundfile as sf

from .course_pilot import (
    COURSE_SETTING_OVERRIDES,
    apply_pronunciation,
    create_preview,
    production_pronunciation,
    stable_digest,
    trim_and_fade_audio,
    write_json,
)
from .pilot import MODEL_SPECS, normalize_audio, probe_audio, snapshot_revision


def chunk_text(manifest: dict[str, Any], chunk_key: str) -> str:
    entries = [entry for entry in manifest["entries"] if entry["chunkKey"] == chunk_key]
    if not entries:
        raise ValueError(f"매니페스트에서 {chunk_key}를 찾지 못했습니다.")
    text = " ".join(entry["tts_text"] for entry in entries)
    return apply_pronunciation(text, production_pronunciation())


def generate_candidates(
    manifest_path: Path,
    chunk_keys: list[str],
    output_dir: Path,
    takes: int,
) -> None:
    import mlx.core as mx
    from mlx_audio.tts.utils import load_model
    from mlx_audio.utils import get_model_path

    if takes < 1:
        raise ValueError("후보 수는 1개 이상이어야 합니다.")
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    spec = MODEL_SPECS["qwen3-tts"]
    settings = {**spec.settings, **COURSE_SETTING_OVERRIDES}
    reference = manifest["reference"]
    reference_text = Path(reference["transcriptPath"]).read_text(encoding="utf-8").strip()
    base_seed = int(manifest["seed"])

    model_path = get_model_path(spec.repository)
    model = load_model(model_path)
    output_dir.mkdir(parents=True, exist_ok=True)
    index: list[dict[str, Any]] = []

    for chunk_key in chunk_keys:
        text = chunk_text(manifest, chunk_key)
        chunk_dir = output_dir / chunk_key
        chunk_dir.mkdir(parents=True, exist_ok=True)
        for take in range(1, takes + 1):
            seed = base_seed ^ int(
                stable_digest({"chunkKey": chunk_key, "take": take})[:8], 16
            )
            mx.random.seed(seed)
            started = time.perf_counter()
            results = list(
                model.generate(
                    text=text,
                    ref_audio=reference["path"],
                    ref_text=reference_text,
                    lang_code=spec.language,
                    verbose=False,
                    **settings,
                )
            )
            generation_ms = round((time.perf_counter() - started) * 1000)
            if not results:
                raise RuntimeError(f"{chunk_key} take {take} 생성 결과가 없습니다.")
            rate = int(results[0].sample_rate)
            raw = np.concatenate([np.asarray(result.audio) for result in results])
            audio, cleanup = trim_and_fade_audio(raw, rate)

            native_path = chunk_dir / f"take-{take}-native.wav"
            wav_path = chunk_dir / f"take-{take}.wav"
            m4a_path = chunk_dir / f"take-{take}.m4a"
            sf.write(native_path, audio, rate, subtype="PCM_24")
            normalization = normalize_audio(native_path, wav_path)
            create_preview(wav_path, m4a_path)
            index.append(
                {
                    "chunkKey": chunk_key,
                    "take": take,
                    "seed": seed,
                    "text": text,
                    "generationMs": generation_ms,
                    "cleanup": cleanup,
                    "normalization": normalization,
                    "audioPath": str(wav_path.resolve()),
                    "previewPath": str(m4a_path.resolve()),
                    **probe_audio(wav_path),
                }
            )

    write_json(
        output_dir / "index.json",
        {
            "schemaVersion": 1,
            "sourceManifest": str(manifest_path.resolve()),
            "model": spec.repository,
            "modelRevision": snapshot_revision(model_path),
            "settings": {"language": spec.language, **settings},
            "candidates": index,
        },
    )
    print(json.dumps(index, ensure_ascii=False, indent=2))


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--manifest", type=Path, required=True)
    parser.add_argument("--chunk-key", action="append", required=True)
    parser.add_argument("--output-dir", type=Path, required=True)
    parser.add_argument("--takes", type=int, default=3)
    return parser


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    generate_candidates(
        manifest_path=args.manifest,
        chunk_keys=args.chunk_key,
        output_dir=args.output_dir,
        takes=args.takes,
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
