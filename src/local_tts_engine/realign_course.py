"""Audit or realign a completed course project without invoking TTS."""

from __future__ import annotations

import argparse
import hashlib
import json
import shutil
import subprocess
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from .course.alignment_audit import audit_timeline, detect_silences, voiced_spans
from .course.alignment_repair import ALIGNMENT_REPAIR_VERSION, repair_timeline
from .course.serialization import stable_digest, write_json


ROOT = Path(__file__).resolve().parents[2]
CONTRACT_FIELDS = ("chapter", "slideId", "slideNumber", "step", "sourceText")


def _sha256(file: Path) -> str:
    digest = hashlib.sha256()
    with file.open("rb") as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def _read_json(file: Path) -> Any:
    return json.loads(file.read_text(encoding="utf-8"))


def _contract(timeline: dict) -> list[dict]:
    return [
        {"position": index, **{field: entry[field] for field in CONTRACT_FIELDS},
         "order": entry.get("order"), "ttsText": entry.get("ttsText"),
         "words": [word.get("text") for word in entry.get("alignment", {}).get("words", [])]}
        for index, entry in enumerate(timeline["entries"])
    ]


def _assert_contract(original: dict, revised: dict) -> None:
    if _contract(original) != _contract(revised):
        raise ValueError("정렬 교정이 대본 계약·단어·스텝 순서를 바꿨습니다.")
    if original.get("sourceContract") != revised.get("sourceContract"):
        raise ValueError("정렬 교정이 대본 판본 계약을 바꿨습니다.")
    if original["totalMs"] != revised["totalMs"]:
        raise ValueError("정렬 교정이 전체 음성 길이를 바꿨습니다.")


def audit_project(timeline_path: Path, audio_path: Path, captions_path: Path, report_path: Path) -> dict:
    paths = [Path(file).resolve() for file in (timeline_path, audio_path, captions_path)]
    report_path = Path(report_path).resolve()
    if report_path in paths:
        raise ValueError("정렬 검사 보고서는 원본 입력 파일과 다른 경로여야 합니다.")
    timeline, captions = _read_json(paths[0]), _read_json(paths[2])
    report = audit_timeline(timeline, captions, detect_silences(paths[1]))
    report["rawAuditStatus"] = report["status"]
    report["repairWarnings"] = timeline.get("alignmentRepair", {}).get("warnings", []) or timeline.get("realignment", {}).get("correctionWarnings", [])
    if report["repairWarnings"]:
        report.update(status="warning", severity="warning")
    report["inputs"] = {"timeline": str(paths[0]), "audio": str(paths[1]), "captions": str(paths[2])}
    report["generatedAt"] = datetime.now(timezone.utc).isoformat()
    write_json(report_path, report)
    return report


def _measure_evidence(audio_path: Path, spans: list[dict]) -> list[dict]:
    # This read-only acoustic helper does not load a synthesis/alignment model.
    from .course.alignment_evidence import measure_speech_evidence

    return measure_speech_evidence(audio_path, spans)


def _generate_captions(timeline_path: Path, out_dir: Path) -> None:
    result = subprocess.run(
        ["node", str(ROOT / "electron-app/main/workers/captions.mjs"),
         "--timeline", str(timeline_path), "--out-dir", str(out_dir)],
        capture_output=True, text=True, check=False,
    )
    if result.returncode:
        raise RuntimeError(f"자막 생성 실패 ({result.returncode}): {result.stderr[-2000:]}")
    for name in ("captions.json", "captions.srt", "captions.vtt"):
        if not (out_dir / name).is_file():
            raise RuntimeError(f"자막 생성 결과가 없습니다: {name}")


def realign_project(source_dir: Path, out_dir: Path) -> dict:
    source_dir, out_dir = Path(source_dir).resolve(), Path(out_dir).resolve()
    if out_dir == source_dir or source_dir in out_dir.parents:
        raise ValueError("새 정렬 결과는 원본 제작 폴더 밖에 저장해야 합니다.")
    if out_dir.exists():
        raise FileExistsError(f"새 정렬 결과 폴더가 이미 있습니다: {out_dir}")
    timeline_path, captions_path = source_dir / "timeline.json", source_dir / "captions.json"
    audio_path = source_dir / "audio/track.wav"
    timeline, captions = _read_json(timeline_path), _read_json(captions_path)
    # Check complete source identity before creating the destination.
    original_contract = _contract(timeline)
    audio_files = [audio_path, *[file for file in (
        source_dir / "audio/track.m4a", source_dir / "audio/track.aac",
    ) if file.is_file()]]
    input_hashes = {str(file): _sha256(file) for file in [timeline_path, captions_path, *audio_files]}
    original_report_path = source_dir / "validation-report.json"
    original_report = _read_json(original_report_path) if original_report_path.is_file() else None
    if original_report is not None:
        input_hashes[str(original_report_path)] = _sha256(original_report_path)
    source_report = ({"path": str(original_report_path), **{
        key: original_report.get(key) for key in ("name", "displayName", "videoPath", "generatedAt")
    }} if original_report is not None else None)
    out_dir.mkdir(parents=True, exist_ok=False)
    operation = {"schemaVersion": 1, "operation": "alignment-only", "status": "running",
        "sourceDir": str(source_dir), "outDir": str(out_dir), "ttsInvoked": False,
        "startedAt": datetime.now(timezone.utc).isoformat()}
    write_json(out_dir / "realignment-state.json", operation)
    try:
        silences = detect_silences(audio_path)
        evidence = _measure_evidence(audio_path, [span for span in voiced_spans(silences, 0, timeline["totalMs"])
            if span["endMs"] - span["startMs"] <= 150])
        before = audit_timeline(timeline, captions, silences)
        fixed, repair = repair_timeline(timeline, silences, speech_evidence=evidence)
        _assert_contract(timeline, fixed)
        fixed["realignment"] = {
            "sourceTimeline": str(timeline_path), "sourceAudio": str(audio_path),
            "sourceAudioSha256": input_hashes[str(audio_path)],
            "originalTimelineSha256": input_hashes[str(timeline_path)],
            "originalTotalMs": timeline["totalMs"], "algorithmVersion": ALIGNMENT_REPAIR_VERSION,
            "sourceContractSha256": stable_digest(original_contract),
            "sourceAlignmentWarnings": before["findings"],
            "correctionWarnings": repair.get("warnings", []),
        }
        (out_dir / "audio").mkdir()
        audio_checks = []
        for file in audio_files:
            destination = out_dir / "audio" / file.name
            shutil.copyfile(file, destination)
            copied_hash = _sha256(destination)
            matches = copied_hash == input_hashes[str(file)]
            audio_checks.append({"source": str(file), "copy": str(destination),
                "sha256": input_hashes[str(file)], "copySha256": copied_hash, "identical": matches})
            if not matches:
                raise RuntimeError(f"복사된 음성의 바이트가 원본과 다릅니다: {file.name}")
        write_json(out_dir / "timeline.json", fixed)
        _generate_captions(out_dir / "timeline.json", out_dir)
        revised_captions = _read_json(out_dir / "captions.json")
        after = audit_timeline(fixed, revised_captions, silences)
        after["rawAuditStatus"] = after["status"]
        after["repairWarnings"] = repair.get("warnings", [])
        if after["repairWarnings"]:
            after.update(status="warning", severity="warning")
        candidates = repair.get("unassignedSpeechCandidates", [])
        acoustic_quality = None
        if candidates:
            acoustic_quality = audit_timeline(fixed, revised_captions, [*silences, *candidates])
            acoustic_quality.update(
                measurementBasis="conditional-exclusion-of-unverified-weak-tail-candidates",
                speechIdentityConfirmed=False,
                limitation="약한 짧은 소리를 발화가 아니라고 가정한 참고값입니다. 원본 검사 수치나 청취 확인을 대체하지 않습니다.",
            )
        _assert_contract(timeline, _read_json(out_dir / "timeline.json"))
        for file, digest in input_hashes.items():
            if _sha256(Path(file)) != digest:
                raise RuntimeError(f"작업 중 원본 입력이 바뀌었습니다: {file}")
        checks = [
            {"label": "원본 파일 불변", "ok": True},
            {"label": "음성 파일 바이트 보존", "ok": all(item["identical"] for item in audio_checks)},
            {"label": "대본 계약과 스텝 순서 보존", "ok": True},
            {"label": "전체 음성 길이 보존", "ok": True},
            {"label": "자막 파일 생성", "ok": bool(revised_captions)},
        ]
        warnings = []
        if after["status"] != "passed":
            warnings.append("자막·화면 정렬에 확인할 경고가 있습니다. alignment-quality.json에서 위치를 확인하세요.")
        if repair.get("warnings"):
            warnings.append(f"파형 정렬 교정 중 확인이 필요한 구간이 {len(repair['warnings'])}곳 있습니다.")
        comparison = {
            "schemaVersion": 1, "operation": "alignment-only", "sourceDir": str(source_dir),
            "outDir": str(out_dir), "measurementBasis": "raw-ffmpeg-silencedetect",
            "before": before, "after": after, "repair": repair, "speechEvidence": evidence,
            "acousticAwareQuality": acoustic_quality,
            "preservation": {"sourceFiles": input_hashes, "audioFiles": audio_checks,
                "sourceContractSha256": stable_digest(original_contract),
                "revisedContractSha256": stable_digest(_contract(fixed)),
                "sourceFilesUnchanged": True, "totalMsUnchanged": True},
            "warnings": warnings,
        }
        write_json(out_dir / "comparison-report.json", comparison)
        write_json(out_dir / "alignment-quality.json", after)
        failed = [check["label"] for check in checks if not check["ok"]]
        report = {
            "schemaVersion": 1, "operation": "alignment-only", "generatedAt": datetime.now(timezone.utc).isoformat(),
            "name": out_dir.name, "displayName": original_report.get("displayName", out_dir.name) if original_report else out_dir.name,
            "sourceContract": fixed.get("sourceContract"), "sourceDir": str(out_dir), "renderDir": str(out_dir),
            "audioPath": str(out_dir / "audio/track.wav"), "videoPath": None, "durationMs": fixed["totalMs"],
            "sourceOriginalReport": source_report, "alignmentQuality": after, "warnings": warnings,
            "checks": checks, "summary": {"ok": not failed, "passed": len(checks) - len(failed),
                "total": len(checks), "failed": failed},
            "target": {"root": "render", "name": out_dir.name},
        }
        write_json(out_dir / "validation-report.json", report)
        if failed:
            raise RuntimeError(f"정렬 결과 파일 검증 실패: {', '.join(failed)}")
        operation.update(status="complete", completedAt=datetime.now(timezone.utc).isoformat(), warnings=warnings)
        write_json(out_dir / "realignment-state.json", operation)
        return comparison
    except BaseException as error:
        operation.update(status="failed", error=str(error), completedAt=datetime.now(timezone.utc).isoformat())
        write_json(out_dir / "realignment-state.json", operation)
        write_json(out_dir / "validation-report.json", {
            "schemaVersion": 1, "operation": "alignment-only", "name": out_dir.name,
            "videoPath": None, "audioPath": None, "warnings": [str(error)],
            "summary": {"ok": False, "passed": 0, "total": 1, "failed": ["정렬 교정 미완료"]},
        })
        raise


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="완성 음성을 보존하며 자막·화면 정렬을 검사하거나 교정합니다.")
    parser.add_argument("--audit-only", action="store_true")
    for flag in ("timeline", "audio", "captions", "report", "source-dir", "out-dir"):
        parser.add_argument(f"--{flag}", type=Path)
    return parser


def main(argv: list[str] | None = None) -> int:
    parser = build_parser()
    args = parser.parse_args(argv)
    if args.audit_only:
        if not all((args.timeline, args.audio, args.captions, args.report)) or args.source_dir or args.out_dir:
            parser.error("--audit-only에는 --timeline --audio --captions --report가 필요합니다.")
        report = audit_project(args.timeline, args.audio, args.captions, args.report)
        print(json.dumps({"status": report["status"], "summary": report["summary"]}, ensure_ascii=False))
    else:
        if not args.source_dir or not args.out_dir or any((args.timeline, args.audio, args.captions, args.report)):
            parser.error("교정에는 --source-dir와 새로운 --out-dir가 필요합니다.")
        comparison = realign_project(args.source_dir, args.out_dir)
        print(json.dumps({"before": comparison["before"]["summary"], "after": comparison["after"]["summary"]}, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
