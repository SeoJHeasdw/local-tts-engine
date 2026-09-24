from pathlib import Path

from local_tts_engine.course.script import normalize_script_text, parse_script
from local_tts_engine.pronunciation import pronunciation_preflight


def test_script_formatting_preserves_underscores_that_belong_to_identifiers() -> None:
    assert normalize_script_text(
        "**도구** _이름_ `exec_command`, create_proposal.py, ambiguous_admin_dong과 "
        "__강조__ [설명](https://example.test)은 남깁니다."
    ) == "도구 이름 exec_command, create_proposal.py, ambiguous_admin_dong과 강조 설명은 남깁니다."


def test_inline_code_content_is_not_treated_as_markdown_formatting() -> None:
    assert normalize_script_text("`__init__`, `foo__bar`, `a*b`, `~/work`를 봅니다.") == (
        "__init__, foo__bar, a*b, ~/work를 봅니다."
    )


def test_script_keeps_source_identifiers_and_reuses_only_existing_approved_readings(tmp_path: Path) -> None:
    script = tmp_path / "ch04.md"
    script.write_text(
        "## tools\n### 0\n`gmail_send`와 refund_order, exec_command를 봅니다.\n",
        encoding="utf-8",
    )
    source = parse_script(script)["tools"][0]
    assert source == "gmail_send와 refund_order, exec_command를 봅니다."
    report = pronunciation_preflight(source, [
        {"from": "gmailsend", "to": "지메일 센드"},
        {"from": "refundorder", "to": "리펀드 오더"},
        {"from": "command", "to": "커맨드"},
    ])
    assert report["sourceText"] == source
    assert report["ttsText"] == "지메일 센드와 리펀드 오더, exec_command를 봅니다."
    assert report["unresolvedAscii"] == ["exec_command"]


def test_plain_identifiers_with_multiple_underscores_remain_intact() -> None:
    assert normalize_script_text("foo__bar와 _강조_, **gmail_send**") == "foo__bar와 강조, gmail_send"
