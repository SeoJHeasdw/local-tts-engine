"""Read the saved adapter shape before constructing a Qwen LoRA wrapper."""
from __future__ import annotations

import json
import math
from pathlib import Path
from typing import Any


def load_adapter_settings(adapter_dir: Path) -> dict[str, Any]:
    config = json.loads((adapter_dir / "adapter_config.json").read_text(encoding="utf-8"))
    parameters = config.get("lora_parameters")
    if not isinstance(parameters, dict):
        raise ValueError("어댑터에 저장된 LoRA 설정이 없습니다.")
    rank = parameters.get("rank")
    alpha = parameters.get("alpha")
    dropout = parameters.get("dropout")
    keys = parameters.get("keys")
    if isinstance(rank, bool) or not isinstance(rank, int) or rank <= 0 \
            or isinstance(alpha, bool) or not isinstance(alpha, (int, float)) or not math.isfinite(alpha) or alpha <= 0 \
            or isinstance(dropout, bool) or not isinstance(dropout, (int, float)) or not math.isfinite(dropout) or not 0 <= dropout < 1 \
            or not isinstance(keys, list) or not keys or any(not isinstance(key, str) or not key for key in keys):
        raise ValueError("어댑터에 저장된 LoRA 설정이 올바르지 않습니다.")
    max_sequence_length = 512
    result_path = adapter_dir.parent / "training-result.json"
    if result_path.is_file():
        result = json.loads(result_path.read_text(encoding="utf-8"))
        max_sequence_length = result.get("parameters", {}).get("maxSequenceLength", max_sequence_length)
    if isinstance(max_sequence_length, bool) or not isinstance(max_sequence_length, int) or max_sequence_length <= 0:
        raise ValueError("어댑터에 저장된 학습 문장 길이가 올바르지 않습니다.")
    return {"maxSequenceLength": max_sequence_length, "rank": rank, "alpha": alpha,
        "dropout": dropout, "targetModules": keys}
