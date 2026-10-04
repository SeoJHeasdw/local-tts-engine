"""Alignment cache identity and damage handling without loading a real model."""

import json
from types import SimpleNamespace

import pytest

from local_tts_engine.course.alignment import load_or_create_alignment, read_cached_alignment
from local_tts_engine.course.types import CourseChunk, CourseEntry


def fixture_record():
    chunk = CourseChunk((CourseEntry("ch00", "sample", 1, 0, "안녕하세요", "안녕하세요"),))
    clip = {"audioPath": "/tmp/current.wav", "hash": "current-hash", "durationMs": 1000}
    record = {"schemaVersion": 1, "chunkKey": chunk.key, "hash": clip["hash"],
              "words": [{"text": "안녕하세요", "startMs": 100, "endMs": 200}]}
    return chunk, clip, record


@pytest.mark.parametrize("damage", [
    {"hash": "old-hash"}, {"chunkKey": "another-chunk"}, {"schemaVersion": 99},
    {"words": [{"text": "전혀다른말", "startMs": 100, "endMs": 200}]},
    {"words": [{"text": "안녕하세요", "startMs": -1, "endMs": 200}]},
    {"words": [{"text": "안녕하세요", "startMs": 300, "endMs": 200}]},
    {"words": [{"text": "안녕하세요", "startMs": 100, "endMs": 2000}]},
    {"words": [{"text": "안녕하세요", "startMs": float("nan"), "endMs": 200}]},
    {"words": []}, {"words": None},
])
def test_invalid_alignment_cache_is_regenerated_and_atomically_replaced(tmp_path, damage):
    chunk, clip, record = fixture_record()
    cache = tmp_path / "alignment.json"
    cache.write_text(json.dumps({**record, **damage}), encoding="utf-8")
    assert read_cached_alignment(chunk, clip, cache) is None

    class Aligner:
        calls = 0

        def generate(self, **kwargs):
            self.calls += 1
            assert kwargs == {"audio": clip["audioPath"], "text": chunk.tts_text, "language": "English"}
            return SimpleNamespace(items=[SimpleNamespace(text="안녕하세요", start_time=0.1, end_time=0.2)])

    aligner = Aligner()
    assert load_or_create_alignment(chunk, clip, aligner, cache) == record["words"]
    assert aligner.calls == 1
    assert read_cached_alignment(chunk, clip, cache) == record["words"]
    assert list(tmp_path.iterdir()) == [cache]


def test_valid_cache_needs_no_aligner_but_incomplete_json_cannot_be_reused(tmp_path):
    chunk, clip, record = fixture_record()
    cache = tmp_path / "alignment.json"
    cache.write_text(json.dumps(record), encoding="utf-8")
    assert load_or_create_alignment(chunk, clip, None, cache) == record["words"]
    cache.write_text('{"words":', encoding="utf-8")
    assert read_cached_alignment(chunk, clip, cache) is None
    with pytest.raises(RuntimeError, match="aligner"):
        load_or_create_alignment(chunk, clip, None, cache)
