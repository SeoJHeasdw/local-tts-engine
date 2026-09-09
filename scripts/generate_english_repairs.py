#!/usr/bin/env python3.13
"""Prepare replacement English quotes from an existing, frozen video timeline."""
from __future__ import annotations

import argparse
import gc
import json
import os
from pathlib import Path
import sys

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))

from local_tts_engine.course_pilot import (COURSE_SETTING_OVERRIDES, LOCAL_QUALITY_ASR_PATH,
    alignment_tokens, generate_candidate_audio, production_pronunciation, read_independent_word_times)
from local_tts_engine.english_voice import EnglishVoiceRouter, english_words, speech_segments
from local_tts_engine.pilot import MODEL_SPECS, normalize_audio, probe_audio, sha256_file


def replacement_plan(timeline, dictionary):
    replacements = []
    for entry in timeline["entries"]:
        words = entry.get("alignment", {}).get("words", [])
        cursor = 0
        for segment in speech_segments(entry["ttsText"], dictionary):
            tokens = alignment_tokens(segment["text"])
            if not tokens:
                continue
            actual = words[cursor:cursor + len(tokens)]
            if english_words(" ".join(w["text"] for w in actual)) != english_words(" ".join(tokens)) and segment["language"] == "English":
                raise ValueError(f"영어 단어와 기존 정렬이 일치하지 않습니다: {entry['key']}")
            if segment["language"] == "English":
                first, last = actual[0], actual[-1]
                if any(w["endMs"] <= w["startMs"] for w in (first, last)):
                    raise ValueError("기존 영어 단어 시각이 비어 있습니다. 수동 검수가 필요합니다.")
                previous_end = words[cursor - 1]["endMs"] if cursor else entry["startMs"]
                next_start = words[cursor + len(tokens)]["startMs"] if cursor + len(tokens) < len(words) else entry["endMs"]
                replacements.append({"entryKey": entry["key"], "chapter": entry["chapter"], "slideId": entry["slideId"],
                    "slideNumber": entry["slideNumber"], "text": segment["text"].strip('"“” '),
                    "startMs": max(previous_end, first["startMs"] - 40),
                    "endMs": min(next_start, last["endMs"] + 80),
                    "wordStart": cursor, "wordCount": len(tokens), "oldWords": actual,
                    "oldUncertainWordTimes": [w["text"] for w in actual if w["endMs"] <= w["startMs"]]})
            cursor += len(tokens)
    if not replacements:
        raise ValueError("이 영상에서 교체할 영어 인용문을 찾지 못했습니다.")
    return replacements


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--manifest", type=Path, required=True)
    parser.add_argument("--timeline", type=Path, required=True)
    parser.add_argument("--output-dir", type=Path, required=True)
    parser.add_argument("--approved-sample", type=Path)
    parser.add_argument("--approved-text", default="Do my Bots share one computer?")
    parser.add_argument("--plan-only", action="store_true")
    args = parser.parse_args()
    if (args.output_dir / "ready.json").exists():
        raise ValueError("이미 완료된 음성 폴더입니다. 다른 출력 폴더를 지정하세요.")
    manifest = json.loads(args.manifest.read_text())
    timeline = json.loads(args.timeline.read_text())
    replacements = replacement_plan(timeline, production_pronunciation())
    args.output_dir.mkdir(parents=True, exist_ok=True)
    report = {"sourceManifest": str(args.manifest.resolve()), "sourceTimeline": str(args.timeline.resolve()),
        "sourceManifestSha256": sha256_file(args.manifest), "sourceTimelineSha256": sha256_file(args.timeline),
        "policy": "english-speaker-only-v1", "accentEnforced": False,
        "review": {"status": "pending"}, "replacements": replacements}
    def save(name="repair-plan.json"):
        (args.output_dir / name).write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n")
    save()
    for item in replacements:
        print(f"{item['startMs'] / 1000:.3f}–{item['endMs'] / 1000:.3f}: {item['text']}", flush=True)
    if args.plan_only:
        return

    os.environ["HF_HUB_OFFLINE"] = "1"
    import mlx.core as mx
    import soundfile as sf
    from mlx_audio.tts.utils import load_model
    from mlx_audio.stt.utils import load_model as load_reader
    mx.eval(mx.array([1.0]) + 1.0)
    model_path = Path.home() / ".cache/huggingface/hub" / ("models--" + manifest["model"].replace("/", "--")) / "snapshots" / manifest["modelRevision"]
    if not model_path.is_dir():
        raise ValueError("원본 제작과 같은 모델이 로컬에 없습니다. 다운로드하지 않습니다.")
    reference = Path(manifest["reference"]["path"])
    if sha256_file(reference) != manifest["reference"]["sha256"]:
        raise ValueError("원본 제작과 참조 음성이 다릅니다.")
    settings = {**MODEL_SPECS["qwen3-tts"].settings, **COURSE_SETTING_OVERRIDES}
    model = load_model(model_path)
    reader = load_reader(LOCAL_QUALITY_ASR_PATH)
    router = EnglishVoiceRouter(production_pronunciation())
    for index, item in enumerate(replacements, 1):
        seed = (131427232 + (index - 1) * 0x9E3779B1) & 0xffffffff
        selected = None
        candidates = []
        approved = args.approved_sample and item["text"] == args.approved_text
        for attempt in range(1, 2 if approved else 5):
            output = args.output_dir / f"quote-{index:02d}-take-{attempt}.wav"
            if approved:
                # Preserve the exact take the user selected, including its rate.
                samples, rate = sf.read(args.approved_sample, dtype="float32")
                sf.write(output, samples, rate, subtype="PCM_24")
                generation = {"approvedSample": str(args.approved_sample.resolve()),
                    "approvedSampleSha256": sha256_file(args.approved_sample)}
            else:
                print(f"영어 {index}/{len(replacements)} · 후보 {attempt} 생성", flush=True)
                mx.random.seed((seed + attempt - 1) & 0xffffffff)
                generated = generate_candidate_audio(model.generate,
                    {"text": item["text"], "lang_code": "English", "ref_audio": str(reference),
                     "verbose": False, **settings}, voice_router=router)
                native = output.with_name(output.stem + "-native.wav")
                sf.write(native, generated["audio"], generated["sampleRate"], subtype="PCM_24")
                normalize_audio(native, output)
                generation = {"generationMs": generated["generationMs"], "voiceRouting": generated["cleanup"]["voiceRouting"]}
            readings = []
            for temperature in (0.0, .2):
                result = reader.generate(str(output), language="en", task="transcribe", temperature=temperature,
                    return_timestamps=False, condition_on_previous_text=False, max_tokens=768)
                readings.append(result.text.strip())
                if english_words(result.text) == english_words(item["text"]):
                    break
            passed = any(english_words(text) == english_words(item["text"]) for text in readings)
            candidate = {"attempt": attempt, "seed": seed + attempt - 1, "audioPath": str(output.resolve()),
                "sha256": sha256_file(output), "readings": readings, "readingPassed": passed,
                **probe_audio(output), **generation}
            candidates.append(candidate)
            selected = candidate
            if passed:
                break
        item.update({"candidates": candidates, "selected": selected})
        save()
        if not selected["readingPassed"]:
            raise ValueError(f"영어 {index}의 받아쓰기가 일치하지 않습니다. repair-plan.json을 확인하세요.")
    del model, reader, router
    gc.collect()
    mx.clear_cache()
    for item in replacements:
        path = Path(item["selected"]["audioPath"])
        words = read_independent_word_times(path, item["text"])
        if english_words(" ".join(w["text"] for w in words)) != english_words(item["text"]) or any(
            w["startMs"] < 0 or w["endMs"] <= w["startMs"] or w["endMs"] > item["selected"]["durationMs"] + 20 for w in words
        ):
            raise ValueError("새 영어의 단어 시각을 확인할 수 없습니다.")
        item["selected"]["alignment"] = words
        save()
    save("ready.json")
    print(f"영어 음성·단어 시각 준비 완료: {args.output_dir / 'ready.json'}", flush=True)


if __name__ == "__main__":
    main()
