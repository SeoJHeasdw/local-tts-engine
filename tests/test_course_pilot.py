import json
from pathlib import Path

import pytest

from local_tts_engine.course_pilot import (
    CourseChunk,
    CourseEntry,
    apply_pronunciation,
    apply_adapter_scale,
    adapter_identity,
    build_parser,
    course_entries,
    course_lesson_catalog,
    course_page_catalog,
    chunk_gap_after,
    gap_after,
    group_course_entries,
    lesson_title_from_source,
    AUDIO_TRIM_STAT_KEYS,
    load_or_create_alignment,
    merge_step_record_parts,
    parse_script,
    slide_ids_from_source,
    split_forced_pause_segments,
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
**(한 번만 누르고 다음 문장을 이어서.)**
**MCP**를 사용합니다.
문장 안 괄호(본문 설명)는 읽습니다.
""",
        encoding="utf-8",
    )

    assert parse_script(script) == {
        "first-slide": {
            0: "첫 문장입니다. 둘째 문장입니다.",
            1: "MCP를 사용합니다. 문장 안 괄호(본문 설명)는 읽습니다.",
        }
    }


def test_parse_script_keeps_a_standalone_forced_pause_marker(tmp_path: Path) -> None:
    script = tmp_path / "ch02.md"
    script.write_text(
        """## camera-in
### 2
들어갑니다.

[2s]

자, 이제 이 네모 안입니다.
""",
        encoding="utf-8",
    )

    text = parse_script(script)["camera-in"][2]
    assert text == "들어갑니다. [2s] 자, 이제 이 네모 안입니다."
    assert split_forced_pause_segments(text) == [
        ("들어갑니다.", 0),
        ("자, 이제 이 네모 안입니다.", 2_000),
    ]


def test_parse_script_rejects_an_inline_forced_pause_marker(tmp_path: Path) -> None:
    script = tmp_path / "ch02.md"
    script.write_text("## camera-in\n### 2\n들어갑니다. [2s] 이어갑니다.\n", encoding="utf-8")

    with pytest.raises(ValueError, match="단독 줄"):
        parse_script(script)


def test_apply_pronunciation_respects_ascii_boundaries() -> None:
    dictionary = [{"from": "MCP", "to": "엠씨피"}]

    assert apply_pronunciation("MCP와 XMCP는 다릅니다.", dictionary) == (
        "엠씨피와 XMCP는 다릅니다."
    )


def test_course_pronunciation_preflight_keeps_caption_source_separate(tmp_path: Path) -> None:
    deck = tmp_path / "deck"
    (deck / "src/production/chapters").mkdir(parents=True)
    (deck / "script/course").mkdir(parents=True)
    (deck / "narration").mkdir(parents=True)
    (deck / "src/production/chapters/ch00-test.ts").write_text(
        '  {\n    id: "slide-a",\n  },\n', encoding="utf-8"
    )
    (deck / "script/course/ch00.md").write_text(
        "## slide-a\n### 0\nRuntime과 RAG, Qwen3.6-27B, 같은 50개라도\n",
        encoding="utf-8",
    )
    (deck / "narration/pronunciation.ko.json").write_text(
        json.dumps([{"from": "RAG", "to": "랙"}], ensure_ascii=False),
        encoding="utf-8",
    )

    [entry] = course_entries(tmp_path, "ch00", "slide-a")

    assert entry.source_text == "Runtime과 RAG, Qwen3.6-27B, 같은 50개라도"
    assert entry.tts_text == "런타임과 래그, 큐웬삼점육 이십칠비, 같은 오십 개라도"
    assert "RAG → 래그" in entry.pronunciation_matches


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


def test_forced_pause_splits_chunks_and_overrides_the_normal_step_gap() -> None:
    first = CourseEntry(
        "ch02", "camera-in", 138, 2, "들어갑니다.", "들어갑니다.",
        part_index=0, part_count=2,
    )
    second = CourseEntry(
        "ch02", "camera-in", 138, 2, "자, 이제 안입니다.", "자, 이제 안입니다.",
        part_index=1, part_count=2, pause_before_ms=2_000,
    )

    chunks = group_course_entries([first, second])

    assert [len(chunk.entries) for chunk in chunks] == [1, 1]
    assert [chunk.key for chunk in chunks] == [
        "ch02--camera-in--2-part-1-to-2-part-1",
        "ch02--camera-in--2-part-2-to-2-part-2",
    ]
    assert chunk_gap_after(chunks[0], chunks[1]) == 2_000


def test_forced_pause_parts_merge_back_into_one_visual_step() -> None:
    records = [
        {
            "chapter": "ch02", "slide_id": "camera-in", "step": 2,
            "key": "part-1", "source_text": "들어갑니다.", "tts_text": "들어갑니다.",
            "part_count": 2, "pause_before_ms": 0,
            "speechStartMs": 100, "speechEndMs": 500,
            "alignment": {"words": [{"text": "들어갑니다", "startMs": 100, "endMs": 500}]},
            "chunkKey": "chunk-a", "audioPath": "/tmp/a.wav", "hash": "hash-a",
        },
        {
            "chapter": "ch02", "slide_id": "camera-in", "step": 2,
            "key": "part-2", "source_text": "자, 이제 안입니다.", "tts_text": "자, 이제 안입니다.",
            "part_count": 2, "pause_before_ms": 2_000,
            "speechStartMs": 2_650, "speechEndMs": 3_200,
            "alignment": {"words": [{"text": "자", "startMs": 2_650, "endMs": 2_800}]},
            "chunkKey": "chunk-b", "audioPath": "/tmp/b.wav", "hash": "hash-b",
        },
    ]

    merged = merge_step_record_parts(records)

    assert len(merged) == 1
    assert merged[0]["key"] == "ch02--camera-in--2"
    assert merged[0]["source_text"] == "들어갑니다. 자, 이제 안입니다."
    assert merged[0]["forcedPauses"] == [
        {"durationMs": 2_000, "nextSpeechStartMs": 2_650}
    ]
    assert [word["startMs"] for word in merged[0]["alignment"]["words"]] == [100, 2_650]


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


def test_every_clip_reports_the_same_trim_statistics(tmp_path: Path) -> None:
    """A clip too short or too quiet to trim still owes the full record.

    Manifest assembly and the clip cache both read all four keys. A partial
    result used to raise KeyError mid-run and, because the same dict was written
    to the clip sidecar, poisoned the cache for every later run.
    """
    rate = 1_000
    silent = np.zeros(800, dtype=np.float32)
    shorter_than_one_frame = np.full(5, 0.2, dtype=np.float32)
    ordinary = np.concatenate([np.zeros(100), np.full(400, 0.2), np.zeros(100)]).astype(np.float32)

    for audio in (silent, shorter_than_one_frame, ordinary):
        _, info = trim_and_fade_audio(audio, rate)
        assert set(info) == set(AUDIO_TRIM_STAT_KEYS), audio.shape
        assert all(isinstance(info[key], int) for key in AUDIO_TRIM_STAT_KEYS)


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


def test_course_entries_expands_a_forced_pause_inside_one_step(tmp_path: Path) -> None:
    deck = tmp_path / "deck"
    chapters = deck / "src/production/chapters"
    scripts = deck / "script/course"
    narration = deck / "narration"
    chapters.mkdir(parents=True)
    scripts.mkdir(parents=True)
    narration.mkdir(parents=True)
    (chapters / "ch02-test.ts").write_text(
        '  id: "camera-in"\n', encoding="utf-8"
    )
    (scripts / "ch02.md").write_text(
        "## camera-in\n### 2\n들어갑니다.\n\n[2s]\n\n자, 이제 안입니다.\n",
        encoding="utf-8",
    )
    (narration / "pronunciation.ko.json").write_text("[]", encoding="utf-8")

    entries = course_entries(tmp_path, "ch02")

    assert [entry.key for entry in entries] == [
        "ch02--camera-in--2--part-1",
        "ch02--camera-in--2--part-2",
    ]
    assert [entry.source_text for entry in entries] == [
        "들어갑니다.",
        "자, 이제 안입니다.",
    ]
    assert [entry.pause_before_ms for entry in entries] == [0, 2_000]


def test_course_entries_page_range_includes_every_step_on_end_page(tmp_path: Path) -> None:
    deck = tmp_path / "deck"
    chapters = deck / "src/production/chapters"
    scripts = deck / "script/course"
    narration = deck / "narration"
    chapters.mkdir(parents=True)
    scripts.mkdir(parents=True)
    narration.mkdir(parents=True)
    (chapters / "ch00-test.ts").write_text(
        '  id: "slide-a"\n  id: "slide-b"\n  id: "slide-c"\n', encoding="utf-8"
    )
    (scripts / "ch00.md").write_text(
        "## slide-a\n### 0\nA\n"
        "## slide-b\n### 0\nB0\n### 2\nB2\n"
        "## slide-c\n### 0\nC\n",
        encoding="utf-8",
    )
    (narration / "pronunciation.ko.json").write_text("[]", encoding="utf-8")

    entries = course_entries(tmp_path, "ch00", "slide-b", end_slide_number=2)
    catalog = course_page_catalog(tmp_path)

    assert [entry.key for entry in entries] == ["ch00--slide-b--0", "ch00--slide-b--2"]
    assert catalog[1] == {
        "page": 2,
        "chapter": "ch00",
        "slideId": "slide-b",
        "firstStep": 0,
        "lastStep": 2,
        "stepCount": 2,
    }


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


def test_lesson_title_drops_slide_count_and_joins_chapter_with_lesson() -> None:
    source = "/**\n * CH01 · L05 · 기업들이 RAG를 도입하는 이유  (12장)\n */\n"
    assert lesson_title_from_source(source) == "CH01 L05 · 기업들이 RAG를 도입하는 이유"
    fractional = "/**\n * CH03 · L01.5 · 벤더 공통 어휘  (16장)\n */\n"
    assert lesson_title_from_source(fractional) == "CH03 L01.5 · 벤더 공통 어휘"
    frame = "/**\n * CH02 · 파트 2 진입 · 그것을 이루는 부품  (3장)\n */\n"
    assert lesson_title_from_source(frame) == "CH02 · 파트 2 진입 · 그것을 이루는 부품"
    assert lesson_title_from_source("const slides = [];\n") == ""


def _write_split_chapter(tmp_path: Path, files: dict[str, tuple[str, list[str]]]) -> Path:
    """레슨 파일로 쪼갠 ch01 하나만 있는 최소 deck 을 만든다."""
    deck = tmp_path / "deck"
    chapters = deck / "src/production/chapters"
    split = chapters / "ch01"
    scripts = deck / "script/course"
    split.mkdir(parents=True)
    scripts.mkdir(parents=True)
    (chapters / "ch01-test.ts").write_text("const slides = [...A, ...B];\n", encoding="utf-8")
    body = []
    for name, (title, slide_ids) in files.items():
        slides = "".join(f'  {{\n    id: "{slide_id}",\n  }},\n' for slide_id in slide_ids)
        (split / name).write_text(f"/**\n * {title}\n */\n{slides}", encoding="utf-8")
        body.extend(f"## {slide_id}\n### 0\n본문\n" for slide_id in slide_ids)
    (scripts / "ch01.md").write_text("".join(body), encoding="utf-8")
    return deck


def test_lesson_catalog_makes_one_video_per_lesson_file(tmp_path: Path) -> None:
    deck = _write_split_chapter(tmp_path, {
        "01-L01-open.ts": ("CH01 · L01 · 여는 레슨  (2장)", ["open-a", "open-b"]),
        "02-L02-close.ts": ("CH01 · L02 · 닫는 레슨  (1장)", ["close"]),
    })
    pages = course_page_catalog(tmp_path)

    lessons = course_lesson_catalog(deck, pages)

    assert [(l["id"], l["title"], l["pageCount"], l["stepCount"]) for l in lessons] == [
        ("ch01-l01", "CH01 L01 · 여는 레슨", 2, 2),
        ("ch01-l02", "CH01 L02 · 닫는 레슨", 1, 1),
    ]
    assert (lessons[0]["startPage"], lessons[0]["endPage"]) == (1, 2)
    assert lessons[0]["file"] == "01-L01-open.ts"


def test_lesson_catalog_supports_a_fractional_lesson_number(tmp_path: Path) -> None:
    deck = _write_split_chapter(tmp_path, {
        "01-L01-open.ts": ("CH01 · L01 · 여는 레슨  (1장)", ["open"]),
        "02-L01.5-vocabulary.ts": ("CH01 · L01.5 · 공통 어휘  (1장)", ["vocabulary"]),
        "03-L02-close.ts": ("CH01 · L02 · 닫는 레슨  (1장)", ["close"]),
    })
    pages = course_page_catalog(tmp_path)

    lessons = course_lesson_catalog(deck, pages)

    assert [(lesson["id"], lesson["title"]) for lesson in lessons] == [
        ("ch01-l01", "CH01 L01 · 여는 레슨"),
        ("ch01-l01-5", "CH01 L01.5 · 공통 어휘"),
        ("ch01-l02", "CH01 L02 · 닫는 레슨"),
    ]


def test_lesson_catalog_rejects_a_file_without_a_lesson_number(tmp_path: Path) -> None:
    deck = _write_split_chapter(tmp_path, {
        "01-L01-open.ts": ("CH01 · L01 · 여는 레슨  (1장)", ["open-a"]),
        "02-part2-open.ts": ("CH01 · 파트 2 진입  (1장)", ["part-two"]),
    })
    pages = course_page_catalog(tmp_path)

    try:
        course_lesson_catalog(deck, pages)
    except ValueError as error:
        assert "레슨 번호가 없습니다" in str(error)
    else:
        raise AssertionError("레슨 번호 없는 파일을 그대로 받아들였습니다.")


def test_lesson_catalog_rejects_a_repeated_lesson_number(tmp_path: Path) -> None:
    deck = _write_split_chapter(tmp_path, {
        "01-L01-open.ts": ("CH01 · L01 · 여는 레슨  (1장)", ["open-a"]),
        "02-L01-again.ts": ("CH01 · L01 · 또 여는 레슨  (1장)", ["open-b"]),
    })
    pages = course_page_catalog(tmp_path)

    try:
        course_lesson_catalog(deck, pages)
    except ValueError as error:
        assert "레슨 ID가 겹칩니다" in str(error)
    else:
        raise AssertionError("겹치는 레슨 번호를 그대로 받아들였습니다.")


def test_adapter_identity_changes_with_scale_and_rejects_missing_files(tmp_path: Path) -> None:
    adapter = tmp_path / "adapter"
    adapter.mkdir()
    (adapter / "adapters.safetensors").write_bytes(b"weights")
    (adapter / "adapter_config.json").write_text("{}", encoding="utf-8")

    low = adapter_identity(adapter, 0.6)
    high = adapter_identity(adapter, 0.8)

    assert low is not None and high is not None
    assert low["scale"] == 0.6
    assert low["identitySha256"] != high["identitySha256"]


def test_adapter_scale_accepts_continuous_065_value() -> None:
    class LoraModule:
        lora_a = object()
        lora_b = object()
        scale = 1.0

    class Model:
        module = LoraModule()

        def named_modules(self):
            return [("voice", self.module)]

    model = Model()
    assert apply_adapter_scale(model, 0.65) == 1
    assert model.module.scale == 0.65


def test_alignment_no_cache_rebuilds_existing_file(tmp_path: Path) -> None:
    entry = CourseEntry("ch00", "slide-a", 1, 0, "새", "새")
    chunk = CourseChunk((entry,))
    alignment = tmp_path / "alignment.json"
    alignment.write_text(
        json.dumps({"words": [{"text": "오래된", "startMs": 0, "endMs": 1}]}),
        encoding="utf-8",
    )

    class Item:
        text = "새"
        start_time = 0.1
        end_time = 0.2

    class Result:
        items = [Item()]

    class Aligner:
        calls = 0

        def generate(self, **_kwargs):
            self.calls += 1
            return Result()

    aligner = Aligner()
    words = load_or_create_alignment(
        chunk,
        {"audioPath": "/tmp/new.wav", "hash": "fresh"},
        aligner,
        alignment,
        use_cache=False,
    )

    assert aligner.calls == 1
    assert words == [{"text": "새", "startMs": 100, "endMs": 200}]


def test_no_cache_cli_flag_disables_result_reuse() -> None:
    args = build_parser().parse_args([
        "--output-dir", "/tmp/out",
        "--reference", "/tmp/ref.wav",
        "--reference-text", "/tmp/ref.txt",
        "--no-cache",
    ])

    assert args.no_cache is True


def test_peak_memory_is_reported_from_whichever_mlx_namespace_exists() -> None:
    """The reviewer is resident with the generator, so the run must report a
    process-wide peak. MLX has moved this call, and a missing diagnostic must
    never be the reason a finished lecture fails."""
    from local_tts_engine.course_pilot import metal_peak_memory_gb

    class Current:
        @staticmethod
        def get_peak_memory() -> float:
            return 13.4 * 1024**3

    class Older:
        class metal:
            @staticmethod
            def get_peak_memory() -> float:
                return 11.6 * 1024**3

    class Broken:
        @staticmethod
        def get_peak_memory() -> float:
            raise RuntimeError("메모리 카운터 없음")

    class Absent:
        pass

    assert metal_peak_memory_gb(Current) == 13.4
    assert metal_peak_memory_gb(Older) == 11.6
    assert metal_peak_memory_gb(Broken) == 0.0
    assert metal_peak_memory_gb(Absent) == 0.0
