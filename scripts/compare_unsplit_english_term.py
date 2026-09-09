#!/usr/bin/env python3.13
"""Make two listening candidates for a whole Korean sentence containing English.

This standalone experiment never updates the production dictionary or videos.
"""
from __future__ import annotations

import argparse
import datetime
import gc
import json
import os
from pathlib import Path
import sys

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "src"))


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--plan", type=Path, required=True)
    args = parser.parse_args()
    plan = json.loads(args.plan.read_text())
    from local_tts_engine.course_pilot import COURSE_SETTING_OVERRIDES, LOCAL_QUALITY_ASR_PATH, trim_and_fade_audio
    from local_tts_engine.pilot import MODEL_SPECS, normalize_audio, probe_audio, sha256_file, sha256_text

    manifest = json.loads(Path(plan["manifest"]).read_text())
    reference = Path(manifest["reference"]["path"])
    transcript = Path(manifest["reference"]["transcriptPath"]).read_text().strip()
    adapter = Path(manifest["adapter"]["path"])
    inputs = [(reference, manifest["reference"]["sha256"]),
              (adapter / "adapters.safetensors", manifest["adapter"]["weightsSha256"]),
              (adapter / "adapter_config.json", manifest["adapter"]["configSha256"])]
    if plan.get("baseline"):
        inputs.append((Path(plan["baseline"]["audioPath"]), plan["baseline"]["sha256"]))
    for request in plan.get("alignments", []):
        if request.get("audioPath"):
            inputs.append((Path(request["audioPath"]), request["sha256"]))
    for file, expected in inputs:
        if sha256_file(file) != expected:
            raise ValueError(f"비교 입력이 변경됐습니다: {file.name}")
    if sha256_text(transcript) != manifest["reference"]["transcriptSha256"]:
        raise ValueError("참조 전사가 변경됐습니다.")
    settings = {**MODEL_SPECS["qwen3-tts"].settings, **COURSE_SETTING_OVERRIDES}
    if {"language": "Korean", **settings} != manifest["settings"]:
        raise ValueError("기존 비교와 생성 설정이 다릅니다.")
    model_path = Path.home() / ".cache/huggingface/hub" / ("models--" + manifest["model"].replace("/", "--")) / "snapshots" / manifest["modelRevision"]
    if not model_path.is_dir():
        raise ValueError("같은 모델이 로컬에 없습니다. 다운로드하지 않습니다.")
    os.environ["HF_HUB_OFFLINE"] = "1"
    import mlx.core as mx
    import numpy as np
    import soundfile as sf
    from mlx_tune import FastTTSModel

    mx.eval(mx.array([1.0]) + 1.0)
    run = args.plan.parent / datetime.datetime.now().strftime("comparison-%Y%m%d-%H%M%S-%f")
    run.mkdir()
    report = {"plan": str(args.plan.resolve()), "sourceText": plan["text"],
              "reviewStatus": "pending", "productionApplied": False,
              "modelRevision": manifest["modelRevision"], "reference": manifest["reference"],
              "settings": settings, "baseline": plan.get("baseline"), "candidates": []}

    def save():
        (run / "comparison.json").write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n")
        (args.plan.parent / "latest.json").write_text(json.dumps({"comparison": str((run / "comparison.json").resolve())}, ensure_ascii=False, indent=2) + "\n")

    wrapper, _ = FastTTSModel.from_pretrained(model_name=str(model_path), max_seq_length=512)
    wrapper = FastTTSModel.get_peft_model(wrapper, r=16, lora_alpha=16, lora_dropout=0.,
        target_modules=["q_proj", "k_proj", "v_proj", "o_proj", "gate_proj", "up_proj", "down_proj"], random_state=plan["seed"])
    wrapper.load_adapter(str(adapter))
    wrapper.model.eval()
    model = wrapper.full_model
    layers = [(layer, layer.scale) for _, layer in wrapper.model.named_modules()
              if all(hasattr(layer, key) for key in ("lora_a", "lora_b", "scale"))]
    if not layers:
        raise ValueError("LoRA 모듈을 찾지 못했습니다.")

    def set_scale(strength):
        # Use each original layer scale; repeated multiplication would turn .20 into .12.
        for layer, original in layers:
            layer.scale = original * strength

    try:
        for index, condition in enumerate(plan["conditions"], 1):
            scale = condition["scale"]
            text = condition.get("text", plan["text"])
            seed = condition.get("seed", plan["seed"])
            if plan.get("dictionary"):
                from local_tts_engine.pronunciation import apply_pronunciation
                from local_tts_engine.english_voice import speech_segments
                if apply_pronunciation(condition["sourceText"], plan["dictionary"]) != text:
                    raise ValueError("샘플 원문과 준비한 발음 사전이 다릅니다.")
                if speech_segments(text, plan["dictionary"]) != [{"text": text, "language": "Korean"}]:
                    raise ValueError("문장 전체 합성 조건이 아닙니다.")
            set_scale(scale)
            print(f"{index}/{len(plan['conditions'])} · {condition['label']} · 문장 전체를 한 번에 생성", flush=True)
            mx.random.seed(seed)
            chunks = list(model.generate(text=text, ref_audio=str(reference),
                ref_text=transcript, lang_code="Korean", verbose=False, **settings))
            if not chunks:
                raise ValueError("생성 음성이 없습니다.")
            rate = int(chunks[0].sample_rate)
            if any(int(chunk.sample_rate) != rate for chunk in chunks):
                raise ValueError("샘플레이트가 일치하지 않습니다.")
            raw = np.concatenate([np.asarray(chunk.audio, dtype=np.float32).reshape(-1) for chunk in chunks])
            if not len(raw) or not np.all(np.isfinite(raw)):
                raise ValueError("생성 음성이 유효하지 않습니다.")
            raw_path = run / f"{index:02d}-whole-lora-{scale:.2f}-raw.wav"
            native_path = run / f"{index:02d}-whole-lora-{scale:.2f}-native.wav"
            output = run / f"{index:02d}-whole-lora-{scale:.2f}.wav"
            sf.write(raw_path, raw, rate, subtype="PCM_24")
            cleaned, cleanup = trim_and_fade_audio(raw, rate)
            sf.write(native_path, cleaned, rate, subtype="PCM_24")
            normalization = normalize_audio(native_path, output)
            report["candidates"].append({**condition, "audioPath": str(output.resolve()),
                "nativeAudioPath": str(native_path.resolve()), "rawAudioPath": str(raw_path.resolve()),
                "sha256": sha256_file(output), "seed": seed, "synthesisCalls": 1,
                "text": text, "language": "Korean", "referenceMode": "icl",
                "voiceRouting": None, "cleanup": cleanup, "normalization": normalization,
                "reviewStatus": "pending", **probe_audio(output)})
            save()
            del chunks
    finally:
        set_scale(.60)
    del set_scale, layers, model, wrapper
    gc.collect()
    mx.clear_cache()

    # Evidence only. No selection, regeneration, or pronunciation approval from ASR.
    try:
        from mlx_audio.stt.utils import load_model as load_reader
        reader = load_reader(LOCAL_QUALITY_ASR_PATH)
        for candidate in report["candidates"]:
            candidate["asrText"] = reader.generate(candidate["audioPath"], language="ko", task="transcribe",
                temperature=0., return_timestamps=False, condition_on_previous_text=False, max_tokens=256).text.strip()
            save()
        del reader
        gc.collect()
        mx.clear_cache()
    except Exception as error:
        report["asrError"] = str(error)
    report["alignments"] = []
    if plan.get("alignments"):
        from local_tts_engine.course_pilot import alignment_tokens, read_independent_word_times
        for request in plan["alignments"]:
            try:
                take = request if request.get("audioPath") else next(c for c in report["candidates"] if c.get("id") == request["candidateId"])
                raw_words = read_independent_word_times(Path(take["audioPath"]), request["text"])
                words, cursor = [], 0
                for token in alignment_tokens(request["text"]):
                    group, value = [], ""
                    while cursor < len(raw_words) and value.casefold() != token.casefold():
                        word = raw_words[cursor]
                        cursor += 1
                        group.append(word)
                        value += "".join(alignment_tokens(word["text"]))
                        if not token.casefold().startswith(value.casefold()):
                            raise ValueError("단어 정렬 표기 불일치")
                    if not group or value.casefold() != token.casefold():
                        raise ValueError("단어 정렬 누락")
                    words.append({"text": token, "startMs": group[0]["startMs"], "endMs": group[-1]["endMs"]})
                if cursor != len(raw_words) or any(w["endMs"] <= w["startMs"] for w in words):
                    raise ValueError("단어 정렬 시각 확인 필요")
                report["alignments"].append({**request, "audioPath": take["audioPath"], "sha256": take["sha256"], "words": words, "rawWords": raw_words})
            except Exception as error:
                report["alignments"].append({**request, "error": str(error)})
            save()
    report["generationComplete"] = True
    save()
    print(f"완료: {run}\n각 파일을 따로 듣고 비교해 주세요. 제작에는 적용하지 않았습니다.", flush=True)


if __name__ == "__main__":
    main()
