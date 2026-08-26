import json
from pathlib import Path

import pytest

from local_tts_engine.pilot import MODEL_SPECS, parse_loudnorm_json, resolve_model_path


def test_pilot_models_use_same_local_runtime() -> None:
    assert set(MODEL_SPECS) == {"qwen3-tts", "chatterbox-v3"}
    assert all(
        spec.repository.startswith("mlx-community/")
        for spec in MODEL_SPECS.values()
    )


def test_parse_loudnorm_json_uses_last_measurement() -> None:
    first = json.dumps({"input_i": "-31.0"})
    second = json.dumps({"input_i": "-23.1", "target_offset": "0.1"})

    assert parse_loudnorm_json(f"noise\n{first}\nmore\n{second}") == {
        "input_i": "-23.1",
        "target_offset": "0.1",
    }


def test_parse_loudnorm_json_rejects_missing_measurement() -> None:
    with pytest.raises(RuntimeError):
        parse_loudnorm_json("ffmpeg failed before measurement")


def test_resolve_model_path_prefers_installed_snapshot(tmp_path: Path, monkeypatch) -> None:
    repository = "mlx-community/local-test"
    cache = tmp_path / "hub" / "models--mlx-community--local-test"
    snapshot = cache / "snapshots/abc123"
    snapshot.mkdir(parents=True)
    (cache / "refs").mkdir()
    (cache / "refs/main").write_text("abc123", encoding="utf-8")
    monkeypatch.setenv("HF_HUB_CACHE", str(tmp_path / "hub"))

    def fail_download(_repository: str):
        raise AssertionError("설치된 모델에서 온라인 다운로드를 호출하면 안 됩니다.")

    assert resolve_model_path(repository, fail_download) == snapshot
