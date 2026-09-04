#!/usr/bin/env python3.13
"""Read back every clip already produced, without generating any audio.

CH00, all of CH01 and CH02 L01~L11 were produced before the automatic review
layer existed, so their manifests carry no ``quality`` block and nothing has
ever listened to them.  The clip WAVs survive, so the reading can be done now
for the price of loading Whisper alone — no TTS model, no regeneration, and
no change to a single output file.

Each clip is judged against the pronunciation text today's dictionary produces
for its steps, so a term whose reading was only just decided is checked as if
the clip had been made under the current rules.  That means a flagged chunk can
mean either "read badly" or "the script/dictionary moved since"; both are
reasons to regenerate, and the report prints the transcript so they can be told
apart by eye.
"""

from __future__ import annotations

import argparse
import json
import sys
import tempfile
import time
from pathlib import Path
from typing import Any

import numpy as np
import soundfile as sf

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))

from local_tts_engine.course_pilot import (  # noqa: E402
    DEFAULT_SOURCE_PROJECT,
    LOCAL_QUALITY_ASR_PATH,
    course_page_catalog,
    course_pronunciation_dictionary,
    parse_script,
    split_forced_pause_segments,
)
from local_tts_engine.pronunciation import pronunciation_preflight  # noqa: E402
from local_tts_engine.speech_quality import (  # noqa: E402
    asr_reading_windows,
    better_evaluation,
    chunk_severity,
    evaluate_candidate,
)


def chunk_expectation(
    chunk_key: str,
    pages: dict[str, dict[str, Any]],
    scripts: dict[str, dict[str, dict[int, str]]],
    deck_root: Path,
    dictionary: list[dict[str, Any]],
) -> tuple[str, tuple[str, ...], int] | None:
    """Rebuild the pronunciation text and required terms for one chunk key.

    Chunk keys look like ``ch02--toolpick-model--0-to-1``; the tail is the
    inclusive step range.  A key whose steps no longer exist means the script
    moved, which the caller reports rather than guesses about.
    """
    chapter, slide_id, span = chunk_key.split("--")
    first, last = span.split("-to-")
    # A step split by a forced pause is written "3-part-2"; the page still
    # starts and ends at those step numbers.
    first_step = int(str(first).split("-part-")[0])
    last_step = int(str(last).split("-part-")[0])
    page = pages.get(f"{chapter}/{slide_id}")
    if page is None:
        return None
    if chapter not in scripts:
        scripts[chapter] = parse_script(deck_root / f"script/course/{chapter}.md")
    steps = scripts[chapter].get(slide_id)
    if not steps:
        return None
    texts: list[str] = []
    required: list[str] = []
    for step in sorted(steps):
        if not first_step <= step <= last_step:
            continue
        for spoken, _ in split_forced_pause_segments(steps[step]):
            report = pronunciation_preflight(spoken, dictionary)
            texts.append(str(report["ttsText"]))
            required.extend(str(term) for term in report["requiredPronunciations"])
    if not texts:
        return None
    return " ".join(texts), tuple(dict.fromkeys(required)), int(page["page"])


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source-project", type=Path, default=DEFAULT_SOURCE_PROJECT)
    parser.add_argument("--tts-root", type=Path, default=Path("output/tts"))
    parser.add_argument("--report", type=Path, required=True)
    parser.add_argument("--only", default="", help="이 문자열이 든 작업 이름만 검사")
    args = parser.parse_args(argv)

    deck_root = args.source_project / "deck"
    dictionary = course_pronunciation_dictionary(args.source_project)
    pages = {
        f"{page['chapter']}/{page['slideId']}": page
        for page in course_page_catalog(args.source_project)
    }
    scripts: dict[str, dict[str, dict[int, str]]] = {}

    from mlx_audio.stt.utils import load_model

    model = load_model(LOCAL_QUALITY_ASR_PATH)

    def read_once(path: str, temperature: float) -> str:
        return model.generate(
            path,
            language="ko",
            task="transcribe",
            temperature=temperature,
            return_timestamps=False,
            condition_on_previous_text=False,
            max_tokens=768,
        ).text

    def transcribe(path: str, temperature: float) -> str:
        samples, rate = sf.read(path, dtype="float32", always_2d=True)
        mono = np.mean(samples, axis=1, dtype=np.float32)
        windows = asr_reading_windows(mono, rate)
        if len(windows) == 1:
            return read_once(path, temperature)
        readings: list[str] = []
        with tempfile.TemporaryDirectory(prefix="tts-asr-window-") as scratch:
            for index, (begin, end) in enumerate(windows):
                window_path = Path(scratch) / f"window-{index}.wav"
                sf.write(window_path, mono[begin:end], rate)
                readings.append(read_once(str(window_path), temperature).strip())
        return " ".join(reading for reading in readings if reading)

    runs = sorted(
        path.parent
        for path in args.tts_root.glob("*/*/manifest.json")
        if (path.parent / "clips/native").is_dir()
    )
    findings: list[dict[str, Any]] = []
    stale: list[dict[str, Any]] = []
    started = time.perf_counter()
    total_clips = 0

    for run in runs:
        if args.only and args.only not in run.name:
            continue
        manifest = json.loads((run / "manifest.json").read_text(encoding="utf-8"))
        # The manifest names the clip each chunk actually shipped. Filenames
        # cannot be parsed for it: runs made before the retry loop are
        # "<key>--<hash>.wav" and later ones "<key>--take-N--<hash>.wav", and
        # only the manifest knows which take was chosen.
        published: dict[str, Path] = {}
        for chunk in manifest.get("chunks", []):
            audio_path = Path(str(chunk.get("audioPath", "")))
            if audio_path.is_file():
                published[str(chunk["key"])] = audio_path
        for chunk_key, wav in published.items():
            expectation = chunk_expectation(chunk_key, pages, scripts, deck_root, dictionary)
            if expectation is None:
                stale.append({"run": run.name, "chunkKey": chunk_key})
                continue
            expected, required, page = expectation
            total_clips += 1
            evaluation = evaluate_candidate(
                expected_text=expected,
                recognized_text=transcribe(str(wav), 0.0),
                audio_path=wav,
                dictionary=dictionary,
                required_pronunciations=required,
            )
            if not evaluation["passed"]:
                # A second decoding rules out ASR noise before blaming the clip,
                # exactly as course_pilot.evaluate does.
                evaluation = better_evaluation(
                    evaluation,
                    evaluate_candidate(
                        expected_text=expected,
                        recognized_text=transcribe(str(wav), 0.2),
                        audio_path=wav,
                        dictionary=dictionary,
                        required_pronunciations=required,
                    ),
                )
            # One take exists, so there is no seed repetition to promote a
            # warning on. Two temperatures reading one clip the same way is
            # a consistent transcript, not a consistently different reading.
            best = evaluation
            severity = chunk_severity([best], best)
            if severity == "ok":
                continue
            findings.append({
                "run": run.name,
                "page": page,
                "chunkKey": chunk_key,
                "severity": severity,
                "phoneticErrorRate": best["phoneticErrorRate"],
                "failures": best["failures"],
                "warnings": best["warnings"],
                "terms": [
                    {"term": check["term"], "status": check["status"], "reason": check.get("reason", "")}
                    for check in best["pronunciationChecks"]
                    if check["status"] != "ok"
                ],
                "expectedText": expected,
                "recognizedText": best["recognizedText"],
            })
            print(
                f"[{severity:7}] {page:>3}p {chunk_key}  per={best['phoneticErrorRate']:.3f}  "
                f"{', '.join(best['failures'] + best['warnings'])}",
                flush=True,
            )

    elapsed = round(time.perf_counter() - started, 1)
    findings.sort(key=lambda item: (item["severity"] != "failed", item["page"]))
    args.report.parent.mkdir(parents=True, exist_ok=True)
    args.report.write_text(
        json.dumps(
            {
                "generatedAt": time.strftime("%Y-%m-%dT%H:%M:%S"),
                "clipsRead": total_clips,
                "elapsedSeconds": elapsed,
                "failed": sum(item["severity"] == "failed" for item in findings),
                "warned": sum(item["severity"] == "warning" for item in findings),
                "staleChunks": stale,
                "findings": findings,
            },
            ensure_ascii=False,
            indent=2,
        )
        + "\n",
        encoding="utf-8",
    )
    print(
        f"\n클립 {total_clips}개 판독, {elapsed}초. "
        f"재생성 필요 {sum(item['severity'] == 'failed' for item in findings)}건, "
        f"확인 권장 {sum(item['severity'] == 'warning' for item in findings)}건. "
        f"대본이 바뀐 청크 {len(stale)}개."
    )
    print(f"보고서: {args.report}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
