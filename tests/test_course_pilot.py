import json
from pathlib import Path

from local_tts_engine.course_pilot import (
    CourseChunk,
    CourseEntry,
    apply_pronunciation,
    course_entries,
    gap_after,
    group_course_entries,
    parse_script,
    slide_ids_from_source,
    trim_and_fade_audio,
)

import numpy as np


def test_parse_script_matches_narration_contract(tmp_path: Path) -> None:
    script = tmp_path / "ch00.md"
    script.write_text(
        """# title
> ignored
## first-slide
### 0
첫 문장입니다.

둘째 문장입니다.
### 1
**MCP**를 사용합니다.
""",
        encoding="utf-8",
    )

    assert parse_script(script) == {
        "first-slide": {
            0: "첫 문장입니다. 둘째 문장입니다.",
            1: "MCP를 사용합니다.",
        }
    }


def test_apply_pronunciation_respects_ascii_boundaries() -> None:
    dictionary = [{"from": "MCP", "to": "엠씨피"}]

    assert apply_pronunciation("MCP와 XMCP는 다릅니다.", dictionary) == (
        "엠씨피와 XMCP는 다릅니다."
    )


def test_gap_after_uses_step_and_slide_boundaries() -> None:
    first = CourseEntry("ch00", "slide-a", 1, 0, "a", "a")
    same_slide = CourseEntry("ch00", "slide-a", 1, 1, "b", "b")
    next_slide = CourseEntry("ch00", "slide-b", 2, 0, "c", "c")

    assert gap_after(first, same_slide) == 200
    assert gap_after(same_slide, next_slide) == 750


def test_group_course_entries_keeps_contiguous_steps_on_one_slide() -> None:
    entries = [
        CourseEntry("ch00", "slide-a", 1, 0, "a", "a"),
        CourseEntry("ch00", "slide-a", 1, 1, "b", "b"),
        CourseEntry("ch00", "slide-b", 2, 0, "c", "c"),
    ]

    chunks = group_course_entries(entries)

    assert chunks == [CourseChunk(tuple(entries[:2])), CourseChunk((entries[2],))]


def test_trim_and_fade_audio_removes_only_edge_silence() -> None:
    rate = 1_000
    audio = np.concatenate(
        [np.zeros(300), np.full(400, 0.2), np.zeros(250)]
    ).astype(np.float32)

    trimmed, info = trim_and_fade_audio(audio, rate)

    assert 500 <= len(trimmed) <= 570
    assert info["trimmedHeadMs"] >= 220
    assert info["trimmedTailMs"] >= 170
    assert trimmed[0] == 0
    assert abs(float(trimmed[-1])) < 1e-6


def test_trim_and_fade_audio_compacts_only_long_internal_pause() -> None:
    rate = 1_000
    audio = np.concatenate(
        [
            np.zeros(100),
            np.full(400, 0.2),
            np.zeros(1_000),
            np.full(400, 0.2),
            np.zeros(100),
        ]
    ).astype(np.float32)

    trimmed, info = trim_and_fade_audio(audio, rate)

    assert info["shortenedSilenceCount"] == 1
    assert 450 <= info["shortenedSilenceMs"] <= 550
    assert 1_300 <= len(trimmed) <= 1_500


def test_course_entries_uses_canonical_order_and_dictionary(tmp_path: Path) -> None:
    deck = tmp_path / "deck"
    chapters = deck / "src/production/chapters"
    scripts = deck / "script/course"
    narration = deck / "narration"
    chapters.mkdir(parents=True)
    scripts.mkdir(parents=True)
    narration.mkdir(parents=True)
    (chapters / "ch00-test.ts").write_text(
        '      id: "slide-a"\n      id: "slide-b"\n', encoding="utf-8"
    )
    (scripts / "ch00.md").write_text(
        "## slide-a\n### 0\nMCP 시작\n## slide-b\n### 0\n끝\n",
        encoding="utf-8",
    )
    (narration / "pronunciation.ko.json").write_text(
        json.dumps([{"from": "MCP", "to": "엠씨피"}]), encoding="utf-8"
    )

    entries = course_entries(tmp_path, "ch00")

    assert [entry.key for entry in entries] == [
        "ch00--slide-a--0",
        "ch00--slide-b--0",
    ]
    assert entries[0].tts_text == "엠씨피 시작"


def test_slide_ids_from_source_uses_outermost_id_indent() -> None:
    source = '''
const slides = [
  {
    id: "slide-a",
    nested: { id: "not-a-slide" },
  },
  {
    id: "slide-b",
  },
];
'''

    assert slide_ids_from_source(source) == ["slide-a", "slide-b"]


def test_course_entries_reads_split_chapter_files(tmp_path: Path) -> None:
    deck = tmp_path / "deck"
    chapters = deck / "src/production/chapters"
    split = chapters / "ch01"
    scripts = deck / "script/course"
    narration = deck / "narration"
    split.mkdir(parents=True)
    scripts.mkdir(parents=True)
    narration.mkdir(parents=True)
    (chapters / "ch01-test.ts").write_text(
        'const slides = [...S01, ...S02];\n', encoding="utf-8"
    )
    (split / "01-first.ts").write_text(
        '  {\n    id: "slide-a",\n  },\n', encoding="utf-8"
    )
    (split / "02-second.ts").write_text(
        '  {\n    id: "slide-b",\n  },\n', encoding="utf-8"
    )
    (scripts / "ch01.md").write_text(
        "## slide-a\n### 0\n첫째\n## slide-b\n### 0\n둘째\n",
        encoding="utf-8",
    )
    (narration / "pronunciation.ko.json").write_text("[]", encoding="utf-8")

    entries = course_entries(tmp_path, "ch01")

    assert [entry.key for entry in entries] == [
        "ch01--slide-a--0",
        "ch01--slide-b--0",
    ]
