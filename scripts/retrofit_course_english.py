#!/usr/bin/env python3.13
"""Repair approved inline English terms in existing CH01/CH02, retaining latest edits."""
from __future__ import annotations

import argparse
import copy
import datetime
import gc
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys
import tempfile

import numpy as np
import soundfile as sf

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "src"))
from local_tts_engine.course_pilot import (alignment_tokens, apply_adapter_scale, course_pronunciation_dictionary,
    generate_candidate_audio, COURSE_SETTING_OVERRIDES, LOCAL_QUALITY_ASR_PATH, ALIGNER_REPOSITORY)
from local_tts_engine.english_voice import EnglishVoiceRouter, speech_segments
from local_tts_engine.pilot import MODEL_SPECS, normalize_audio, probe_audio, sha256_file, sha256_text, resolve_model_path
from local_tts_engine.pronunciation import _dictionary_pattern, pronunciation_preflight
from local_tts_engine.speech_quality import evaluate_candidate, better_evaluation, review_candidate_prosody, read_timed_words


def read(path):
    return json.loads(Path(path).read_text())


def write(path, value):
    Path(path).write_text(json.dumps(value, ensure_ascii=False, indent=2) + "\n")


def quiet_boundary(audio, rate, lower, upper, fallback):
    """Choose a quiet 20-ms window within existing word/step bounds."""
    if upper - lower < 20:
        return fallback, None
    choices = []
    for ms in range(round(lower), round(upper) - 19, 5):
        part = audio[round(ms * rate / 1000):round((ms + 20) * rate / 1000)]
        choices.append((float(np.sqrt(np.mean(part ** 2))), ms + 10))
    rms, at = min(choices)
    return at, round(rms, 7)


def align_checked_audio(aligner, audio_path, text):
    """Re-align localized source audio when a full pass collapses a word to 0 ms."""
    def run(path, script):
        result = aligner.generate(audio=str(path), text=script, language="English")
        words = [{"text": w.text, "startMs": round(w.start_time * 1000), "endMs": round(w.end_time * 1000)} for w in result.items]
        if [w["text"].casefold() for w in words] != [w.casefold() for w in alignment_tokens(script)]:
            raise ValueError("Alignment tokens differ")
        return words
    words = run(audio_path, text)
    original = copy.deepcopy(words)
    audio, rate = sf.read(audio_path, dtype="float32")
    repairs = []
    for _ in range(3):
        bad = [i for i, w in enumerate(words) if w["endMs"] <= w["startMs"]]
        if not bad:
            break
        first = bad[0]
        last = first
        while last + 1 in bad:
            last += 1
        left, right = max(0, first - 1), min(len(words), last + 2)
        start, end = words[left]["startMs"], words[right - 1]["endMs"]
        if end <= start:
            raise ValueError("No valid timing anchors around collapsed words")
        with tempfile.TemporaryDirectory(prefix="tts-local-alignment-") as scratch:
            piece = Path(scratch) / "source.wav"
            sf.write(piece, audio[round(start * rate / 1000):round(end * rate / 1000)], rate, subtype="PCM_24")
            patch = run(piece, " ".join(w["text"] for w in words[left:right]))
        if any(not 0 <= w["startMs"] < w["endMs"] <= end - start for w in patch):
            raise ValueError("Localized alignment still has invalid word times")
        repaired = [{**w, "startMs": start + w["startMs"], "endMs": start + w["endMs"]} for w in patch]
        repairs.append({"method": "localized-independent-alignment", "sourceStartMs": start,
                        "sourceEndMs": end, "original": words[left:right], "replacement": repaired})
        words[left:right] = repaired
    duration = len(audio) / rate * 1000
    if any(not 0 <= w["startMs"] < w["endMs"] <= duration for w in words) or any(a["endMs"] > b["startMs"] for a, b in zip(words, words[1:])):
        raise ValueError("Invalid alignment after localized verification")
    return words, original, repairs


def prepare(folder):
    dictionary = course_pronunciation_dictionary(ROOT.parent / "udemy-agent")
    terms = [item for item in dictionary if item.get("inline")]
    projects = [ROOT / "output/projects/studio-20260909-111048-ch01-full"]
    projects += sorted((ROOT / "output/projects").glob("studio-20260909-141529-ch02-lessons-ch02-l*"))
    edits = {
        "ch02-l04": ROOT / "output/edits/2026-09-09/ch02-l04-omission-repair",
        "ch02-l05": ROOT / "output/edits/2026-09-09/ch02-l05-english-repair",
        "ch02-l09": ROOT / "output/edits/2026-09-10/ch02-l09-english-terms-repair",
    }
    plan = {"createdAt": datetime.datetime.now(datetime.timezone.utc).isoformat(), "dictionary": dictionary,
            "authorization": "User requested approved English corrections in existing CH01 and CH02, using latest L04/L05 edits.",
            "audit": [], "jobs": []}
    for original in projects:
        key = "ch01-full" if original.name.endswith("ch01-full") else original.name[-8:]
        project = edits.get(key, original)
        report = read(project / "validation-report.json")
        video = Path(report["videoPath"])
        renamed = not video.is_file()
        if renamed:
            candidates = list(project.glob("*.mp4"))
            if len(candidates) != 1:
                raise ValueError(f"Cannot resolve the renamed latest edit: {project}")
            video = candidates[0]
        timeline_path = project / "timeline.json"
        timeline = read(timeline_path)
        manifest_path = ROOT / "output/tts/2026-09-09" / original.name / "manifest.json"
        manifest = read(manifest_path)
        audio_path = Path(report["audioPath"])
        audio, rate = sf.read(audio_path, dtype="float32")
        if rate != 48000 or audio.ndim != 1 or abs(len(audio) / rate * 1000 - timeline["totalMs"]) > 1:
            raise ValueError(f"Latest audio/timeline mismatch: {key}")
        if renamed:
            # A renamed file must still contain the latest edited soundtrack.
            pcm = subprocess.check_output(["ffmpeg", "-v", "error", "-nostdin", "-ss", "285", "-i", str(video),
                "-t", "20", "-vn", "-ac", "1", "-ar", str(rate), "-f", "f32le", "-"])
            decoded = np.frombuffer(pcm, dtype="float32")
            correlation = float(np.corrcoef(decoded, audio[285 * rate:285 * rate + len(decoded)])[0, 1])
            if correlation < .999:
                raise ValueError("Renamed video is not the latest edited audio")
        targets = []
        flat = [w for e in timeline["entries"] for w in e["alignment"]["words"]]
        for entry in timeline["entries"]:
            selected = [term for term in terms if _dictionary_pattern(term).search(entry["sourceText"])]
            if not selected:
                continue
            source_sentences = re.split(r"(?<=[.!?])\s+", entry["sourceText"])
            old_sentences = re.split(r"(?<=[.!?])\s+", entry["ttsText"])
            if len(source_sentences) != len(old_sentences):
                raise ValueError(f"Sentence mapping differs: {key}/{entry['key']}")
            if sum(len(alignment_tokens(s)) for s in old_sentences) != len(entry["alignment"]["words"]):
                raise ValueError(f"Word mapping differs: {key}/{entry['key']}")
            offset = 0
            new_sentences = []
            pending = []
            for source, old in zip(source_sentences, old_sentences):
                applicable = [term for term in selected if _dictionary_pattern(term).search(source)]
                new = old
                for term in applicable:
                    new = new.replace(term["comparisonReading"], term["to"])
                count = len(alignment_tokens(old))
                new_sentences.append(new)
                if new != old:
                    if len(alignment_tokens(new)) != count or speech_segments(new, dictionary) != [{"text": new, "language": "Korean"}]:
                        raise ValueError("Repair must preserve whole-sentence routing and word count")
                    words = entry["alignment"]["words"][offset:offset + count]
                    before = max((w["endMs"] for w in flat if w["endMs"] <= words[0]["startMs"]), default=0)
                    after = min((w["startMs"] for w in flat if w["startMs"] >= words[-1]["endMs"]), default=timeline["totalMs"])
                    begin, head_rms = quiet_boundary(audio, rate, max(before + 20, words[0]["startMs"] - 160), words[0]["startMs"], words[0]["startMs"])
                    end, tail_rms = quiet_boundary(audio, rate, words[-1]["endMs"], min(after - 20, entry["endMs"], words[-1]["endMs"] + 220), words[-1]["endMs"])
                    pending.append({"id": f"{key}-{len(targets) + len(pending) + 1:02d}", "entryKey": entry["key"], "chapter": entry["chapter"],
                        "slideId": entry["slideId"], "slideNumber": entry["slideNumber"], "sourceText": source, "text": new,
                        "oldText": old, "wordStart": offset, "wordCount": count, "oldWords": words,
                        "terms": [term["to"] for term in applicable], "startMs": begin, "endMs": end,
                        "boundaryRms": {"head": head_rms, "tail": tail_rms}})
                offset += count
            for target in pending:
                target["entryTtsText"] = " ".join(new_sentences)
            targets += pending
        plan["audit"].append({"key": key, "video": str(video), "project": str(project), "replacements": len(targets), "latestEdit": project != original})
        if not targets:
            continue
        snapshot = folder / "inputs" / key
        snapshot.mkdir(parents=True, exist_ok=True)
        adjusted = copy.deepcopy(report)
        adjusted["videoPath"] = str(video)
        adjusted["sourceReportPath"] = str(project / "validation-report.json")
        if renamed:
            adjusted["renamedInputVerification"] = {"previousPath": report["videoPath"], "correlation": correlation}
        write(snapshot / "validation-report.json", adjusted)
        shutil.copy2(project / "captions.json", snapshot / "captions.json")
        plan["jobs"].append({"key": key, "sourceManifest": str(manifest_path), "sourceManifestSha256": sha256_file(manifest_path),
            "sourceTimeline": str(timeline_path), "sourceTimelineSha256": sha256_file(timeline_path),
            "sourceAudioPath": str(audio_path), "sourceAudioSha256": sha256_file(audio_path),
            "video": str(video), "videoSha256": sha256_file(video), "project": str(snapshot),
            "output": str(ROOT / "output/edits/2026-09-10" / f"{key}-english-retrofit"), "replacements": targets})
    write(folder / "plan.json", plan)
    print(json.dumps({"videos": len(plan["audit"]), "jobs": len(plan["jobs"]), "sentences": sum(len(j["replacements"]) for j in plan["jobs"])}, ensure_ascii=False))


def generate(folder):
    os.environ["HF_HUB_OFFLINE"] = "1"
    import mlx.core as mx
    from mlx_tune import FastTTSModel
    from mlx_audio.stt.utils import load_model as load_reader
    from mlx_audio.utils import get_model_path
    from local_tts_engine.course_pilot import read_independent_word_times
    plan = read(folder / "plan.json")
    state_path = folder / "generation.json"
    state = read(state_path) if state_path.exists() else {"targets": {}, "complete": False}
    manifests = [read(job["sourceManifest"]) for job in plan["jobs"]]
    manifest = manifests[0]
    for m in manifests:
        if any(m[k] != manifest[k] for k in ("model", "modelRevision", "reference", "adapter", "settings")):
            raise ValueError("Source production profiles differ")
    reference = Path(manifest["reference"]["path"])
    reference_text = Path(manifest["reference"]["transcriptPath"]).read_text().strip()
    adapter = Path(manifest["adapter"]["path"])
    if sha256_file(reference) != manifest["reference"]["sha256"] or sha256_text(reference_text) != manifest["reference"]["transcriptSha256"] or sha256_file(adapter / "adapters.safetensors") != manifest["adapter"]["weightsSha256"]:
        raise ValueError("Immutable generation input changed")
    model_path = Path.home() / ".cache/huggingface/hub" / ("models--" + manifest["model"].replace("/", "--")) / "snapshots" / manifest["modelRevision"]
    if not model_path.is_dir():
        raise ValueError("Pinned model unavailable locally")
    wrapper, _ = FastTTSModel.from_pretrained(model_name=str(model_path), max_seq_length=512)
    wrapper = FastTTSModel.get_peft_model(wrapper, r=16, lora_alpha=16, lora_dropout=0.,
        target_modules=["q_proj", "k_proj", "v_proj", "o_proj", "gate_proj", "up_proj", "down_proj"], random_state=20260910)
    wrapper.load_adapter(str(adapter))
    if not apply_adapter_scale(wrapper.model, .6):
        raise ValueError("Missing LoRA layers")
    wrapper.model.eval()
    model = wrapper.full_model
    reader = load_reader(LOCAL_QUALITY_ASR_PATH)
    router = EnglishVoiceRouter(plan["dictionary"], wrapper.model)
    settings = {**MODEL_SPECS["qwen3-tts"].settings, **COURSE_SETTING_OVERRIDES}
    targets = [target for job in plan["jobs"] for target in job["replacements"]]
    for index, target in enumerate(targets):
        record = state["targets"].setdefault(target["id"], {"candidates": []})
        if record.get("selected", {}).get("evaluation", {}).get("passed") or record.get("selected", {}).get("reviewStatus") == "approved":
            continue
        for attempt in range(len(record["candidates"]) + 1, target.get("attemptBudget", 4) + 1):
            seed = (20260910 + index * 0x9e3779b1 + attempt - 1) & 0xffffffff
            mx.random.seed(seed)
            print(f"[{index + 1}/{len(targets)}] {target['id']} 후보 {attempt}: {target['text']}", flush=True)
            result = generate_candidate_audio(model.generate, {"text": target["text"], "lang_code": "Korean",
                "ref_audio": str(reference), "ref_text": reference_text, "verbose": False, **settings}, voice_router=router)
            if result["cleanup"].get("voiceRouting"):
                raise ValueError("Unexpected word-level voice switching")
            native = folder / f"{target['id']}-{attempt}-native.wav"
            output = folder / f"{target['id']}-{attempt}.wav"
            sf.write(native, result["audio"], result["sampleRate"], subtype="PCM_24")
            required = pronunciation_preflight(target["sourceText"], plan["dictionary"])["requiredPronunciations"]
            evaluations = []
            for temperature in (0., .2):
                recognized = reader.generate(str(native), language="ko", task="transcribe", temperature=temperature,
                    return_timestamps=False, condition_on_previous_text=False, max_tokens=768).text.strip()
                evaluation = evaluate_candidate(expected_text=target["text"], recognized_text=recognized,
                    audio_path=native, dictionary=plan["dictionary"], required_pronunciations=required, seed=seed, attempt=attempt)
                evaluations.append(evaluation)
                if evaluation["passed"]:
                    break
            evaluation = min(evaluations, key=lambda e: (not e["passed"], e["score"]))
            evaluation = review_candidate_prosody(evaluation,
                lambda path, temperature: read_timed_words(reader, path, temperature), read_independent_word_times)
            normalize_audio(native, output)
            candidate = {"audioPath": str(output), "nativeAudioPath": str(native), "sha256": sha256_file(output),
                "seed": seed, "evaluation": evaluation, "readings": [evaluation["recognizedText"]],
                "readingPassed": evaluation["passed"], "reviewStatus": "pending", "profile": "ko-inline-english-v1",
                "adapterScale": .6, "cleanup": result["cleanup"], **probe_audio(output)}
            record["candidates"].append(candidate)
            record["selected"] = min(record["candidates"], key=lambda c: (not c["readingPassed"], c["evaluation"]["score"]))
            write(state_path, state)
            print(f"  {'통과' if evaluation['passed'] else '재확인'}: {evaluation['recognizedText']}", flush=True)
            if evaluation["passed"]:
                break
    del router, model, wrapper, reader
    gc.collect()
    mx.clear_cache()
    finalize(folder)


def finalize(folder):
    """Align checked takes; leave undecided clips and their videos pending."""
    import mlx.core as mx
    from mlx_audio.stt.utils import load_model as load_reader
    from mlx_audio.utils import get_model_path
    plan = read(folder / "plan.json")
    state_path = folder / "generation.json"
    state = read(state_path)
    def accepted(target):
        selected = state["targets"][target["id"]]["selected"]
        if selected.get("reviewStatus") in {"rejected", "deferred"}:
            return False
        return selected.get("reviewStatus") == "approved" or selected["readingPassed"]
    def retained(target):
        return state["targets"][target["id"]].get("decision") == "keep-original"
    targets = [target for job in plan["jobs"] for target in job["replacements"] if accepted(target) and not retained(target)]
    aligner = load_reader(resolve_model_path(ALIGNER_REPOSITORY, get_model_path))
    for target in targets:
        selected = state["targets"][target["id"]]["selected"]
        if selected.get("alignment"):
            continue
        words, original, repairs = align_checked_audio(aligner, selected["audioPath"], target["text"])
        selected["alignmentAttempt"] = original
        selected["alignmentRepairs"] = repairs
        write(state_path, state)
        if [w["text"].casefold() for w in words] != [w.casefold() for w in alignment_tokens(target["text"])]:
            raise ValueError(f"Alignment tokens differ: {target['id']}")
        if any(not 0 <= w["startMs"] < w["endMs"] <= selected["durationMs"] for w in words) or any(a["endMs"] > b["startMs"] for a, b in zip(words, words[1:])):
            raise ValueError(f"Alignment times invalid: {target['id']}")
        selected["alignment"] = words
        write(state_path, state)
    del aligner
    gc.collect()
    mx.clear_cache()
    state["complete"] = all(accepted(t) or retained(t) for j in plan["jobs"] for t in j["replacements"])
    write(state_path, state)
    for job in plan["jobs"]:
        if any(not accepted(t) and not retained(t) for t in job["replacements"]):
            continue
        replacements = [t for t in job["replacements"] if not retained(t)]
        if not replacements:
            continue
        ready = {k: job[k] for k in ("sourceManifest", "sourceManifestSha256", "sourceTimeline", "sourceTimelineSha256", "sourceAudioPath", "sourceAudioSha256")}
        ready.update({"policy": "ko-inline-english-v1", "approvalBasis": "approved-policy-retrofit", "authorization": plan["authorization"],
            "replacements": [{**target, "selected": state["targets"][target["id"]]["selected"]} for target in replacements]})
        write(folder / f"{job['key']}-ready.json", ready)
    print(f"Checked/aligned {len(targets)} sentences. All decisions complete: {state['complete']}", flush=True)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("action", choices=["prepare", "generate", "finalize"])
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    folder = args.output.resolve()
    folder.mkdir(parents=True, exist_ok=True)
    {"prepare": prepare, "generate": generate, "finalize": finalize}[args.action](folder)


if __name__ == "__main__":
    main()
