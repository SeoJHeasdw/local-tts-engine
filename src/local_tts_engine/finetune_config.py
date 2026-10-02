"""Read shared voice-training defaults without loading the MLX runtime."""
from __future__ import annotations

import json
import os
from pathlib import Path
from typing import Any


PROJECT_ROOT = Path(__file__).resolve().parents[2]
DEFAULT_CONFIG = PROJECT_ROOT / "config/voice-training.json"


def load_config(path: Path = DEFAULT_CONFIG) -> dict[str, Any]:
    config = json.loads(path.read_text(encoding="utf-8"))
    if config.get("schemaVersion") != 1:
        raise ValueError("지원하지 않는 음성 학습 설정 버전입니다.")
    return config


def comparison_model(config: dict[str, Any], *, root: Path = PROJECT_ROOT) -> str:
    preferred = config.get("comparisonModelPath")
    if preferred:
        path = Path(preferred).expanduser()
        if not path.is_absolute():
            path = root / path
        if path.is_dir():
            return str(path)
    return config["comparisonModel"]


def configure_offline() -> None:
    """Keep terminal training and analysis local, as before."""
    os.environ["HF_HUB_OFFLINE"] = "1"
    for key in ("ALL_PROXY", "all_proxy", "HTTP_PROXY", "http_proxy", "HTTPS_PROXY", "https_proxy"):
        os.environ.pop(key, None)


def installed_model(model: str) -> Path:
    from .pilot import resolve_model_path

    def no_download(*args: Any, **kwargs: Any) -> None:
        raise FileNotFoundError("필요한 모델이 로컬 캐시에 없습니다. 자동으로 내려받지 않습니다.")

    return resolve_model_path(model, no_download)


def config_argument(argv: list[str] | None = None) -> Path:
    """Read only --config before building a parser with its defaults."""
    import argparse

    parser = argparse.ArgumentParser(add_help=False)
    parser.add_argument("--config", type=Path, default=DEFAULT_CONFIG)
    return parser.parse_known_args(argv)[0].config
