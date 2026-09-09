"""Export a local course pilot into the udemy-agent narration contract.

course_pilot.py 가 생성한 manifest.json을 udemy-agent의 narration 계약 형식으로
변환해 deck 저장소에 직접 복사·배치한다.

변환 흐름:
    1. course_pilot manifest.json 읽기
    2. deck의 narration.config.json 에서 preset·provider 정의 로드
    3. manifest entries → timeline entries 형식으로 변환
    4. 오디오 파일(track.wav, track.m4a)을 deck 출력 디렉터리로 복사
    5. timeline.json, local-import.json 저장

출력 결과물 (deck_root/narration/output/<preset_name>/ 하위):
    track.wav          - 정규화된 최종 오디오
    track.m4a          - AAC 미리듣기 파일
    timeline.json      - captions.mjs/capture.mjs 가 소비하는 타임라인 계약
    local-import.json  - 재현성 추적용 소스 링크

CLI 진입점:
    python -m local_tts_engine.export_udemy \\
        --source-dir outputs/ch00-5m \\
        --deck-root /path/to/udemy-agent/deck
"""

from __future__ import annotations

import argparse
import json
import shutil
import sys
from pathlib import Path
from typing import Any


# narration.config.json 에 정의된 preset/provider 기본값
DEFAULT_PRESET = "qwen3-first-5m"
DEFAULT_PROVIDER = "qwen3-local"


# ─── 파일 I/O ────────────────────────────────────────────────────────────────

def write_json(path: Path, value: Any) -> None:
    """부모 디렉터리를 자동 생성하고 JSON을 UTF-8로 저장한다."""
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(
        json.dumps(value, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )


def invalidate_render_derivatives(output_dir: Path, preset_name: str) -> None:
    """새 트랙과 함께 사용할 수 없는 이전 자막·녹화 산출물을 제거한다."""
    for name in ("captions.json", "captions.srt", "captions.vtt"):
        (output_dir / name).unlink(missing_ok=True)

    video_dir = output_dir / "video"
    if video_dir.is_dir():
        shutil.rmtree(video_dir)

    for video in output_dir.glob(f"{preset_name}*.mp4"):
        video.unlink()


# ─── 타임라인 변환 ────────────────────────────────────────────────────────────

def timeline_from_course_manifest(
    manifest: dict[str, Any],
    preset: dict[str, Any],
    provider: dict[str, Any],
) -> dict[str, Any]:
    """course_pilot manifest를 덱 미디어 런타임의 timeline 형식으로 변환한다.

    course-media.mjs 계약:
        - entries[].order:         0-based 순번
        - entries[].key:           "<slide_id>--<step>" 형식 고유 키
        - entries[].startMs:       화면이 활성화되는 절대 시각 (ms)
        - entries[].endMs:         화면이 비활성화되는 절대 시각 (ms)
        - entries[].transitionAtMs 다음 화면으로 전환하는 절대 시각 (ms)
        - entries[].gapAfterMs:    현재 endMs → 다음 startMs 사이의 빈 시간
        - entries[].speechStartMs: 실제 발화가 시작되는 절대 시각 (ms)
        - entries[].speechEndMs:   실제 발화가 끝나는 절대 시각 (ms)
        - entries[].audio.durationMs: 이 스텝에 배정된 오디오 길이

    Args:
        manifest: course_pilot 이 생성한 manifest 딕셔너리.
        preset:   deck narration.config.json 의 preset 항목 (이름 포함).
        provider: deck narration.config.json 의 provider 항목 (이름 포함).

    Returns:
        captions.mjs와 capture.mjs가 직접 소비할 수 있는 timeline 딕셔너리.
    """
    source_entries = manifest["entries"]
    total_ms = int(manifest["durationMs"])
    entries = []
    for index, item in enumerate(source_entries):
        # 다음 스텝의 startMs가 이 스텝 이후의 갭 계산 기준
        next_start = (
            int(source_entries[index + 1]["startMs"])
            if index + 1 < len(source_entries)
            else total_ms
        )
        end_ms = int(item["endMs"])
        # transitionAtMs 가 없는 구버전 manifest와의 하위 호환
        transition_at_ms = int(item.get("transitionAtMs", end_ms))
        entries.append(
            {
                "order": index,
                "chapter": item["chapter"],
                # 덱 미디어 런타임은 "<slide_id>--<step>" 형태의 키를 사용한다.
                "key": f"{item['slide_id']}--{item['step']}",
                "slideId": item["slide_id"],
                "slideNumber": int(item["slide_number"]),
                "step": int(item["step"]),
                "sourceText": item["source_text"],   # 자막용 원문
                "ttsText": item["tts_text"],          # TTS에 실제 입력된 텍스트
                "hash": item["hash"],                 # 클립 캐시 해시 (재현성 추적)
                "audio": {
                    # raw/wav 는 트랙 전체에서 공유하므로 여기서는 null
                    "raw": None,
                    "wav": None,
                    "durationMs": int(item["durationMs"]),
                },
                "startMs": int(item["startMs"]),
                "endMs": end_ms,
                "transitionAtMs": transition_at_ms,
                "gapAfterMs": next_start - end_ms,
                # speechStartMs/speechEndMs 가 없는 구버전 manifest 대응
                "speechStartMs": int(item.get("speechStartMs", item["startMs"])),
                "speechEndMs": int(item.get("speechEndMs", item["endMs"])),
                "alignment": item.get("alignment"),   # 단어별 타이밍 (없을 수도 있음)
                # 같은 화면 스텝 내부의 의도된 무음 구간 (예: 대본의 [2s])
                "forcedPauses": item.get("forcedPauses", []),
            }
        )
    return {
        "schemaVersion": int(manifest["schemaVersion"]),
        "generatedAt": manifest.get("generatedAt"),  # 생성 시각 (있으면 전달)
        "sourceContract": manifest.get("sourceContract"),
        **({"voiceRouting": manifest["voiceRouting"]} if manifest.get("voiceRouting") else {}),
        "preset": preset,
        "provider": provider,
        "startPadMs": int(manifest["timing"]["startPadMs"]),
        "totalMs": total_ms,
        "entries": entries,
    }


# ─── 내보내기 ─────────────────────────────────────────────────────────────────

def export(
    source_dir: Path,
    deck_root: Path,
    preset_name: str,
    provider_name: str,
) -> Path:
    """course_pilot 결과물을 deck 저장소의 narration 출력 디렉터리로 내보낸다.

    deck narration.config.json 에서 outputRoot 를 읽어 출력 경로를 결정하므로
    경로를 하드코딩하지 않는다.

    복사 목록:
        - manifest["audioPath"]   → <output_dir>/audio/track.wav
        - manifest["previewPath"] → <output_dir>/audio/track.m4a

    저장 목록:
        - <output_dir>/timeline.json       (captions.mjs/capture.mjs 소비)
        - <output_dir>/local-import.json   (재현성 추적)

    Args:
        source_dir:    course_pilot --output-dir 와 동일한 경로 (manifest.json 포함).
        deck_root:     udemy-agent 저장소의 deck 하위 디렉터리.
        preset_name:   narration.config.json["presets"] 의 키.
        provider_name: narration.config.json["providers"] 의 키.

    Returns:
        생성된 출력 디렉터리 경로.
    """
    source_manifest_path = source_dir / "manifest.json"
    source_manifest = json.loads(source_manifest_path.read_text(encoding="utf-8"))

    # deck 설정에서 preset·provider 정의와 출력 루트를 읽는다
    deck_config = json.loads(
        (deck_root / "narration.config.json").read_text(encoding="utf-8")
    )
    preset = {"name": preset_name, **deck_config["presets"][preset_name]}
    provider = {"provider": provider_name, **deck_config["providers"][provider_name]}

    timeline = timeline_from_course_manifest(source_manifest, preset, provider)

    # 출력 디렉터리: deck_root/<outputRoot>/<preset_name>/
    output_dir = deck_root / deck_config["outputRoot"] / preset_name
    audio_dir = output_dir / "audio"
    audio_dir.mkdir(parents=True, exist_ok=True)

    # 오디오·타임라인만 교체되고 예전 MP4가 최종본처럼 남는 일을 방지한다.
    invalidate_render_derivatives(output_dir, preset_name)

    # 오디오 파일을 deck 저장소 내 고정 경로로 복사
    shutil.copy2(source_manifest["audioPath"], audio_dir / "track.wav")
    shutil.copy2(source_manifest["previewPath"], audio_dir / "track.m4a")

    # 자막 생성과 화면 촬영이 함께 읽는 타임라인 파일 저장
    write_json(output_dir / "timeline.json", timeline)

    # 소스 추적: 어느 manifest 에서, 어느 모델로 생성됐는지 기록
    write_json(
        output_dir / "local-import.json",
        {
            "schemaVersion": 1,
            "sourceManifest": str(source_manifest_path.resolve()),
            "sourceAudio": source_manifest["audioPath"],
            "sourcePreview": source_manifest["previewPath"],
            "model": source_manifest["model"],
            "modelRevision": source_manifest["modelRevision"],
            "reference": source_manifest["reference"],
            "target": str(output_dir.resolve()),
        },
    )
    return output_dir


# ─── CLI ──────────────────────────────────────────────────────────────────────

def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source-dir", type=Path, required=True,
                        help="course_pilot --output-dir 와 동일한 경로 (manifest.json 포함)")
    parser.add_argument("--deck-root", type=Path, required=True,
                        help="udemy-agent 저장소의 deck 하위 디렉터리")
    parser.add_argument("--preset", default=DEFAULT_PRESET,
                        help=f"narration.config.json 의 preset 키 (기본값: {DEFAULT_PRESET})")
    parser.add_argument("--provider", default=DEFAULT_PROVIDER,
                        help=f"narration.config.json 의 provider 키 (기본값: {DEFAULT_PROVIDER})")
    return parser


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    output_dir = export(
        source_dir=args.source_dir,
        deck_root=args.deck_root,
        preset_name=args.preset,
        provider_name=args.provider,
    )
    # 성공 시 출력 디렉터리 경로를 stdout에 출력해 셸 파이프라인에서 사용 가능하게 한다
    print(output_dir)
    return 0


if __name__ == "__main__":
    sys.exit(main())
