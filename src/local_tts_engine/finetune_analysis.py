"""Analyze a selected speaker dataset using installed ASR and speaker models."""
from __future__ import annotations

import argparse
import gc
import json
import traceback
from pathlib import Path
from typing import Any

from .finetune_config import DEFAULT_CONFIG, comparison_model, config_argument, configure_offline, installed_model, load_config


def speaker_consistency(vectors: Any) -> tuple[Any, Any, float]:
    import numpy as np

    matrix = np.asarray(vectors, dtype=np.float64)
    if matrix.ndim != 2 or len(matrix) < 2 or not np.all(np.isfinite(matrix)):
        raise ValueError("목소리 비교에 필요한 화자 벡터가 올바르지 않습니다.")
    norms = np.linalg.norm(matrix, axis=1, keepdims=True)
    if np.any(norms <= 1e-12):
        raise ValueError("목소리 비교에 필요한 화자 벡터가 올바르지 않습니다.")
    unit = matrix / norms
    cosine = np.clip(unit @ unit.T, -1, 1)
    peers = np.array([np.median(np.delete(row, index)) for index, row in enumerate(cosine)])
    median = float(np.median(peers))
    mad = float(np.median(np.abs(peers - median)))
    return cosine, peers, median - max(0.05, 3 * mad)


def analyze_dataset(dataset_dir: Path, *, model: str, transcription_model: str,
                    comparison_model: str) -> dict[str, Any]:
    configure_offline()
    from .finetune_dataset import read_jsonl, sha256_file, transcribe_dataset, validate_dataset, write_json
    from .finetune_review import review_dataset
    import mlx.core as mx
    import numpy as np

    dataset_dir = dataset_dir.expanduser().resolve()
    validate_dataset(dataset_dir)
    # Resolve every model before writing any transcription or review output.
    asr = installed_model(transcription_model)
    tts = installed_model(model)
    whisper = installed_model(comparison_model)
    rows = read_jsonl(dataset_dir / "metadata.jsonl")
    if len(rows) < 2:
        raise ValueError("목소리 일관성 분석에는 녹음 클립이 2개 이상 필요합니다.")
    mx.eval(mx.array([1.0]) + 1)

    print(f"1/3 · {len(rows)}개 녹음 전사", flush=True)
    transcribe_dataset(dataset_dir, model_name=str(asr))
    gc.collect()
    mx.clear_cache()
    print("2/3 · 녹음 경고와 별도 받아쓰기 비교", flush=True)
    review = review_dataset(dataset_dir, comparison_model=whisper)
    gc.collect()
    mx.clear_cache()
    print("3/3 · Qwen 모델의 화자 벡터로 목소리 일관성 비교", flush=True)
    from mlx_audio.tts.utils import load_model
    from mlx_audio.utils import load_audio

    speaker_model = load_model(str(tts))
    rows = read_jsonl(dataset_dir / "metadata.jsonl")
    vectors = []
    for index, row in enumerate(rows, 1):
        audio = load_audio(row["audio"], sample_rate=24000)
        vector = speaker_model.extract_speaker_embedding(audio, sr=24000)
        mx.eval(vector)
        vectors.append(np.asarray(vector).reshape(-1))
        print(f"[speaker {index}/{len(rows)}] {row['id']}", flush=True)
    cosine, peers, cutoff = speaker_consistency(vectors)
    report_by_id = {item["id"]: item for item in review["clips"]}
    clips = []
    for index, row in enumerate(rows):
        checked = report_by_id[row["id"]]
        agreement = checked["transcriptAgreement"]
        reasons = [item["message"] for item in checked["audio"]["warnings"]]
        if agreement is None:
            reasons.append("두 받아쓰기를 비교할 수 없어 청취 확인 필요")
        elif agreement < 0.95:
            reasons.append(f"두 받아쓰기 일치도 {agreement:.1%} · 차이 확인 필요")
        outlier = bool(peers[index] < cutoff)
        if outlier:
            reasons.append("다른 원본 클립보다 화자 코사인이 낮아 청취 확인 필요")
        clips.append({"number": index + 1, "id": row["id"], "audioPath": row["audio"],
            "audioSha256": sha256_file(Path(row["audio"])), "durationMs": row["durationMs"],
            "text": row["text"], "independentText": checked["independentText"],
            "transcriptAgreement": agreement, "peerSpeakerCosine": round(float(peers[index]), 6),
            "speakerOutlier": outlier, "needsListening": bool(reasons), "reasons": reasons,
            "listeningApproval": "not-performed"})
    candidates = [clip for clip in clips if not clip["needsListening"] and 6000 <= clip["durationMs"] <= 12000]
    candidates.sort(key=lambda clip: (-clip["peerSpeakerCosine"], -clip["transcriptAgreement"], abs(clip["durationMs"] - 8000)))
    reference = candidates[0]["number"] if candidates else None
    report = {"schemaVersion": 1, "status": "analyzed-awaiting-review", "model": str(tts),
        "method": "Qwen3-ASR / Whisper transcript agreement; fixed Qwen ECAPA speaker encoder; median cosine to other source clips",
        "interpretation": "Cosine is a relative voice-consistency measure, not identity probability or listening approval.",
        "speakerOutlierThreshold": round(cutoff, 6), "cosineMatrix": cosine.round(6).tolist(),
        "recommendedReferenceNumber": reference, "clips": clips,
        "trainingStatus": "not-started", "productionSettings": "unchanged"}
    write_json(dataset_dir / "direct-analysis.json", report)
    summary = {"status": "analysis-complete", "clips": len(clips),
        "clearCandidates": [clip["number"] for clip in clips if not clip["needsListening"]],
        "listenNumbers": [clip["number"] for clip in clips if clip["needsListening"]],
        "recommendedReferenceNumber": reference,
        "resultPath": str(dataset_dir / "direct-analysis.json")}
    write_json(dataset_dir / "direct-analysis-summary.json", summary)
    return summary


def build_parser(config: dict[str, Any] | None = None) -> argparse.ArgumentParser:
    config = config if config is not None else load_config()
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--config", type=Path, default=DEFAULT_CONFIG)
    parser.add_argument("--dataset-dir", type=Path, required=True)
    parser.add_argument("--model", default=config["model"])
    parser.add_argument("--transcription-model", default=config["transcriptionModel"])
    parser.add_argument("--comparison-model", default=comparison_model(config))
    return parser


def main(argv: list[str] | None = None) -> int:
    try:
        config_path = config_argument(argv)
        args = build_parser(load_config(config_path)).parse_args(argv)
        summary = analyze_dataset(args.dataset_dir, model=args.model,
            transcription_model=args.transcription_model, comparison_model=args.comparison_model)
        print("\n분석 완료 · 아래 요약을 채팅에 붙여 주세요.", flush=True)
        print(json.dumps(summary, ensure_ascii=False, indent=2), flush=True)
        return 0
    except Exception:
        traceback.print_exc()
        print("\n분석이 완료되지 않았습니다. 마지막 오류를 채팅에 전달해 주세요.", flush=True)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
