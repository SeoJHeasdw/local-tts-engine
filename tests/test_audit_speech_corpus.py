"""Keep corpus denominators honest when archived manifests contain copies."""
import importlib.util
import json
from pathlib import Path
import pytest


SPEC = importlib.util.spec_from_file_location(
    "audit_speech_corpus", Path(__file__).parents[1] / "scripts/audit_speech_corpus.py"
)
audit = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(audit)


def write_manifest(path, recognized="문장을 확인합니다", *, hash_value="same-take"):
    take = {"attempt": 1, "hash": hash_value, "expectedText": "문장을 확인합니다",
            "recognizedText": recognized, "passed": True, "warnings": [], "failures": []}
    chunk = {"chunkKey": "ch01--test--0-to-0", "chapter": "ch01", "severity": "ok",
             "candidates": [take], "selected": take}
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps({"quality": {"maxAttempts": 4, "chunks": [chunk]}}))
    return take


def test_copies_and_overlapping_search_roots_do_not_inflate_record_denominators(tmp_path):
    original = tmp_path / "one/manifest.json"
    write_manifest(original)
    write_manifest(tmp_path / "archive/manifest.json")
    summary, rows = audit.summarize_saved([tmp_path, original])
    assert len(summary["manifests"]) == 2
    assert summary["chunkRecords"] == 2
    assert summary["uniqueChunkRuns"] == 1
    assert summary["duplicateChunkRecords"] == 1
    assert len(rows) == 1
    assert summary["attemptDistribution"] == {"1": 1}
    assert summary["selectedProsodyStatus"] == {"not-recorded": 1}


def test_different_readings_of_one_waveform_remain_separate_evidence(tmp_path):
    write_manifest(tmp_path / "one/manifest.json")
    write_manifest(tmp_path / "second-reader/manifest.json", recognized="문장을 확인해요")
    summary, rows = audit.summarize_saved([tmp_path])
    assert summary["uniqueCandidateReadings"] == 2
    assert len(rows) == 2


def test_missing_audio_identity_does_not_merge_unrelated_takes(tmp_path):
    one = write_manifest(tmp_path / "one/manifest.json", hash_value=None)
    two = write_manifest(tmp_path / "two/manifest.json", hash_value=None)
    assert audit.candidate_identity(one, tmp_path / "one/manifest.json", "chunk") != (
        audit.candidate_identity(two, tmp_path / "two/manifest.json", "chunk"))


def test_bad_manifest_is_visible_and_does_not_hide_good_records(tmp_path):
    write_manifest(tmp_path / "good/manifest.json")
    bad = tmp_path / "bad/manifest.json"
    bad.parent.mkdir()
    bad.write_text("{not-json")
    summary, rows = audit.summarize_saved([tmp_path])
    assert len(rows) == 1
    assert len(summary["readErrors"]) == 1
    assert summary["readErrors"][0]["path"] == str(bad)


def test_current_source_samples_are_stable_and_keep_original_caption_text(studio):
    project = studio(slides={"ch00": ["test"]}, scripts={"ch00": (
        '## test\n### 0\nAPI 3개를 확인합니다. "Do my Bots share one computer?"\n'
    )}, dictionary=[{"from": "API", "to": "에이피아이"}])
    first = audit.source_inventory(project.root, 2)
    second = audit.source_inventory(project.root, 2)
    assert first == second
    assert first["byChapter"]["ch00"]["english-sentence"] == 1
    sample = first["samples"]["ch00/english-sentence"][0]
    assert "API 3개" in sample["sourceText"]
    assert "에이피아이" in sample["ttsText"]
    assert "numbers-identifiers" in sample["strata"]


def test_historical_decision_changes_are_separate_from_same_dictionary_code_changes():
    from local_tts_engine import speech_quality, transcript_coverage

    row = {"identity": "take", "manifest": "saved.json", "chunkKey": "chunk", "chapter": "ch00",
           "candidate": {"attempt": 1, "expectedText": "문장을 확인합니다", "recognizedText": "문장을 확인합니다",
               "passed": False, "pronunciationChecks": [{"kind": "lexical", "term": "문장을",
                   "status": "warning", "reason": "historical decision"}]}}
    baseline = {"revision": "same-current-code", "quality": speech_quality, "coverage": transcript_coverage}
    report = audit.replay_text([row], [], baseline)
    assert report["changed"] == 1
    assert report["baselineComparison"]["changed"] == 0


def test_reassessment_of_same_audio_and_transcript_preserves_both_saved_verdicts(tmp_path):
    write_manifest(tmp_path / "one/manifest.json")
    revised = tmp_path / "revised/manifest.json"
    write_manifest(revised)
    data = json.loads(revised.read_text())
    chunk = data["quality"]["chunks"][0]
    chunk["severity"] = "warning"
    for candidate in [*chunk["candidates"], chunk["selected"]]:
        candidate["passed"] = False
        candidate["warnings"] = ["단어 내부 끊김 확인 필요"]
    revised.write_text(json.dumps(data))
    summary, rows = audit.summarize_saved([tmp_path])
    assert len(rows) == 1
    assert summary["uniqueChunkRuns"] == 2
    assert summary["selectionSeverity"] == {"ok": 1, "warning": 1}
    assert summary["candidateStatus"] == {"conflicting-saved-statuses": 1}
    assert len(summary["conflictingSavedDecisions"]) == 1
    assert len(summary["conflictingSavedDecisions"][0]["decisions"]) == 2


def test_output_cannot_overwrite_an_input_manifest(tmp_path):
    manifest = tmp_path / "manifest.json"
    write_manifest(manifest)
    original = manifest.read_bytes()
    with pytest.raises(SystemExit) as error:
        audit.main(["--manifest-root", str(manifest), "--output", str(manifest)])
    assert error.value.code == 2
    assert manifest.read_bytes() == original
