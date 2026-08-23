"""Export a local course pilot into the udemy-agent narration contract."""

from __future__ import annotations

import argparse
import json
import shutil
import sys
from pathlib import Path
from typing import Any


DEFAULT_PRESET = "qwen3-first-5m"
DEFAULT_PROVIDER = "qwen3-local"


def write_json(path: Path, value: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(
        json.dumps(value, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )


def timeline_from_course_manifest(
    manifest: dict[str, Any],
    preset: dict[str, Any],
    provider: dict[str, Any],
) -> dict[str, Any]:
    source_entries = manifest["entries"]
    total_ms = int(manifest["durationMs"])
    entries = []
    for index, item in enumerate(source_entries):
        next_start = (
            int(source_entries[index + 1]["startMs"])
            if index + 1 < len(source_entries)
            else total_ms
        )
        end_ms = int(item["endMs"])
        transition_at_ms = int(item.get("transitionAtMs", end_ms))
        entries.append(
            {
                "order": index,
                "chapter": item["chapter"],
                "key": f"{item['slide_id']}--{item['step']}",
                "slideId": item["slide_id"],
                "slideNumber": int(item["slide_number"]),
                "step": int(item["step"]),
                "sourceText": item["source_text"],
                "ttsText": item["tts_text"],
                "hash": item["hash"],
                "audio": {
                    "raw": None,
                    "wav": None,
                    "durationMs": int(item["durationMs"]),
                },
                "startMs": int(item["startMs"]),
                "endMs": end_ms,
                "transitionAtMs": transition_at_ms,
                "gapAfterMs": next_start - end_ms,
                "speechStartMs": int(item.get("speechStartMs", item["startMs"])),
                "speechEndMs": int(item.get("speechEndMs", item["endMs"])),
                "alignment": item.get("alignment"),
            }
        )
    return {
        "schemaVersion": int(manifest["schemaVersion"]),
        "generatedAt": manifest.get("generatedAt"),
        "preset": preset,
        "provider": provider,
        "startPadMs": int(manifest["timing"]["startPadMs"]),
        "totalMs": total_ms,
        "entries": entries,
    }


def export(
    source_dir: Path,
    deck_root: Path,
    preset_name: str,
    provider_name: str,
) -> Path:
    source_manifest_path = source_dir / "manifest.json"
    source_manifest = json.loads(source_manifest_path.read_text(encoding="utf-8"))
    deck_config = json.loads(
        (deck_root / "narration.config.json").read_text(encoding="utf-8")
    )
    preset = {"name": preset_name, **deck_config["presets"][preset_name]}
    provider = {"provider": provider_name, **deck_config["providers"][provider_name]}
    timeline = timeline_from_course_manifest(source_manifest, preset, provider)

    output_dir = deck_root / deck_config["outputRoot"] / preset_name
    audio_dir = output_dir / "audio"
    audio_dir.mkdir(parents=True, exist_ok=True)
    shutil.copy2(source_manifest["audioPath"], audio_dir / "track.wav")
    shutil.copy2(source_manifest["previewPath"], audio_dir / "track.m4a")
    write_json(output_dir / "timeline.json", timeline)
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


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source-dir", type=Path, required=True)
    parser.add_argument("--deck-root", type=Path, required=True)
    parser.add_argument("--preset", default=DEFAULT_PRESET)
    parser.add_argument("--provider", default=DEFAULT_PROVIDER)
    return parser


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    output_dir = export(
        source_dir=args.source_dir,
        deck_root=args.deck_root,
        preset_name=args.preset,
        provider_name=args.provider,
    )
    print(output_dir)
    return 0


if __name__ == "__main__":
    sys.exit(main())
