#!/usr/bin/env python3.13
"""Thin entry point for the shared voice pipeline."""
from pathlib import Path
import sys

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))
from local_tts_engine.finetune_analysis import main


if __name__ == "__main__":
    raise SystemExit(main())
