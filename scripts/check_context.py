#!/usr/bin/env python3.13
"""Verify that the immutable source context required by this project exists."""

from pathlib import Path
import json
import platform
import sys


PROJECT_ROOT = Path(__file__).resolve().parents[1]
SOURCE_ROOT = Path("/Users/jaehoseo/Desktop/vswrk/edu/udemy-agent")
VOICE_ROOT = PROJECT_ROOT / "data/private/voice"
REQUIRED_PATHS = [
    SOURCE_ROOT / "NARRATION-PIPELINE.md",
    SOURCE_ROOT / "VIDEO-PACING-GUIDELINES.md",
    SOURCE_ROOT / "deck/script/course/ch01.md",
    SOURCE_ROOT / "deck/narration/pronunciation.ko.json",
    SOURCE_ROOT / "deck/tools/captions.mjs",
    SOURCE_ROOT / "deck/tools/capture.mjs",
    SOURCE_ROOT / "deck/tools/production.mjs",
    SOURCE_ROOT / "deck/tools/preflight.mjs",
    SOURCE_ROOT / "deck/narration.config.json",
    VOICE_ROOT / "training/pvc/README.md",
    VOICE_ROOT / "training/pvc/manifest.json",
    VOICE_ROOT / "ch01/pilot/master-48k-mono.wav",
]


def main() -> int:
    missing = [path for path in REQUIRED_PATHS if not path.exists()]
    manifest_path = VOICE_ROOT / "training/pvc/manifest.json"

    print(f"machine: {platform.machine()}")
    print(f"macOS: {platform.mac_ver()[0] or 'unknown'}")
    print(f"python: {platform.python_version()}")
    print(f"source project: {SOURCE_ROOT}")
    print(f"voice library: {VOICE_ROOT}")

    if manifest_path.exists():
        manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
        print(f"clean voice duration: {manifest['totalDurationSeconds']:.3f}s")
        print(f"clean voice files: {len(manifest['files'])}")

    if missing:
        print("missing required paths:", file=sys.stderr)
        for path in missing:
            print(f"- {path}", file=sys.stderr)
        return 1

    print(f"context check: OK ({len(REQUIRED_PATHS)} required paths)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
