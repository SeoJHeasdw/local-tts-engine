#!/usr/bin/env python3.13
"""Replace prepared speech and retime burned captions, preserving PCM outside edits."""
from __future__ import annotations

import argparse
import copy
import datetime
import json
import re
from pathlib import Path
import subprocess
import sys

import numpy as np
import soundfile as sf

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))
from local_tts_engine.pilot import sha256_file


class AudioTimeMap:
    def __init__(self, replacements):
        self.replacements = sorted(replacements, key=lambda item: item["startMs"])
        last = 0
        for item in self.replacements:
            if not last <= item["startMs"] < item["endMs"] or item["replacementMs"] <= 0:
                raise ValueError("교체 구간이 겹치거나 길이가 올바르지 않습니다.")
            last = item["endMs"]

    def __call__(self, value):
        delta = 0
        for item in self.replacements:
            start, end, duration = item["startMs"], item["endMs"], item["replacementMs"]
            if value <= start:
                return round(value + delta)
            if value < end:
                return round(start + delta + (value - start) * duration / (end - start))
            delta += duration - (end - start)
        return round(value + delta)


def patch_timeline(original, replacements, policy="english-speaker-only-v1"):
    mapping = AudioTimeMap(replacements)
    timeline = copy.deepcopy(original)
    for old, entry in zip(original["entries"], timeline["entries"]):
        for field in ("startMs", "endMs", "transitionAtMs", "speechStartMs", "speechEndMs"):
            entry[field] = mapping(old[field])
        entry["audio"]["durationMs"] = entry["endMs"] - entry["startMs"]
        words = entry["alignment"]["words"]
        for word in words:
            word["startMs"], word["endMs"] = mapping(word["startMs"]), mapping(word["endMs"])
        for item in sorted((r for r in replacements if r["entryKey"] == entry["key"]), key=lambda r: r["wordStart"], reverse=True):
            offset = mapping(item["startMs"])
            new_words = [{**word, "startMs": offset + word["startMs"], "endMs": offset + word["endMs"]}
                         for word in item["selected"]["alignment"]]
            if len(new_words) != item["wordCount"]:
                raise ValueError("교체 음성의 단어 수가 기존 타임라인과 다릅니다.")
            start = item["wordStart"]
            words[start:start + item["wordCount"]] = new_words
            if item.get("entryTtsText"):
                entry["ttsText"] = item["entryTtsText"]
        entry["speechStartMs"], entry["speechEndMs"] = words[0]["startMs"], words[-1]["endMs"]
        for pause in entry.get("forcedPauses", []):
            if "nextSpeechStartMs" in pause:
                pause["nextSpeechStartMs"] = mapping(pause["nextSpeechStartMs"])
    timeline["totalMs"] = mapping(original["totalMs"])
    timeline["generatedAt"] = datetime.datetime.now(datetime.timezone.utc).isoformat()
    if original.get("editTiming"):
        timeline["previousEditTiming"] = copy.deepcopy(original["editTiming"])
    timeline["editTiming"] = {"method": "speech-word-alignment-and-caption-anchors", "policy": policy}
    return timeline, mapping


def speech_rms(samples, rate):
    frame = round(.02 * rate)
    framed = samples[:len(samples) // frame * frame].reshape(-1, frame)
    power = np.mean(framed ** 2, axis=1)
    active = power[power > max(1e-8, float(np.max(power)) * .01)]
    if not len(active):
        raise ValueError("음량을 맞출 발화 신호가 없습니다.")
    return float(np.sqrt(np.mean(active)))


def splice_audio(original, rate, replacements):
    parts, cursor, new_cursor, evidence = [], 0, 0, []
    for item in replacements:
        start, end = round(item["startMs"] * rate / 1000), round(item["endMs"] * rate / 1000)
        if not cursor <= start < end <= len(original):
            raise ValueError("교체 구간이 원본 음성 범위를 벗어났습니다.")
        unchanged = original[cursor:start]
        parts.append(unchanged)
        evidence.append({"oldStartSample": cursor, "newStartSample": new_cursor, "samples": len(unchanged)})
        new_cursor += len(unchanged)
        audio_path = Path(item["selected"]["audioPath"])
        if sha256_file(audio_path) != item["selected"]["sha256"]:
            raise ValueError("검수 뒤 교체 음성 파일이 변경됐습니다.")
        audio, audio_rate = sf.read(audio_path, dtype="float32")
        if audio_rate != rate or audio.ndim != 1 or not np.all(np.isfinite(audio)):
            raise ValueError("교체 음성은 원본과 같은 샘플레이트의 정상 모노 PCM이어야 합니다.")
        gain = min(speech_rms(original[start:end], rate) / speech_rms(audio, rate), .89 / max(1e-8, float(np.max(np.abs(audio)))))
        audio *= gain
        fade = min(round(.005 * rate), len(audio) // 2)
        audio[:fade] *= np.linspace(0, 1, fade)
        audio[-fade:] *= np.linspace(1, 0, fade)
        parts.append(audio)
        item.update({"replacementMs": round(len(audio) * 1000 / rate), "newStartSample": new_cursor,
                     "newEndSample": new_cursor + len(audio), "gainDb": round(20 * float(np.log10(gain)), 4)})
        new_cursor += len(audio)
        cursor = end
    parts.append(original[cursor:])
    evidence.append({"oldStartSample": cursor, "newStartSample": new_cursor, "samples": len(original) - cursor})
    audio = np.concatenate(parts)
    for part in evidence:
        n, before, after = part["samples"], part["oldStartSample"], part["newStartSample"]
        assert np.array_equal(original[before:before + n], audio[after:after + n])
    return audio, evidence


def caption_runtime(deck, work):
    # Extract only the pure caption helpers. The normal legacy CLI also reads
    # .env.local, which neither this repair nor these helpers need or access.
    source = (deck / "tools/course-media.mjs").read_text()
    pure = source[source.index("function splitLongSentence("):source.index("function concatPath(")]
    runtime = work / "caption-runtime.mjs"
    runtime.write_text('import fs from "node:fs"; import path from "node:path";\n'
        'function writeJson(file,value){fs.writeFileSync(file,JSON.stringify(value,null,2)+"\\n");}\n' + pure +
        '\nbuildCaptions(JSON.parse(fs.readFileSync(process.argv[2])),JSON.parse(fs.readFileSync(process.argv[3])),process.argv[4]);\n')
    config = work / "caption-config.json"
    config.write_text(json.dumps({"captions": json.loads((deck / "narration.config.json").read_text())["captions"]}))
    return runtime, config


def video_anchors(original, timeline, old_captions, new_captions):
    if [c["text"] for c in old_captions] != [c["text"] for c in new_captions]:
        raise ValueError("원문 자막의 묶음이나 문구가 변경됐습니다.")
    anchors = [(0, 0), (original["totalMs"], timeline["totalMs"])]
    for old, new in zip(original["entries"], timeline["entries"]):
        anchors.extend((old[field], new[field]) for field in ("startMs", "endMs", "transitionAtMs"))
    for old, new in zip(old_captions, new_captions):
        anchors.extend((old[field], new[field]) for field in ("startMs", "endMs"))
    unique = {}
    for x, y in anchors:
        if x in unique and unique[x] != y:
            raise ValueError(f"같은 영상 시각에 상충하는 자막/화면 기준점이 있습니다: {x}, {unique[x]}, {y}")
        unique[x] = y
    ordered = sorted(unique.items())
    if any(a[1] >= b[1] for a, b in zip(ordered, ordered[1:])):
        raise ValueError("자막/화면 시간 변환이 순서를 보존하지 않습니다.")
    compact = []
    for point in ordered:
        while len(compact) >= 2:
            a, b = compact[-2:]
            cross = (b[1] - a[1]) * (point[0] - b[0]) - (point[1] - b[1]) * (b[0] - a[0])
            if abs(cross) > 1e-6:
                break
            compact.pop()
        compact.append(point)
    return ordered, compact


def video_filter(anchors):
    terms = ["T"]
    for (x1, y1), (x2, y2) in zip(anchors, anchors[1:]):
        slope = (y2 - y1) / (x2 - x1)
        if abs(slope - 1) > 1e-12:
            terms.append(f"({slope - 1:.12f})*clip(T-{x1 / 1000:.6f},0,{(x2 - x1) / 1000:.6f})")
    return "setpts='(" + "+".join(terms) + ")/TB',fps=25"


def replaced_finding_terms(finding, replacements):
    """Identify old term warnings fully covered by user-approved replacement speech."""
    normalize = lambda text: re.sub(r"[^\w]", "", text.casefold())
    expected = normalize(finding.get("expectedText", ""))
    overlapping = [item for item in replacements
                   if finding["startMs"] < item["endMs"] and finding["endMs"] > item["startMs"]
                   and (item["selected"].get("reviewStatus") == "approved"
                        or item["selected"].get("evaluation", {}).get("passed") is True)]
    covered = []
    for term in finding.get("terms", []):
        word = normalize(term.get("term", ""))
        if not word:
            continue
        count = expected.count(word)
        replaced = sum(normalize(" ".join(w["text"] for w in item["oldWords"])).count(word) for item in overlapping)
        if count and replaced >= count:
            covered.append(term)
    return covered


def validate_replacement_approval(ready):
    """Keep policy authorization separate from listening approval of a new take."""
    if ready.get("policy") != "ko-inline-english-v1":
        return "english-reading"
    retrofit = ready.get("approvalBasis") == "approved-policy-retrofit" and bool(ready.get("authorization"))
    all_listened = True
    for item in ready["replacements"]:
        selected = item["selected"]
        if selected.get("reviewStatus") in {"rejected", "deferred"}:
            raise ValueError("사용자가 거절하거나 보류한 후보는 적용할 수 없습니다.")
        if selected.get("reviewStatus") == "approved":
            continue
        all_listened = False
        if not retrofit or selected.get("evaluation", {}).get("passed") is not True:
            raise ValueError("문장 후보의 청취 승인 또는 승인 정책에 따른 내용 검수가 필요합니다.")
    return "user-listened" if all_listened else "approved-policy-auto-review"


def source_audio_path(ready, manifest):
    """Use the latest edited PCM when repairing an existing edit, never its ancestor."""
    if ready.get("sourceAudioPath"):
        path = Path(ready["sourceAudioPath"])
        if sha256_file(path) != ready.get("sourceAudioSha256"):
            raise ValueError("최신 편집 음성의 해시가 준비 기록과 다릅니다.")
        return path
    return Path(manifest["audioPath"])


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--ready", type=Path, required=True)
    parser.add_argument("--video", type=Path, required=True)
    parser.add_argument("--project", type=Path, required=True)
    parser.add_argument("--deck", type=Path, required=True)
    parser.add_argument("--output-dir", type=Path, required=True)
    parser.add_argument("--output-name", help="Optional MP4 basename for a successive edit")
    parser.add_argument("--prepare-only", action="store_true")
    args = parser.parse_args()
    args.output_dir.mkdir(parents=True, exist_ok=True)
    output_name = args.output_name or f"{args.video.stem} - 영어 발음 수정.mp4"
    if Path(output_name).name != output_name or not output_name.endswith(".mp4"):
        raise ValueError("출력 이름은 폴더 경로가 없는 MP4 파일명이어야 합니다.")
    video = args.output_dir / output_name
    if video.exists():
        raise ValueError("수정 영상이 이미 있습니다. 기존 산출물을 덮어쓰지 않습니다.")
    old_report = json.loads((args.project / "validation-report.json").read_text())
    if Path(old_report["videoPath"]).resolve() != args.video.resolve():
        raise ValueError("영상과 원본 제작 프로젝트가 서로 다릅니다.")
    work = args.output_dir / "work"
    work.mkdir(exist_ok=True)
    ready = json.loads(args.ready.read_text())
    policy = ready.get("policy", "english-speaker-only-v1")
    approval = validate_replacement_approval(ready)
    for path_key, hash_key in (("sourceManifest", "sourceManifestSha256"), ("sourceTimeline", "sourceTimelineSha256")):
        if sha256_file(Path(ready[path_key])) != ready[hash_key]:
            raise ValueError("교체 음성 준비 뒤 원본 제작 기록이 변경됐습니다.")
    manifest = json.loads(Path(ready["sourceManifest"]).read_text())
    original = json.loads(Path(ready["sourceTimeline"]).read_text())
    video_hash = sha256_file(args.video)
    input_audio = source_audio_path(ready, manifest)
    samples, rate = sf.read(input_audio, dtype="float32")
    if samples.ndim != 1 or abs(len(samples) * 1000 / rate - original["totalMs"]) > 1:
        raise ValueError("원본 음성의 형식 또는 길이가 원본 타임라인과 다릅니다.")
    replacements = copy.deepcopy(ready["replacements"])
    repaired, evidence = splice_audio(samples, rate, replacements)
    audio_path = args.output_dir / "영어 발음 수정.wav"
    sf.write(audio_path, repaired, rate, subtype="PCM_24")
    stored, _ = sf.read(audio_path, dtype="float32")
    for part in evidence:
        n, before, after = part["samples"], part["oldStartSample"], part["newStartSample"]
        if not np.array_equal(samples[before:before + n], stored[after:after + n]):
            raise ValueError("교체 밖 PCM 음성이 변경됐습니다.")
    timeline, mapping = patch_timeline(original, replacements, policy)
    if abs(timeline["totalMs"] - len(repaired) * 1000 / rate) > 1:
        raise ValueError("실제 음성과 타임라인 길이가 다릅니다.")
    for entry in timeline["entries"]:
        if not 0 <= entry["startMs"] <= entry["speechStartMs"] <= entry["speechEndMs"] <= entry["endMs"] <= timeline["totalMs"]:
            raise ValueError(f"수정 타임라인 범위를 확인하세요: {entry['key']}")
    timeline_path = args.output_dir / "timeline.json"
    timeline_path.write_text(json.dumps(timeline, ensure_ascii=False, indent=2) + "\n")
    runtime, config = caption_runtime(args.deck, work)
    baseline = work / "caption-baseline"
    baseline.mkdir(exist_ok=True)
    subprocess.run(["node", str(runtime), ready["sourceTimeline"], str(config), str(baseline)], check=True)
    old_captions = json.loads((args.project / "captions.json").read_text())
    if old_captions != json.loads((baseline / "captions.json").read_text()):
        raise ValueError("현재 자막 생성 규칙이 원본과 다릅니다. 기존 판본이 필요합니다.")
    subprocess.run(["node", str(runtime), str(timeline_path), str(config), str(args.output_dir)], check=True)
    captions = json.loads((args.output_dir / "captions.json").read_text())
    anchors, compact = video_anchors(original, timeline, old_captions, captions)
    plan = {"policy": policy, "approvalBasis": approval, "sourceAudioPath": str(input_audio.resolve()),
        "sourceAudioSha256": sha256_file(input_audio), "sourceVideo": str(args.video.resolve()), "sourceVideoSha256": video_hash,
        "replacements": replacements, "preservedPcmRanges": evidence, "anchors": anchors,
        "compactAnchors": compact, "videoFilter": video_filter(compact), "durationMs": timeline["totalMs"]}
    (work / "render-plan.json").write_text(json.dumps(plan, ensure_ascii=False, indent=2) + "\n")
    if args.prepare_only:
        print(json.dumps({"durationMs": timeline["totalMs"], "captions": len(captions), "anchors": len(compact)}, ensure_ascii=False))
        return
    subprocess.run(["ffmpeg", "-v", "warning", "-nostdin", "-i", str(args.video), "-i", str(audio_path),
        "-filter:v", video_filter(compact), "-map", "0:v:0", "-map", "1:a:0", "-c:v", "libx264",
        "-preset", "veryfast", "-crf", "18", "-threads", "6", "-pix_fmt", "yuv420p", "-c:a", "aac",
        "-b:a", "160k", "-ar", "48000", "-t", str(timeline["totalMs"] / 1000), "-movflags", "+faststart", str(video)], check=True)
    subprocess.run(["ffmpeg", "-v", "error", "-nostdin", "-i", str(video), "-f", "null", "-"], check=True)
    decoded = work / "decoded.wav"
    subprocess.run(["ffmpeg", "-v", "error", "-nostdin", "-y", "-i", str(video), "-vn", "-ac", "1", "-ar", str(rate), "-c:a", "pcm_f32le", str(decoded)], check=True)
    actual, _ = sf.read(decoded, dtype="float32")
    correlations = []
    for item in replacements:
        start, end = item["newStartSample"], item["newEndSample"]
        correlation = float(np.corrcoef(repaired[start:end], actual[start:end])[0, 1])
        correlations.append(correlation)
        if correlation < .999:
            raise ValueError("최종 영상에 들어간 영어 음성이 준비된 음성과 일치하지 않습니다.")
    probe = json.loads(subprocess.check_output(["ffprobe", "-v", "error", "-show_streams", "-show_format", "-of", "json", str(video)]))
    duration = round(float(probe["format"]["duration"]) * 1000)
    if abs(duration - timeline["totalMs"]) > 50:
        raise ValueError("최종 영상 길이가 타임라인과 다릅니다.")
    if sha256_file(args.video) != video_hash:
        raise ValueError("원본 영상이 변경됐습니다.")
    video.with_suffix(".timeline.json").write_text(timeline_path.read_text())
    report = copy.deepcopy(old_report)
    report.update({"generatedAt": datetime.datetime.now(datetime.timezone.utc).isoformat(),
        "name": args.output_dir.name, "displayName": video.stem, "videoPath": str(video.resolve()),
        "audioPath": str(audio_path.resolve()), "renderDir": str(args.output_dir.resolve()),
        "durationMs": duration, "target": {"root": "edit", "day": args.output_dir.parent.name, "name": args.output_dir.name},
        "sourceValidation": old_report, "englishRepair": {**plan, "audioCorrelations": correlations}})
    report.pop("lessonReview", None)
    report["review"] = {"status": "pending", "clearedFindings": []}
    report["voiceFindings"] = []
    report["repairedFindings"] = copy.deepcopy(old_report.get("repairedFindings", []))
    term_reasons = {"지정 발음 확인 필요", "지정 발음 불일치", "단어 발음 확인 필요", "단어 일부 누락", "단어 누락 또는 오독"}
    for old in old_report["voiceFindings"]:
        finding = copy.deepcopy(old)
        covered = replaced_finding_terms(old, replacements)
        if covered and len(covered) == len(old.get("terms", [])) and set(old.get("reasons", [])) <= term_reasons:
            report["repairedFindings"].append({"original": copy.deepcopy(old), "reason": "reported terms replaced; listening or content review passed"})
            continue
        if covered:
            finding["terms"] = [term for term in finding["terms"] if term not in covered]
        finding["startMs"], finding["endMs"] = mapping(old["startMs"]), mapping(old["endMs"])
        if f"{old['slideNumber']}:{old['startMs']}" in old_report.get("review", {}).get("clearedFindings", []):
            report["review"]["clearedFindings"].append(f"{finding['slideNumber']}:{finding['startMs']}")
        if any(old["startMs"] < r["endMs"] and old["endMs"] > r["startMs"] for r in replacements):
            finding["previousEvidence"] = copy.deepcopy(old)
            finding["recognizedText"] = ""
            finding["evidenceStatus"] = "original-finding-preserved; overlapping-speech-replaced"
        report["voiceFindings"].append(finding)
    for item in replacements:
        chapter = next(e["chapter"] for e in original["entries"] if e["key"] == item["entryKey"])
        report["voiceFindings"].append({"chapter": chapter, "slideId": item["slideId"], "slideNumber": item["slideNumber"],
            "startMs": mapping(item["startMs"]), "endMs": mapping(item["startMs"]) + item["replacementMs"],
            "severity": "warning", "reasons": ["교체 문장 연결부 청취 확인"], "terms": [],
            "expectedText": item["text"], "recognizedText": item["selected"]["readings"][-1]})
    report["voiceFindings"].sort(key=lambda finding: finding["startMs"])
    def pages(severity):
        rows = {(f["chapter"], f["slideId"], f["slideNumber"]) for f in report["voiceFindings"] if f["severity"] == severity}
        return [{"chapter": chapter, "slideId": slide, "slideNumber": number} for chapter, slide, number in sorted(rows, key=lambda row: row[2])]
    report["needsReview"], report["listenSuggested"] = pages("failed"), pages("warning")
    report["voiceQuality"] = {"ok": not report["needsReview"], "clean": not report["voiceFindings"], "needsReview": report["needsReview"],
        "listenSuggested": report["listenSuggested"], "note": "교체 밖의 기존 확인 항목 보존. 새 문장의 연결부 청취 확인 필요."}
    review_label = {"user-listened": "교체 음성 청취 승인", "approved-policy-auto-review": "승인 정책의 교체 음성 내용 검수", "english-reading": "영어 받아쓰기"}[approval]
    labels = ["영상 전체 디코딩", "영상·음성·타임라인 길이", review_label, "교체 단어 시각",
        "자막 문구·묶음 보존", "자막·화면 경계 보정", "교체 밖 PCM 보존", "최종 영어 음성 일치", "원본 영상 보존"]
    report["checks"] = [{"label": label, "ok": True} for label in labels]
    report["summary"] = {"ok": True, "passed": len(labels), "total": len(labels), "failed": []}
    (args.output_dir / "validation-report.json").write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n")
    print(json.dumps({"video": str(video), "durationMs": duration, "englishCorrelations": correlations}, ensure_ascii=False), flush=True)


if __name__ == "__main__":
    main()
