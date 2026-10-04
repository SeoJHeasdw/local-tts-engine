"""Forced alignment records and visual-step timeline assembly."""

from __future__ import annotations

import json
import math
import os
import tempfile
import unicodedata
from pathlib import Path
from typing import Any

from .serialization import stable_digest
from .types import CourseChunk


def clean_alignment_token(token: str) -> str:
    """정렬 토큰에서 문자·숫자·아포스트로피만 남기고 구두점을 제거한다.

    ForcedAligner의 어휘에 없는 특수문자를 포함한 토큰을 정규화해
    텍스트와 정렬 결과의 토큰 수를 일치시킨다.
    유니코드 카테고리 L(문자), N(숫자)과 아포스트로피(')만 허용한다.
    """
    return "".join(
        char
        for char in token
        if char == "'" or unicodedata.category(char).startswith(("L", "N"))
    )


def alignment_tokens(text: str) -> list[str]:
    """텍스트를 공백으로 분리한 뒤 각 토큰을 clean_alignment_token으로 정규화한다.

    빈 문자열이 된 토큰은 제외한다 (순수 구두점 토큰 등).
    """
    return [cleaned for token in text.split() if (cleaned := clean_alignment_token(token))]


def entry_alignment_slices(
    chunk: CourseChunk,
    words: list[dict[str, Any]],
) -> list[list[dict[str, Any]]]:
    """청크 전체 단어 정렬 결과를 엔트리별로 분할한다.

    각 엔트리의 토큰 수를 세어 words 리스트를 순서대로 슬라이싱한다.
    토큰 수 불일치는 텍스트 전처리와 정렬 결과가 어긋난 것이므로 즉시 오류를 낸다.

    Returns:
        엔트리별 단어 정렬 딕셔너리 목록 (청크 엔트리 순서와 동일)
    """
    counts = [len(alignment_tokens(entry.tts_text)) for entry in chunk.entries]
    if sum(counts) != len(words):
        raise RuntimeError(
            f"{chunk.key} 정렬 토큰 수가 다릅니다: expected={sum(counts)}, actual={len(words)}"
        )
    expected = [token for entry in chunk.entries for token in alignment_tokens(entry.tts_text)]
    actual = [clean_alignment_token(str(word.get("text", ""))) for word in words]
    if actual != expected:
        raise RuntimeError(f"{chunk.key} 정렬 단어가 현재 발음문과 다릅니다.")
    result: list[list[dict[str, Any]]] = []
    cursor = 0
    for count in counts:
        result.append(words[cursor : cursor + count])
        cursor += count
    return result


def merge_step_record_parts(records: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Merge forced-pause speech parts back into one visual-step record."""
    merged: list[dict[str, Any]] = []
    for record in records:
        identity = (record["chapter"], record["slide_id"], int(record["step"]))
        previous_identity = (
            (merged[-1]["chapter"], merged[-1]["slide_id"], int(merged[-1]["step"]))
            if merged
            else None
        )
        if identity != previous_identity:
            if merged and int(record.get("pause_before_ms", 0)) > 0:
                merged[-1]["forcedPauses"].append({
                    "durationMs": int(record["pause_before_ms"]),
                    "nextSpeechStartMs": int(record["speechStartMs"]),
                })
            merged.append(
                {
                    **record,
                    "key": f"{record['chapter']}--{record['slide_id']}--{record['step']}",
                    "alignment": {"words": list(record["alignment"]["words"])},
                    "chunkKeys": [record["chunkKey"]],
                    "audioPaths": [record["audioPath"]],
                    "forcedPauses": [],
                }
            )
            continue

        previous = merged[-1]
        pause_ms = int(record.get("pause_before_ms", 0))
        if pause_ms <= 0:
            raise RuntimeError(f"{record['key']}의 분할 음성에 강제 무음이 없습니다.")
        previous["source_text"] = f"{previous['source_text']} {record['source_text']}"
        previous["tts_text"] = f"{previous['tts_text']} {record['tts_text']}"
        for field in (
            "pronunciation_matches",
            "naturalness_checks",
            "naturalness_warnings",
            "required_pronunciations",
            "unresolved_tokens",
        ):
            previous[field] = tuple(
                dict.fromkeys([*previous.get(field, ()), *record.get(field, ())])
            )
        previous["speechEndMs"] = int(record["speechEndMs"])
        previous["alignment"]["words"].extend(record["alignment"]["words"])
        previous["chunkKeys"].append(record["chunkKey"])
        previous["audioPaths"].append(record["audioPath"])
        previous["forcedPauses"].append(
            {
                "durationMs": pause_ms,
                "nextSpeechStartMs": int(record["speechStartMs"]),
            }
        )
        previous["part_count"] = max(
            int(previous.get("part_count", 1)), int(record.get("part_count", 1))
        )
        previous["hash"] = stable_digest(
            [previous["hash"], record["hash"], pause_ms]
        )
    return merged


def read_cached_alignment(
    chunk: CourseChunk, clip: dict[str, Any], alignment_path: Path,
) -> list[dict[str, Any]] | None:
    """Reuse only complete records bound to this chunk, text, hash and duration."""
    try:
        record = json.loads(alignment_path.read_text(encoding="utf-8"))
        if (record.get("schemaVersion") != 1 or record.get("chunkKey") != chunk.key
                or record.get("hash") != clip["hash"] or not isinstance(record.get("words"), list)):
            return None
        words = record["words"]
        entry_alignment_slices(chunk, words)
        duration = (float(clip["frames"]) * 1000 / float(clip["sampleRate"])
                    if "frames" in clip and "sampleRate" in clip else clip.get("durationMs"))
        if duration is not None and (not math.isfinite(float(duration)) or float(duration) <= 0):
            return None
        for word in words:
            start, end = float(word["startMs"]), float(word["endMs"])
            if (not math.isfinite(start) or not math.isfinite(end) or start < 0 or end < start
                    or (duration is not None and end > float(duration) + 1)):
                return None
        return words
    except (OSError, UnicodeError, ValueError, TypeError, KeyError, AttributeError, RuntimeError, ZeroDivisionError):
        return None


def load_or_create_alignment(
    chunk: CourseChunk,
    clip: dict[str, Any],
    aligner: Any,
    alignment_path: Path,
    use_cache: bool = True,
) -> list[dict[str, Any]]:
    """정렬 캐시가 있으면 읽고, 없으면 ForcedAligner로 생성한 뒤 저장한다.

    정렬은 계산 비용이 크므로 clip 해시가 포함된 파일명으로 캐싱한다.
    aligner=None 이면 캐시 파일이 반드시 존재해야 한다
    (TTS 완료 후 aligner를 로드하지 않은 상태에서 재실행할 때).

    Args:
        chunk:          정렬할 CourseChunk.
        clip:           오디오 경로와 해시를 담은 딕셔너리.
        aligner:        mlx_audio STT 모델 인스턴스 (캐시 히트 시 None 가능).
        alignment_path: 캐시 파일 경로.

    Returns:
        단어별 {"text", "startMs", "endMs"} 딕셔너리 목록.
    """
    cached = read_cached_alignment(chunk, clip, alignment_path) if use_cache else None
    if cached is not None:
        return cached
    if aligner is None:
        raise RuntimeError(f"{chunk.key} 정렬 캐시가 없지만 aligner가 로드되지 않았습니다.")

    result = aligner.generate(
        audio=clip["audioPath"],
        text=chunk.tts_text,
        # Space tokenization is deterministic for mixed Korean/English. This
        # forced-aligner API does not feed a separate language token to the model.
        # 공백 기반 토크나이저는 한국어/영어 혼합에서도 결정적이므로 "English" 고정.
        language="English",
    )
    words = [
        {
            "text": item.text,
            "startMs": round(item.start_time * 1000),
            "endMs": round(item.end_time * 1000),
        }
        for item in result.items
    ]
    # 토큰 수 일관성 검증 후 캐시 저장
    entry_alignment_slices(chunk, words)
    record = {
        "schemaVersion": 1,
        "chunkKey": chunk.key,
        "hash": clip["hash"],
        "words": words,
    }
    alignment_path.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.NamedTemporaryFile(mode="w", encoding="utf-8", dir=alignment_path.parent,
                                     prefix=f".{alignment_path.name}.", delete=False) as pending:
        pending_path = Path(pending.name)
        try:
            pending.write(json.dumps(record, ensure_ascii=False, indent=2) + "\n")
            pending.flush()
            os.fsync(pending.fileno())
            os.replace(pending_path, alignment_path)
        finally:
            pending_path.unlink(missing_ok=True)
    return words
