import csv
import json
from pathlib import Path

import numpy as np
import soundfile as sf

from local_tts_engine.finetune_dataset import (
    apply_review,
    apply_decisions,
    export_official_jsonl,
    make_spot_check_page,
    plan_segments,
    read_jsonl,
    reconcile_source_rows,
    segment_dataset,
    silence_midpoints,
    validate_dataset,
)


def test_silence_segmentation_prefers_quiet_boundaries() -> None:
    rate = 1_000
    audio = np.concatenate(
        [
            np.full(4_000, 0.1),
            np.zeros(500),
            np.full(4_000, 0.1),
            np.zeros(500),
            np.full(4_000, 0.1),
        ]
    ).astype(np.float32)

    points = silence_midpoints(audio, rate, silence_dbfs=-45, min_silence_ms=200)
    plans = plan_segments(
        len(audio),
        rate,
        points,
        min_seconds=3,
        target_seconds=4.5,
        max_seconds=6,
    )

    assert points == [4_240, 8_740]
    assert [(plan.start_sample, plan.end_sample) for plan in plans] == [
        (0, 4_240),
        (4_240, 8_740),
        (8_740, 13_000),
    ]
    assert all(plan.method in {"silence", "tail"} for plan in plans)


def test_segment_review_validate_and_export(tmp_path: Path) -> None:
    source_dir = tmp_path / "masters"
    source_dir.mkdir()
    rate = 1_000
    audio = np.concatenate(
        [np.full(3_500, 0.1), np.zeros(500), np.full(3_500, 0.1)]
    ).astype(np.float32)
    source = source_dir / "voice.wav"
    reference = tmp_path / "reference.wav"
    sf.write(source, audio, rate, subtype="PCM_24")
    sf.write(reference, audio[:3_000], rate, subtype="PCM_24")
    source_before = source.read_bytes()
    dataset_dir = tmp_path / "dataset"

    segment_dataset(
        source_dir=source_dir,
        output_dir=dataset_dir,
        reference=reference,
        min_seconds=2,
        target_seconds=3.5,
        max_seconds=5,
        min_silence_ms=200,
    )

    assert source.read_bytes() == source_before
    rows = [json.loads(line) for line in (dataset_dir / "metadata.jsonl").read_text().splitlines()]
    assert len(rows) == 2
    assert validate_dataset(dataset_dir)["clips"] == 2

    review_path = dataset_dir / "review.tsv"
    with review_path.open("r", encoding="utf-8", newline="") as handle:
        reviews = list(csv.DictReader(handle, delimiter="\t"))
    for index, review in enumerate(reviews):
        review["text"] = f"검수 문장 {index + 1}"
        review["status"] = "accepted"
    with review_path.open("w", encoding="utf-8", newline="") as handle:
        writer = csv.DictWriter(handle, fieldnames=reviews[0].keys(), delimiter="\t")
        writer.writeheader()
        writer.writerows(reviews)

    stats = apply_review(dataset_dir)
    split = export_official_jsonl(dataset_dir)

    assert stats["review"]["accepted"] == 2
    assert split == {"train": 2, "val": 0, "test": 0}
    exported = [
        json.loads(line)
        for line in (dataset_dir / "official/train_raw.jsonl").read_text().splitlines()
    ]
    assert exported[0].keys() == {"audio", "text", "ref_audio"}


def test_export_refuses_unreviewed_data(tmp_path: Path) -> None:
    (tmp_path / "metadata.jsonl").write_text(
        json.dumps({"id": "a", "reviewStatus": "pending"}) + "\n",
        encoding="utf-8",
    )
    (tmp_path / "manifest.json").write_text(
        json.dumps({"referenceAudio": "/tmp/ref.wav"}), encoding="utf-8"
    )

    try:
        export_official_jsonl(tmp_path)
    except ValueError as error:
        assert "accepted" in str(error)
    else:
        raise AssertionError("검수 전 데이터가 내보내졌습니다.")


def test_reconcile_source_rows_uses_historical_script_and_flags_mismatch() -> None:
    rows = [
        {"text": "안녕하세요 오늘은 날씨가 좋습니다"},
        {"text": "두 번째 문장을 읽겠습니다"},
        {"text": "대본에 없는 말을 길게 추가했습니다"},
    ]
    script = "안녕하세요. 오늘은 날씨가 좋습니다. 두 번째 문장을 읽겠습니다."

    global_score = reconcile_source_rows(rows, script, accept_similarity=0.8)

    assert global_score > 0.7
    assert rows[0]["text"].startswith("안녕하세요")
    assert rows[0]["reviewRecommendation"] == "spot-check"
    assert rows[-1]["reviewRecommendation"] == "listen"
    assert rows[-1]["reviewStatus"] == "pending"


def test_make_spot_check_page_selects_candidates(tmp_path: Path) -> None:
    audio = tmp_path / "clip.wav"
    sf.write(audio, np.zeros(1_000), 1_000)
    rows = []
    for source in ("voice-a", "voice-b"):
        for index in range(3):
            rows.append(
                {
                    "id": f"{source}-{index}",
                    "sourceAudio": str(tmp_path / f"{source}.wav"),
                    "audio": str(audio),
                    "durationMs": 1_000,
                    "text": f"문장 {index}",
                    "scriptSimilarity": 0.95,
                    "reviewRecommendation": "spot-check",
                }
            )
    metadata = tmp_path / "metadata.jsonl"
    metadata.write_text(
        "".join(json.dumps(row, ensure_ascii=False) + "\n" for row in rows),
        encoding="utf-8",
    )

    page = make_spot_check_page(tmp_path, per_source=1)

    assert page.is_file()
    assert page.read_text(encoding="utf-8").count("<audio ") == 2


def test_apply_decisions_accepts_exact_and_overrides_reviewed_items(tmp_path: Path) -> None:
    rows = [
        {"id": "exact", "audio": "/tmp/exact.wav", "durationMs": 1_000, "text": "정확", "scriptSimilarity": 1.0, "reviewStatus": "pending"},
        {"id": "fixed", "audio": "/tmp/fixed.wav", "durationMs": 1_000, "text": "이전", "scriptSimilarity": 0.95, "reviewStatus": "pending"},
        {"id": "bad", "audio": "/tmp/bad.wav", "durationMs": 1_000, "text": "실수", "scriptSimilarity": 0.97, "reviewStatus": "pending"},
    ]
    (tmp_path / "metadata.jsonl").write_text(
        "".join(json.dumps(row, ensure_ascii=False) + "\n" for row in rows), encoding="utf-8"
    )
    (tmp_path / "manifest.json").write_text(json.dumps({"stats": {}}), encoding="utf-8")
    decisions = tmp_path / "decisions.json"
    decisions.write_text(
        json.dumps(
            {
                "decisions": [
                    {"id": "fixed", "status": "accepted", "text": "실제 발음"},
                    {"id": "bad", "status": "rejected", "notes": "말실수"},
                ]
            },
            ensure_ascii=False,
        ),
        encoding="utf-8",
    )

    stats = apply_decisions(tmp_path, decisions, auto_accept_exact=True)
    updated = {row["id"]: row for row in read_jsonl(tmp_path / "metadata.jsonl")}

    assert stats["review"] == {"accepted": 2, "pending": 0, "rejected": 1}
    assert updated["exact"]["reviewStatus"] == "accepted"
    assert updated["fixed"]["text"] == "실제 발음"
    assert updated["bad"]["reviewStatus"] == "rejected"
