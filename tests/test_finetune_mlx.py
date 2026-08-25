import json
from pathlib import Path

import numpy as np
import soundfile as sf

from local_tts_engine.finetune_mlx import load_training_data


def test_load_training_data_resamples_to_24khz(tmp_path: Path) -> None:
    audio_path = tmp_path / "clip.wav"
    sf.write(audio_path, np.full(48_000, 0.1, dtype=np.float32), 48_000)
    jsonl = tmp_path / "train.jsonl"
    jsonl.write_text(
        json.dumps({"audio": str(audio_path), "text": "테스트"}, ensure_ascii=False) + "\n",
        encoding="utf-8",
    )

    rows = load_training_data(jsonl)

    assert rows[0]["audio"]["sampling_rate"] == 24_000
    assert 23_990 <= len(rows[0]["audio"]["array"]) <= 24_010
    assert rows[0]["text"] == "테스트"
