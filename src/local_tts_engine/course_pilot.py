"""Generate a cached, aligned Qwen3-TTS course excerpt from deck scripts."""

from __future__ import annotations

import argparse
import gc
import hashlib
import json
import platform
import re
import subprocess
import sys
import time
import unicodedata
from dataclasses import asdict, dataclass
from importlib.metadata import version
from pathlib import Path
from typing import Any

import numpy as np
import soundfile as sf

from .pilot import (
    DEFAULT_SEED,
    MODEL_SPECS,
    normalize_audio,
    probe_audio,
    sha256_file,
    sha256_text,
    snapshot_revision,
)


DEFAULT_SOURCE_PROJECT = Path("/Users/jaehoseo/Desktop/vswrk/edu/udemy-agent")
LOCAL_PRONUNCIATION_PATH = Path(__file__).parents[2] / "config/production-pronunciation.ko.json"
ALIGNER_REPOSITORY = "mlx-community/Qwen3-ForcedAligner-0.6B-8bit"

# The opening pad is part of the audio timeline, not an independent caption
# offset. It lets the video muxer and player settle without hiding speech.
START_PAD_MS = 1300
STEP_GAP_MS = 200
SLIDE_GAP_MS = 750
END_PAD_MS = 600
EDGE_PAD_MS = 65
EDGE_FADE_MS = 24
MAX_INTERNAL_SILENCE_MS = 700
TARGET_INTERNAL_SILENCE_MS = 480
STEP_VISUAL_LEAD_MS = 120
SLIDE_VISUAL_LEAD_MS = 650
MAX_CHUNK_CHARS = 300
MAX_CHUNK_ENTRIES = 4

# Course generation is less stochastic than the A/B comparison settings.
COURSE_SETTING_OVERRIDES: dict[str, Any] = {
    "temperature": 0.75,
    "top_p": 0.95,
}


@dataclass(frozen=True)
class CourseEntry:
    chapter: str
    slide_id: str
    slide_number: int
    step: int
    source_text: str
    tts_text: str

    @property
    def key(self) -> str:
        return f"{self.chapter}--{self.slide_id}--{self.step}"


@dataclass(frozen=True)
class CourseChunk:
    entries: tuple[CourseEntry, ...]

    @property
    def key(self) -> str:
        first = self.entries[0]
        last = self.entries[-1]
        return f"{first.chapter}--{first.slide_id}--{first.step}-to-{last.step}"

    @property
    def source_text(self) -> str:
        return " ".join(entry.source_text for entry in self.entries)

    @property
    def tts_text(self) -> str:
        return " ".join(entry.tts_text for entry in self.entries)


def stable_digest(value: Any) -> str:
    payload = json.dumps(
        value,
        ensure_ascii=False,
        sort_keys=True,
        separators=(",", ":"),
    )
    return hashlib.sha256(payload.encode("utf-8")).hexdigest()


def strip_markdown(text: str) -> str:
    return (
        re.sub(r"!\[([^]]*)]\([^)]*\)", r"\1", text)
        .replace("\n", " ")
        .strip()
    )


def normalize_script_text(text: str) -> str:
    text = re.sub(r"\[([^]]+)]\([^)]*\)", r"\1", text)
    text = re.sub(r"[*_`~]", "", text)
    text = re.sub(r"^\s*[-+]\s+", "", text, flags=re.MULTILINE)
    return re.sub(r"\s+", " ", text).strip()


def parse_script(path: Path) -> dict[str, dict[int, str]]:
    result: dict[str, dict[int, str]] = {}
    slide_id: str | None = None
    step: int | None = None
    buffer: list[str] = []

    def flush() -> None:
        nonlocal buffer
        if slide_id is not None and step is not None:
            text = normalize_script_text("\n".join(buffer))
            if text:
                result.setdefault(slide_id, {})[step] = text
        buffer = []

    for raw in path.read_text(encoding="utf-8").splitlines():
        slide_match = re.match(r"^##\s+(.+?)\s*$", raw)
        step_match = re.match(r"^###\s+(\d+)\s*$", raw)
        if step_match:
            flush()
            step = int(step_match.group(1))
            continue
        if slide_match:
            flush()
            slide_id = slide_match.group(1).strip()
            step = None
            continue
        if step is not None and not re.match(r"^---+\s*$", raw) and not raw.startswith(">"):
            buffer.append(raw)
    flush()
    return result


def apply_pronunciation(text: str, dictionary: list[dict[str, str]]) -> str:
    output = text
    for item in dictionary:
        source = item["from"]
        replacement = item["to"]
        escaped = re.escape(source)
        if re.fullmatch(r"[A-Za-z0-9]+", source):
            pattern = rf"(?<![A-Za-z0-9]){escaped}(?![A-Za-z0-9])"
        else:
            pattern = escaped
        output = re.sub(pattern, replacement, output)
    return output


def production_pronunciation() -> list[dict[str, str]]:
    if not LOCAL_PRONUNCIATION_PATH.is_file():
        return []
    return json.loads(LOCAL_PRONUNCIATION_PATH.read_text(encoding="utf-8"))


def chapter_slide_order(deck_root: Path) -> list[tuple[str, str]]:
    chapters_dir = deck_root / "src/production/chapters"
    order: list[tuple[str, str]] = []
    for path in sorted(chapters_dir.glob("ch[0-9][0-9]-*.ts")):
        chapter = path.name[:4]
        source = path.read_text(encoding="utf-8")
        slide_ids = re.findall(r'^ {6}id:\s*"([a-z0-9-]+)"', source, flags=re.MULTILINE)
        if not slide_ids:
            raise ValueError(f"{path.name}에서 화면 ID를 찾지 못했습니다.")
        order.extend((chapter, slide_id) for slide_id in slide_ids)
    return order


def course_entries(
    source_project: Path,
    start_chapter: str,
    start_slide: str | None = None,
) -> list[CourseEntry]:
    deck_root = source_project / "deck"
    pronunciation = json.loads(
        (deck_root / "narration/pronunciation.ko.json").read_text(encoding="utf-8")
    )
    pronunciation.extend(production_pronunciation())
    order = chapter_slide_order(deck_root)
    global_numbers = {pair: index + 1 for index, pair in enumerate(order)}
    script_cache: dict[str, dict[str, dict[int, str]]] = {}
    entries: list[CourseEntry] = []
    started = False

    for chapter, slide_id in order:
        if not started:
            chapter_matches = chapter == start_chapter
            slide_matches = start_slide is None or slide_id == start_slide
            started = chapter_matches and slide_matches
        if not started:
            continue
        if chapter not in script_cache:
            script_cache[chapter] = parse_script(deck_root / f"script/course/{chapter}.md")
        steps = script_cache[chapter].get(slide_id)
        if not steps:
            raise ValueError(f"{chapter}/{slide_id}의 대본이 없습니다.")
        for step in sorted(steps):
            source_text = steps[step]
            entries.append(
                CourseEntry(
                    chapter=chapter,
                    slide_id=slide_id,
                    slide_number=global_numbers[(chapter, slide_id)],
                    step=step,
                    source_text=source_text,
                    tts_text=apply_pronunciation(source_text, pronunciation),
                )
            )

    if not started:
        marker = f"{start_chapter}/{start_slide or '<first>'}"
        raise ValueError(f"시작 화면 {marker}을 찾지 못했습니다.")
    return entries


def group_course_entries(entries: list[CourseEntry]) -> list[CourseChunk]:
    """Join nearby visual steps into one natural TTS breath."""
    chunks: list[CourseChunk] = []
    current: list[CourseEntry] = []
    current_chars = 0

    for entry in entries:
        same_slide = bool(current) and (
            current[0].chapter == entry.chapter and current[0].slide_id == entry.slide_id
        )
        added_chars = len(entry.tts_text) + (1 if current else 0)
        fits = (
            same_slide
            and len(current) < MAX_CHUNK_ENTRIES
            and current_chars + added_chars <= MAX_CHUNK_CHARS
        )
        if current and not fits:
            chunks.append(CourseChunk(tuple(current)))
            current = []
            current_chars = 0
        current.append(entry)
        current_chars += len(entry.tts_text) + (1 if len(current) > 1 else 0)

    if current:
        chunks.append(CourseChunk(tuple(current)))
    return chunks


def milliseconds_to_samples(milliseconds: int, sample_rate: int) -> int:
    return round(milliseconds * sample_rate / 1000)


def gap_after(current: CourseEntry, following: CourseEntry) -> int:
    if current.chapter == following.chapter and current.slide_id == following.slide_id:
        return STEP_GAP_MS
    return SLIDE_GAP_MS


def chunk_gap_after(current: CourseChunk, following: CourseChunk) -> int:
    return gap_after(current.entries[-1], following.entries[0])


def write_json(path: Path, value: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(value, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


def create_preview(source: Path, destination: Path) -> None:
    subprocess.run(
        [
            "ffmpeg",
            "-y",
            "-hide_banner",
            "-nostats",
            "-loglevel",
            "error",
            "-i",
            str(source),
            "-c:a",
            "aac",
            "-b:a",
            "192k",
            str(destination),
        ],
        check=True,
    )


def trim_and_fade_audio(audio: np.ndarray, sample_rate: int) -> tuple[np.ndarray, dict[str, int]]:
    """Remove generated edge silence while preserving a short natural breath."""
    samples = np.asarray(audio, dtype=np.float32).reshape(-1)
    frame = max(1, milliseconds_to_samples(20, sample_rate))
    hop = max(1, milliseconds_to_samples(10, sample_rate))
    if len(samples) < frame:
        return samples, {"trimmedHeadMs": 0, "trimmedTailMs": 0}

    starts = np.arange(0, len(samples) - frame + 1, hop)
    rms = np.sqrt(
        np.array([np.mean(samples[start : start + frame] ** 2) for start in starts])
        + 1e-12
    )
    threshold = max(5e-4, float(rms.max()) * 0.0125)
    voiced = np.flatnonzero(rms >= threshold)
    if not len(voiced):
        return samples, {"trimmedHeadMs": 0, "trimmedTailMs": 0}

    pad = milliseconds_to_samples(EDGE_PAD_MS, sample_rate)
    start = max(0, int(starts[voiced[0]]) - pad)
    end = min(len(samples), int(starts[voiced[-1]]) + frame + pad)
    trimmed = samples[start:end].copy()

    # Qwen occasionally inserts a second-long pause between otherwise adjacent
    # sentences. Keep normal rhetorical pauses, but compact the rare outliers.
    starts = np.arange(0, max(0, len(trimmed) - frame + 1), hop)
    rms = np.sqrt(
        np.array([np.mean(trimmed[at : at + frame] ** 2) for at in starts])
        + 1e-12
    )
    silent = rms < threshold
    runs: list[tuple[int, int]] = []
    run_start: int | None = None
    for index, is_silent in enumerate(silent):
        if is_silent and run_start is None:
            run_start = index
        if run_start is not None and (not is_silent or index == len(silent) - 1):
            run_end = index if not is_silent else index + 1
            silence_start = int(starts[run_start])
            silence_end = min(len(trimmed), int(starts[run_end - 1]) + frame)
            duration_ms = round((silence_end - silence_start) * 1000 / sample_rate)
            if (
                silence_start > milliseconds_to_samples(EDGE_PAD_MS, sample_rate)
                and silence_end < len(trimmed) - milliseconds_to_samples(EDGE_PAD_MS, sample_rate)
                and duration_ms > MAX_INTERNAL_SILENCE_MS
            ):
                runs.append((silence_start, silence_end))
            run_start = None

    shortened_ms = 0
    if runs:
        compacted: list[np.ndarray] = []
        cursor = 0
        target_silence = milliseconds_to_samples(TARGET_INTERNAL_SILENCE_MS, sample_rate)
        for silence_start, silence_end in runs:
            compacted.append(trimmed[cursor:silence_start])
            keep = min(target_silence, silence_end - silence_start)
            compacted.append(trimmed[silence_start : silence_start + keep])
            shortened_ms += round((silence_end - silence_start - keep) * 1000 / sample_rate)
            cursor = silence_end
        compacted.append(trimmed[cursor:])
        trimmed = np.concatenate(compacted)

    fade = min(milliseconds_to_samples(EDGE_FADE_MS, sample_rate), len(trimmed) // 2)
    if fade:
        phase = np.linspace(0.0, np.pi / 2.0, fade, endpoint=True, dtype=np.float32)
        trimmed[:fade] *= np.sin(phase) ** 2
        trimmed[-fade:] *= np.cos(phase) ** 2

    return trimmed, {
        "trimmedHeadMs": round(start * 1000 / sample_rate),
        "trimmedTailMs": round((len(samples) - end) * 1000 / sample_rate),
        "shortenedSilenceCount": len(runs),
        "shortenedSilenceMs": shortened_ms,
    }


def clean_alignment_token(token: str) -> str:
    return "".join(
        char
        for char in token
        if char == "'" or unicodedata.category(char).startswith(("L", "N"))
    )


def alignment_tokens(text: str) -> list[str]:
    return [cleaned for token in text.split() if (cleaned := clean_alignment_token(token))]


def entry_alignment_slices(
    chunk: CourseChunk,
    words: list[dict[str, Any]],
) -> list[list[dict[str, Any]]]:
    counts = [len(alignment_tokens(entry.tts_text)) for entry in chunk.entries]
    if sum(counts) != len(words):
        raise RuntimeError(
            f"{chunk.key} 정렬 토큰 수가 다릅니다: expected={sum(counts)}, actual={len(words)}"
        )
    result: list[list[dict[str, Any]]] = []
    cursor = 0
    for count in counts:
        result.append(words[cursor : cursor + count])
        cursor += count
    return result


def load_or_create_alignment(
    chunk: CourseChunk,
    clip: dict[str, Any],
    aligner: Any,
    alignment_path: Path,
) -> list[dict[str, Any]]:
    if alignment_path.is_file():
        return json.loads(alignment_path.read_text(encoding="utf-8"))["words"]
    if aligner is None:
        raise RuntimeError(f"{chunk.key} 정렬 캐시가 없지만 aligner가 로드되지 않았습니다.")

    result = aligner.generate(
        audio=clip["audioPath"],
        text=chunk.tts_text,
        # Space tokenization is deterministic for mixed Korean/English. This
        # forced-aligner API does not feed a separate language token to the model.
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
    entry_alignment_slices(chunk, words)
    write_json(
        alignment_path,
        {
            "schemaVersion": 1,
            "chunkKey": chunk.key,
            "hash": clip["hash"],
            "words": words,
        },
    )
    return words


def synthesize_excerpt(
    source_project: Path,
    output_dir: Path,
    reference_path: Path,
    reference_text_path: Path,
    target_seconds: float,
    start_chapter: str,
    start_slide: str | None,
    seed: int,
) -> None:
    import mlx.core as mx
    from mlx_audio.tts.utils import load_model as load_tts_model
    from mlx_audio.utils import get_model_path

    if target_seconds <= 0:
        raise ValueError("목표 길이는 0초보다 커야 합니다.")

    spec = MODEL_SPECS["qwen3-tts"]
    settings = {**spec.settings, **COURSE_SETTING_OVERRIDES}
    entries = course_entries(source_project, start_chapter, start_slide)
    chunks = group_course_entries(entries)
    reference_text = reference_text_path.read_text(encoding="utf-8").strip()
    reference_hash = sha256_file(reference_path)
    reference_text_hash = sha256_text(reference_text)
    output_dir.mkdir(parents=True, exist_ok=True)
    clips_dir = output_dir / "clips/native"
    alignments_dir = output_dir / "clips/alignment"
    clips_dir.mkdir(parents=True, exist_ok=True)
    alignments_dir.mkdir(parents=True, exist_ok=True)

    model_path = get_model_path(spec.repository)
    revision = snapshot_revision(model_path)
    load_started = time.perf_counter()
    model = load_tts_model(model_path)
    load_ms = round((time.perf_counter() - load_started) * 1000)

    target_samples: int | None = None
    native_rate: int | None = None
    cursor_samples: int | None = None
    selected_chunks: list[dict[str, Any]] = []
    generation_ms = 0
    cache_hits = 0
    peak_memory_gb = 0.0

    for index, chunk in enumerate(chunks):
        cache_hash = stable_digest(
            {
                "schemaVersion": 4,
                "model": spec.repository,
                "modelRevision": revision,
                "settings": {"language": spec.language, **settings},
                "referenceSha256": reference_hash,
                "referenceTextSha256": reference_text_hash,
                "entryKeys": [entry.key for entry in chunk.entries],
                "ttsText": chunk.tts_text,
                "seed": seed,
                "edgePadMs": EDGE_PAD_MS,
                "edgeFadeMs": EDGE_FADE_MS,
                "maxInternalSilenceMs": MAX_INTERNAL_SILENCE_MS,
                "targetInternalSilenceMs": TARGET_INTERNAL_SILENCE_MS,
            }
        )
        clip_path = clips_dir / f"{chunk.key}--{cache_hash[:12]}.wav"
        clip_meta_path = clip_path.with_suffix(".json")
        entry_seed = seed ^ int(cache_hash[:8], 16)

        if clip_path.is_file():
            info = sf.info(clip_path)
            rate = int(info.samplerate)
            frames = int(info.frames)
            trim_info = (
                json.loads(clip_meta_path.read_text(encoding="utf-8"))
                if clip_meta_path.is_file()
                else {
                    "trimmedHeadMs": 0,
                    "trimmedTailMs": 0,
                    "shortenedSilenceCount": 0,
                    "shortenedSilenceMs": 0,
                }
            )
            cache_hits += 1
        else:
            mx.random.seed(entry_seed)
            started = time.perf_counter()
            results = list(
                model.generate(
                    text=chunk.tts_text,
                    ref_audio=str(reference_path),
                    ref_text=reference_text,
                    lang_code=spec.language,
                    verbose=False,
                    **settings,
                )
            )
            generation_ms += round((time.perf_counter() - started) * 1000)
            if not results:
                raise RuntimeError(f"{chunk.key}에서 오디오가 생성되지 않았습니다.")
            rate = int(results[0].sample_rate)
            if any(int(result.sample_rate) != rate for result in results):
                raise RuntimeError(f"{chunk.key}의 샘플레이트가 일치하지 않습니다.")
            raw_audio = np.concatenate([np.asarray(result.audio) for result in results])
            audio, trim_info = trim_and_fade_audio(raw_audio, rate)
            sf.write(clip_path, audio, rate, subtype="PCM_24")
            write_json(clip_meta_path, trim_info)
            frames = len(audio)
            peak_memory_gb = max(
                peak_memory_gb,
                *(float(result.peak_memory_usage) for result in results),
            )

        if native_rate is None:
            native_rate = rate
            target_samples = round(target_seconds * native_rate)
            cursor_samples = milliseconds_to_samples(START_PAD_MS, native_rate)
        if rate != native_rate:
            raise RuntimeError("캐시된 클립의 샘플레이트가 서로 다릅니다.")
        assert cursor_samples is not None and target_samples is not None

        start_sample = cursor_samples
        end_sample = start_sample + frames
        selected_chunks.append(
            {
                "chunk": chunk,
                "key": chunk.key,
                "hash": cache_hash,
                "seed": entry_seed,
                "audioPath": str(clip_path.resolve()),
                "frames": frames,
                "sampleRate": rate,
                "startSample": start_sample,
                "endSample": end_sample,
                "startMs": round(start_sample * 1000 / rate),
                "endMs": round(end_sample * 1000 / rate),
                "durationMs": round(frames * 1000 / rate),
                **trim_info,
            }
        )

        total_if_finished = end_sample + milliseconds_to_samples(END_PAD_MS, rate)
        if total_if_finished >= target_samples:
            if len(selected_chunks) > 1:
                previous_end = int(selected_chunks[-2]["endSample"])
                without_current = previous_end + milliseconds_to_samples(END_PAD_MS, rate)
                if abs(without_current - target_samples) < abs(
                    total_if_finished - target_samples
                ):
                    selected_chunks.pop()
            break
        following = chunks[index + 1]
        cursor_samples = end_sample + milliseconds_to_samples(
            chunk_gap_after(chunk, following), rate
        )
    else:
        raise RuntimeError("강의 끝까지 생성해도 목표 길이에 도달하지 못했습니다.")

    # Keep TTS and forced alignment in separate Metal phases.
    del model
    gc.collect()
    mx.clear_cache()

    aligner_paths = [
        alignments_dir / f"{item['key']}--{item['hash'][:12]}.json"
        for item in selected_chunks
    ]
    missing_alignment = any(not path.is_file() for path in aligner_paths)
    aligner = None
    aligner_revision = None
    alignment_load_ms = 0
    alignment_ms = 0
    if missing_alignment:
        from mlx_audio.stt.utils import load_model as load_stt_model

        aligner_path = get_model_path(ALIGNER_REPOSITORY)
        aligner_revision = snapshot_revision(aligner_path)
        started = time.perf_counter()
        aligner = load_stt_model(aligner_path)
        alignment_load_ms = round((time.perf_counter() - started) * 1000)

    for item, alignment_path in zip(selected_chunks, aligner_paths):
        started = time.perf_counter()
        item["words"] = load_or_create_alignment(item["chunk"], item, aligner, alignment_path)
        alignment_ms += round((time.perf_counter() - started) * 1000)

    if aligner is not None:
        del aligner
        gc.collect()
        mx.clear_cache()
    if aligner_revision is None:
        cached_aligner = get_model_path(ALIGNER_REPOSITORY)
        aligner_revision = snapshot_revision(cached_aligner)

    assert native_rate is not None
    pieces: list[np.ndarray] = [
        np.zeros(milliseconds_to_samples(START_PAD_MS, native_rate), dtype=np.float32)
    ]
    for index, item in enumerate(selected_chunks):
        audio, rate = sf.read(item["audioPath"], dtype="float32")
        if int(rate) != native_rate:
            raise RuntimeError("트랙 조립 중 샘플레이트 불일치가 발견됐습니다.")
        pieces.append(np.asarray(audio))
        gap_ms = (
            chunk_gap_after(item["chunk"], selected_chunks[index + 1]["chunk"])
            if index + 1 < len(selected_chunks)
            else END_PAD_MS
        )
        pieces.append(np.zeros(milliseconds_to_samples(gap_ms, native_rate), dtype=np.float32))

    artifact_name = output_dir.name
    native_track = output_dir / f"work/{artifact_name}-native.wav"
    native_track.parent.mkdir(parents=True, exist_ok=True)
    sf.write(native_track, np.concatenate(pieces), native_rate, subtype="PCM_24")
    final_track = output_dir / f"{artifact_name}.wav"
    normalization = normalize_audio(native_track, final_track)
    preview = output_dir / f"{artifact_name}.m4a"
    create_preview(final_track, preview)
    final_probe = probe_audio(final_track)

    # Convert chunk-local word alignment to step-level absolute timing. The
    # screen changes shortly before the next step's first spoken word.
    step_records: list[dict[str, Any]] = []
    for item in selected_chunks:
        chunk: CourseChunk = item["chunk"]
        slices = entry_alignment_slices(chunk, item["words"])
        for entry, words in zip(chunk.entries, slices):
            if not words:
                raise RuntimeError(f"{entry.key}에 정렬된 단어가 없습니다.")
            absolute_words = [
                {
                    **word,
                    "startMs": item["startMs"] + int(word["startMs"]),
                    "endMs": item["startMs"] + int(word["endMs"]),
                }
                for word in words
            ]
            step_records.append(
                {
                    **asdict(entry),
                    "key": entry.key,
                    "chunkKey": item["key"],
                    "hash": item["hash"],
                    "seed": item["seed"],
                    "audioPath": item["audioPath"],
                    "sampleRate": item["sampleRate"],
                    "speechStartMs": absolute_words[0]["startMs"],
                    "speechEndMs": absolute_words[-1]["endMs"],
                    "alignment": {"words": absolute_words},
                }
            )

    total_ms = int(final_probe["durationMs"])
    for index, record in enumerate(step_records):
        visual_start = (
            START_PAD_MS if index == 0 else int(step_records[index - 1]["transitionAtMs"])
        )
        if index + 1 < len(step_records):
            following = step_records[index + 1]
            next_speech = int(following["speechStartMs"])
            same_slide = (
                record["chapter"] == following["chapter"]
                and record["slide_id"] == following["slide_id"]
            )
            visual_lead = STEP_VISUAL_LEAD_MS if same_slide else SLIDE_VISUAL_LEAD_MS
            transition = max(int(record["speechEndMs"]), next_speech - visual_lead)
        else:
            transition = total_ms
        record["startMs"] = visual_start
        record["endMs"] = transition
        record["transitionAtMs"] = transition
        record["durationMs"] = transition - visual_start

    chunk_manifest = [
        {
            "key": item["key"],
            "entryKeys": [entry.key for entry in item["chunk"].entries],
            "hash": item["hash"],
            "seed": item["seed"],
            "audioPath": item["audioPath"],
            "sampleRate": item["sampleRate"],
            "frames": item["frames"],
            "startMs": item["startMs"],
            "endMs": item["endMs"],
            "durationMs": item["durationMs"],
            "trimmedHeadMs": item["trimmedHeadMs"],
            "trimmedTailMs": item["trimmedTailMs"],
            "shortenedSilenceCount": item["shortenedSilenceCount"],
            "shortenedSilenceMs": item["shortenedSilenceMs"],
        }
        for item in selected_chunks
    ]

    metadata = {
        "schemaVersion": 4,
        "title": f"강의 시작 {target_seconds / 60:g}분 Qwen3-TTS 파일럿",
        "model": spec.repository,
        "modelRevision": revision,
        "modelLicense": spec.license,
        "aligner": {
            "model": ALIGNER_REPOSITORY,
            "revision": aligner_revision,
            "license": "Apache-2.0",
        },
        "seed": seed,
        "settings": {"language": spec.language, **settings},
        "sourceProject": str(source_project.resolve()),
        "start": {"chapter": start_chapter, "slide": start_slide},
        "targetSeconds": target_seconds,
        "reference": {
            "path": str(reference_path.resolve()),
            "sha256": reference_hash,
            "transcriptPath": str(reference_text_path.resolve()),
            "transcriptSha256": reference_text_hash,
        },
        "timing": {
            "startPadMs": START_PAD_MS,
            "stepGapMs": STEP_GAP_MS,
            "slideGapMs": SLIDE_GAP_MS,
            "endPadMs": END_PAD_MS,
            "edgePadMs": EDGE_PAD_MS,
            "edgeFadeMs": EDGE_FADE_MS,
            "maxInternalSilenceMs": MAX_INTERNAL_SILENCE_MS,
            "targetInternalSilenceMs": TARGET_INTERNAL_SILENCE_MS,
            "stepVisualLeadMs": STEP_VISUAL_LEAD_MS,
            "slideVisualLeadMs": SLIDE_VISUAL_LEAD_MS,
        },
        "chunking": {
            "maxCharacters": MAX_CHUNK_CHARS,
            "maxEntries": MAX_CHUNK_ENTRIES,
            "sameSlideOnly": True,
        },
        "stats": {
            "chapters": sorted({item["chapter"] for item in step_records}),
            "slides": len({(item["chapter"], item["slide_id"]) for item in step_records}),
            "steps": len(step_records),
            "clips": len(selected_chunks),
            "characters": sum(len(item["source_text"]) for item in step_records),
            "cacheHits": cache_hits,
        },
        "performance": {
            "modelLoadMs": load_ms,
            "generationMs": generation_ms,
            "alignmentLoadMs": alignment_load_ms,
            "alignmentMs": alignment_ms,
            "peakMetalMemoryGb": round(peak_memory_gb, 3),
        },
        "normalization": normalization,
        "audioPath": str(final_track.resolve()),
        "previewPath": str(preview.resolve()),
        **final_probe,
        "chunks": chunk_manifest,
        "entries": step_records,
        "software": {
            "python": platform.python_version(),
            "mlxAudio": version("mlx-audio"),
            "mlx": version("mlx"),
        },
    }
    write_json(output_dir / "manifest.json", metadata)
    print(
        json.dumps(
            {
                key: metadata[key]
                for key in ("stats", "performance", "audioPath", "previewPath", "durationMs")
            },
            ensure_ascii=False,
            indent=2,
        )
    )


def entries_for_item(item: dict[str, Any]) -> CourseEntry:
    return CourseEntry(
        chapter=item["chapter"],
        slide_id=item["slide_id"],
        slide_number=int(item["slide_number"]),
        step=int(item["step"]),
        source_text=item["source_text"],
        tts_text=item["tts_text"],
    )


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source-project", type=Path, default=DEFAULT_SOURCE_PROJECT)
    parser.add_argument("--output-dir", type=Path, required=True)
    parser.add_argument("--reference", type=Path, required=True)
    parser.add_argument("--reference-text", type=Path, required=True)
    parser.add_argument("--target-seconds", type=float, default=300.0)
    parser.add_argument("--start-chapter", default="ch00")
    parser.add_argument("--start-slide")
    parser.add_argument("--seed", type=int, default=DEFAULT_SEED)
    return parser


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    synthesize_excerpt(
        source_project=args.source_project,
        output_dir=args.output_dir,
        reference_path=args.reference,
        reference_text_path=args.reference_text,
        target_seconds=args.target_seconds,
        start_chapter=args.start_chapter,
        start_slide=args.start_slide,
        seed=args.seed,
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
