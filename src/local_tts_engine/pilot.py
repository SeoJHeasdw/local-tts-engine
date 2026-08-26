"""Run one side of the local TTS A/B pilot and record reproducible metadata.

두 모델(Qwen3-TTS, Chatterbox-V3)을 같은 조건으로 비교하기 위한 단일 실행 단위.
참조 음성 + 텍스트를 받아 음성을 생성하고, ffmpeg로 라우드니스를 정규화한 뒤
재현 가능한 메타데이터를 JSON으로 기록한다.

CLI 진입점:
    python -m local_tts_engine.pilot \\
        --model qwen3-tts \\
        --text-file input.txt \\
        --reference ref.wav \\
        --reference-text ref.txt \\
        --output out.wav \\
        --metadata out.json
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import platform
import re
import subprocess
import sys
import time
from dataclasses import dataclass
from importlib.metadata import version
from pathlib import Path
from typing import Any

import numpy as np
import soundfile as sf


# ─── 오디오 품질 기준 ──────────────────────────────────────────────────────────
# EBU R128 방송 표준 기반 라우드니스 목표치.
# 강의 플랫폼(Udemy 등)에서 요구하는 -14 LUFS보다 약간 보수적으로 잡는다.
TARGET_SAMPLE_RATE = 48_000         # 출력 샘플레이트 (Hz)
TARGET_LUFS = -23.0                 # 목표 통합 라우드니스 (EBU R128)
TARGET_TRUE_PEAK_DBTP = -3.0        # 최대 트루 피크 (dBTP)
TARGET_LRA = 11.0                   # 허용 라우드니스 범위 (LU)

# 시드를 고정하면 같은 텍스트·참조 음성에서 항상 같은 결과를 얻는다.
# 날짜 형식(YYYYMMDD)으로 지정해 의미를 명확히 한다.
DEFAULT_SEED = 20_260_823


# ─── 모델 스펙 ────────────────────────────────────────────────────────────────
@dataclass(frozen=True)
class ModelSpec:
    """한 TTS 모델의 HuggingFace 경로, 라이선스, 언어, 생성 파라미터를 묶는 불변 레코드."""

    key: str                    # 내부 식별자 (예: "qwen3-tts")
    repository: str             # mlx-community 또는 HuggingFace 저장소 슬러그
    license: str                # SPDX 라이선스 식별자
    language: str               # 모델 API에 전달하는 언어 코드
    settings: dict[str, Any]    # generate() 에 전달되는 추론 하이퍼파라미터


MODEL_SPECS = {
    "qwen3-tts": ModelSpec(
        key="qwen3-tts",
        # MLX 변환된 BF16 가중치. Apple Silicon Metal 가속 사용.
        repository="mlx-community/Qwen3-TTS-12Hz-1.7B-Base-bf16",
        license="Apache-2.0",
        language="Korean",
        settings={
            "temperature": 0.9,         # 샘플링 다양성 (높을수록 발화가 다채로워진다)
            "top_k": 50,                # 상위 k 토큰만 후보로 유지
            "top_p": 1.0,               # 누적 확률 임계값 (1.0 = 비활성)
            "repetition_penalty": 1.5,  # 반복 억제 강도 (Qwen은 긴 문장에서 루프 경향)
            "max_tokens": 4096,         # 생성 최대 토큰 수
        },
    ),
    "chatterbox-v3": ModelSpec(
        key="chatterbox-v3",
        # Resemble AI의 다국어 v3 모델 (MLX 변환).
        repository="mlx-community/chatterbox-multilingual-v3",
        license="MIT",
        language="ko",
        settings={
            "temperature": 0.8,
            "top_p": 1.0,
            "min_p": 0.05,              # 최소 확률 필터 (너무 낮은 토큰 제거)
            "repetition_penalty": 1.2,
            "exaggeration": 0.5,        # 감정 과장 정도 (0=평탄, 1=과장)
            "cfg_weight": 0.5,          # Classifier-Free Guidance 강도
            "max_new_tokens": 3000,
        },
    ),
}


# ─── 유틸리티 ─────────────────────────────────────────────────────────────────

def sha256_file(path: Path) -> str:
    """파일을 1MB 청크로 스트리밍하며 SHA-256 다이제스트를 계산한다.

    대용량 음성 파일도 메모리에 전부 올리지 않고 해시할 수 있다.
    """
    digest = hashlib.sha256()
    with path.open("rb") as source:
        for chunk in iter(lambda: source.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def sha256_text(text: str) -> str:
    """UTF-8 인코딩된 문자열의 SHA-256 다이제스트를 반환한다."""
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


def resolve_model_path(repository: str, downloader: Any) -> Path:
    """Prefer an installed Hugging Face snapshot and only download as fallback."""
    direct = Path(repository).expanduser()
    if direct.exists():
        return direct

    hub_root = Path(
        os.environ.get(
            "HF_HUB_CACHE",
            Path(os.environ.get("HF_HOME", Path.home() / ".cache/huggingface")) / "hub",
        )
    )
    cache_root = hub_root / f"models--{repository.replace('/', '--')}"
    ref = cache_root / "refs/main"
    if ref.is_file():
        revision = ref.read_text(encoding="utf-8").strip()
        snapshot = cache_root / "snapshots" / revision
        if snapshot.is_dir():
            return snapshot
    snapshots = sorted(
        (cache_root / "snapshots").glob("*"),
        key=lambda item: item.stat().st_mtime,
        reverse=True,
    ) if (cache_root / "snapshots").is_dir() else []
    if snapshots:
        return snapshots[0]
    return Path(downloader(repository))


def run_checked(command: list[str]) -> subprocess.CompletedProcess[str]:
    """명령어를 실행하고 실패하면 CalledProcessError를 발생시킨다.

    stdout·stderr를 모두 캡처하므로 호출자가 파싱할 수 있다.
    """
    return subprocess.run(
        command,
        check=True,
        text=True,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
    )


def parse_loudnorm_json(stderr: str) -> dict[str, str]:
    """ffmpeg loudnorm 필터가 stderr에 출력하는 JSON 블록을 파싱한다.

    ffmpeg는 측정 결과를 stderr에 JSON 형식으로 덤프한다.
    2패스 정규화에서 1패스(측정)와 2패스(적용) 모두 이 함수로 파싱한다.
    """
    matches = re.findall(r"\{\s*\"input_i\".*?\}", stderr, flags=re.DOTALL)
    if not matches:
        raise RuntimeError("ffmpeg loudnorm 측정 결과를 찾지 못했습니다.")
    # 여러 JSON 블록이 있으면 마지막 블록(최종 측정값)을 사용한다.
    return json.loads(matches[-1])


def normalize_audio(source: Path, destination: Path) -> dict[str, Any]:
    """EBU R128 2패스 라우드니스 정규화를 수행하고 측정 결과를 반환한다.

    1패스: 실제 파일을 재생하지 않고(-f null) 라우드니스를 측정한다.
    2패스: 측정값을 loudnorm에 직접 주입해 선형 보정(linear=true)으로 적용한다.
    선형 보정은 다이나믹을 최대한 보존하면서 목표 LUFS에 맞춘다.

    출력 포맷: 48kHz, 모노, PCM 24비트 WAV
    """
    # 1패스: 입력 라우드니스 측정 (오디오 출력 없음)
    measure_filter = (
        f"loudnorm=I={TARGET_LUFS}:TP={TARGET_TRUE_PEAK_DBTP}:"
        f"LRA={TARGET_LRA}:print_format=json"
    )
    first_pass = run_checked(
        [
            "ffmpeg",
            "-hide_banner",
            "-nostats",
            "-i",
            str(source),
            "-af",
            measure_filter,
            "-f",
            "null",
            "-",
        ]
    )
    measured = parse_loudnorm_json(first_pass.stderr)

    # 2패스: 1패스 측정값을 이용해 정규화 적용
    normalize_filter = (
        f"loudnorm=I={TARGET_LUFS}:TP={TARGET_TRUE_PEAK_DBTP}:LRA={TARGET_LRA}:"
        f"measured_I={measured['input_i']}:measured_LRA={measured['input_lra']}:"
        f"measured_TP={measured['input_tp']}:"
        f"measured_thresh={measured['input_thresh']}:"
        f"offset={measured['target_offset']}:linear=true:print_format=json"
    )
    destination.parent.mkdir(parents=True, exist_ok=True)
    second_pass = run_checked(
        [
            "ffmpeg",
            "-y",
            "-hide_banner",
            "-nostats",
            "-i",
            str(source),
            "-af",
            normalize_filter,
            "-ar",
            str(TARGET_SAMPLE_RATE),
            "-ac",
            "1",           # 모노 다운믹스
            "-c:a",
            "pcm_s24le",   # 24비트 리틀엔디언 PCM
            str(destination),
        ]
    )
    output_measurement = parse_loudnorm_json(second_pass.stderr)
    return {
        "method": "ffmpeg loudnorm two-pass linear",
        "targetIntegratedLufs": TARGET_LUFS,
        "targetTruePeakDbtp": TARGET_TRUE_PEAK_DBTP,
        "targetLra": TARGET_LRA,
        "inputMeasurement": measured,
        "outputMeasurement": output_measurement,
    }


def probe_audio(path: Path) -> dict[str, Any]:
    """ffprobe로 오디오 파일의 메타데이터(길이·크기·코덱 등)를 추출한다.

    출력은 메타데이터 JSON에 그대로 병합된다.
    """
    result = run_checked(
        [
            "ffprobe",
            "-v",
            "error",
            "-show_entries",
            "format=duration,size:stream=codec_name,sample_rate,channels,bits_per_raw_sample",
            "-of",
            "json",
            str(path),
        ]
    )
    data = json.loads(result.stdout)
    stream = data["streams"][0]
    audio_format = data["format"]
    return {
        "durationMs": round(float(audio_format["duration"]) * 1000),
        "sizeBytes": int(audio_format["size"]),
        "codec": stream["codec_name"],
        "sampleRate": int(stream["sample_rate"]),
        "channels": int(stream["channels"]),
        "bitsPerSample": int(stream.get("bits_per_raw_sample") or 0),
    }


def snapshot_revision(model_path: Path) -> str:
    """모델 경로에서 HuggingFace 스냅샷 커밋 해시를 추출한다.

    HuggingFace 캐시 구조는 .../snapshots/<commit_hash>/ 형태이므로,
    부모 디렉터리가 "snapshots"이면 폴더명이 곧 커밋 해시다.
    로컬 경로로 직접 넘긴 경우에는 "local"을 반환한다.
    """
    if model_path.parent.name == "snapshots":
        return model_path.name
    return "local"


def cached_main_revision(repository: str) -> str | None:
    """HuggingFace 로컬 캐시에서 'main' 브랜치의 커밋 해시를 읽는다.

    Chatterbox-V3는 토크나이저(S3TokenizerV2)가 별도 저장소에 있어
    버전 추적을 위해 따로 기록한다.
    캐시가 없으면(모델 미다운로드) None을 반환한다.
    """
    cache_name = "models--" + repository.replace("/", "--")
    ref_path = Path.home() / ".cache/huggingface/hub" / cache_name / "refs/main"
    if ref_path.is_file():
        return ref_path.read_text(encoding="utf-8").strip()
    return None


# ─── 핵심 생성 로직 ───────────────────────────────────────────────────────────

def synthesize(
    model_key: str,
    text_path: Path,
    reference_path: Path,
    reference_text_path: Path,
    output_path: Path,
    metadata_path: Path,
    seed: int,
) -> None:
    """텍스트와 참조 음성을 받아 TTS 음성을 생성하고 메타데이터를 기록한다.

    흐름:
        1. mlx-audio 모델 로드 (타이밍 측정 포함)
        2. 모델별 generate() 호출 (Qwen3은 ref_text 필요, Chatterbox는 불필요)
        3. 다중 세그먼트를 하나의 numpy 배열로 연결
        4. 네이티브 WAV 저장 → ffmpeg 2패스 정규화 → 최종 WAV 저장
        5. 재현성·라이선스·성능 수치를 JSON 메타데이터로 기록

    MLX 임포트를 함수 안으로 지연시켜 --help와 단위 테스트가
    Metal 없이도 동작하도록 한다.
    """
    # MLX imports are deliberately delayed so --help and unit tests work without Metal.
    import mlx.core as mx
    from mlx_audio.tts.utils import load_model
    from mlx_audio.utils import get_model_path

    spec = MODEL_SPECS[model_key]
    text = text_path.read_text(encoding="utf-8").strip()
    reference_text = reference_text_path.read_text(encoding="utf-8").strip()
    if not text:
        raise ValueError("입력 문장이 비어 있습니다.")
    if not reference_text:
        raise ValueError("참조 전사문이 비어 있습니다.")

    mx.random.seed(seed)
    model_path = resolve_model_path(spec.repository, get_model_path)
    load_started = time.perf_counter()
    model = load_model(model_path)
    load_ms = round((time.perf_counter() - load_started) * 1000)

    generation_started = time.perf_counter()
    if model_key == "qwen3-tts":
        # Qwen3-TTS는 참조 전사문(ref_text)을 받아 음성 스타일을 복제한다.
        results = list(
            model.generate(
                text=text,
                ref_audio=str(reference_path),
                ref_text=reference_text,
                lang_code=spec.language,
                verbose=True,
                **spec.settings,
            )
        )
    else:
        # Chatterbox-V3는 전사문 없이 참조 음성만으로 스타일을 복제한다.
        results = list(
            model.generate(
                text=text,
                ref_audio=str(reference_path),
                lang_code=spec.language,
                verbose=True,
                **spec.settings,
            )
        )
    generation_ms = round((time.perf_counter() - generation_started) * 1000)
    if not results:
        raise RuntimeError("모델이 오디오를 생성하지 않았습니다.")

    # 세그먼트별 샘플레이트 일관성 검증 후 하나의 배열로 연결
    native_rate = int(results[0].sample_rate)
    if any(int(result.sample_rate) != native_rate for result in results):
        raise RuntimeError("생성 세그먼트의 샘플레이트가 서로 다릅니다.")
    audio = np.concatenate([np.asarray(result.audio) for result in results])

    # 네이티브 파일(원본)은 work/ 하위에 보존하고, 정규화된 파일을 최종 출력으로 사용한다.
    native_path = output_path.parent / "work" / f"{model_key}-native.wav"
    native_path.parent.mkdir(parents=True, exist_ok=True)
    sf.write(native_path, audio, native_rate, subtype="PCM_24")
    normalization = normalize_audio(native_path, output_path)
    output_probe = probe_audio(output_path)

    peak_memory_gb = max(float(result.peak_memory_usage) for result in results)
    metadata = {
        "schemaVersion": 1,
        "modelKey": spec.key,
        "model": spec.repository,
        "modelRevision": snapshot_revision(model_path),
        "modelLicense": spec.license,
        # Chatterbox-V3는 S3TokenizerV2를 별도로 사용하므로 버전을 따로 기록
        "tokenizerRevision": (
            cached_main_revision("mlx-community/S3TokenizerV2")
            if model_key == "chatterbox-v3"
            else None
        ),
        "seed": seed,
        "settings": {"language": spec.language, **spec.settings},
        "input": {
            "path": str(text_path.resolve()),
            "sha256": sha256_text(text),
            "characters": len(text),
        },
        "reference": {
            "path": str(reference_path.resolve()),
            "sha256": sha256_file(reference_path),
            "transcriptPath": str(reference_text_path.resolve()),
            "transcriptSha256": sha256_text(reference_text),
        },
        "performance": {
            "modelLoadMs": load_ms,
            "generationMs": generation_ms,
            "peakMetalMemoryGb": round(peak_memory_gb, 3),
        },
        "nativeAudio": {
            "path": str(native_path.resolve()),
            "sampleRate": native_rate,
            "segments": len(results),
        },
        "normalization": normalization,
        "audioPath": str(output_path.resolve()),
        **output_probe,
        "software": {
            "python": platform.python_version(),
            "mlxAudio": version("mlx-audio"),
            "mlx": version("mlx"),
        },
        "platform": {
            "machine": platform.machine(),
            "macOS": platform.mac_ver()[0],
        },
    }
    metadata_path.parent.mkdir(parents=True, exist_ok=True)
    metadata_path.write_text(
        json.dumps(metadata, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )
    print(json.dumps(metadata, ensure_ascii=False, indent=2))


# ─── CLI ──────────────────────────────────────────────────────────────────────

def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--model", choices=sorted(MODEL_SPECS), required=True,
                        help="비교할 TTS 모델 키 (qwen3-tts 또는 chatterbox-v3)")
    parser.add_argument("--text-file", type=Path, required=True,
                        help="합성할 텍스트 파일 경로")
    parser.add_argument("--reference", type=Path, required=True,
                        help="음성 복제에 사용할 참조 WAV 파일")
    parser.add_argument("--reference-text", type=Path, required=True,
                        help="참조 음성의 전사문 텍스트 파일")
    parser.add_argument("--output", type=Path, required=True,
                        help="정규화된 출력 WAV 파일 경로")
    parser.add_argument("--metadata", type=Path, required=True,
                        help="재현성 메타데이터를 기록할 JSON 파일 경로")
    parser.add_argument("--seed", type=int, default=DEFAULT_SEED,
                        help=f"MLX 난수 시드 (기본값: {DEFAULT_SEED})")
    return parser


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    synthesize(
        model_key=args.model,
        text_path=args.text_file,
        reference_path=args.reference,
        reference_text_path=args.reference_text,
        output_path=args.output,
        metadata_path=args.metadata,
        seed=args.seed,
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
