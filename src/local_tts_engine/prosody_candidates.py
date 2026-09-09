"""Generate alternative Qwen3-TTS takes for selected cached course chunks.

course_pilot.py 가 캐시한 청크 중 일부를 골라
동일 텍스트를 서로 다른 시드로 여러 번 재합성(multi-take)해
최적의 발화를 청취로 선택할 수 있도록 후보군을 생성한다.

사용 시나리오:
    - course_pilot 결과를 들어봤을 때 특정 청크의 운율이 어색한 경우
    - 동일 발화 여러 버전을 빠르게 비교 청취하고 싶은 경우

출력 구조 (<output_dir>/<chunk_key>/):
    take-1.wav          - 1번 후보 (라우드니스 정규화됨)
    take-1.m4a          - 1번 후보 AAC 미리듣기
    take-1-native.wav   - 1번 후보 원본 (트리밍만 적용)
    take-2.wav, ...     - 이하 동일
    index.json          - 모든 후보의 메타데이터 목록

CLI 진입점:
    python -m local_tts_engine.prosody_candidates \\
        --manifest outputs/ch00-5m/manifest.json \\
        --chunk-key ch00--intro-why--1-to-2 \\
        --chunk-key ch00--intro-what--1 \\
        --output-dir outputs/prosody-candidates \\
        --takes 3
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path
from typing import Any

import soundfile as sf

from .course_pilot import (
    COURSE_SETTING_OVERRIDES,
    apply_pronunciation,
    create_preview,
    production_pronunciation,
    stable_digest,
    generate_candidate_audio,
    write_json,
)
from .pilot import MODEL_SPECS, normalize_audio, probe_audio, snapshot_revision
from .english_voice import EnglishVoiceRouter


# ─── 텍스트 추출 ─────────────────────────────────────────────────────────────

def chunk_text(manifest: dict[str, Any], chunk_key: str) -> str:
    """manifest에서 특정 chunkKey 에 속하는 엔트리의 TTS 텍스트를 재구성한다.

    manifest entries 에는 스텝 단위 항목이 들어있고,
    chunkKey 로 필터링해 해당 청크의 모든 스텝 텍스트를 이어 붙인다.
    프로덕션 발음 사전을 다시 한번 적용해 텍스트가 항상 최신 사전을 반영하도록 한다.

    Args:
        manifest:  course_pilot manifest 딕셔너리.
        chunk_key: 재합성할 청크의 key 문자열.

    Returns:
        발음 치환이 적용된 TTS 입력 텍스트.
    """
    entries = [entry for entry in manifest["entries"] if entry["chunkKey"] == chunk_key]
    if not entries:
        raise ValueError(f"매니페스트에서 {chunk_key}를 찾지 못했습니다.")
    # 스텝 순서대로 공백으로 연결 (manifest entries 는 이미 순서 보장)
    text = " ".join(entry["tts_text"] for entry in entries)
    # 사전이 업데이트됐을 경우를 대비해 프로덕션 발음 사전을 재적용
    return apply_pronunciation(text, production_pronunciation())


# ─── 후보 생성 ────────────────────────────────────────────────────────────────

def generate_candidates(
    manifest_path: Path,
    chunk_keys: list[str],
    output_dir: Path,
    takes: int,
) -> None:
    """지정한 청크들에 대해 여러 시드로 TTS를 재합성하고 후보 파일을 저장한다.

    각 (chunk_key, take) 조합마다 고유한 시드를 파생시켜
    동일 텍스트의 다양한 운율 변형을 얻는다.

    시드 파생 방식:
        seed = manifest_seed XOR stable_digest({"chunkKey": key, "take": n})[:8]
    XOR을 사용하면 기반 시드가 같아도 청크·테이크마다 독립적인 시드를 얻을 수 있다.

    후처리:
        1. trim_and_fade_audio: 앞뒤 무음 제거 + 내부 과도 무음 압축 + 페이드
        2. normalize_audio:     ffmpeg EBU R128 2패스 라우드니스 정규화
        3. create_preview:      AAC M4A 미리듣기 생성

    결과는 <output_dir>/index.json 에 모두 기록된다.
    """
    # MLX 임포트를 지연해 --help와 단위 테스트가 Metal 없이 동작하도록 한다.
    import mlx.core as mx
    from mlx_audio.tts.utils import load_model
    from mlx_audio.utils import get_model_path

    if takes < 1:
        raise ValueError("후보 수는 1개 이상이어야 합니다.")

    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    spec = MODEL_SPECS["qwen3-tts"]
    # 강의 생성과 동일한 파라미터 오버라이드 적용 (안정성 우선)
    settings = {**spec.settings, **COURSE_SETTING_OVERRIDES}

    # 참조 음성 정보: manifest 에 기록된 경로·전사문을 그대로 사용
    reference = manifest["reference"]
    reference_text = Path(reference["transcriptPath"]).read_text(encoding="utf-8").strip()
    # 시드 파생의 기반이 되는 manifest 전역 시드
    base_seed = int(manifest["seed"])

    model_path = get_model_path(spec.repository)
    model = load_model(model_path)
    output_dir.mkdir(parents=True, exist_ok=True)
    index: list[dict[str, Any]] = []

    for chunk_key in chunk_keys:
        text = chunk_text(manifest, chunk_key)
        chunk_dir = output_dir / chunk_key
        chunk_dir.mkdir(parents=True, exist_ok=True)

        for take in range(1, takes + 1):
            # (chunk_key, take) 조합으로 결정적 시드 파생
            seed = base_seed ^ int(
                stable_digest({"chunkKey": chunk_key, "take": take})[:8], 16
            )
            mx.random.seed(seed)
            generated = generate_candidate_audio(model.generate, dict(
                    text=text,
                    ref_audio=reference["path"],
                    ref_text=reference_text,
                    lang_code=spec.language,
                    verbose=False,   # 후보 생성은 조용히 진행
                    **settings,
                ), voice_router=EnglishVoiceRouter(production_pronunciation()))
            generation_ms = generated["generationMs"]
            rate, audio, cleanup = generated["sampleRate"], generated["audio"], generated["cleanup"]

            # 파일 경로 정의
            native_path = chunk_dir / f"take-{take}-native.wav"  # 트리밍만 된 원본
            wav_path = chunk_dir / f"take-{take}.wav"            # 정규화된 최종 WAV
            m4a_path = chunk_dir / f"take-{take}.m4a"            # AAC 미리듣기

            # 저장 순서: 네이티브 → 정규화(WAV) → 미리듣기(M4A)
            sf.write(native_path, audio, rate, subtype="PCM_24")
            normalization = normalize_audio(native_path, wav_path)
            create_preview(wav_path, m4a_path)

            # 이 테이크의 메타데이터를 index 에 추가
            index.append(
                {
                    "chunkKey": chunk_key,
                    "take": take,
                    "seed": seed,
                    "text": text,                             # 실제 합성에 사용된 텍스트
                    "generationMs": generation_ms,
                    "cleanup": cleanup,                       # trim_and_fade_audio 통계
                    "normalization": normalization,           # EBU R128 측정값
                    "audioPath": str(wav_path.resolve()),
                    "previewPath": str(m4a_path.resolve()),
                    **probe_audio(wav_path),                  # durationMs, sizeBytes 등
                }
            )

    # 모든 청크·테이크의 요약을 index.json 으로 저장
    write_json(
        output_dir / "index.json",
        {
            "schemaVersion": 1,
            "sourceManifest": str(manifest_path.resolve()),
            "model": spec.repository,
            "modelRevision": snapshot_revision(model_path),
            "settings": {"language": spec.language, **settings},
            "candidates": index,
        },
    )
    # 터미널에는 생성된 후보 목록(audioPath, generationMs 등)을 출력한다
    print(json.dumps(index, ensure_ascii=False, indent=2))


# ─── CLI ──────────────────────────────────────────────────────────────────────

def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--manifest", type=Path, required=True,
                        help="course_pilot 가 생성한 manifest.json 경로")
    parser.add_argument("--chunk-key", action="append", required=True,
                        help="재합성할 청크 key (여러 번 지정 가능)")
    parser.add_argument("--output-dir", type=Path, required=True,
                        help="후보 파일을 저장할 디렉터리")
    parser.add_argument("--takes", type=int, default=3,
                        help="청크당 생성할 후보 수 (기본값: 3)")
    return parser


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    generate_candidates(
        manifest_path=args.manifest,
        chunk_keys=args.chunk_key,
        output_dir=args.output_dir,
        takes=args.takes,
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
