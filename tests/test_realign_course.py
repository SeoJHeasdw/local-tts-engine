import copy
import json
import math
import shutil
import struct
import wave
from pathlib import Path

import pytest

from local_tts_engine import realign_course


@pytest.fixture
def project(tmp_path: Path) -> Path:
    source = tmp_path / "source"
    (source / "audio").mkdir(parents=True)
    timeline = {
        "schemaVersion": 1, "totalMs": 1500, "sourceContract": {"fingerprint": "unchanged"},
        "entries": [{"chapter": "ch01", "slideId": "sample", "slideNumber": 1, "step": 0,
            "order": 0, "sourceText": "한 문장입니다.", "ttsText": "한 문장입니다.",
            "startMs": 0, "endMs": 1500, "gapAfterMs": 0, "transitionAtMs": 1500,
            "speechStartMs": 100, "speechEndMs": 1000,
            "alignment": {"words": [{"text": "한", "startMs": 100, "endMs": 350},
                {"text": "문장입니다", "startMs": 350, "endMs": 1000}]}}],
    }
    (source / "timeline.json").write_text(json.dumps(timeline, ensure_ascii=False))
    (source / "captions.json").write_text(json.dumps([{"startMs": 50, "endMs": 1050, "text": "한 문장입니다."}]))
    (source / "validation-report.json").write_text(json.dumps({"name": "original", "displayName": "원본",
        "videoPath": "original.mp4", "voiceQuality": {"privateDetail": "not-copied"}}))
    rate = 16000
    samples = [int(12000 * math.sin(2 * math.pi * 440 * index / rate)) if 1600 <= index < 16000 else 0
        for index in range(24000)]
    with wave.open(str(source / "audio/track.wav"), "wb") as audio:
        audio.setparams((1, 2, rate, 0, "NONE", "not compressed"))
        audio.writeframes(struct.pack(f"<{len(samples)}h", *samples))
    (source / "audio/track.m4a").write_bytes(b"copy-existing-encoded-audio-without-decoding")
    return source


def snapshot(directory: Path) -> dict:
    return {str(file.relative_to(directory)): file.read_bytes() for file in directory.rglob("*") if file.is_file()}


@pytest.mark.skipif(not shutil.which("ffmpeg") or not shutil.which("node"), reason="FFmpeg and Node are required")
def test_realignment_keeps_audio_contract_and_original_files_and_uses_caption_worker(project: Path):
    original = snapshot(project)
    destination = project.parent / "revised"
    comparison = realign_course.realign_project(project, destination)
    assert snapshot(project) == original
    assert (destination / "audio/track.wav").read_bytes() == original["audio/track.wav"]
    assert (destination / "audio/track.m4a").read_bytes() == original["audio/track.m4a"]
    timeline = json.loads((destination / "timeline.json").read_text())
    source = json.loads(original["timeline.json"])
    assert realign_course._contract(timeline) == realign_course._contract(source)
    assert timeline["sourceContract"] == source["sourceContract"]
    assert timeline["totalMs"] == source["totalMs"]
    assert timeline["realignment"]["sourceAudio"] == str(project / "audio/track.wav")
    assert comparison["preservation"]["sourceFilesUnchanged"] is True
    assert comparison["measurementBasis"] == "raw-ffmpeg-silencedetect"
    assert comparison["after"]["captionAuditStatus"] == "checked"
    for name in ("captions.json", "captions.srt", "captions.vtt", "alignment-quality.json", "comparison-report.json"):
        assert (destination / name).is_file()
    report = json.loads((destination / "validation-report.json").read_text())
    assert report["operation"] == "alignment-only"
    assert report["videoPath"] is None
    assert report["audioPath"] == str(destination / "audio/track.wav")
    assert report["summary"]["ok"] is True
    assert "voiceQuality" not in report["sourceOriginalReport"]
    assert json.loads((destination / "realignment-state.json").read_text())["status"] == "complete"


def test_existing_destination_and_source_child_are_refused_without_writes(project: Path):
    original = snapshot(project)
    destination = project.parent / "existing"
    destination.mkdir()
    (destination / "keep.txt").write_text("existing")
    with pytest.raises(FileExistsError):
        realign_course.realign_project(project, destination)
    with pytest.raises(ValueError, match="원본 제작 폴더 밖"):
        realign_course.realign_project(project, project / "child")
    assert (destination / "keep.txt").read_text() == "existing"
    assert snapshot(project) == original


def test_changed_contract_marks_new_output_failed_and_never_changes_original(project: Path, monkeypatch):
    original = snapshot(project)
    monkeypatch.setattr(realign_course, "detect_silences", lambda audio: [])
    monkeypatch.setattr(realign_course, "_measure_evidence", lambda audio, spans: [])

    def broken(timeline, silence, **kwargs):
        fixed = copy.deepcopy(timeline)
        fixed["entries"][0]["sourceText"] = "바뀐 대본"
        return fixed, {"warnings": []}

    monkeypatch.setattr(realign_course, "repair_timeline", broken)
    destination = project.parent / "contract-failed"
    with pytest.raises(ValueError, match="대본 계약"):
        realign_course.realign_project(project, destination)
    assert snapshot(project) == original
    assert json.loads((destination / "realignment-state.json").read_text())["status"] == "failed"
    assert json.loads((destination / "validation-report.json").read_text())["summary"]["ok"] is False


def test_caption_failure_keeps_partial_result_unpublished_and_source_intact(project: Path, monkeypatch):
    original = snapshot(project)
    monkeypatch.setattr(realign_course, "detect_silences", lambda audio: [])
    monkeypatch.setattr(realign_course, "_measure_evidence", lambda audio, spans: [])

    def fail(*args):
        raise RuntimeError("자막 작업 실패")

    monkeypatch.setattr(realign_course, "_generate_captions", fail)
    destination = project.parent / "caption-failed"
    with pytest.raises(RuntimeError, match="자막 작업 실패"):
        realign_course.realign_project(project, destination)
    assert snapshot(project) == original
    report = json.loads((destination / "validation-report.json").read_text())
    assert report["summary"]["ok"] is False
    assert report["videoPath"] is None
    assert not (destination / "comparison-report.json").exists()


def test_audit_mode_does_not_repair_or_overwrite_inputs(project: Path, monkeypatch, capsys):
    original = snapshot(project)
    monkeypatch.setattr(realign_course, "detect_silences", lambda audio: [])
    monkeypatch.setattr(realign_course, "repair_timeline", lambda *args, **kwargs: pytest.fail("audit invoked repair"))
    report = project.parent / "audit.json"
    assert realign_course.main(["--audit-only", "--timeline", str(project / "timeline.json"),
        "--audio", str(project / "audio/track.wav"), "--captions", str(project / "captions.json"),
        "--report", str(report)]) == 0
    assert json.loads(report.read_text())["summary"]["alignmentEndBeyond250Ms"] == 1
    assert "warning" in capsys.readouterr().out
    assert snapshot(project) == original
    with pytest.raises(ValueError, match="다른 경로"):
        realign_course.audit_project(project / "timeline.json", project / "audio/track.wav",
            project / "captions.json", project / "timeline.json")


def test_audit_only_preserves_unverified_repair_warnings(project: Path, monkeypatch):
    timeline_path = project / "timeline.json"
    timeline = json.loads(timeline_path.read_text())
    warning = {"type": "unassigned-weak-tail", "entry": 0}
    timeline["alignmentRepair"] = {"warnings": [warning]}
    timeline_path.write_text(json.dumps(timeline))
    monkeypatch.setattr(realign_course, "detect_silences", lambda audio: [{"startMs": 1000, "endMs": 1500}])
    result = realign_course.audit_project(timeline_path, project / "audio/track.wav", project / "captions.json", project.parent / "audit.json")
    assert result["rawAuditStatus"] == "passed"
    assert result["status"] == "warning"
    assert result["repairWarnings"] == [warning]


def test_repair_warning_keeps_raw_and_conditional_acoustic_metrics_separate(project: Path, monkeypatch):
    monkeypatch.setattr(realign_course, "detect_silences", lambda audio: [{"startMs": 1000, "endMs": 1400}])
    observed = []

    def measure(audio, spans):
        observed.extend(spans)
        return [{**span, "rmsDb": -45, "periodicVoiceMs": 0, "weakNonSpeechCandidate": True} for span in spans]

    monkeypatch.setattr(realign_course, "_measure_evidence", measure)
    candidate = {"startMs": 1400, "endMs": 1500, "type": "unassigned-weak-tail"}
    monkeypatch.setattr(realign_course, "repair_timeline", lambda timeline, silence, **kwargs: (copy.deepcopy(timeline),
        {"warnings": [candidate], "unassignedSpeechCandidates": [candidate]}))

    def captions(timeline, output):
        for name in ("captions.json", "captions.srt", "captions.vtt"):
            shutil.copyfile(project / "captions.json", output / name)

    monkeypatch.setattr(realign_course, "_generate_captions", captions)
    comparison = realign_course.realign_project(project, project.parent / "conditional")
    assert all(span["endMs"] - span["startMs"] <= 150 for span in observed)
    assert comparison["after"]["summary"]["alignmentEndBeyond250Ms"] == 1
    assert comparison["acousticAwareQuality"]["summary"]["alignmentEndBeyond250Ms"] == 0
    assert comparison["acousticAwareQuality"]["speechIdentityConfirmed"] is False
    assert comparison["after"]["repairWarnings"] == [candidate]
    assert comparison["after"]["status"] == "warning"


@pytest.mark.parametrize("argv", [[], ["--audit-only"], ["--source-dir", "/missing"],
    ["--source-dir", "/missing", "--out-dir", "/unused", "--audio", "/unused.wav"]])
def test_cli_rejects_incomplete_or_mixed_modes(argv):
    with pytest.raises(SystemExit) as error:
        realign_course.main(argv)
    assert error.value.code == 2
