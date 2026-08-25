"""Run an experimental local Qwen3-TTS LoRA fine-tune with MLX-Tune.

This module is intentionally isolated from the production inference environment.
Run it with .venv-train and PYTHONPATH=src. It never edits source audio.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import math
import platform
import sys
import time
from importlib.metadata import version
from pathlib import Path
from typing import Any

import numpy as np
import soundfile as sf
from scipy.signal import resample_poly


DEFAULT_MODEL = "mlx-community/Qwen3-TTS-12Hz-1.7B-Base-bf16"
TARGET_SAMPLE_RATE = 24_000


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for block in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def read_jsonl(path: Path) -> list[dict[str, Any]]:
    return [
        json.loads(line)
        for line in path.read_text(encoding="utf-8").splitlines()
        if line.strip()
    ]


def load_training_data(path: Path, limit: int | None = None) -> list[dict[str, Any]]:
    rows = read_jsonl(path)
    if limit is not None:
        rows = rows[:limit]
    result: list[dict[str, Any]] = []
    for row in rows:
        audio_path = Path(row["audio"])
        audio, sample_rate = sf.read(audio_path, dtype="float32", always_2d=False)
        if audio.ndim != 1:
            audio = np.mean(audio, axis=-1).astype(np.float32)
        if sample_rate != TARGET_SAMPLE_RATE:
            divisor = math.gcd(int(sample_rate), TARGET_SAMPLE_RATE)
            audio = resample_poly(
                audio,
                TARGET_SAMPLE_RATE // divisor,
                int(sample_rate) // divisor,
            ).astype(np.float32)
        result.append(
            {
                "id": row.get("id", audio_path.stem),
                "text": row["text"],
                "audio": {
                    "array": np.asarray(audio, dtype=np.float32),
                    "sampling_rate": TARGET_SAMPLE_RATE,
                },
            }
        )
    if not result:
        raise ValueError("학습 데이터가 비어 있습니다.")
    return result


def write_json(path: Path, value: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(
        json.dumps(value, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )


def run_training(args: argparse.Namespace) -> dict[str, Any]:
    import mlx.core as mx
    from mlx_tune import FastTTSModel, TTSDataCollator, TTSSFTConfig, TTSSFTTrainer

    args.output_dir.mkdir(parents=True, exist_ok=True)
    data = load_training_data(args.train_jsonl, args.limit)
    mx.random.seed(args.seed)
    mx.reset_peak_memory()

    started = time.perf_counter()
    wrapper, tokenizer = FastTTSModel.from_pretrained(
        model_name=args.model,
        max_seq_length=args.max_seq_length,
    )
    load_seconds = time.perf_counter() - started
    wrapper = FastTTSModel.get_peft_model(
        wrapper,
        r=args.rank,
        lora_alpha=args.alpha,
        lora_dropout=0.0,
        target_modules=[
            "q_proj",
            "k_proj",
            "v_proj",
            "o_proj",
            "gate_proj",
            "up_proj",
            "down_proj",
        ],
        random_state=args.seed,
    )
    collator = TTSDataCollator(
        model=wrapper,
        tokenizer=tokenizer,
        max_seq_length=args.max_seq_length,
        text_column="text",
        audio_column="audio",
    )
    trainer = TTSSFTTrainer(
        model=wrapper,
        tokenizer=tokenizer,
        data_collator=collator,
        train_dataset=data,
        args=TTSSFTConfig(
            output_dir=str(args.output_dir),
            per_device_train_batch_size=1,
            gradient_accumulation_steps=args.gradient_accumulation,
            learning_rate=args.learning_rate,
            max_steps=args.max_steps,
            warmup_steps=min(args.warmup_steps, max(0, args.max_steps - 1)),
            logging_steps=1,
            weight_decay=args.weight_decay,
            max_seq_length=args.max_seq_length,
            seed=args.seed,
            train_on_completions=True,
        ),
    )
    training_started = time.perf_counter()
    result = trainer.train()
    training_seconds = time.perf_counter() - training_started

    eval_metadata = None
    if args.eval_output is not None:
        wrapper.model.eval()
        full_model = wrapper.full_model
        generated = list(
            full_model.generate(
                text=args.eval_text,
                ref_audio=str(args.reference),
                ref_text=args.reference_text.read_text(encoding="utf-8").strip(),
                lang_code="Korean",
                temperature=0.75,
                top_p=0.95,
                repetition_penalty=1.5,
                max_tokens=2048,
            )
        )
        if not generated:
            raise RuntimeError("학습 체크포인트 평가 음성이 생성되지 않았습니다.")
        rate = int(generated[0].sample_rate)
        audio = np.concatenate([np.asarray(item.audio) for item in generated])
        args.eval_output.parent.mkdir(parents=True, exist_ok=True)
        sf.write(args.eval_output, audio, rate, subtype="PCM_24")
        eval_metadata = {
            "path": str(args.eval_output.resolve()),
            "durationSeconds": round(len(audio) / rate, 3),
            "sampleRate": rate,
            "text": args.eval_text,
        }

    metadata = {
        "schemaVersion": 1,
        "status": "complete",
        "experimental": True,
        "platform": platform.platform(),
        "model": args.model,
        "trainJsonl": str(args.train_jsonl.resolve()),
        "trainJsonlSha256": sha256_file(args.train_jsonl),
        "samples": len(data),
        "parameters": {
            "rank": args.rank,
            "alpha": args.alpha,
            "learningRate": args.learning_rate,
            "maxSteps": args.max_steps,
            "gradientAccumulation": args.gradient_accumulation,
            "warmupSteps": min(args.warmup_steps, max(0, args.max_steps - 1)),
            "weightDecay": args.weight_decay,
            "maxSequenceLength": args.max_seq_length,
            "seed": args.seed,
        },
        "metrics": {
            "trainLoss": float(result.metrics["train_loss"]),
            "modelLoadSeconds": round(load_seconds, 3),
            "trainingSeconds": round(training_seconds, 3),
            "peakMetalMemoryGb": round(mx.get_peak_memory() / 1024**3, 3),
        },
        "packages": {
            name: version(name)
            for name in ("mlx-tune", "mlx-audio", "mlx", "datasets")
        },
        "adapterDir": str((args.output_dir / "adapters").resolve()),
        "evaluation": eval_metadata,
    }
    write_json(args.output_dir / "training-result.json", metadata)
    return metadata


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--train-jsonl", type=Path, required=True)
    parser.add_argument("--output-dir", type=Path, required=True)
    parser.add_argument("--model", default=DEFAULT_MODEL)
    parser.add_argument("--limit", type=int)
    parser.add_argument("--max-steps", type=int, default=60)
    parser.add_argument("--gradient-accumulation", type=int, default=4)
    parser.add_argument("--learning-rate", type=float, default=2e-5)
    parser.add_argument("--warmup-steps", type=int, default=5)
    parser.add_argument("--weight-decay", type=float, default=0.01)
    parser.add_argument("--max-seq-length", type=int, default=512)
    parser.add_argument("--rank", type=int, default=16)
    parser.add_argument("--alpha", type=int, default=16)
    parser.add_argument("--seed", type=int, default=20260825)
    parser.add_argument("--eval-output", type=Path)
    parser.add_argument(
        "--eval-text",
        default="AI Agent를 운영에 넣으려면 권한과 승인, 되돌리기 기준을 먼저 정해야 합니다.",
    )
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
    print(json.dumps(run_training(args), ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    sys.exit(main())
