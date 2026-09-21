"""Generate one uncached TTS candidate from arbitrary text."""

from __future__ import annotations

import argparse
import gc
import json
import sys
import time
from pathlib import Path
from typing import Any

import soundfile as sf

from .course_pilot import (
    COURSE_SETTING_OVERRIDES,
    adapter_identity,
    apply_adapter_scale,
    apply_pronunciation,
    production_pronunciation,
    generate_candidate_audio,
    write_json,
)
from .english_voice import EnglishVoiceRouter
from .pilot import (
    MODEL_SPECS,
    normalize_audio,
    probe_audio,
    resolve_model_path,
    sha256_text,
    snapshot_revision,
)


def load_text(path: Path) -> tuple[str, str]:
    """Return the display text and the pronunciation-adjusted synthesis text."""
    source = "\n".join(
        normalized
        for line in path.read_text(encoding="utf-8").splitlines()
        if (normalized := " ".join(line.split()).strip())
    ).strip()
    if not source:
        raise ValueError("합성할 텍스트를 입력해 주세요.")
    if len(source) > 2_000:
        raise ValueError("한 번에 입력할 수 있는 텍스트는 2,000자까지입니다.")
    return source, apply_pronunciation(source, production_pronunciation())


def generate_candidate(
    *,
    model_key: str,
    text_path: Path,
    reference_path: Path,
    reference_text_path: Path,
    output_path: Path,
    metadata_path: Path,
    seed: int,
    adapter_path: Path | None = None,
    adapter_scale: float = 1.0,
) -> dict[str, Any]:
    """Generate a fresh take; this command never reads an audio-result cache."""
    import mlx.core as mx
    from mlx_audio.tts.utils import load_model as load_tts_model
    from mlx_audio.utils import get_model_path

    if model_key not in MODEL_SPECS:
        raise ValueError(f"지원하지 않는 TTS 모델입니다: {model_key}")
    if adapter_path is not None and model_key != "qwen3-tts":
        raise ValueError("음성 어댑터는 Qwen3-TTS에서만 사용할 수 있습니다.")

    source_text, tts_text = load_text(text_path)
    reference_text = reference_text_path.read_text(encoding="utf-8").strip()
    if not reference_text:
        raise ValueError("참조 음성 전사문이 비어 있습니다.")

    spec = MODEL_SPECS[model_key]
    settings = (
        {**spec.settings, **COURSE_SETTING_OVERRIDES}
        if model_key == "qwen3-tts"
        else dict(spec.settings)
    )
    adapter = adapter_identity(adapter_path, adapter_scale)
    model_path = resolve_model_path(spec.repository, get_model_path)
    revision = snapshot_revision(model_path)

    mx.random.seed(seed)
    mx.reset_peak_memory()
    load_started = time.perf_counter()
    training_wrapper = None
    if adapter_path is None:
        model = load_tts_model(model_path)
    else:
        from mlx_tune import FastTTSModel

        training_wrapper, _ = FastTTSModel.from_pretrained(
            model_name=str(model_path),
            max_seq_length=512,
        )
        training_wrapper = FastTTSModel.get_peft_model(
            training_wrapper,
            r=16,
            lora_alpha=16,
            lora_dropout=0.0,
            target_modules=[
                "q_proj", "k_proj", "v_proj", "o_proj",
                "gate_proj", "up_proj", "down_proj",
            ],
            random_state=seed,
        )
        training_wrapper.load_adapter(str(adapter_path))
        if apply_adapter_scale(training_wrapper.model, adapter_scale) == 0:
            raise RuntimeError("강도를 조절할 LoRA 모듈을 찾지 못했습니다.")
        training_wrapper.model.eval()
        model = training_wrapper.full_model
    load_ms = round((time.perf_counter() - load_started) * 1000)

    generation_args: dict[str, Any] = {
        "text": tts_text,
        "ref_audio": str(reference_path),
        "lang_code": spec.language,
        "verbose": False,
        **settings,
    }
    if model_key == "qwen3-tts":
        generation_args["ref_text"] = reference_text

    router = EnglishVoiceRouter(production_pronunciation(), training_wrapper.model if training_wrapper else None) if model_key == "qwen3-tts" else None
    generated = generate_candidate_audio(model.generate, generation_args, voice_router=router)
    generation_ms = generated["generationMs"]
    sample_rate, audio, cleanup = generated["sampleRate"], generated["audio"], generated["cleanup"]
    output_path.parent.mkdir(parents=True, exist_ok=True)
    native_path = output_path.with_name(f"{output_path.stem}-native.wav")
    sf.write(native_path, audio, sample_rate, subtype="PCM_24")
    normalization = normalize_audio(native_path, output_path)
    output_probe = probe_audio(output_path)
    peak_memory_gb = generated["peakMemoryGb"]

    metadata = {
        "schemaVersion": 1,
        "cachePolicy": "disabled",
        "modelKey": model_key,
        "model": spec.repository,
        "modelRevision": revision,
        "adapter": adapter,
        "seed": seed,
        "sourceText": source_text,
        "ttsText": tts_text,
        "textSha256": sha256_text(tts_text),
        "reference": str(reference_path.resolve()),
        "output": str(output_path.resolve()),
        "cleanup": cleanup,
        # Always recorded, null included. A missing key cannot say whether the
        # text held no English or whether the routing simply went unrecorded,
        # and that is the one thing this field is read to find out.
        "voiceRouting": cleanup.get("voiceRouting"),
        "normalization": normalization,
        "performance": {
            "modelLoadMs": load_ms,
            "generationMs": generation_ms,
            "peakMetalMemoryGb": round(peak_memory_gb, 3),
        },
        **output_probe,
    }
    write_json(metadata_path, metadata)

    del router
    del model
    if training_wrapper is not None:
        del training_wrapper
    gc.collect()
    mx.clear_cache()
    print(json.dumps(metadata, ensure_ascii=False, indent=2))
    return metadata


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--model", choices=sorted(MODEL_SPECS), default="qwen3-tts")
    parser.add_argument("--text-file", type=Path, required=True)
    parser.add_argument("--reference", type=Path, required=True)
    parser.add_argument("--reference-text", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--metadata", type=Path, required=True)
    parser.add_argument("--seed", type=int, required=True)
    parser.add_argument("--adapter", type=Path)
    parser.add_argument("--adapter-scale", type=float, default=1.0)
    return parser


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    generate_candidate(
        model_key=args.model,
        text_path=args.text_file,
        reference_path=args.reference,
        reference_text_path=args.reference_text,
        output_path=args.output,
        metadata_path=args.metadata,
        seed=args.seed,
        adapter_path=args.adapter,
        adapter_scale=args.adapter_scale,
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
