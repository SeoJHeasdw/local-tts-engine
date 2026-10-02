"""Prepare hash-bound training plans and compare reviewed speaker adapters.

Run training in .venv-train. Source audio and production defaults stay unchanged;
successful automatic comparison still requires separate listening approval.
"""
from __future__ import annotations

import argparse
import contextlib
import gc
import json
import math
import re
import shutil
import traceback
from datetime import datetime
from pathlib import Path
from typing import Any
from uuid import uuid4
from zoneinfo import ZoneInfo

from .finetune_config import DEFAULT_CONFIG, config_argument, configure_offline, installed_model, load_config
from .finetune_dataset import read_jsonl, sha256_file, split_rows, validate_dataset, write_json, write_jsonl


SPLITS = ("train", "val", "test")


def ranking(item: dict[str, Any]) -> tuple[int, float, float, int]:
    severity = {"passed": 0, "warning": 1, "failed": 2, "not-checked": 3}.get(item["qualityStatus"], 3)
    return severity, item["contentScore"], -item.get("speakerCosine", -1), item["steps"]


def approved_rows(rows: list[dict[str, Any]]) -> list[dict[str, Any]]:
    # Old reviewed-only plans can predate reviewStatus. Mixed review datasets
    # must explicitly mark every eligible clip accepted.
    if any("reviewStatus" in row for row in rows):
        return [row for row in rows if row.get("reviewStatus") == "accepted"]
    return rows


def reference_row(plan: dict[str, Any], metadata: list[dict[str, Any]]) -> dict[str, Any]:
    if "referenceClipId" in plan:
        matches = [row for row in metadata if row.get("id") == plan["referenceClipId"]]
    elif "referenceOriginalClipNumber" in plan:
        matches = [row for row in metadata if row.get("originalClipNumber") == plan["referenceOriginalClipNumber"]]
    else:
        raise ValueError("학습 계획에 선택한 참조 클립이 없습니다.")
    if len(matches) != 1:
        raise ValueError("참조 클립을 검수 데이터에서 하나로 확인할 수 없습니다.")
    return matches[0]


def verify_plan(plan: dict[str, Any], dataset: Path) -> dict[str, list[dict[str, Any]]]:
    dataset = dataset.expanduser().resolve()
    if Path(plan["trainJsonl"]).resolve() != (dataset / "official/train_raw.jsonl").resolve():
        raise ValueError("준비된 학습 JSONL 경로와 다릅니다.")
    if "datasetDir" in plan and Path(plan["datasetDir"]).resolve() != dataset:
        raise ValueError("학습 계획의 데이터셋 경로와 다릅니다.")
    if set(plan["splitJsonlSha256"]) != set(SPLITS):
        raise ValueError("학습·검증·시험 분할 해시가 모두 필요합니다.")
    bound_files = {dataset / "manifest.json": plan["datasetManifestSha256"],
        dataset / "metadata.jsonl": plan["metadataSha256"],
        Path(plan["referenceAudio"]): plan["referenceAudioSha256"],
        Path(plan["referenceText"]): plan["referenceTextSha256"]}
    for split, digest in plan["splitJsonlSha256"].items():
        bound_files[dataset / "official" / f"{split}_raw.jsonl"] = digest
    for file, expected in bound_files.items():
        if sha256_file(file) != expected:
            raise ValueError(f"검수 준비 당시와 파일이 다릅니다: {file.name}")
    if "trainJsonlSha256" in plan and plan["trainJsonlSha256"] != plan["splitJsonlSha256"]["train"]:
        raise ValueError("학습 JSONL 해시와 학습 분할 해시가 다릅니다.")
    rows = approved_rows(read_jsonl(dataset / "metadata.jsonl"))
    metadata = {str(Path(row["audio"]).resolve()): row for row in rows}
    if len(metadata) != len(rows):
        raise ValueError("검수 데이터의 음성 경로가 중복됐습니다.")
    seen: set[str] = set()
    audio_hashes: set[str] = set()
    splits = {}
    for split in SPLITS:
        splits[split] = read_jsonl(dataset / "official" / f"{split}_raw.jsonl")
        for row in splits[split]:
            key = str(Path(row["audio"]).resolve())
            known = metadata.get(key)
            digest = sha256_file(Path(key))
            if key in seen or digest in audio_hashes or not known or known["text"] != row["text"] or digest != known["audioSha256"]:
                raise ValueError("학습·보류 데이터가 겹치거나 검수 기록과 다릅니다.")
            seen.add(key)
            audio_hashes.add(digest)
    if len(seen) != len(metadata):
        raise ValueError("학습·보류 데이터 목록에 승인된 검수 클립이 빠졌습니다.")
    if not splits["train"]:
        raise ValueError("학습 데이터가 비어 있습니다.")
    selected_reference = reference_row(plan, rows)
    if selected_reference["audioSha256"] != plan["referenceAudioSha256"] \
            or Path(plan["referenceText"]).read_text(encoding="utf-8").strip() != selected_reference["text"].strip():
        raise ValueError("참조 음성·전사가 선택한 클립과 다릅니다.")
    return splits


def heldout_rows(splits: dict[str, list[dict[str, Any]]], reference_hash: str) -> list[dict[str, Any]]:
    rows = [row for split in ("val", "test") for row in splits[split]
        if sha256_file(Path(row["audio"])) != reference_hash]
    if not rows:
        raise ValueError("참조와 다른 보류 원본이 없어 화자 유사도 평가를 하지 않습니다.")
    return rows


def selected_splits(rows: list[dict[str, Any]], mapping: dict[str, list[str]] | None) -> dict[str, list[dict[str, Any]]]:
    if mapping is None:
        return split_rows(rows)
    if set(mapping) != set(SPLITS):
        raise ValueError("분할 파일에는 train·val·test 목록이 모두 필요합니다.")
    by_id = {row["id"]: row for row in rows}
    assigned = [clip_id for split in SPLITS for clip_id in mapping[split]]
    if len(assigned) != len(set(assigned)) or set(assigned) != set(by_id):
        raise ValueError("분할에는 승인된 클립을 빠짐없이 한 번씩 지정해야 합니다.")
    return {split: [by_id[clip_id] for clip_id in mapping[split]] for split in SPLITS}


def validate_steps(steps: list[int]) -> None:
    if not steps or any(isinstance(step, bool) or not isinstance(step, int) or step <= 0 for step in steps) or len(steps) != len(set(steps)):
        raise ValueError("학습 스텝은 중복 없는 양의 정수 목록이어야 합니다.")


def prepare_training_plan(dataset_dir: Path, *, reference_clip_id: str, steps: list[int],
                          scale: float, reference_text: Path | None = None,
                          split_map: dict[str, list[str]] | None = None,
                          replace_plan: bool = False) -> dict[str, Any]:
    """Bind approved clips, chosen reference and partitions without editing audio."""
    dataset = dataset_dir.expanduser().resolve()
    plan_path = dataset / "training-plan.json"
    if plan_path.exists() and not replace_plan:
        raise FileExistsError("학습 계획이 이미 있습니다. 갱신하려면 --replace-plan을 명시하세요.")
    validate_steps(steps)
    if not math.isfinite(scale) or not 0 < scale <= 1:
        raise ValueError("비교 어댑터 강도는 0보다 크고 1 이하여야 합니다.")
    validate_dataset(dataset)
    all_rows = read_jsonl(dataset / "metadata.jsonl")
    rows = [row for row in all_rows if row.get("reviewStatus") == "accepted"]
    if not rows:
        raise ValueError("accepted로 검수한 클립이 없어 학습 계획을 만들지 않습니다.")
    reference = reference_row({"referenceClipId": reference_clip_id}, rows)
    partitions = selected_splits(rows, split_map)
    if not partitions["train"]:
        raise ValueError("학습 데이터가 비어 있습니다.")
    hashes = [row["audioSha256"] for row in rows]
    if len(hashes) != len(set(hashes)):
        raise ValueError("학습·보류 데이터가 겹치거나 검수 기록과 다릅니다.")
    heldout_rows(partitions, reference["audioSha256"])
    if not reference["text"].strip():
        raise ValueError("참조 클립의 승인 전사가 비어 있습니다.")
    if reference_text is None:
        # The transcript is derived from the selected approved row. Existing
        # transcripts are never silently replaced with another speaker's text.
        text_path = dataset / f"training-reference-{sha256_file(Path(reference['audio']))[:12]}.txt"
        if text_path.exists() and text_path.read_text(encoding="utf-8").strip() != reference["text"].strip():
            raise ValueError("저장된 학습 참조 전사가 선택한 클립과 다릅니다.")
    else:
        text_path = reference_text.expanduser().resolve()
        if text_path.read_text(encoding="utf-8").strip() != reference["text"].strip():
            raise ValueError("참조 전사가 선택한 승인 클립과 다릅니다.")
    if not text_path.exists():
        with text_path.open("x", encoding="utf-8") as handle:
            handle.write(reference["text"].strip() + "\n")
    audio_path = Path(reference["audio"]).resolve()
    manifest_path = dataset / "manifest.json"
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    manifest.update(referenceAudio=str(audio_path), referenceSha256=reference["audioSha256"],
        referenceClipId=reference["id"])
    write_json(manifest_path, manifest)
    official = dataset / "official"
    for split in SPLITS:
        write_jsonl(official / f"{split}_raw.jsonl", [
            {"audio": row["audio"], "text": row["text"], "ref_audio": str(audio_path)}
            for row in partitions[split]])
    counts = {split: len(partitions[split]) for split in SPLITS}
    write_json(official / "split-summary.json", counts)
    plan = {"schemaVersion": 1, "status": "prepared-not-trained", "datasetDir": str(dataset),
        "datasetManifestSha256": sha256_file(dataset / "manifest.json"),
        "metadataSha256": sha256_file(dataset / "metadata.jsonl"),
        "trainJsonl": str(official / "train_raw.jsonl"),
        "trainJsonlSha256": sha256_file(official / "train_raw.jsonl"),
        "splitJsonlSha256": {split: sha256_file(official / f"{split}_raw.jsonl") for split in SPLITS},
        "splits": counts, "acceptedClipIds": [row["id"] for row in rows],
        "excludedClipIds": [row["id"] for row in all_rows if row.get("reviewStatus") != "accepted"],
        "referenceClipId": reference["id"], "referenceAudio": str(audio_path),
        "referenceAudioSha256": reference["audioSha256"], "referenceText": str(text_path),
        "referenceTextSha256": sha256_file(text_path),
        "referenceListeningApproval": reference.get("listeningApproval", "not-performed"),
        "steps": steps, "scaleForComparison": scale, "scaleApproval": "comparison only",
        "productionSettings": "unchanged"}
    if "originalClipNumber" in reference:
        plan["referenceOriginalClipNumber"] = reference["originalClipNumber"]
    verify_plan(plan, dataset)
    write_json(plan_path, plan)
    return plan


def training_arguments(args: argparse.Namespace, *, model_path: Path, output: Path,
                       train_jsonl: Path, steps: int) -> argparse.Namespace:
    from .finetune_mlx import build_parser

    return build_parser().parse_args([
        "--train-jsonl", str(train_jsonl), "--output-dir", str(output), "--model", str(model_path),
        "--max-steps", str(steps), "--warmup-steps", str(args.warmup_steps), "--seed", str(args.seed),
        "--rank", str(args.rank), "--alpha", str(args.alpha),
        "--learning-rate", str(args.learning_rate), "--gradient-accumulation", str(args.gradient_accumulation),
        "--weight-decay", str(args.weight_decay), "--max-seq-length", str(args.max_seq_length),
        "--reference", str(output / "reference.wav"), "--reference-text", str(output / "reference.txt")])


def run_comparison(args: argparse.Namespace) -> dict[str, Any]:
    configure_offline()
    if not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9_-]{0,79}", args.voice_id):
        raise ValueError("voice-id는 영문·숫자로 시작하고 영문·숫자·밑줄·하이픈 80자 이내여야 합니다.")
    if not args.display_name.strip():
        raise ValueError("목소리 표시 이름이 비어 있습니다.")
    if not 1 <= args.quality_attempts <= 5:
        raise ValueError("자동 음성 후보 수는 1~5 사이여야 합니다.")
    if args.rank <= 0 or args.alpha <= 0 or args.gradient_accumulation <= 0 or args.max_seq_length <= 0 \
            or args.warmup_steps < 0 or not math.isfinite(args.learning_rate) or args.learning_rate <= 0 \
            or not math.isfinite(args.weight_decay) or args.weight_decay < 0:
        raise ValueError("학습 설정의 크기·횟수·학습률이 올바르지 않습니다.")
    evaluation_text = args.evaluation_text.expanduser().resolve()
    from .text_candidate import load_text

    load_text(evaluation_text)
    dataset = args.dataset_dir.expanduser().resolve()
    plan_path = dataset / "training-plan.json"
    plan = json.loads(plan_path.read_text(encoding="utf-8"))
    validate_dataset(dataset)
    splits = verify_plan(plan, dataset)
    validate_steps(plan["steps"])
    if not math.isfinite(plan["scaleForComparison"]) or not 0 < plan["scaleForComparison"] <= 1:
        raise ValueError("비교 어댑터 강도는 0보다 크고 1 이하여야 합니다.")
    heldout = heldout_rows(splits, plan["referenceAudioSha256"])
    model_path = installed_model(args.model)
    from .course.settings import LOCAL_QUALITY_ASR_PATH
    from .speech_quality import ASR_REPOSITORY
    from .text_candidate import _installed_model_path, generate_candidate

    _installed_model_path(ASR_REPOSITORY, preferred=LOCAL_QUALITY_ASR_PATH)
    from .finetune_mlx import run_training
    import mlx.core as mx
    import numpy as np

    print("1/4 · GPU와 검수 데이터 확인", flush=True)
    mx.eval(mx.array([1.0]) + 1)
    now = datetime.now(ZoneInfo("Asia/Seoul"))
    day = now.strftime("%Y-%m-%d")
    name = f"{args.voice_id}-r{args.rank}-{now.strftime('%H%M%S')}-{uuid4().hex[:6]}"
    work = args.review_root.expanduser().resolve() / day / name
    work.mkdir(parents=True, exist_ok=False)
    print(f"결과 폴더: {work}", flush=True)
    shutil.copyfile(plan["referenceAudio"], work / "reference.wav")
    shutil.copyfile(plan["referenceText"], work / "reference.txt")
    shutil.copyfile(plan_path, work / "training-plan.json")
    text_path = work / "evaluation.txt"
    shutil.copyfile(evaluation_text, text_path)
    variants = [{"id": "base", "steps": 0, "adapterPath": None}]

    print("2/4 · " + "·".join(f"{step}스텝" for step in plan["steps"]) + " 어댑터 학습", flush=True)
    for steps in plan["steps"]:
        output = args.run_root.expanduser().resolve() / day / f"{name}-s{steps}"
        output.mkdir(parents=True, exist_ok=False)
        shutil.copyfile(work / "reference.wav", output / "reference.wav")
        shutil.copyfile(work / "reference.txt", output / "reference.txt")
        frozen_train = output / "train_raw.jsonl"
        shutil.copyfile(plan["trainJsonl"], frozen_train)
        profile = {"schemaVersion": 1, "voiceId": args.voice_id, "displayName": args.display_name,
            "datasetId": dataset.name, "model": args.model, "modelPath": str(model_path),
            "listeningStatus": "pending", "trainingStatus": "comparison-candidate",
            "referenceAudioPath": "reference.wav", "referenceTextPath": "reference.txt", "trainJsonl": "train_raw.jsonl",
            "referenceAudioSha256": plan["referenceAudioSha256"], "referenceTextSha256": plan["referenceTextSha256"],
            "trainJsonlSha256": sha256_file(frozen_train),
            "training": {"rank": args.rank, "alpha": args.alpha, "maxSteps": steps,
                "gradientAccumulation": args.gradient_accumulation, "learningRate": args.learning_rate,
                "warmupSteps": min(args.warmup_steps, max(0, steps - 1)), "seed": args.seed,
                "weightDecay": args.weight_decay, "maxSequenceLength": args.max_seq_length},
            "comparisonScale": plan["scaleForComparison"], "reviewPlan": str(work / "training-plan.json")}
        write_json(output / "voice-profile.json", profile)
        print(f"학습 후보 {steps}스텝", flush=True)
        result = run_training(training_arguments(args, model_path=model_path, output=output,
            train_jsonl=frozen_train, steps=steps))
        variants.append({"id": f"lora-{steps}", "steps": steps, "adapterPath": str(output / "adapters"),
            "runDir": str(output), "trainingMetrics": result["metrics"]})
        gc.collect()
        mx.clear_cache()

    print("3/4 · 같은 새 대본으로 기본 복제·학습 후보 비교 및 자동 발음 검사", flush=True)
    for variant in variants:
        directory = work / variant["id"]
        directory.mkdir()
        audio = directory / "evaluation.wav"
        metadata_path = directory / "evaluation.json"
        print(f"음성·검수: {variant['id']} (상세 기록은 결과 폴더에 저장)", flush=True)
        with (directory / "generation.log").open("w", encoding="utf-8") as log:
            with contextlib.redirect_stdout(log), contextlib.redirect_stderr(log):
                metadata = generate_candidate(model_key="qwen3-tts", model_path=model_path, text_path=text_path,
                    reference_path=work / "reference.wav", reference_text_path=work / "reference.txt",
                    output_path=audio, metadata_path=metadata_path, seed=args.seed,
                    adapter_path=Path(variant["adapterPath"]) if variant["adapterPath"] else None,
                    adapter_scale=plan["scaleForComparison"], quality_review=True, quality_attempts=args.quality_attempts)
        variant.update(audioPath=str(audio), audioSha256=metadata["audioSha256"], metadataPath=str(metadata_path),
            qualityStatus=metadata["qualityReview"]["status"], findings=metadata["qualityReview"]["findings"],
            contentScore=sum(float(chunk.get("quality", {}).get("score", 0)) for chunk in metadata["chunks"]))
        write_json(work / "comparison-progress.json", {"status": "evaluating", "variants": variants})

    print("4/4 · 합성 음성과 학습에 쓰지 않은 원본의 화자 유사도 비교", flush=True)
    from mlx_audio.tts.utils import load_model
    from mlx_audio.utils import load_audio

    speaker_model = load_model(str(model_path))

    def embedding(file: str) -> Any:
        vector = speaker_model.extract_speaker_embedding(load_audio(str(file), sample_rate=24000), sr=24000)
        mx.eval(vector)
        value = np.asarray(vector).reshape(-1).astype(np.float64)
        norm = np.linalg.norm(value)
        if not np.isfinite(norm) or norm < 1e-12:
            raise ValueError("화자 유사도를 계산할 수 없습니다.")
        return value / norm

    target = np.mean([embedding(row["audio"]) for row in heldout], axis=0)
    target_norm = np.linalg.norm(target)
    if not np.isfinite(target_norm) or target_norm < 1e-12:
        raise ValueError("보류 원본의 화자 유사도를 계산할 수 없습니다.")
    target /= target_norm
    for variant in variants:
        if sha256_file(Path(variant["audioPath"])) != variant["audioSha256"]:
            raise ValueError("평가 음성이 생성 당시와 달라졌습니다.")
        variant["speakerCosine"] = round(float(np.clip(embedding(variant["audioPath"]) @ target, -1, 1)), 6)

    selected = min((variant for variant in variants if variant["steps"]), key=ranking)
    run_dir = Path(selected["runDir"])
    profile_path = run_dir / "voice-profile.json"
    profile = json.loads(profile_path.read_text(encoding="utf-8"))
    profile.update(trainingStatus="complete", comparisonResult=str(work / "comparison.json"),
        evaluationQualityStatus=selected["qualityStatus"], listeningStatus="pending")
    shutil.copyfile(selected["audioPath"], run_dir / "preview.wav")
    shutil.copyfile(selected["metadataPath"], run_dir / "preview.json")
    baseline = variants[0]
    comparison = {"schemaVersion": 1, "status": "trained-awaiting-listening", "variants": variants,
        "voiceId": args.voice_id, "displayName": args.display_name,
        "selectedAdapterVariant": selected["id"], "baselineRanksBetter": ranking(baseline) < ranking(selected),
        "heldoutAudioPaths": [row["audio"] for row in heldout],
        "speakerSimilarityMeaning": "Fixed Base encoder cosine to held-out originals; not identity probability or listening approval.",
        "productionSettings": "unchanged", "listeningApproval": "not-performed"}
    for key in ("referenceClipId", "referenceOriginalClipNumber"):
        if key in plan:
            comparison[key] = plan[key]
    write_json(work / "comparison.json", comparison)
    summary = {"status": comparison["status"], "voiceId": args.voice_id, "displayName": args.display_name,
        "selectedAdapterVariant": selected["id"], "adapterPath": selected["adapterPath"],
        "referenceAudio": str(run_dir / "reference.wav"), "referenceText": str(run_dir / "reference.txt"),
        "baselineRanksBetter": comparison["baselineRanksBetter"],
        "variants": [{key: value[key] for key in ("id", "steps", "qualityStatus", "contentScore", "speakerCosine")} for value in variants],
        "comparisonPath": str(work / "comparison.json"), "productionSettings": "unchanged"}
    write_json(work / "summary.json", summary)
    write_json(dataset / "latest-training-result.json", summary)
    # Only complete comparisons expose a discoverable trained profile.
    write_json(profile_path, profile)
    return summary


def build_parser(config: dict[str, Any] | None = None) -> argparse.ArgumentParser:
    config = config if config is not None else load_config()
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--config", type=Path, default=DEFAULT_CONFIG)
    subparsers = parser.add_subparsers(dest="command", required=True)
    prepare = subparsers.add_parser("prepare", help="승인 클립의 참조·분할·해시를 학습 계획에 저장")
    prepare.add_argument("--config", type=Path, default=argparse.SUPPRESS)
    prepare.add_argument("--dataset-dir", type=Path, required=True)
    prepare.add_argument("--reference-clip", required=True, help="accepted metadata 클립 ID")
    prepare.add_argument("--reference-text", type=Path, help="선택 클립과 일치하는 전사 파일; 생략하면 승인 전사로 새 파일 생성")
    prepare.add_argument("--split-map", type=Path, help="train·val·test별 승인 클립 ID 목록 JSON; 생략하면 결정적 기본 분할")
    prepare.add_argument("--steps", type=int, nargs="+", default=config["comparison"]["steps"])
    prepare.add_argument("--scale", type=float, default=config["preview"]["scale"])
    prepare.add_argument("--replace-plan", action="store_true")
    compare = subparsers.add_parser("compare", help="학습 계획을 검증하고 어댑터 후보를 같은 대본으로 비교")
    compare.add_argument("--config", type=Path, default=argparse.SUPPRESS)
    compare.add_argument("--dataset-dir", type=Path, required=True)
    compare.add_argument("--display-name", required=True)
    compare.add_argument("--voice-id", required=True, help="결과 폴더와 프로필에 사용하는 목소리 식별자")
    compare.add_argument("--evaluation-text", type=Path, required=True)
    compare.add_argument("--review-root", type=Path, required=True)
    compare.add_argument("--run-root", type=Path, required=True)
    compare.add_argument("--model", default=config["model"], help="설치된 Qwen3-TTS Base 모델 저장소 또는 로컬 경로")
    compare.add_argument("--seed", type=int, default=config["comparison"]["seed"])
    compare.add_argument("--warmup-steps", type=int, default=config["comparison"]["warmupSteps"])
    compare.add_argument("--quality-attempts", type=int, default=config["comparison"]["qualityAttempts"])
    compare.add_argument("--rank", type=int, default=config["training"]["rank"])
    compare.add_argument("--alpha", type=int, default=config["training"]["alpha"])
    compare.add_argument("--learning-rate", type=float, default=config["training"]["learningRate"])
    compare.add_argument("--gradient-accumulation", type=int, default=config["training"]["gradientAccumulation"])
    compare.add_argument("--weight-decay", type=float, default=config["training"]["weightDecay"])
    compare.add_argument("--max-seq-length", type=int, default=config["training"]["maxSequenceLength"])
    return parser


def main(argv: list[str] | None = None) -> int:
    try:
        config_path = config_argument(argv)
        args = build_parser(load_config(config_path)).parse_args(argv)
        if args.command == "prepare":
            mapping = json.loads(args.split_map.read_text(encoding="utf-8")) if args.split_map else None
            result = prepare_training_plan(args.dataset_dir, reference_clip_id=args.reference_clip,
                steps=args.steps, scale=args.scale, reference_text=args.reference_text,
                split_map=mapping, replace_plan=args.replace_plan)
            print("학습 계획 준비 완료 · 실제 학습과 청취 승인은 아직 수행하지 않았습니다.", flush=True)
        else:
            result = run_comparison(args)
            print("\n학습·참조 설정·비교 완료 · 아래 요약을 채팅에 붙여 주세요.", flush=True)
        print(json.dumps(result, ensure_ascii=False, indent=2), flush=True)
        return 0
    except Exception:
        traceback.print_exc()
        print("\n학습 준비 또는 비교가 완료되지 않았습니다. 마지막 오류를 채팅에 전달해 주세요.", flush=True)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
