"""Generate a controlled Qwen3-TTS A/B sample with an optional MLX LoRA adapter."""

from __future__ import annotations

import argparse
import json
import sys
import time
from pathlib import Path

import numpy as np
import soundfile as sf

from .finetune_mlx import DEFAULT_MODEL, write_json


TARGET_MODULES = [
    "q_proj",
    "k_proj",
    "v_proj",
    "o_proj",
    "gate_proj",
    "up_proj",
    "down_proj",
]


def generate(args: argparse.Namespace) -> dict:
    import mlx.core as mx
    from mlx_tune import FastTTSModel

    mx.random.seed(args.seed)
    mx.reset_peak_memory()
    started = time.perf_counter()
    wrapper, _ = FastTTSModel.from_pretrained(
        model_name=args.model,
        max_seq_length=512,
    )
    if args.adapter is not None:
        wrapper = FastTTSModel.get_peft_model(
            wrapper,
            r=args.rank,
            lora_alpha=args.alpha,
            lora_dropout=0.0,
            target_modules=TARGET_MODULES,
            random_state=args.seed,
        )
        wrapper.load_adapter(str(args.adapter))
        scaled_modules = 0
        for _, module in wrapper.model.named_modules():
            if all(hasattr(module, name) for name in ("lora_a", "lora_b", "scale")):
                module.scale *= args.adapter_scale
                scaled_modules += 1
        if scaled_modules == 0:
            raise RuntimeError("강도를 조절할 LoRA 모듈을 찾지 못했습니다.")
    wrapper.model.eval()
    reference_text = args.reference_text.read_text(encoding="utf-8").strip()
    text = args.text_file.read_text(encoding="utf-8").strip() if args.text_file else args.text
    results = list(
        wrapper.full_model.generate(
            text=text,
            ref_audio=str(args.reference),
            ref_text=reference_text,
            lang_code="Korean",
            temperature=0.75,
            top_p=0.95,
            repetition_penalty=1.5,
            max_tokens=2048,
        )
    )
    if not results:
        raise RuntimeError("평가 음성이 생성되지 않았습니다.")
    sample_rate = int(results[0].sample_rate)
    audio = np.concatenate([np.asarray(result.audio) for result in results])
    args.output.parent.mkdir(parents=True, exist_ok=True)
    sf.write(args.output, audio, sample_rate, subtype="PCM_24")
    metadata = {
        "schemaVersion": 1,
        "model": args.model,
        "adapter": str(args.adapter.resolve()) if args.adapter else None,
        "adapterScale": args.adapter_scale if args.adapter else 0.0,
        "seed": args.seed,
        "text": text,
        "reference": str(args.reference.resolve()),
        "output": str(args.output.resolve()),
        "sampleRate": sample_rate,
        "durationSeconds": round(len(audio) / sample_rate, 3),
        "generationSeconds": round(time.perf_counter() - started, 3),
        "peakMetalMemoryGb": round(mx.get_peak_memory() / 1024**3, 3),
    }
    write_json(args.output.with_suffix(".json"), metadata)
    return metadata


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--adapter", type=Path)
    parser.add_argument("--model", default=DEFAULT_MODEL)
    parser.add_argument("--rank", type=int, default=16)
    parser.add_argument("--alpha", type=int, default=16)
    parser.add_argument("--adapter-scale", type=float, default=1.0)
    parser.add_argument("--seed", type=int, default=20260825)
    parser.add_argument(
        "--text",
        default="AI Agent를 운영에 넣으려면 권한과 승인, 되돌리기 기준을 먼저 정해야 합니다.",
    )
    parser.add_argument("--text-file", type=Path)
    parser.add_argument(
        "--reference",
        type=Path,
        default=Path("artifacts/benchmarks/2026-08-23/reference.wav"),
    )
    parser.add_argument(
        "--reference-text",
        type=Path,
        default=Path("artifacts/benchmarks/2026-08-23/reference.txt"),
    )
    return parser


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    print(json.dumps(generate(args), ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    sys.exit(main())
