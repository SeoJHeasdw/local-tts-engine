#!/usr/bin/env python3.13
"""Audit saved speech decisions and the current course without loading models.

Rates describe recorded automatic decisions, never listening quality. Historical
manifests include superseded takes and are not a list of current deliverables.
Optional text replay uses saved transcripts; it cannot hear an undetected error.
"""

from __future__ import annotations

import argparse
from collections import Counter, defaultdict
from contextlib import contextmanager
import hashlib
import importlib
import json
from pathlib import Path
import re
import subprocess
import sys
import tempfile
from typing import Any

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "src"))

from local_tts_engine.course.script import (  # noqa: E402
    course_entries, course_pronunciation_dictionary, group_course_entries,
)
from local_tts_engine.course.settings import DEFAULT_SOURCE_PROJECT  # noqa: E402
from local_tts_engine.english_voice import speech_segments  # noqa: E402


def digest(value: Any) -> str:
    return hashlib.sha256(json.dumps(value, sort_keys=True, ensure_ascii=False).encode()).hexdigest()


def candidate_identity(candidate: dict[str, Any], manifest: Path, chunk_key: str) -> str:
    """Deduplicate copied records, but retain changed transcripts of one take.

    A generation hash is metadata, not a checksum of the waveform. With no hash
    or path, scope the identity to its manifest and chunk instead of collapsing
    unrelated candidates which happen to have the same words and seed.
    """
    audio_identity = candidate.get("hash") or candidate.get("audioPath")
    if not audio_identity:
        audio_identity = [str(manifest), chunk_key, candidate.get("attempt")]
    return digest([audio_identity, candidate.get("seed"), candidate.get("expectedText"),
                   candidate.get("recognizedText")])


def count_rows(counter: Counter, limit: int = 30) -> list[dict[str, Any]]:
    return [{"value": value, "count": count} for value, count in counter.most_common(limit)]


def status(record: dict[str, Any]) -> str:
    if record.get("failures"):
        return "failed"
    if record.get("warnings"):
        return "warning"
    return "passed" if record.get("passed") is True else "unknown"


def decision_snapshot(record: dict[str, Any]) -> dict[str, Any]:
    """A saved verdict and its evidence may change for the same audio/text."""
    result = {"passed": record.get("passed")}
    for key in ("failures", "warnings", "pronunciationChecks", "contentChecks", "englishChecks"):
        result[key] = record.get(key, [])
    for key in ("prosody", "restarts"):
        inspection = record.get(key) or {}
        result[key] = {"status": inspection.get("status", "not-recorded"),
                       "checks": inspection.get("checks", [])}
    return result


def summarize_saved(roots: list[Path]) -> tuple[dict[str, Any], list[dict[str, Any]]]:
    paths = sorted({p.resolve() for root in roots for p in
                    ([root] if root.is_file() else root.rglob("manifest.json"))})
    candidates: dict[str, dict[str, Any]] = {}
    decisions: dict[str, dict[str, dict[str, Any]]] = defaultdict(dict)
    seen_chunks: set[str] = set()
    chapters: dict[str, Counter] = defaultdict(Counter)
    severity, attempts, warnings, terms, prosody = (Counter() for _ in range(5))
    manifests, errors, promoted = [], [], []
    chunk_records = candidate_records = duplicates = 0
    for path in paths:
        try:
            raw = path.read_bytes()
            data = json.loads(raw)
            chunks = data.get("quality", {}).get("chunks", [])
            if not isinstance(chunks, list):
                raise ValueError("quality.chunks must be a list")
        except (OSError, ValueError, AttributeError) as error:
            errors.append({"path": str(path), "error": str(error)})
            continue
        if not chunks:
            continue
        manifests.append({"path": str(path), "sha256": hashlib.sha256(raw).hexdigest(),
                          "chunks": len(chunks), "maxAttempts": data.get("quality", {}).get("maxAttempts")})
        for chunk in chunks:
            selected = chunk.get("selected", {})
            takes = chunk.get("candidates", [])
            chunk_records += 1
            candidate_records += len(takes)
            take_ids = []
            take_decisions = []
            for take in takes:
                identity = candidate_identity(take, path, chunk.get("chunkKey", ""))
                take_ids.append(identity)
                decision = decision_snapshot(take)
                decision_id = digest(decision)
                take_decisions.append(decision_id)
                observation = decisions[identity].setdefault(decision_id, {
                    "decision": decision, "sources": [], "status": status(take)})
                observation["sources"].append({"manifest": str(path), "chunkKey": chunk.get("chunkKey")})
                if identity not in candidates:
                    candidates[identity] = {"identity": identity, "manifest": str(path),
                        "chunkKey": chunk.get("chunkKey"), "chapter": chunk.get("chapter"),
                        "candidate": take}
            # Duplicated manifests must not inflate retry/selection denominators.
            chunk_id = digest([chunk.get("chunkKey"), take_ids, take_decisions, chunk.get("severity"),
                               candidate_identity(selected, path, chunk.get("chunkKey", "")),
                               decision_snapshot(selected)])
            if chunk_id in seen_chunks:
                duplicates += 1
                continue
            seen_chunks.add(chunk_id)
            selected_status = chunk.get("severity") or status(selected)
            severity[selected_status] += 1
            chapters[str(chunk.get("chapter", "unknown"))][selected_status] += 1
            attempts[str(len(takes))] += 1
            warnings.update(selected.get("warnings", []))
            terms.update(check.get("term", "") for check in selected.get("pronunciationChecks", [])
                         if check.get("status") in {"warning", "failed"})
            prosody[selected.get("prosody", {}).get("status", "not-recorded")] += 1
            if selected_status == "failed" and not selected.get("failures"):
                promoted.append({"manifest": str(path), "chunkKey": chunk.get("chunkKey"),
                    "selectedAttempt": selected.get("attempt"), "warnings": selected.get("warnings", []),
                    "evidenceByAttempt": [{"attempt": take.get("attempt"),
                        "checks": [check for check in take.get("pronunciationChecks", [])
                                   + take.get("contentChecks", [])
                                   if check.get("status") in {"warning", "failed"}]}
                        for take in takes]})
    rows = list(candidates.values())
    candidate_status = Counter()
    conflicts = []
    for row in rows:
        observations = list(decisions[row["identity"]].values())
        statuses = {item["status"] for item in observations}
        candidate_status[next(iter(statuses)) if len(statuses) == 1 else "conflicting-saved-statuses"] += 1
        if len(observations) > 1:
            conflicts.append({"identity": row["identity"], "decisions": observations})
    return {"method": "Saved manifest decisions; no synthesis, ASR, alignment or listening performed.",
        "manifests": manifests, "readErrors": errors, "chunkRecords": chunk_records,
        "duplicateChunkRecords": duplicates, "uniqueChunkRuns": len(seen_chunks),
        "chunkDenominator": "Distinct saved chunk decision records, including changed verdicts/evidence for the same audio.",
        "candidateRecords": candidate_records, "uniqueCandidateReadings": len(rows),
        "conflictingSavedDecisions": conflicts,
        "selectionSeverity": dict(severity), "selectionSeverityByChapter": dict(chapters),
        "attemptDistribution": dict(attempts), "candidateStatus": dict(candidate_status),
        "selectedWarnings": count_rows(warnings), "selectedTerms": count_rows(terms),
        "selectedProsodyStatus": dict(prosody), "warningPromotions": promoted}, rows


@contextmanager
def baseline_gates(reference: str | None):
    """Load a Git version in an isolated package; never checkout or edit files."""
    if not reference:
        yield None
        return
    revision = subprocess.run(
        ["git", "rev-parse", "--verify", "--end-of-options", f"{reference}^{{commit}}"],
        cwd=ROOT, capture_output=True, text=True, check=True,
    ).stdout.strip()
    package_name = "_speech_audit_baseline"
    module_names = ("speech_quality", "transcript_coverage", "korean_phonetics", "pronunciation",
                    "korean_naturalness", "prosody", "restarts")
    with tempfile.TemporaryDirectory(prefix="speech-audit-") as directory:
        package = Path(directory) / package_name
        package.mkdir()
        (package / "__init__.py").write_text("")
        for name in module_names:
            source = subprocess.run(
                ["git", "show", f"{revision}:src/local_tts_engine/{name}.py"],
                cwd=ROOT, capture_output=True, text=True, check=True,
            ).stdout
            (package / f"{name}.py").write_text(source)
        sys.path.insert(0, directory)
        try:
            quality = importlib.import_module(f"{package_name}.speech_quality")
            coverage = importlib.import_module(f"{package_name}.transcript_coverage")
            yield {"revision": revision, "quality": quality, "coverage": coverage}
        finally:
            sys.path.remove(directory)
            for name in list(sys.modules):
                if name == package_name or name.startswith(package_name + "."):
                    del sys.modules[name]


def replay_text(rows: list[dict[str, Any]], dictionary: list[dict[str, Any]], baseline=None) -> dict[str, Any]:
    """Re-run actual text gates on stored ASR; do not infer waveform/prosody."""
    from local_tts_engine.speech_quality import check_pronunciation, lexical_pronunciation_checks
    from local_tts_engine.transcript_coverage import (
        adjacent_repetitions, clause_omissions, negation_omissions,
    )

    changed, baseline_changes = [], []
    missing = 0
    for row in rows:
        take = row["candidate"]
        if not isinstance(take.get("recognizedText"), str) or not take.get("expectedText"):
            missing += 1
            continue
        expected, recognized = take["expectedText"], take["recognizedText"]
        required = take.get("requiredPronunciations", [])
        checks = [check_pronunciation(term, expected, recognized, dictionary) for term in required]
        checks += lexical_pronunciation_checks(expected, recognized, dictionary, required)
        content = [*clause_omissions(expected, recognized, dictionary),
                   *adjacent_repetitions(expected, recognized, dictionary),
                   *negation_omissions(expected, recognized, dictionary)]
        # Ignore extra diagnostic fields: compare only the identity and verdict.
        def compact(items):
            return [{key: item[key] for key in ("kind", "term", "text", "status", "reason") if key in item}
                    for item in items if item.get("status") != "ok"]
        before = compact(take.get("pronunciationChecks", []) + take.get("contentChecks", []))
        after = compact(checks + content)
        record = {key: row[key] for key in ("identity", "manifest", "chunkKey", "chapter")} | {
            "attempt": take.get("attempt"), "savedPassed": take.get("passed"),
            "expectedText": expected, "recognizedText": recognized}
        if before != after:
            changed.append(record | {"before": before, "after": after})
        if baseline:
            quality, coverage = baseline["quality"], baseline["coverage"]
            old_checks = [quality.check_pronunciation(term, expected, recognized, dictionary) for term in required]
            old_checks += quality.lexical_pronunciation_checks(expected, recognized, dictionary, required)
            for name in ("clause_omissions", "adjacent_repetitions", "negation_omissions"):
                if function := getattr(coverage, name, None):
                    old_checks += function(expected, recognized, dictionary)
            old = compact(old_checks)
            if old != after:
                baseline_changes.append(record | {"before": old, "after": after})
    return {"method": "Current dictionary + current required/lexical/omission/repetition/negation gates on saved transcripts. "
                       "English routing, acoustic and prosody decisions are not replayed. Changed decisions "
                       "are review candidates, not measured corrections or new audio quality.",
            "recordSelection": "One representative per generation/audio identity and transcript; conflicting saved "
                               "verdicts are preserved separately in saved.conflictingSavedDecisions.",
            "checked": len(rows) - missing, "unavailable": missing,
            "dictionarySha256": digest(dictionary), "changed": len(changed), "changes": changed,
            **({"baselineComparison": {"revision": baseline["revision"],
                "method": "Same saved transcripts and current dictionary; only code version differs.",
                "changed": len(baseline_changes), "changes": baseline_changes}} if baseline else {})}


def source_inventory(source_project: Path, samples_per_group: int) -> dict[str, Any]:
    dictionary = course_pronunciation_dictionary(source_project)
    entries = course_entries(source_project, "ch00")
    chunks = group_course_entries(entries)
    chapters: dict[str, Counter] = defaultdict(Counter)
    groups: dict[str, list[dict[str, Any]]] = defaultdict(list)
    tokens = Counter()
    for chunk in chunks:
        first = chunk.entries[0]
        parts = speech_segments(chunk.tts_text, dictionary)
        labels = ["english-sentence"] if any(p["language"] == "English" for p in parts) else ["korean"]
        if any(p["language"] == "Korean" and re.search(r"[A-Za-z]", p["text"]) for p in parts):
            labels.append("inline-latin")
        if re.search(r"\d", chunk.source_text):
            labels.append("numbers-identifiers")
        unresolved = sorted({token for entry in chunk.entries for token in entry.unresolved_tokens})
        if unresolved:
            labels.append("unresolved")
            tokens.update(unresolved)
        if len(chunk.tts_text) > 180:
            labels.append("long-text")
        chapters[first.chapter]["chunks"] += 1
        chapters[first.chapter].update(labels)
        record = {"chunkKey": chunk.key, "chapter": first.chapter, "slideId": first.slide_id,
                  "sourceText": chunk.source_text, "ttsText": chunk.tts_text,
                  "ttsCharacters": len(chunk.tts_text), "unresolvedTokens": unresolved,
                  "strata": labels, "textSha256": digest(chunk.tts_text)}
        for label in labels:
            groups[f"{first.chapter}/{label}"].append(record)
    # Seedless hash ordering is repeatable and avoids taking only early pages.
    samples = {group: sorted(records, key=lambda record: digest(record["chunkKey"]))[:samples_per_group]
               for group, records in sorted(groups.items())}
    scripts = sorted((source_project / "deck/script/course").glob("ch*.md"))
    return {"method": "Current script preparation and voice routing only; sample strata overlap. "
                      "Source IDs are stable references; page numbers are intentionally omitted.",
            "sourceProject": str(source_project.resolve()), "entries": len(entries), "chunks": len(chunks),
            "dictionarySha256": digest(dictionary), "byChapter": dict(chapters),
            "sourceSha256": {str(path): hashlib.sha256(path.read_bytes()).hexdigest() for path in scripts},
            "unresolvedTokens": count_rows(tokens, 1000), "samplesPerChapterStratum": samples_per_group,
            "samples": samples}


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--manifest-root", action="append", type=Path,
                        help="Repeat for roots or individual manifests; default: output/tts")
    parser.add_argument("--source-project", type=Path, default=DEFAULT_SOURCE_PROJECT)
    parser.add_argument("--samples-per-group", type=int, default=2)
    parser.add_argument("--replay-text", action="store_true")
    parser.add_argument("--baseline-ref", help="With --replay-text, compare a Git code revision using the same dictionary")
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args(argv)
    if args.samples_per_group < 1:
        parser.error("--samples-per-group must be positive")
    if args.baseline_ref and not args.replay_text:
        parser.error("--baseline-ref requires --replay-text")
    if args.output.exists() or args.output.is_symlink():
        parser.error("--output must be a new file; existing files are never overwritten")
    saved, rows = summarize_saved(args.manifest_root or [ROOT / "output/tts"])
    report = {"schemaVersion": 1, "qualityPercentage": None,
              "limitations": ["Automatic pass rate is not pronunciation or naturalness accuracy.",
                  "Historical manifests include superseded productions and repeated source passages.",
                  "A stored transcript can share an ASR blind spot with every retry.",
                  "No human labels means false-positive/false-negative rates cannot be estimated."],
              "saved": saved, "source": source_inventory(args.source_project, args.samples_per_group)}
    if args.replay_text:
        with baseline_gates(args.baseline_ref) as baseline:
            report["textReplay"] = replay_text(rows, course_pronunciation_dictionary(args.source_project), baseline)
    args.output.parent.mkdir(parents=True, exist_ok=True)
    with args.output.open("x", encoding="utf-8") as destination:
        destination.write(json.dumps(report, ensure_ascii=False, indent=2) + "\n")
    print(json.dumps({"output": str(args.output.resolve()), "manifestCount": len(saved["manifests"]),
        "uniqueChunkRuns": saved["uniqueChunkRuns"], "uniqueCandidateReadings": len(rows),
        "selectionSeverity": saved["selectionSeverity"], "sourceChunks": report["source"]["chunks"],
        "readErrors": len(saved["readErrors"]),
        **({"replayChanges": report["textReplay"]["changed"]} if args.replay_text else {})}, ensure_ascii=False))
    return 1 if saved["readErrors"] else 0


if __name__ == "__main__":
    raise SystemExit(main())
