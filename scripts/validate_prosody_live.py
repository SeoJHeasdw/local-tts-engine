#!/usr/bin/env python3.13
"""Run a small real-model validation with the approved production voice.

Run from a regular local terminal when the agent's command process cannot see
Metal. Uses installed models only, an isolated sample script, and a new result
directory on every invocation. No project settings or existing outputs change.
"""

from __future__ import annotations

import argparse
import contextlib
import hashlib
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
from local_tts_engine.course.settings import DEFAULT_SOURCE_PROJECT

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


def prepare_input(directory: Path, source_project: Path = DEFAULT_SOURCE_PROJECT, samples=SAMPLES) -> Path:
    source = directory / "sample-input"
    deck = source / "deck"
    chapters = deck / "src/production/chapters"
    scripts = deck / "script/course"
    narration = deck / "narration"
    for folder in (chapters, scripts, narration):
        folder.mkdir(parents=True)
    (chapters / "ch00-validation.ts").write_text(
        "export default [\n" + "\n".join(
            f'  {{\n    id: "{name}",\n  }},' for name, _ in samples
        ) + "\n];\n", encoding="utf-8"
    )
    (scripts / "ch00.md").write_text(
        "\n".join(f"## {name}\n### 1\n{text}\n" for name, text in samples), encoding="utf-8"
    )
    shutil.copyfile(
        source_project / "deck/narration/pronunciation.ko.json",
        narration / "pronunciation.ko.json",
    )
    return source


def load_samples(path: Path | None):
    """Accept a bounded, explicitly saved review set; never generate a course."""
    if path is None:
        return SAMPLES
    import re
    data = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(data, list) or not 1 <= len(data) <= 16:
        raise ValueError("검증 대본은 1~16개여야 합니다.")
    result = []
    for item in data:
        name, text = str(item["name"]), str(item["text"]).strip()
        if not re.fullmatch(r"[a-z0-9][a-z0-9-]*", name) or name in {n for n, _ in result}:
            raise ValueError("검증 대본의 이름은 중복 없는 영문 소문자·숫자·하이픈이어야 합니다.")
        if not text or len(text) > 500 or "\n" in text:
            raise ValueError("검증 대본은 500자 이하의 한 문단이어야 합니다.")
        result.append((name, text))
    return tuple(result)


def review_content(previous, prepared, routing, dictionary, read_once):
    """Read the actual saved WAV again with production language/quality rules."""
    import numpy as np
    import soundfile as sf
    from local_tts_engine.english_voice import read_routed_transcript
    from local_tts_engine.speech_quality import (
        apply_english_checks, asr_reading_windows, evaluate_candidate, review_transcriptions,
    )

    if prepared["ttsText"] != previous["expectedText"]:
        raise ValueError("합성 입력이 변경되어 기존 음성을 동일 조건으로 재검할 수 없습니다.")
    path = Path(previous["audioPath"])

    def read(temperature):
        english_checks = []
        if routing:
            recognized, english_checks = read_routed_transcript(path, routing, read_once, temperature)
        else:
            samples, rate = sf.read(path, dtype="float32", always_2d=True)
            mono = np.mean(samples, axis=1, dtype=np.float32)
            windows = asr_reading_windows(mono, rate)
            if len(windows) == 1:
                recognized = read_once(str(path), temperature, "ko")
            else:
                readings = []
                with tempfile.TemporaryDirectory(prefix="tts-review-asr-") as scratch:
                    for index, (start, end) in enumerate(windows):
                        piece = Path(scratch) / f"{index}.wav"
                        sf.write(piece, mono[start:end], rate)
                        readings.append(read_once(str(piece), temperature, "ko").strip())
                recognized = " ".join(readings)
        evaluated = evaluate_candidate(
            expected_text=prepared["ttsText"], recognized_text=recognized, audio_path=path,
            dictionary=dictionary, required_pronunciations=prepared["requiredPronunciations"],
            attempt=previous["attempt"], seed=previous.get("seed"),
            speech_parts=routing.get("segments") if routing else None,
        )
        return apply_english_checks(evaluated, english_checks)

    return review_transcriptions(read)


def review_passed(chunks, synthetic_probe=None):
    """A course sample does not contain the default synthetic pause experiment."""
    return bool(chunks) and all(c["passed"] for c in chunks) and (
        synthetic_probe is None or synthetic_probe.get("status") == "detected"
    )


def listening_prosody_input(evaluation, chunk_key, annotations, dictionary):
    """Unlock a diagnostic timing check for one exact, user-heard false alarm.

    Never change the automatic verdict. This temporary input is used only for
    the extra prosody result, and any additional problem still blocks it.
    """
    from local_tts_engine.pronunciation import comparison_pronunciation
    if evaluation["passed"] or evaluation.get("failures"):
        return None, []
    if any(c.get("status") != "ok" for c in evaluation.get("contentChecks", [])):
        return None, []
    if any(not c.get("passed") for c in evaluation.get("englishChecks", [])):
        return None, []
    checks = [c for c in evaluation.get("pronunciationChecks", []) if c.get("status") != "ok"]
    if len(checks) != 1 or checks[0].get("status") != "warning":
        return None, []
    check = checks[0]
    if set(evaluation.get("warnings", [])) != {check.get("reason")}:
        return None, []
    digest = hashlib.sha256(Path(evaluation["audioPath"]).read_bytes()).hexdigest()
    expected = evaluation["expectedText"]
    recognized = comparison_pronunciation(evaluation["recognizedText"], dictionary)
    for annotation in annotations:
        scope, finding = annotation.get("scope", {}), annotation.get("finding", {})
        if annotation.get("disposition") != "accepted-asr-variation":
            continue
        if not (scope.get("chunkKey") == chunk_key and scope.get("audioSha256") == digest
                and scope.get("expectedText") == expected
                and scope.get("attempt") == evaluation.get("attempt")):
            continue
        fields = ("kind", "term", "reason", "status", "expectedCount")
        if any(finding.get(key) != check.get(key) for key in fields):
            continue
        begin, end = finding.get("expectedStart"), finding.get("expectedEnd")
        if not isinstance(begin, int) or not isinstance(end, int) or expected[begin:end] != check["term"]:
            continue
        expected_excerpt = annotation.get("expectedExcerpt", "")
        heard_excerpt = annotation.get("recognizedExcerpt", "")
        if not expected_excerpt or expected.count(expected_excerpt) != 1 or not heard_excerpt or heard_excerpt not in recognized:
            continue
        return {**evaluation, "passed": True, "warnings": []}, [annotation["id"]]
    return None, []


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
        "method": "Fresh language-routed Whisper transcripts and timing with independent Qwen confirmation; original audio and manifest unchanged.",
        "chunks": [], "listeningReview": "not-performed",
    }
    annotation_path = directory / "listening-review.json"
    annotations = []
    if annotation_path.is_file():
        listening = json.loads(annotation_path.read_text(encoding="utf-8"))
        annotations = listening.get("annotations", [])
        report["listeningReview"] = "partial-user-feedback-recorded"
        report["listeningReviewPath"] = str(annotation_path)
        report["listeningRefinements"] = listening.get("refinements", [])
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
                from local_tts_engine.english_voice import read_routed_timings
                from local_tts_engine.short_word_review import short_word_review_candidates

                mx.eval(mx.array([1.0, 2.0]) * 2)
                manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
                dictionary = course_pronunciation_dictionary(directory / "sample-input")
                model = load_model(LOCAL_QUALITY_ASR_PATH)
                def read_once(path, temperature, language):
                    return model.generate(path, language=language, task="transcribe", temperature=temperature,
                        return_timestamps=False, condition_on_previous_text=False, max_tokens=768).text
                tracks = {chunk["key"]: chunk for chunk in manifest["chunks"]}
                for chunk in manifest["quality"]["chunks"]:
                    entries = [e for e in manifest["entries"] if e["chunkKey"] == chunk["chunkKey"]]
                    prepared = pronunciation_preflight(" ".join(e["source_text"] for e in entries), dictionary)
                    previous = chunk["selected"]
                    routing = tracks[chunk["chunkKey"]].get("voiceRouting")
                    evaluation = review_content(previous, prepared, routing, dictionary, read_once)
                    reviewed = review_candidate_prosody(
                        evaluation, lambda path, temperature: read_routed_timings(model, path, temperature, routing)
                            if routing else read_timed_words(model, path, temperature),
                        read_independent_word_times,
                    )
                    accepted_input, acceptance_ids = listening_prosody_input(
                        evaluation, chunk["chunkKey"], annotations, dictionary,
                    )
                    if accepted_input is not None:
                        extra = review_candidate_prosody(
                            accepted_input, lambda path, temperature: read_routed_timings(model, path, temperature, routing)
                                if routing else read_timed_words(model, path, temperature),
                            read_independent_word_times,
                        )
                        reviewed["contentListeningAcceptance"] = acceptance_ids
                        reviewed["prosodyAfterListening"] = {key: extra[key] for key in
                            ("passed", "warnings", "prosody", "restarts") if key in extra}
                    # Research evidence only: short words have legitimate liaison
                    # and spelling ambiguity. Never change score/pass/retries.
                    reviewed["shortWordReviewCandidates"] = short_word_review_candidates(
                        evaluation["expectedText"], evaluation["recognizedText"], dictionary,
                    )
                    report["chunks"].append({"chunkKey": chunk["chunkKey"], **reviewed})
                    print(f"{chunk['chunkKey']}: {'통과' if reviewed['passed'] else '확인 필요'} · {reviewed['prosody']['status']}", flush=True)
                    if acceptance_ids:
                        print("  기록된 청취 확인을 반영한 추가 운율 검사: " +
                              ("통과" if extra["passed"] else "확인 필요") + " (원래 자동 판정은 보존)", flush=True)

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
                                    expected_text=prepared["ttsText"], recognized_text=evaluation["recognizedText"],
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
                report["selectedTakesPassed"] = bool(report["chunks"]) and all(c["passed"] for c in report["chunks"])
                report["passed"] = review_passed(report["chunks"], report.get("syntheticPauseProbe"))
                report["contentListeningAcceptedChunks"] = [c["chunkKey"] for c in report["chunks"]
                    if c.get("contentListeningAcceptance")]
                report["unresolvedReviewChunks"] = [c["chunkKey"] for c in report["chunks"]
                    if not c["passed"] and not c.get("prosodyAfterListening", {}).get("passed")]
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
    parser.add_argument("--source-project", type=Path, default=DEFAULT_SOURCE_PROJECT)
    parser.add_argument("--samples-file", type=Path, help="1~16개의 {name, text}를 담은 고정 검증 대본 JSON")
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

                samples = load_samples(args.samples_file)
                source = prepare_input(directory, args.source_project, samples)
                entries = course_entries(source, "ch00", end_slide_number=len(samples))
                if len(entries) != len(samples):
                    raise RuntimeError("검증 대본의 발음 지정과 페이지 구성을 확인하지 못했습니다.")
                status["inputs"] = [{"sourceText": e.source_text, "ttsText": e.tts_text,
                                     "unresolvedTokens": list(e.unresolved_tokens)} for e in entries]
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
                    start_chapter="ch00", start_slide=None, start_page=1, end_page=len(samples),
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
                if args.samples_file:
                    status["status"] = "generated-for-review"
                    save()
                    print("고정 대본 생성·자동 검수 완료. 자연스러움의 청취 판정은 별도입니다.")
                    return 0 if manifest["quality"]["summary"]["clean"] else 2
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
