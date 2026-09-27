"""Bind a course manifest to the latest attempt in a reusable output directory.

Direct CLI runs may reuse clip caches in the same directory. A failed later run
must not make its older successful manifest look like the result of that run.
"""

from __future__ import annotations

import json
import os
import uuid
import fcntl
from contextlib import contextmanager
from datetime import datetime, timezone
from pathlib import Path
from typing import Any


STATE_FILE = "run-state.json"


@contextmanager
def course_run_lock(directory: Path):
    """Keep two producers from publishing into the same cache/output at once."""
    directory.mkdir(parents=True, exist_ok=True)
    handle = (directory / "run.lock").open("a+")
    locked = False
    try:
        try:
            fcntl.flock(handle, fcntl.LOCK_EX | fcntl.LOCK_NB)
            locked = True
        except BlockingIOError as error:
            raise RuntimeError("같은 출력 폴더에서 강의 음성을 이미 만들고 있습니다.") from error
        yield
    finally:
        if locked:
            fcntl.flock(handle, fcntl.LOCK_UN)
        handle.close()


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _write_state(directory: Path, value: dict[str, Any]) -> None:
    directory.mkdir(parents=True, exist_ok=True)
    destination = directory / STATE_FILE
    staged = directory / f".{STATE_FILE}.{uuid.uuid4().hex}.tmp"
    try:
        staged.write_text(json.dumps(value, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
        os.replace(staged, destination)
    finally:
        staged.unlink(missing_ok=True)


def begin_course_run(directory: Path) -> str:
    run_id = uuid.uuid4().hex
    _write_state(directory, {"schemaVersion": 1, "runId": run_id,
                             "status": "running", "startedAt": _now()})
    return run_id


def finish_course_run(directory: Path, run_id: str) -> None:
    _write_state(directory, {"schemaVersion": 1, "runId": run_id,
                             "status": "complete", "finishedAt": _now()})


def fail_course_run(directory: Path, run_id: str, error: BaseException) -> None:
    _write_state(directory, {"schemaVersion": 1, "runId": run_id,
                             "status": "failed", "finishedAt": _now(),
                             "error": f"{type(error).__name__}: {error}"})


def require_current_course_manifest(directory: Path, manifest: dict[str, Any]) -> None:
    """Allow historical manifests without a marker; validate every new run."""
    file = directory / STATE_FILE
    if not file.exists():
        if manifest.get("runId"):
            raise RuntimeError("강의 음성 실행 상태 기록이 없어 현재 manifest를 확인할 수 없습니다.")
        return
    try:
        state = json.loads(file.read_text(encoding="utf-8"))
    except (OSError, ValueError) as error:
        raise RuntimeError("강의 음성 실행 상태 기록을 읽을 수 없습니다.") from error
    if (not isinstance(state, dict) or state.get("status") != "complete"
            or not manifest.get("runId") or state.get("runId") != manifest.get("runId")):
        raise RuntimeError("최근 강의 음성 제작이 완료되지 않았거나 manifest 판본과 다릅니다.")
