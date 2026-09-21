#!/usr/bin/env python3.13
"""Try several spellings of a hard term and measure which one the model reads.

The dictionary decides *what* to send the synthesizer, but sending correct
Hangul is not the same as being read correctly.  ``런타임`` has been a
dictionary entry since the beginning and the model still says 런트민, 런틈,
런팀.  The reading of a term is therefore an empirical question, and this script
answers it the only way it can be answered: generate the candidate spellings in
a real sentence from the course, read them back with the independent ASR, and
score each against the sound the term is supposed to have.

Nothing here changes production. It writes candidate clips and a JSON report to
a scratch directory so a spelling can be chosen on evidence and then written
into config/production-pronunciation.ko.json by hand.
"""

from __future__ import annotations

import argparse
import json
import re
import sys
import tempfile
import time
from pathlib import Path
from typing import Any

import numpy as np
import soundfile as sf

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))

from local_tts_engine.course_pilot import (  # noqa: E402
    LOCAL_QUALITY_ASR_PATH,
    apply_adapter_scale,
)
from local_tts_engine.pilot import MODEL_SPECS, resolve_model_path  # noqa: E402
from local_tts_engine.speech_quality import (  # noqa: E402
    PRONUNCIATION_MATCH_DISTANCE,
    PRONUNCIATION_WARNING_DISTANCE,
    asr_reading_windows,
)
from local_tts_engine.korean_phonetics import phonetic_variants, pronunciation_distance  # noqa: E402


def term_distance(target: str, recognized: str) -> float:
    """How far the transcript is from the sound the term should have."""
    target_keys = [key for key in phonetic_variants(target) if key]
    recognized_keys = [key for key in phonetic_variants(recognized) if key] or [""]
    if not target_keys:
        return 0.0
    return min(
        pronunciation_distance(target_key, recognized_key)
        for target_key in target_keys
        for recognized_key in recognized_keys
    )


def verdict(distance: float) -> str:
    if distance > PRONUNCIATION_WARNING_DISTANCE:
        return "불일치"
    if distance > PRONUNCIATION_MATCH_DISTANCE:
        return "애매"
    return "일치"


def clip_name(case_number: int, case_name: str, trial_number: int, label: str, seed_index: int) -> str:
    """Name one clip so that no two trials can land on the same file.

    macOS compares file names without case, so ``RICE`` and ``Rice`` — exactly
    the pair this script exists to tell apart — would write to one file and the
    surviving clips would all belong to whichever trial ran last.  The report
    would still be right, but anyone listening to the clips afterwards would
    hear the wrong spelling.  The ordinals carry the identity; the readable
    part is only there for humans.
    """
    safe_case = re.sub(r"[^0-9A-Za-z가-힣]+", "_", case_name).strip("_")
    safe_label = re.sub(r"[^0-9A-Za-z가-힣]+", "_", label).strip("_")
    return f"{case_number:02d}-{safe_case}--{trial_number:02d}-{safe_label}--{seed_index}.wav"


def expand_trials(case: dict[str, Any]) -> dict[str, Any]:
    """Normalize a case into ``trials`` of {label, text}.

    Two questions need the same machinery.  *Which spelling gets read right?*
    varies the term inside one carrier.  *Does chunk length break the reading?*
    keeps the term fixed and varies the passage around it.  A case may give
    ``spellings`` with a ``carrier``, or ``passages`` of its own.
    """
    if "trials" in case:
        return case
    trials: list[dict[str, str]] = []
    if "spellings" in case:
        carrier = str(case["carrier"])
        for spelling in case["spellings"]:
            trials.append({"label": spelling, "text": carrier.replace("{}", spelling)})
    for passage in case.get("passages", []):
        text = str(passage["text"])
        trials.append({"label": f"{passage['label']} ({len(text)}자)", "text": text})
    if not trials:
        raise ValueError(f"{case['name']}: 시험할 후보가 없습니다.")
    return {**case, "trials": trials}


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--cases", type=Path, required=True, help="시험할 후보 JSON")
    parser.add_argument("--reference", type=Path, required=True)
    parser.add_argument("--reference-text", type=Path, required=True)
    parser.add_argument("--output-dir", type=Path, required=True)
    parser.add_argument("--adapter", type=Path)
    parser.add_argument("--adapter-scale", type=float, default=0.60)
    parser.add_argument("--seeds", type=int, default=3)
    parser.add_argument("--seed", type=int, default=20260904)
    args = parser.parse_args(argv)

    cases = [expand_trials(case) for case in json.loads(args.cases.read_text(encoding="utf-8"))]
    reference_text = args.reference_text.read_text(encoding="utf-8").strip()
    args.output_dir.mkdir(parents=True, exist_ok=True)

    import mlx.core as mx
    from mlx_audio.stt.utils import load_model as load_stt_model
    from mlx_audio.tts.utils import load_model as load_tts_model
    from mlx_audio.utils import get_model_path

    reader = load_stt_model(LOCAL_QUALITY_ASR_PATH)

    spec = MODEL_SPECS["qwen3-tts"]
    model_path = resolve_model_path(spec.repository, get_model_path)
    if args.adapter is None:
        model = load_tts_model(model_path)
    else:
        from mlx_tune import FastTTSModel

        wrapper, _ = FastTTSModel.from_pretrained(model_name=str(model_path), max_seq_length=512)
        wrapper = FastTTSModel.get_peft_model(
            wrapper, r=16, lora_alpha=16, lora_dropout=0.0,
            target_modules=["q_proj", "k_proj", "v_proj", "o_proj",
                            "gate_proj", "up_proj", "down_proj"],
            random_state=args.seed,
        )
        wrapper.load_adapter(str(args.adapter))
        if apply_adapter_scale(wrapper.model, args.adapter_scale) == 0:
            raise RuntimeError("강도를 조절할 LoRA 모듈을 찾지 못했습니다.")
        wrapper.model.eval()
        model = wrapper.full_model

    def read_once(path: str) -> str:
        return reader.generate(
            path, language="ko", task="transcribe", temperature=0.0,
            return_timestamps=False, condition_on_previous_text=False, max_tokens=768,
        ).text

    def transcribe(path: str) -> str:
        samples, rate = sf.read(path, dtype="float32", always_2d=True)
        mono = np.mean(samples, axis=1, dtype=np.float32)
        windows = asr_reading_windows(mono, rate)
        if len(windows) == 1:
            return read_once(path)
        readings = []
        with tempfile.TemporaryDirectory() as scratch:
            for index, (begin, end) in enumerate(windows):
                piece = Path(scratch) / f"{index}.wav"
                sf.write(piece, mono[begin:end], rate)
                readings.append(read_once(str(piece)).strip())
        return " ".join(readings)

    results: list[dict[str, Any]] = []
    started = time.perf_counter()
    for case_number, case in enumerate(cases, start=1):
        target = str(case["target"])
        print(f"\n═══ {case['name']}  목표 소리: {target}", flush=True)
        for trial_number, trial in enumerate(case["trials"], start=1):
            spelling = str(trial["label"])
            sentence = str(trial["text"])
            heard: list[str] = []
            distances: list[float] = []
            clips: list[str] = []
            for index in range(args.seeds):
                seed = (args.seed + index * 0x9E3779B1) & 0xFFFFFFFF
                mx.random.seed(seed)
                pieces = [
                    np.asarray(segment.audio, dtype=np.float32).reshape(-1)
                    for segment in model.generate(
                        text=sentence, ref_audio=str(args.reference),
                        ref_text=reference_text, lang_code=spec.language,
                        verbose=False, **spec.settings,
                    )
                ]
                if not pieces:
                    raise RuntimeError(f"{spelling}: 오디오가 생성되지 않았습니다.")
                audio = np.concatenate(pieces)
                clip = args.output_dir / clip_name(
                    case_number, str(case["name"]), trial_number, spelling, index
                )
                sf.write(clip, audio, 24_000)
                clips.append(clip.name)
                text = transcribe(str(clip)).strip()
                heard.append(text)
                distances.append(term_distance(target, text))
            worst = max(distances)
            best = min(distances)
            print(f"  {spelling:26} 거리 최선 {best:.3f} / 최악 {worst:.3f}  [{verdict(worst)}]", flush=True)
            for text in heard:
                print(f"       들림: {text}", flush=True)
            results.append({
                "name": case["name"], "target": target, "spelling": spelling,
                "sentence": sentence, "heard": heard, "clips": clips,
                "distances": [round(value, 4) for value in distances],
                "best": round(best, 4), "worst": round(worst, 4),
                "verdict": verdict(worst),
            })

    report = args.output_dir / "report.json"
    report.write_text(json.dumps(results, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(f"\n{round(time.perf_counter() - started, 1)}초. 보고서: {report}")
    print("\n■ 용어별 최선 표기")
    for case in cases:
        rows = [row for row in results if row["name"] == case["name"]]
        rows.sort(key=lambda row: (row["worst"], row["best"]))
        top = rows[0]
        print(f"  {case['name']:22} → {top['spelling']}  최악거리 {top['worst']:.3f} [{top['verdict']}]")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
