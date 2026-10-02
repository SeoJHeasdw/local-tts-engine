import json
from pathlib import Path

import pytest

from local_tts_engine.finetune_adapter import load_adapter_settings


def write_adapter_config(path: Path, *, rank: int = 16, alpha: int = 16) -> dict:
    config = {"model_name": "mlx-community/Qwen3-TTS-12Hz-1.7B-Base-bf16", "model_type": "tts",
        "fine_tune_type": "lora", "lora_parameters": {"rank": rank, "alpha": alpha,
            "dropout": 0.0, "scale": 1.0,
            "keys": ["q_proj", "k_proj", "v_proj", "o_proj", "gate_proj", "up_proj", "down_proj"]}}
    (path / 'adapter_config.json').write_text(json.dumps(config), encoding='utf-8')
    return config


@pytest.mark.parametrize(('rank', 'alpha'), [(8, 16), (16, 16), (32, 64)])
def test_saved_adapter_shape_controls_loading(tmp_path: Path, rank: int, alpha: int) -> None:
    adapter = tmp_path / 'adapters'
    adapter.mkdir()
    config = write_adapter_config(adapter, rank=rank, alpha=alpha)
    (tmp_path / 'training-result.json').write_text(json.dumps({'parameters': {'maxSequenceLength': 1024}}))

    settings = load_adapter_settings(adapter)

    assert settings == {'rank': rank, 'alpha': alpha, 'dropout': 0.0,
        'targetModules': config['lora_parameters']['keys'], 'maxSequenceLength': 1024}


def test_legacy_saved_adapter_keeps_its_original_shape(tmp_path: Path) -> None:
    write_adapter_config(tmp_path)
    assert load_adapter_settings(tmp_path)['maxSequenceLength'] == 512
    assert load_adapter_settings(tmp_path)['rank'] == 16
    assert load_adapter_settings(tmp_path)['alpha'] == 16


@pytest.mark.parametrize('update', [{'rank': 0}, {'alpha': float('nan')}, {'dropout': 2}, {'keys': []}])
def test_invalid_saved_shape_never_silently_falls_back_to_rank_16(tmp_path: Path, update: dict) -> None:
    config = write_adapter_config(tmp_path)
    config['lora_parameters'].update(update)
    (tmp_path / 'adapter_config.json').write_text(json.dumps(config))
    with pytest.raises(ValueError, match='LoRA 설정'):
        load_adapter_settings(tmp_path)


def test_missing_saved_shape_cannot_construct_an_adapter(tmp_path: Path) -> None:
    (tmp_path / 'adapter_config.json').write_text('{}')
    with pytest.raises(ValueError, match='LoRA 설정'):
        load_adapter_settings(tmp_path)
