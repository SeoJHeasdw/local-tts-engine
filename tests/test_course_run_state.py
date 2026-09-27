"""A failed retry must not publish an older successful course manifest."""

from __future__ import annotations

import json

import pytest

from local_tts_engine.course.run_state import (
    begin_course_run,
    course_run_lock,
    fail_course_run,
    finish_course_run,
    require_current_course_manifest,
)
from local_tts_engine.export_udemy import export


def test_current_manifest_requires_the_latest_completed_attempt(tmp_path) -> None:
    source = tmp_path / "voice"
    first = begin_course_run(source)
    manifest = {"runId": first, "audioPath": "old-success.wav"}
    with pytest.raises(RuntimeError, match="완료되지 않았거나"):
        require_current_course_manifest(source, manifest)
    finish_course_run(source, first)
    require_current_course_manifest(source, manifest)

    second = begin_course_run(source)
    fail_course_run(source, second, RuntimeError("새 후보 생성 실패"))
    with pytest.raises(RuntimeError, match="완료되지 않았거나"):
        require_current_course_manifest(source, manifest)
    state = json.loads((source / "run-state.json").read_text(encoding="utf-8"))
    assert state["status"] == "failed"
    assert state["runId"] == second

    third = begin_course_run(source)
    finish_course_run(source, third)
    with pytest.raises(RuntimeError, match="판본과 다릅니다"):
        require_current_course_manifest(source, manifest)
    require_current_course_manifest(source, {"runId": third})


def test_export_refuses_a_stale_manifest_before_touching_render_files(tmp_path) -> None:
    source = tmp_path / "voice"
    output = tmp_path / "render"
    first = begin_course_run(source)
    (source / "manifest.json").write_text(json.dumps({"runId": first}), encoding="utf-8")
    finish_course_run(source, first)
    second = begin_course_run(source)
    fail_course_run(source, second, RuntimeError("failed retry"))

    with pytest.raises(RuntimeError, match="완료되지 않았거나"):
        export(source, output, {"name": "lesson"}, {"provider": "local"})
    assert not output.exists()


def test_legacy_manifest_without_state_remains_readable(tmp_path) -> None:
    require_current_course_manifest(tmp_path, {"audioPath": "old.wav"})
    with pytest.raises(RuntimeError, match="상태 기록이 없어"):
        require_current_course_manifest(tmp_path, {"runId": "unexpected"})


def test_two_runs_cannot_publish_into_the_same_output_at_once(tmp_path) -> None:
    with course_run_lock(tmp_path):
        with pytest.raises(RuntimeError, match="이미 만들고 있습니다"):
            with course_run_lock(tmp_path):
                pass
    with course_run_lock(tmp_path):
        pass
