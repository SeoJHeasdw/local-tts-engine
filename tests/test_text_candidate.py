from pathlib import Path

import pytest

from local_tts_engine.text_candidate import load_text


def test_load_text_normalizes_whitespace_and_applies_pronunciation(tmp_path: Path) -> None:
    source = tmp_path / "input.txt"
    source.write_text("똑같이\n  연결합니다.", encoding="utf-8")

    display, tts = load_text(source)

    assert display == "똑같이\n연결합니다."
    assert tts != display
    assert "똑까치" in tts
    assert "\n" in tts


def test_load_text_rejects_empty_and_oversized_input(tmp_path: Path) -> None:
    source = tmp_path / "input.txt"
    source.write_text("   ", encoding="utf-8")
    with pytest.raises(ValueError):
        load_text(source)

    source.write_text("가" * 2_001, encoding="utf-8")
    with pytest.raises(ValueError):
        load_text(source)
