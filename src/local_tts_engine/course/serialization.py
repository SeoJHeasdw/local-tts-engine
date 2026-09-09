"""Stable metadata hashes and JSON persistence."""

from __future__ import annotations

import hashlib
import json
from pathlib import Path
from typing import Any


def stable_digest(value: Any) -> str:
    """임의 JSON 직렬화 가능 값을 결정적 SHA-256 해시로 변환한다.

    sort_keys=True 로 딕셔너리 키 순서를 고정해 Python 버전과 관계없이
    동일한 입력에 동일한 해시를 보장한다. 클립 캐시 키 계산에 사용된다.
    """
    payload = json.dumps(
        value,
        ensure_ascii=False,
        sort_keys=True,
        separators=(",", ":"),
    )
    return hashlib.sha256(payload.encode("utf-8")).hexdigest()


def write_json(path: Path, value: Any) -> None:
    """부모 디렉터리를 자동 생성하고 JSON을 UTF-8로 저장한다."""
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(value, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
