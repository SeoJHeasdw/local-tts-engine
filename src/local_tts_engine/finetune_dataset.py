"""Prepare a reviewed single-speaker Qwen3-TTS fine-tuning dataset.

원본 WAV는 읽기 전용으로 사용한다. 학습용 짧은 클립, ASR 초벌 전사,
사람 검수표, 공식 Qwen JSONL은 모두 artifacts 아래 별도 데이터셋에 만든다.
실제 학습이나 모델 다운로드는 이 모듈의 책임이 아니다.
"""

from __future__ import annotations

import argparse
import csv
import difflib
import hashlib
import html
import json
import math
import re
import subprocess
import sys
from dataclasses import asdict, dataclass
from pathlib import Path
from typing import Any, Iterable

import numpy as np
import soundfile as sf


DEFAULT_MASTER_DIR = Path(
    "/Users/jaehoseo/Desktop/vswrk/javis/local-tts-engine/data/private/voice/training/pvc/master-wav"
)
DEFAULT_REFERENCE = Path("artifacts/benchmarks/2026-08-23/reference.wav")
DEFAULT_ASR_MODEL = "mlx-community/Qwen3-ASR-0.6B-8bit"
SCHEMA_VERSION = 1
DEFAULT_TRANSCRIPT_MAP = Path("config/finetune-transcript-map.json")
REVIEW_FIELDS = (
    "id",
    "audio",
    "duration_s",
    "text",
    "asr_text",
    "script_similarity",
    "recommendation",
    "status",
    "notes",
)
VALID_REVIEW_STATUSES = {"pending", "accepted", "rejected"}


@dataclass(frozen=True)
class SegmentPlan:
    start_sample: int
    end_sample: int
    method: str


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for block in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def write_json(path: Path, value: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(
        json.dumps(value, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )


def read_jsonl(path: Path) -> list[dict[str, Any]]:
    if not path.is_file():
        raise FileNotFoundError(path)
    return [
        json.loads(line)
        for line in path.read_text(encoding="utf-8").splitlines()
        if line.strip()
    ]


def write_jsonl(path: Path, rows: Iterable[dict[str, Any]]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("w", encoding="utf-8") as handle:
        for row in rows:
            handle.write(json.dumps(row, ensure_ascii=False) + "\n")


def dbfs(audio: np.ndarray) -> float:
    if audio.size == 0:
        return -120.0
    rms = math.sqrt(float(np.mean(np.square(audio.astype(np.float64)))))
    return 20 * math.log10(max(rms, 1e-6))


def silence_midpoints(
    audio: np.ndarray,
    sample_rate: int,
    *,
    silence_dbfs: float = -45.0,
    min_silence_ms: int = 240,
    frame_ms: int = 20,
) -> list[int]:
    """Return sample positions at the middle of sufficiently long silences."""
    frame_samples = max(1, round(sample_rate * frame_ms / 1000))
    frame_count = math.ceil(len(audio) / frame_samples)
    padded = np.pad(audio, (0, frame_count * frame_samples - len(audio)))
    frames = padded.reshape(frame_count, frame_samples).astype(np.float64)
    rms = np.sqrt(np.mean(np.square(frames), axis=1))
    frame_db = 20 * np.log10(np.maximum(rms, 1e-6))
    silent = frame_db <= silence_dbfs
    required = max(1, math.ceil(min_silence_ms / frame_ms))

    points: list[int] = []
    start: int | None = None
    for index, is_silent in enumerate(np.append(silent, False)):
        if is_silent and start is None:
            start = index
        elif not is_silent and start is not None:
            if index - start >= required:
                midpoint_frame = (start + index) // 2
                points.append(min(len(audio), midpoint_frame * frame_samples))
            start = None
    return points


def plan_segments(
    total_samples: int,
    sample_rate: int,
    silence_points: Iterable[int],
    *,
    min_seconds: float = 3.0,
    target_seconds: float = 8.0,
    max_seconds: float = 14.0,
    absolute_max_seconds: float = 18.0,
) -> list[SegmentPlan]:
    """Plan contiguous clips, preferring silence nearest the target duration."""
    if not (0 < min_seconds <= target_seconds <= max_seconds <= absolute_max_seconds):
        raise ValueError("분할 길이는 0 < min <= target <= max <= absolute-max 여야 합니다.")

    minimum = round(min_seconds * sample_rate)
    target = round(target_seconds * sample_rate)
    maximum = round(max_seconds * sample_rate)
    absolute_max = round(absolute_max_seconds * sample_rate)
    points = sorted({point for point in silence_points if 0 < point < total_samples})
    plans: list[SegmentPlan] = []
    start = 0

    while start < total_samples:
        remaining = total_samples - start
        if remaining <= maximum:
            plans.append(SegmentPlan(start, total_samples, "tail"))
            break

        preferred = [point for point in points if start + minimum <= point <= start + maximum]
        if preferred:
            end = min(preferred, key=lambda point: (abs(point - (start + target)), point))
            method = "silence"
        else:
            extended = [
                point for point in points
                if start + maximum < point <= start + absolute_max
            ]
            if extended:
                end = extended[0]
                method = "extended-silence"
            else:
                end = min(total_samples, start + maximum)
                method = "hard-cut-review"
        plans.append(SegmentPlan(start, end, method))
        start = end

    if len(plans) > 1 and plans[-1].end_sample - plans[-1].start_sample < minimum:
        previous = plans[-2]
        tail = plans[-1]
        merged_duration = tail.end_sample - previous.start_sample
        if merged_duration <= absolute_max:
            plans[-2:] = [
                SegmentPlan(previous.start_sample, tail.end_sample, "merged-short-tail")
            ]
    return plans


def normalize_transcript(text: str) -> str:
    return " ".join(text.replace("\t", " ").split()).strip()


def comparison_text(text: str) -> str:
    return re.sub(r"[^0-9A-Za-z가-힣]", "", text).lower()


def comparison_text_map(text: str) -> tuple[str, list[int]]:
    chars: list[str] = []
    positions: list[int] = []
    for index, char in enumerate(text):
        if re.fullmatch(r"[0-9A-Za-z가-힣]", char):
            chars.append(char.lower())
            positions.append(index)
    return "".join(chars), positions


def script_sections(repo: Path, revision: str, chapter: str) -> list[tuple[str, str]]:
    raw = subprocess.check_output(
        ["git", "-C", str(repo), "show", f"{revision}:deck/script/course/{chapter}.md"],
        text=True,
    )
    result: list[tuple[str, str]] = []
    current: str | None = None
    buffer: list[str] = []

    def flush() -> None:
        if current is None:
            return
        text = normalize_transcript(
            " ".join(
                line.strip()
                for line in buffer
                if line.strip()
                and not line.startswith("#")
                and not line.startswith(">")
                and line.strip() != "---"
            )
        )
        result.append((current, text))

    for line in raw.splitlines():
        match = re.match(r"^##\s+(.+?)\s*$", line)
        if match:
            flush()
            current = match.group(1)
            buffer = []
        elif current is not None:
            buffer.append(line)
    flush()
    return result


def section_span(sections: list[tuple[str, str]], start: str, end: str) -> str:
    keys = [key for key, _ in sections]
    if start not in keys or end not in keys:
        raise ValueError(f"대본 범위를 찾지 못했습니다: {start} -> {end}")
    start_index = keys.index(start)
    end_index = keys.index(end)
    if start_index > end_index:
        raise ValueError(f"대본 범위 순서가 반대입니다: {start} -> {end}")
    return " ".join(text for _, text in sections[start_index:end_index + 1])


def reconcile_source_rows(
    rows: list[dict[str, Any]],
    script_text: str,
    *,
    accept_similarity: float = 0.90,
) -> float:
    """Partition one historical script across sequential ASR clips."""
    asr_texts = [row.get("asrText") or row.get("text") or "" for row in rows]
    joined_asr = " ".join(asr_texts)
    asr_normalized, _ = comparison_text_map(joined_asr)
    script_normalized, script_positions = comparison_text_map(script_text)
    matcher = difflib.SequenceMatcher(
        None,
        asr_normalized,
        script_normalized,
        autojunk=False,
    )
    opcodes = matcher.get_opcodes()

    def map_position(position: int) -> int:
        if position <= 0:
            return 0
        if position >= len(asr_normalized):
            return len(script_normalized)
        for _, a_start, a_end, b_start, b_end in opcodes:
            if a_start <= position <= a_end:
                if a_end == a_start:
                    return b_start
                ratio = (position - a_start) / (a_end - a_start)
                return round(b_start + ratio * (b_end - b_start))
        return len(script_normalized)

    normalized_boundaries = [0]
    cursor = 0
    for asr_text in asr_texts:
        cursor += len(comparison_text(asr_text))
        normalized_boundaries.append(map_position(cursor))

    def to_original_position(position: int) -> int:
        if position <= 0 or not script_positions:
            return 0
        if position >= len(script_positions):
            return len(script_text)
        return script_positions[position]

    rough_boundaries = [to_original_position(position) for position in normalized_boundaries]
    whitespace_boundaries = [
        index
        for index in range(1, len(script_text))
        if script_text[index - 1].isspace() or script_text[index].isspace()
    ]
    boundaries = [0]
    for rough in rough_boundaries[1:-1]:
        nearby = [point for point in whitespace_boundaries if abs(point - rough) <= 32]
        snapped = min(nearby, key=lambda point: abs(point - rough)) if nearby else rough
        boundaries.append(max(boundaries[-1], snapped))
    boundaries.append(len(script_text))

    for index, row in enumerate(rows):
        candidate = script_text[boundaries[index]:boundaries[index + 1]].strip(
            " \t\n,.;:!?“”\""
        )
        asr_text = asr_texts[index]
        score = difflib.SequenceMatcher(
            None,
            comparison_text(asr_text),
            comparison_text(candidate),
            autojunk=False,
        ).ratio()
        row["asrText"] = asr_text
        row["text"] = candidate
        row["scriptSimilarity"] = round(score, 4)
        row["reviewRecommendation"] = (
            "spot-check" if candidate and score >= accept_similarity else "listen"
        )
        row["reviewStatus"] = "pending"
    return matcher.ratio()


def refresh_review_tsv(dataset_dir: Path, rows: list[dict[str, Any]]) -> Path:
    review_path = dataset_dir / "review.tsv"
    with review_path.open("w", encoding="utf-8", newline="") as handle:
        writer = csv.DictWriter(handle, fieldnames=REVIEW_FIELDS, delimiter="\t")
        writer.writeheader()
        for row in rows:
            writer.writerow(
                {
                    "id": row["id"],
                    "audio": row["audio"],
                    "duration_s": f"{row['durationMs'] / 1000:.3f}",
                    "text": row.get("text", ""),
                    "asr_text": row.get("asrText", ""),
                    "script_similarity": row.get("scriptSimilarity", ""),
                    "recommendation": row.get("reviewRecommendation", ""),
                    "status": row.get("reviewStatus", "pending"),
                    "notes": row.get("reviewNotes", ""),
                }
            )
    return review_path


def segment_dataset(
    *,
    source_dir: Path,
    output_dir: Path,
    reference: Path,
    source_pattern: str = "*.wav",
    max_source_seconds: float | None = None,
    min_seconds: float = 3.0,
    target_seconds: float = 8.0,
    max_seconds: float = 14.0,
    silence_dbfs: float = -45.0,
    min_silence_ms: int = 240,
) -> dict[str, Any]:
    metadata_path = output_dir / "metadata.jsonl"
    if metadata_path.exists():
        raise FileExistsError(
            f"기존 데이터셋을 덮어쓰지 않습니다: {output_dir}. 새 output-dir을 사용하세요."
        )
    if not reference.is_file():
        raise FileNotFoundError(f"참조 음성이 없습니다: {reference}")
    sources = sorted(source_dir.glob(source_pattern))
    if not sources:
        raise FileNotFoundError(f"학습 정본을 찾지 못했습니다: {source_dir}/{source_pattern}")

    clips_dir = output_dir / "clips"
    clips_dir.mkdir(parents=True, exist_ok=True)
    rows: list[dict[str, Any]] = []
    source_records: list[dict[str, Any]] = []

    for source in sources:
        info = sf.info(source)
        if info.channels != 1:
            raise ValueError(f"모노 정본만 허용합니다: {source}")
        audio, sample_rate = sf.read(source, dtype="float32", always_2d=False)
        if max_source_seconds is not None:
            audio = audio[: round(max_source_seconds * sample_rate)]
        source_hash = sha256_file(source)
        points = silence_midpoints(
            np.asarray(audio),
            sample_rate,
            silence_dbfs=silence_dbfs,
            min_silence_ms=min_silence_ms,
        )
        plans = plan_segments(
            len(audio),
            sample_rate,
            points,
            min_seconds=min_seconds,
            target_seconds=target_seconds,
            max_seconds=max_seconds,
        )
        source_records.append(
            {
                "id": source.stem,
                "path": str(source.resolve()),
                "sha256": source_hash,
                "sampleRate": sample_rate,
                "durationMs": round(len(audio) * 1000 / sample_rate),
                "segmentCount": len(plans),
            }
        )
        for index, plan in enumerate(plans, start=1):
            clip = np.asarray(audio[plan.start_sample:plan.end_sample])
            clip_id = f"{source.stem}-{index:04d}"
            clip_path = clips_dir / f"{clip_id}.wav"
            sf.write(clip_path, clip, sample_rate, subtype="PCM_24")
            peak = float(np.max(np.abs(clip))) if clip.size else 0.0
            rows.append(
                {
                    "schemaVersion": SCHEMA_VERSION,
                    "id": clip_id,
                    "audio": str(clip_path.resolve()),
                    "audioSha256": sha256_file(clip_path),
                    "sourceAudio": str(source.resolve()),
                    "sourceSha256": source_hash,
                    "startMs": round(plan.start_sample * 1000 / sample_rate),
                    "endMs": round(plan.end_sample * 1000 / sample_rate),
                    "durationMs": round(len(clip) * 1000 / sample_rate),
                    "sampleRate": sample_rate,
                    "channels": 1,
                    "rmsDbfs": round(dbfs(clip), 2),
                    "peakDbfs": round(20 * math.log10(max(peak, 1e-6)), 2),
                    "splitMethod": plan.method,
                    "text": "",
                    "asrModel": None,
                    "asrLanguage": None,
                    "reviewStatus": "pending",
                    "reviewNotes": "분할 경계 확인 필요" if "hard-cut" in plan.method else "",
                }
            )

    write_jsonl(metadata_path, rows)
    refresh_review_tsv(output_dir, rows)
    manifest = {
        "schemaVersion": SCHEMA_VERSION,
        "purpose": "Qwen3-TTS single-speaker fine-tuning dataset preparation",
        "sourcePolicy": "read-only canonical masters; clips are disposable derivatives",
        "referenceAudio": str(reference.resolve()),
        "referenceSha256": sha256_file(reference),
        "segmentation": {
            "minSeconds": min_seconds,
            "targetSeconds": target_seconds,
            "maxSeconds": max_seconds,
            "silenceDbfs": silence_dbfs,
            "minSilenceMs": min_silence_ms,
        },
        "sources": source_records,
        "stats": dataset_stats(rows),
    }
    write_json(output_dir / "manifest.json", manifest)
    return manifest


def transcribe_dataset(
    dataset_dir: Path,
    *,
    model_name: str = DEFAULT_ASR_MODEL,
    limit: int | None = None,
) -> dict[str, Any]:
    rows = read_jsonl(dataset_dir / "metadata.jsonl")
    targets = [row for row in rows if not row.get("text")]
    if limit is not None:
        targets = targets[:limit]
    if not targets:
        return dataset_stats(rows)

    from mlx_audio.stt import load

    model = load(model_name)
    for index, row in enumerate(targets, start=1):
        result = model.generate(
            row["audio"],
            language="Korean",
            temperature=0.0,
            max_tokens=384,
        )
        row["text"] = normalize_transcript(result.text)
        row["asrModel"] = model_name
        language = getattr(result, "language", None)
        row["asrLanguage"] = language
        row["reviewStatus"] = "pending"
        print(f"[asr {index}/{len(targets)}] {row['id']}: {row['text']}")

    write_jsonl(dataset_dir / "metadata.jsonl", rows)
    refresh_review_tsv(dataset_dir, rows)
    update_manifest_stats(dataset_dir, rows)
    return dataset_stats(rows)


def apply_review(dataset_dir: Path) -> dict[str, Any]:
    metadata_path = dataset_dir / "metadata.jsonl"
    review_path = dataset_dir / "review.tsv"
    rows = read_jsonl(metadata_path)
    by_id = {row["id"]: row for row in rows}
    seen: set[str] = set()
    with review_path.open("r", encoding="utf-8", newline="") as handle:
        for review in csv.DictReader(handle, delimiter="\t"):
            clip_id = review.get("id", "")
            if clip_id not in by_id:
                raise ValueError(f"검수표에 알 수 없는 ID가 있습니다: {clip_id}")
            if clip_id in seen:
                raise ValueError(f"검수표 ID가 중복됐습니다: {clip_id}")
            seen.add(clip_id)
            status = (review.get("status") or "pending").strip().lower()
            if status not in VALID_REVIEW_STATUSES:
                raise ValueError(f"잘못된 검수 상태입니다: {clip_id}={status}")
            text = normalize_transcript(review.get("text") or "")
            if status == "accepted" and not text:
                raise ValueError(f"승인 항목에는 정확한 전사가 필요합니다: {clip_id}")
            row = by_id[clip_id]
            row["text"] = text
            row["reviewStatus"] = status
            row["reviewNotes"] = normalize_transcript(review.get("notes") or "")
    if seen != set(by_id):
        missing = sorted(set(by_id) - seen)
        raise ValueError(f"검수표에서 {len(missing)}개 ID가 누락됐습니다: {missing[:3]}")

    write_jsonl(metadata_path, rows)
    refresh_review_tsv(dataset_dir, rows)
    update_manifest_stats(dataset_dir, rows)
    return dataset_stats(rows)


def apply_decisions(
    dataset_dir: Path,
    decisions_path: Path,
    *,
    auto_accept_exact: bool = False,
) -> dict[str, Any]:
    rows = read_jsonl(dataset_dir / "metadata.jsonl")
    by_id = {row["id"]: row for row in rows}
    if auto_accept_exact:
        for row in rows:
            if (
                row.get("reviewStatus") == "pending"
                and row.get("text")
                and float(row.get("scriptSimilarity", 0)) == 1.0
            ):
                row["reviewStatus"] = "accepted"
                row["reviewNotes"] = "ASR과 녹음 당시 대본이 글자 단위로 일치"

    payload = json.loads(decisions_path.read_text(encoding="utf-8"))
    seen: set[str] = set()
    for decision in payload["decisions"]:
        clip_id = decision["id"]
        if clip_id not in by_id:
            raise ValueError(f"결정 파일에 알 수 없는 ID가 있습니다: {clip_id}")
        if clip_id in seen:
            raise ValueError(f"결정 파일 ID가 중복됐습니다: {clip_id}")
        seen.add(clip_id)
        status = decision["status"]
        if status not in VALID_REVIEW_STATUSES:
            raise ValueError(f"잘못된 결정 상태입니다: {clip_id}={status}")
        row = by_id[clip_id]
        text = normalize_transcript(decision.get("text", row.get("text", "")))
        if status == "accepted" and not text:
            raise ValueError(f"승인 결정에는 정확한 전사가 필요합니다: {clip_id}")
        row["text"] = text
        row["reviewStatus"] = status
        row["reviewNotes"] = normalize_transcript(decision.get("notes", ""))

    write_jsonl(dataset_dir / "metadata.jsonl", rows)
    refresh_review_tsv(dataset_dir, rows)
    update_manifest_stats(dataset_dir, rows)
    return dataset_stats(rows)


def reconcile_historical_scripts(
    dataset_dir: Path,
    *,
    mapping_path: Path = DEFAULT_TRANSCRIPT_MAP,
) -> dict[str, Any]:
    config = json.loads(mapping_path.read_text(encoding="utf-8"))
    repo = Path(config["scriptRepo"])
    revision = config["revision"]
    rows = read_jsonl(dataset_dir / "metadata.jsonl")
    by_source: dict[str, list[dict[str, Any]]] = {}
    for row in rows:
        source_id = Path(row["sourceAudio"]).stem
        by_source.setdefault(source_id, []).append(row)

    section_cache: dict[str, list[tuple[str, str]]] = {}
    source_scores: dict[str, float] = {}
    for source_id, source_rows in by_source.items():
        if source_id not in config["sources"]:
            raise ValueError(f"대본 매핑에 정본이 없습니다: {source_id}")
        item = config["sources"][source_id]
        chapter = item["chapter"]
        if chapter not in section_cache:
            section_cache[chapter] = script_sections(repo, revision, chapter)
        candidate = section_span(
            section_cache[chapter],
            item["startSlide"],
            item["endSlide"],
        )
        score = reconcile_source_rows(source_rows, candidate)
        source_scores[source_id] = round(score, 4)
        for row in source_rows:
            row["scriptRevision"] = revision
            row["scriptRange"] = f"{chapter}:{item['startSlide']}..{item['endSlide']}"

    write_jsonl(dataset_dir / "metadata.jsonl", rows)
    refresh_review_tsv(dataset_dir, rows)
    manifest_path = dataset_dir / "manifest.json"
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    manifest["transcriptReconciliation"] = {
        "scriptRepo": str(repo.resolve()),
        "revision": revision,
        "mapping": str(mapping_path.resolve()),
        "sourceSimilarity": source_scores,
    }
    manifest["stats"] = dataset_stats(rows)
    write_json(manifest_path, manifest)
    return {"sourceSimilarity": source_scores, "stats": dataset_stats(rows)}


def split_rows(rows: list[dict[str, Any]]) -> dict[str, list[dict[str, Any]]]:
    ordered = sorted(rows, key=lambda row: hashlib.sha256(row["id"].encode()).hexdigest())
    count = len(ordered)
    if count < 3:
        return {"train": ordered, "val": [], "test": []}
    val_count = max(1, round(count * 0.05))
    test_count = max(1, round(count * 0.05))
    return {
        "test": ordered[:test_count],
        "val": ordered[test_count:test_count + val_count],
        "train": ordered[test_count + val_count:],
    }


def export_official_jsonl(dataset_dir: Path) -> dict[str, int]:
    rows = read_jsonl(dataset_dir / "metadata.jsonl")
    accepted = [row for row in rows if row.get("reviewStatus") == "accepted"]
    if not accepted:
        raise ValueError("사람이 accepted로 승인한 클립이 없어 내보내지 않습니다.")
    reference = json.loads((dataset_dir / "manifest.json").read_text(encoding="utf-8"))[
        "referenceAudio"
    ]
    splits = split_rows(accepted)
    official_dir = dataset_dir / "official"
    result: dict[str, int] = {}
    for name, items in splits.items():
        payload = [
            {"audio": row["audio"], "text": row["text"], "ref_audio": reference}
            for row in items
        ]
        write_jsonl(official_dir / f"{name}_raw.jsonl", payload)
        result[name] = len(payload)
    write_json(official_dir / "split-summary.json", result)
    return result


def make_spot_check_page(dataset_dir: Path, *, per_source: int = 2) -> Path:
    rows = read_jsonl(dataset_dir / "metadata.jsonl")
    grouped: dict[str, list[dict[str, Any]]] = {}
    for row in rows:
        if row.get("reviewRecommendation") != "spot-check":
            continue
        grouped.setdefault(Path(row["sourceAudio"]).stem, []).append(row)

    selected: list[dict[str, Any]] = []
    for source_id, items in sorted(grouped.items()):
        ordered = sorted(items, key=lambda row: row["id"])
        if len(ordered) <= per_source:
            picks = ordered
        else:
            picks = [
                ordered[round((index + 1) * (len(ordered) - 1) / (per_source + 1))]
                for index in range(per_source)
            ]
        for row in picks:
            selected.append({"source": source_id, **row})

    if not selected:
        raise ValueError("spot-check 후보가 없습니다. 먼저 reconcile-script를 실행하세요.")

    review_dir = dataset_dir / "spot-check"
    review_dir.mkdir(parents=True, exist_ok=True)
    write_json(review_dir / "samples.json", selected)
    cards = []
    for index, row in enumerate(selected, start=1):
        audio_uri = f"../clips/{Path(row['audio']).name}"
        cards.append(
            f"""
            <article>
              <div class="meta">#{index:02d} · {html.escape(row['source'])} · {row['durationMs'] / 1000:.2f}초 · 일치도 {row['scriptSimilarity']:.1%}</div>
              <p>{html.escape(row['text'])}</p>
              <audio controls preload="metadata" src="{html.escape(audio_uri)}"></audio>
              <div class="answer">판정: 음성과 위 문장이 같으면 통과</div>
            </article>
            """
        )
    page = f"""<!doctype html>
<html lang="ko"><head><meta charset="utf-8"><title>Qwen3-TTS 학습 데이터 10개 확인</title>
<style>
body{{font-family:-apple-system,BlinkMacSystemFont,'Apple SD Gothic Neo',sans-serif;background:#0c1020;color:#eef2ff;max-width:920px;margin:0 auto;padding:36px 20px 80px}}
h1{{font-size:28px}} .lead{{color:#b8c1dc;line-height:1.7}} article{{background:#151b31;border:1px solid #2b3559;border-radius:16px;padding:20px;margin:18px 0}}
.meta{{color:#91a4df;font-size:14px}} p{{font-size:20px;line-height:1.65}} audio{{width:100%}} .answer{{margin-top:12px;color:#ffd166;font-size:14px}}
</style></head><body>
<h1>학습 데이터 대표 10개 확인</h1>
<p class="lead">각 음성을 듣고 위 문장과 실제 발화가 같은지만 확인하세요. 억양 취향이나 ASR 철자는 볼 필요 없습니다. 10개가 모두 맞으면 나머지 고신뢰 후보를 일괄 승인할 수 있습니다.</p>
{''.join(cards)}
</body></html>"""
    page_path = review_dir / "index.html"
    page_path.write_text(page, encoding="utf-8")
    return page_path


def dataset_stats(rows: list[dict[str, Any]]) -> dict[str, Any]:
    statuses = {status: 0 for status in sorted(VALID_REVIEW_STATUSES)}
    for row in rows:
        statuses[row.get("reviewStatus", "pending")] += 1
    return {
        "clips": len(rows),
        "durationSeconds": round(sum(row["durationMs"] for row in rows) / 1000, 3),
        "transcribed": sum(bool(row.get("text")) for row in rows),
        "hardCutReview": sum(row.get("splitMethod") == "hard-cut-review" for row in rows),
        "review": statuses,
        "recommendation": {
            "spotCheck": sum(row.get("reviewRecommendation") == "spot-check" for row in rows),
            "listen": sum(row.get("reviewRecommendation") == "listen" for row in rows),
        },
    }


def update_manifest_stats(dataset_dir: Path, rows: list[dict[str, Any]]) -> None:
    path = dataset_dir / "manifest.json"
    manifest = json.loads(path.read_text(encoding="utf-8"))
    manifest["stats"] = dataset_stats(rows)
    write_json(path, manifest)


def validate_dataset(dataset_dir: Path) -> dict[str, Any]:
    manifest = json.loads((dataset_dir / "manifest.json").read_text(encoding="utf-8"))
    rows = read_jsonl(dataset_dir / "metadata.jsonl")
    errors: list[str] = []
    ids: set[str] = set()
    for source in manifest["sources"]:
        path = Path(source["path"])
        if not path.is_file() or sha256_file(path) != source["sha256"]:
            errors.append(f"정본 변경 또는 누락: {path}")
    for row in rows:
        if row["id"] in ids:
            errors.append(f"중복 ID: {row['id']}")
        ids.add(row["id"])
        audio = Path(row["audio"])
        if not audio.is_file() or sha256_file(audio) != row["audioSha256"]:
            errors.append(f"클립 변경 또는 누락: {audio}")
        if row.get("reviewStatus") == "accepted" and not row.get("text"):
            errors.append(f"승인 전사 누락: {row['id']}")
    if errors:
        raise ValueError("\n".join(errors))
    return dataset_stats(rows)


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__)
    subparsers = parser.add_subparsers(dest="command", required=True)

    segment = subparsers.add_parser("segment", help="정본 WAV를 학습용 짧은 클립으로 분할")
    segment.add_argument("--source-dir", type=Path, default=DEFAULT_MASTER_DIR)
    segment.add_argument("--source-pattern", default="*.wav")
    segment.add_argument("--output-dir", type=Path, required=True)
    segment.add_argument("--reference", type=Path, default=DEFAULT_REFERENCE)
    segment.add_argument("--max-source-seconds", type=float)
    segment.add_argument("--min-seconds", type=float, default=3.0)
    segment.add_argument("--target-seconds", type=float, default=8.0)
    segment.add_argument("--max-seconds", type=float, default=14.0)
    segment.add_argument("--silence-dbfs", type=float, default=-45.0)
    segment.add_argument("--min-silence-ms", type=int, default=240)

    transcribe = subparsers.add_parser("transcribe", help="Qwen3-ASR 초벌 전사 생성")
    transcribe.add_argument("--dataset-dir", type=Path, required=True)
    transcribe.add_argument("--model", default=DEFAULT_ASR_MODEL)
    transcribe.add_argument("--limit", type=int)

    review = subparsers.add_parser("apply-review", help="편집한 review.tsv를 반영")
    review.add_argument("--dataset-dir", type=Path, required=True)

    reconcile = subparsers.add_parser(
        "reconcile-script", help="녹음 당시 Git 대본을 ASR 클립에 자동 배치"
    )
    reconcile.add_argument("--dataset-dir", type=Path, required=True)
    reconcile.add_argument("--mapping", type=Path, default=DEFAULT_TRANSCRIPT_MAP)

    decisions = subparsers.add_parser(
        "apply-decisions", help="소수 청취 결과와 보수적 자동 승인 규칙 반영"
    )
    decisions.add_argument("--dataset-dir", type=Path, required=True)
    decisions.add_argument("--decisions", type=Path, required=True)
    decisions.add_argument("--auto-accept-exact", action="store_true")

    validate = subparsers.add_parser("validate", help="정본·클립·검수 상태 검증")
    validate.add_argument("--dataset-dir", type=Path, required=True)

    export = subparsers.add_parser("export", help="승인 클립을 공식 Qwen JSONL로 내보내기")
    export.add_argument("--dataset-dir", type=Path, required=True)

    spot = subparsers.add_parser("spot-check", help="대표 음성 10개 로컬 검수 페이지 생성")
    spot.add_argument("--dataset-dir", type=Path, required=True)
    spot.add_argument("--per-source", type=int, default=2)
    return parser


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    if args.command == "segment":
        result = segment_dataset(
            source_dir=args.source_dir,
            output_dir=args.output_dir,
            reference=args.reference,
            source_pattern=args.source_pattern,
            max_source_seconds=args.max_source_seconds,
            min_seconds=args.min_seconds,
            target_seconds=args.target_seconds,
            max_seconds=args.max_seconds,
            silence_dbfs=args.silence_dbfs,
            min_silence_ms=args.min_silence_ms,
        )
        print(json.dumps(result["stats"], ensure_ascii=False, indent=2))
    elif args.command == "transcribe":
        print(json.dumps(transcribe_dataset(args.dataset_dir, model_name=args.model, limit=args.limit), ensure_ascii=False, indent=2))
    elif args.command == "apply-review":
        print(json.dumps(apply_review(args.dataset_dir), ensure_ascii=False, indent=2))
    elif args.command == "reconcile-script":
        print(json.dumps(reconcile_historical_scripts(args.dataset_dir, mapping_path=args.mapping), ensure_ascii=False, indent=2))
    elif args.command == "apply-decisions":
        print(json.dumps(apply_decisions(args.dataset_dir, args.decisions, auto_accept_exact=args.auto_accept_exact), ensure_ascii=False, indent=2))
    elif args.command == "validate":
        print(json.dumps(validate_dataset(args.dataset_dir), ensure_ascii=False, indent=2))
    elif args.command == "export":
        print(json.dumps(export_official_jsonl(args.dataset_dir), ensure_ascii=False, indent=2))
    elif args.command == "spot-check":
        print(make_spot_check_page(args.dataset_dir, per_source=args.per_source))
    return 0


if __name__ == "__main__":
    sys.exit(main())
