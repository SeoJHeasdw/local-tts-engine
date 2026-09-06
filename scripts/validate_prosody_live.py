#!/usr/bin/env python3.13
"""Run a small real-model validation with the approved production voice.

Run from a regular local terminal when the agent's command process cannot see
Metal. Uses installed models only, an isolated sample script, and a new result
directory on every invocation. No project settings or existing outputs change.
"""

from __future__ import annotations

import argparse
import contextlib
import json
import os
import shutil
import sys
import tempfile
import traceback
from datetime import datetime
from pathlib import Path
from uuid import uuid4


ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "src"))

SAMPLES = (
    (
        "korean",
        "모델을 더 똑똑하게 만드는 것만으로는 충분하지 않습니다. "
        "같은 질문에 똑같이 답하더라도, 한 끗이 결과를 바꿉니다. "
        "여기서 말하는 런타임은 에이전트가 실제로 실행되는 환경입니다.",
    ),
    (
        "english",
        "영어 표현도 함께 보겠습니다. Do my Bots share one computer? "
        "이 질문에서 중요한 건 도구의 개수가 아니라 실행 환경입니다.",
    ),
)


class Tee:
    def __init__(self, terminal, log):
        self.terminal = terminal
        self.log = log

    def write(self, value):
        self.terminal.write(value)
        self.log.write(value)
        self.flush()
        return len(value)

    def flush(self):
        self.terminal.flush()
        self.log.flush()


def prepare_input(directory: Path) -> Path:
    source = directory / "sample-input"
    deck = source / "deck"
    chapters = deck / "src/production/chapters"
    scripts = deck / "script/course"
    narration = deck / "narration"
    for folder in (chapters, scripts, narration):
        folder.mkdir(parents=True)
    (chapters / "ch00-validation.ts").write_text(
        "export default [\n" + "\n".join(
            f'  {{\n    id: "{name}",\n  }},' for name, _ in SAMPLES
        ) + "\n];\n", encoding="utf-8"
    )
    (scripts / "ch00.md").write_text(
        "\n".join(f"## {name}\n### 1\n{text}\n" for name, text in SAMPLES), encoding="utf-8"
    )
    shutil.copyfile(
        ROOT.parent / "udemy-agent/deck/narration/pronunciation.ko.json",
        narration / "pronunciation.ko.json",
    )
    return source


def review_existing(directory: Path) -> int:
    """Review the saved takes after a code fix; do not synthesize again."""
    directory = directory.resolve()
    manifest_path = directory / "audio/manifest.json"
    if not manifest_path.is_file():
        raise ValueError(f"완성된 검증 음성이 없습니다: {manifest_path}")
    stamp = datetime.now().strftime("%Y%m%d-%H%M%S-") + uuid4().hex[:6]
    report_path = directory / f"review-{stamp}.json"
    report = {
        "status": "reviewing", "sourceManifest": str(manifest_path),
        "method": "Stored content transcripts; fresh Whisper timing with independent Qwen confirmation of findings; original audio unchanged.",
        "chunks": [], "listeningReview": "not-performed",
    }
    with (directory / f"review-{stamp}.log").open("w", encoding="utf-8") as log:
        with contextlib.redirect_stdout(Tee(sys.stdout, log)), contextlib.redirect_stderr(Tee(sys.stderr, log)):
            try:
                os.environ["HF_HUB_OFFLINE"] = "1"
                import mlx.core as mx
                import numpy as np
                import soundfile as sf
                from mlx_audio.stt.utils import load_model
                from local_tts_engine.course_pilot import LOCAL_QUALITY_ASR_PATH, course_pronunciation_dictionary, read_independent_word_times
                from local_tts_engine.pronunciation import pronunciation_preflight
                from local_tts_engine.speech_quality import evaluate_candidate, read_timed_words, review_candidate_prosody

                mx.eval(mx.array([1.0, 2.0]) * 2)
                manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
                dictionary = course_pronunciation_dictionary(directory / "sample-input")
                model = load_model(LOCAL_QUALITY_ASR_PATH)
                for chunk in manifest["quality"]["chunks"]:
                    entries = [e for e in manifest["entries"] if e["chunkKey"] == chunk["chunkKey"]]
                    prepared = pronunciation_preflight(" ".join(e["source_text"] for e in entries), dictionary)
                    previous = chunk["selected"]
                    if prepared["ttsText"] != previous["expectedText"]:
                        raise ValueError("합성 입력이 변경되어 기존 음성을 동일 조건으로 재검할 수 없습니다.")
                    evaluation = evaluate_candidate(
                        expected_text=prepared["ttsText"], recognized_text=previous["recognizedText"],
                        audio_path=Path(previous["audioPath"]), dictionary=dictionary,
                        required_pronunciations=prepared["requiredPronunciations"],
                        attempt=previous["attempt"], seed=previous["seed"],
                    )
                    reviewed = review_candidate_prosody(
                        evaluation, lambda path, temperature: read_timed_words(model, path, temperature),
                        read_independent_word_times,
                    )
                    report["chunks"].append({"chunkKey": chunk["chunkKey"], **reviewed})
                    print(f"{chunk['chunkKey']}: {'통과' if reviewed['passed'] else '확인 필요'} · {reviewed['prosody']['status']}", flush=True)

                    # A known perturbation checks that real ASR timings can
                    # locate a pause, rather than merely accepting clean audio.
                    if chunk["slideId"] == "korean":
                        aligned = [w for e in entries for w in e.get("alignment", {}).get("words", [])]
                        target = next((w for w in aligned if w["text"] == "똑똑하게"), None)
                        report["syntheticPauseProbe"] = {"status": "not-run", "purpose": "Detector check only, not a listening sample."}
                        if target and evaluation["passed"]:
                            track = next(c for c in manifest["chunks"] if c["key"] == chunk["chunkKey"])
                            cut_ms = (target["startMs"] + target["endMs"]) / 2 - track["startMs"]
                            samples, rate = sf.read(previous["audioPath"], dtype="float32")
                            cut = round(cut_ms * rate / 1000)
                            with tempfile.TemporaryDirectory(prefix="tts-live-pause-probe-") as scratch:
                                probe_path = Path(scratch) / "pause-probe.wav"
                                sf.write(probe_path, np.concatenate([
                                    samples[:cut], np.zeros(round(rate * 0.4), dtype=np.float32), samples[cut:],
                                ]), rate, subtype="PCM_24")
                                probe = evaluate_candidate(
                                    expected_text=prepared["ttsText"], recognized_text=previous["recognizedText"],
                                    audio_path=probe_path, dictionary=dictionary,
                                    required_pronunciations=prepared["requiredPronunciations"],
                                )
                                probe = review_candidate_prosody(
                                    probe, lambda path, temperature: read_timed_words(model, path, temperature),
                                    read_independent_word_times,
                                )
                            checks = probe["prosody"]["checks"]
                            detected = any(c["term"] == "똑똑하게" and abs(c["pauseStartMs"] - cut_ms) <= 40 for c in checks)
                            report["syntheticPauseProbe"] = {
                                "status": "detected" if detected else "not-detected", "term": "똑똑하게",
                                "insertedAtMs": cut_ms, "insertedPauseMs": 400, "prosody": probe["prosody"],
                            }
                            print(f"검사용 끊김 탐지: {report['syntheticPauseProbe']['status']}", flush=True)
                report["status"] = "completed"
                report["selectedTakesPassed"] = all(c["passed"] for c in report["chunks"])
                report["passed"] = (
                    report["selectedTakesPassed"]
                    and report.get("syntheticPauseProbe", {}).get("status") == "detected"
                )
                return 0 if report["passed"] else 2
            except Exception as error:
                report.update({"status": "failed", "error": str(error)})
                traceback.print_exc()
                return 1
            finally:
                report_path.write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
                print(f"재검 결과: {report_path}", flush=True)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    mode = parser.add_mutually_exclusive_group()
    mode.add_argument("--prepare-only", action="store_true", help="모델 실행 없이 검증 대본·발음문만 확인")
    mode.add_argument("--review-existing", type=Path, help="기존 검증 폴더의 음성을 새로 생성하지 않고 재검")
    args = parser.parse_args()
    if args.review_existing:
        return review_existing(args.review_existing)
    directory = ROOT / "artifacts/validation/prosody" / (
        datetime.now().strftime("%Y%m%d-%H%M%S-") + uuid4().hex[:6]
    )
    directory.mkdir(parents=True)
    status_path = directory / "validation.json"
    status = {"status": "preparing", "outputDirectory": str(directory), "gpuChecked": False}

    def save():
        status_path.write_text(json.dumps(status, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")

    with (directory / "run.log").open("w", encoding="utf-8") as log:
        with contextlib.redirect_stdout(Tee(sys.stdout, log)), contextlib.redirect_stderr(Tee(sys.stderr, log)):
            try:
                # This validation never installs or downloads models.
                os.environ["HF_HUB_OFFLINE"] = "1"
                from local_tts_engine.course_pilot import course_entries, synthesize_excerpt

                source = prepare_input(directory)
                entries = course_entries(source, "ch00", end_slide_number=2)
                if len(entries) != 2 or any(e.unresolved_tokens or e.naturalness_warnings for e in entries):
                    raise RuntimeError("검증 대본의 발음 지정과 페이지 구성을 확인하지 못했습니다.")
                status["inputs"] = [{"sourceText": e.source_text, "ttsText": e.tts_text} for e in entries]
                status["voiceProfile"] = "jaeho-ko-r16-v1"
                status["adapterScale"] = 0.60
                save()
                print(f"검증 결과 폴더: {directory}", flush=True)
                if args.prepare_only:
                    status["status"] = "prepared-only"
                    save()
                    print("대본과 발음문 확인 완료. 음성 생성은 실행하지 않았습니다.")
                    return 0

                import mlx.core as mx
                if (mx.array([1.0, 2.0]) * 2).tolist() != [2.0, 4.0]:
                    raise RuntimeError("GPU 연산 결과가 올바르지 않습니다.")
                status["gpuChecked"] = True
                status["status"] = "generating"
                save()
                print("GPU 확인 완료. 제작 목소리 0.60으로 짧은 검증 음성을 생성합니다.", flush=True)
                synthesize_excerpt(
                    source_project=source,
                    output_dir=directory / "audio",
                    reference_path=ROOT / "artifacts/benchmarks/2026-08-23/reference.wav",
                    reference_text_path=ROOT / "artifacts/benchmarks/2026-08-23/reference.txt",
                    target_seconds=45,
                    start_chapter="ch00", start_slide=None, start_page=1, end_page=2,
                    seed=20260906,
                    adapter_path=ROOT / "artifacts/finetune-runs/2026-08-25/jaeho-ko-r16-v1/adapters",
                    adapter_scale=0.60, use_cache=False, automatic_quality=True, quality_attempts=4,
                )
                manifest_path = directory / "audio/manifest.json"
                manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
                status.update({
                    "status": "completed", "manifestPath": str(manifest_path),
                    "audioPath": manifest["audioPath"], "previewPath": manifest["previewPath"],
                    "durationMs": manifest["durationMs"], "quality": manifest["quality"]["summary"],
                    "performance": manifest["performance"],
                    "prosody": [
                        {"chunkKey": chunk["chunkKey"], "selectedAttempt": chunk["selected"]["attempt"],
                         **chunk["selected"].get("prosody", {})}
                        for chunk in manifest["quality"]["chunks"]
                    ],
                    "listeningReview": "not-performed",
                })
                save()
                print(f"완료: {manifest['durationMs'] / 1000:.2f}초 · {manifest['previewPath']}")
                print("실제 두 정렬기의 교차 확인과 검사용 끊김 탐지를 이어서 검사합니다.")
                review_exit = review_existing(directory)
                status["liveReviewPassed"] = review_exit == 0
                status["status"] = "validated" if review_exit == 0 else "review-needed"
                save()
                print("검증 통과. 결과와 로그가 저장됐습니다." if review_exit == 0 else "검수 결과에 확인할 항목이 있습니다. 기록을 확인하세요.")
                return review_exit
            except Exception as error:
                status.update({"status": "failed", "error": str(error)})
                save()
                traceback.print_exc()
                print(f"오류 기록: {status_path}")
                return 1


if __name__ == "__main__":
    raise SystemExit(main())
