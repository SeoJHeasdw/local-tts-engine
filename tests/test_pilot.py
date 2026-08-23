import json

import pytest

from local_tts_engine.pilot import MODEL_SPECS, parse_loudnorm_json


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
