"""Run one side of the local TTS A/B pilot and record reproducible metadata."""

from __future__ import annotations

import argparse
import hashlib
import json
import platform
import re
import subprocess
import sys
import time
from dataclasses import dataclass
from importlib.metadata import version
from pathlib import Path
from typing import Any

import numpy as np
import soundfile as sf


TARGET_SAMPLE_RATE = 48_000
TARGET_LUFS = -23.0
TARGET_TRUE_PEAK_DBTP = -3.0
TARGET_LRA = 11.0
DEFAULT_SEED = 20_260_823


@dataclass(frozen=True)
class ModelSpec:
    key: str
    repository: str
    license: str
    language: str
    settings: dict[str, Any]


MODEL_SPECS = {
    "qwen3-tts": ModelSpec(
        key="qwen3-tts",
        repository="mlx-community/Qwen3-TTS-12Hz-1.7B-Base-bf16",
        license="Apache-2.0",
        language="Korean",
        settings={
            "temperature": 0.9,
            "top_k": 50,
            "top_p": 1.0,
            "repetition_penalty": 1.5,
            "max_tokens": 4096,
        },
    ),
    "chatterbox-v3": ModelSpec(
        key="chatterbox-v3",
        repository="mlx-community/chatterbox-multilingual-v3",
        license="MIT",
        language="ko",
        settings={
            "temperature": 0.8,
            "top_p": 1.0,
            "min_p": 0.05,
            "repetition_penalty": 1.2,
            "exaggeration": 0.5,
            "cfg_weight": 0.5,
            "max_new_tokens": 3000,
        },
    ),
}


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as source:
        for chunk in iter(lambda: source.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def sha256_text(text: str) -> str:
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


def run_checked(command: list[str]) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        command,
        check=True,
        text=True,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
    )


def parse_loudnorm_json(stderr: str) -> dict[str, str]:
    matches = re.findall(r"\{\s*\"input_i\".*?\}", stderr, flags=re.DOTALL)
    if not matches:
        raise RuntimeError("ffmpeg loudnorm 측정 결과를 찾지 못했습니다.")
    return json.loads(matches[-1])


def normalize_audio(source: Path, destination: Path) -> dict[str, Any]:
    measure_filter = (
        f"loudnorm=I={TARGET_LUFS}:TP={TARGET_TRUE_PEAK_DBTP}:"
        f"LRA={TARGET_LRA}:print_format=json"
    )
    first_pass = run_checked(
        [
            "ffmpeg",
            "-hide_banner",
            "-nostats",
            "-i",
            str(source),
            "-af",
            measure_filter,
            "-f",
            "null",
            "-",
        ]
    )
    measured = parse_loudnorm_json(first_pass.stderr)
    normalize_filter = (
        f"loudnorm=I={TARGET_LUFS}:TP={TARGET_TRUE_PEAK_DBTP}:LRA={TARGET_LRA}:"
        f"measured_I={measured['input_i']}:measured_LRA={measured['input_lra']}:"
        f"measured_TP={measured['input_tp']}:"
        f"measured_thresh={measured['input_thresh']}:"
        f"offset={measured['target_offset']}:linear=true:print_format=json"
    )
    destination.parent.mkdir(parents=True, exist_ok=True)
    second_pass = run_checked(
        [
            "ffmpeg",
            "-y",
            "-hide_banner",
            "-nostats",
            "-i",
            str(source),
            "-af",
            normalize_filter,
            "-ar",
            str(TARGET_SAMPLE_RATE),
            "-ac",
            "1",
            "-c:a",
            "pcm_s24le",
            str(destination),
        ]
    )
    output_measurement = parse_loudnorm_json(second_pass.stderr)
    return {
        "method": "ffmpeg loudnorm two-pass linear",
        "targetIntegratedLufs": TARGET_LUFS,
        "targetTruePeakDbtp": TARGET_TRUE_PEAK_DBTP,
        "targetLra": TARGET_LRA,
        "inputMeasurement": measured,
        "outputMeasurement": output_measurement,
    }


def probe_audio(path: Path) -> dict[str, Any]:
    result = run_checked(
        [
            "ffprobe",
            "-v",
            "error",
            "-show_entries",
            "format=duration,size:stream=codec_name,sample_rate,channels,bits_per_raw_sample",
            "-of",
            "json",
            str(path),
        ]
    )
    data = json.loads(result.stdout)
    stream = data["streams"][0]
    audio_format = data["format"]
    return {
        "durationMs": round(float(audio_format["duration"]) * 1000),
        "sizeBytes": int(audio_format["size"]),
        "codec": stream["codec_name"],
        "sampleRate": int(stream["sample_rate"]),
        "channels": int(stream["channels"]),
        "bitsPerSample": int(stream.get("bits_per_raw_sample") or 0),
    }


def snapshot_revision(model_path: Path) -> str:
    if model_path.parent.name == "snapshots":
        return model_path.name
    return "local"


def cached_main_revision(repository: str) -> str | None:
    cache_name = "models--" + repository.replace("/", "--")
    ref_path = Path.home() / ".cache/huggingface/hub" / cache_name / "refs/main"
    if ref_path.is_file():
        return ref_path.read_text(encoding="utf-8").strip()
    return None


def synthesize(
    model_key: str,
    text_path: Path,
    reference_path: Path,
    reference_text_path: Path,
    output_path: Path,
    metadata_path: Path,
    seed: int,
) -> None:
    # MLX imports are deliberately delayed so --help and unit tests work without Metal.
    import mlx.core as mx
    from mlx_audio.tts.utils import load_model
    from mlx_audio.utils import get_model_path

    spec = MODEL_SPECS[model_key]
    text = text_path.read_text(encoding="utf-8").strip()
    reference_text = reference_text_path.read_text(encoding="utf-8").strip()
    if not text:
        raise ValueError("입력 문장이 비어 있습니다.")
    if not reference_text:
        raise ValueError("참조 전사문이 비어 있습니다.")

    mx.random.seed(seed)
    model_path = get_model_path(spec.repository)
    load_started = time.perf_counter()
    model = load_model(model_path)
    load_ms = round((time.perf_counter() - load_started) * 1000)

    generation_started = time.perf_counter()
    if model_key == "qwen3-tts":
        results = list(
            model.generate(
                text=text,
                ref_audio=str(reference_path),
                ref_text=reference_text,
                lang_code=spec.language,
                verbose=True,
                **spec.settings,
            )
        )
    else:
        results = list(
            model.generate(
                text=text,
                ref_audio=str(reference_path),
                lang_code=spec.language,
                verbose=True,
                **spec.settings,
            )
        )
    generation_ms = round((time.perf_counter() - generation_started) * 1000)
    if not results:
        raise RuntimeError("모델이 오디오를 생성하지 않았습니다.")

    native_rate = int(results[0].sample_rate)
    if any(int(result.sample_rate) != native_rate for result in results):
        raise RuntimeError("생성 세그먼트의 샘플레이트가 서로 다릅니다.")
    audio = np.concatenate([np.asarray(result.audio) for result in results])
    native_path = output_path.parent / "work" / f"{model_key}-native.wav"
    native_path.parent.mkdir(parents=True, exist_ok=True)
    sf.write(native_path, audio, native_rate, subtype="PCM_24")
    normalization = normalize_audio(native_path, output_path)
    output_probe = probe_audio(output_path)

    peak_memory_gb = max(float(result.peak_memory_usage) for result in results)
    metadata = {
        "schemaVersion": 1,
        "modelKey": spec.key,
        "model": spec.repository,
        "modelRevision": snapshot_revision(model_path),
        "modelLicense": spec.license,
        "tokenizerRevision": (
            cached_main_revision("mlx-community/S3TokenizerV2")
            if model_key == "chatterbox-v3"
            else None
        ),
        "seed": seed,
        "settings": {"language": spec.language, **spec.settings},
        "input": {
            "path": str(text_path.resolve()),
            "sha256": sha256_text(text),
            "characters": len(text),
        },
        "reference": {
            "path": str(reference_path.resolve()),
            "sha256": sha256_file(reference_path),
            "transcriptPath": str(reference_text_path.resolve()),
            "transcriptSha256": sha256_text(reference_text),
        },
        "performance": {
            "modelLoadMs": load_ms,
            "generationMs": generation_ms,
            "peakMetalMemoryGb": round(peak_memory_gb, 3),
        },
        "nativeAudio": {
            "path": str(native_path.resolve()),
            "sampleRate": native_rate,
            "segments": len(results),
        },
        "normalization": normalization,
        "audioPath": str(output_path.resolve()),
        **output_probe,
        "software": {
            "python": platform.python_version(),
            "mlxAudio": version("mlx-audio"),
            "mlx": version("mlx"),
        },
        "platform": {
            "machine": platform.machine(),
            "macOS": platform.mac_ver()[0],
        },
    }
    metadata_path.parent.mkdir(parents=True, exist_ok=True)
    metadata_path.write_text(
        json.dumps(metadata, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )
    print(json.dumps(metadata, ensure_ascii=False, indent=2))


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--model", choices=sorted(MODEL_SPECS), required=True)
    parser.add_argument("--text-file", type=Path, required=True)
    parser.add_argument("--reference", type=Path, required=True)
    parser.add_argument("--reference-text", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--metadata", type=Path, required=True)
    parser.add_argument("--seed", type=int, default=DEFAULT_SEED)
    return parser


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    synthesize(
        model_key=args.model,
        text_path=args.text_file,
        reference_path=args.reference,
        reference_text_path=args.reference_text,
        output_path=args.output,
        metadata_path=args.metadata,
        seed=args.seed,
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
