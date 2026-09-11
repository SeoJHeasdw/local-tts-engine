"""Generate a cached, aligned Qwen3-TTS course excerpt from deck scripts.

udemy-agent 저장소의 강의 대본(deck/script/course/<ch>.md)을 읽어
Qwen3-TTS로 오디오를 생성하고, ForcedAligner로 단어별 타이밍을 정렬한 뒤
export_udemy.py가 덱 미디어 계약으로 변환할 manifest.json을 출력한다.

처리 순서:
    1. 대본 파싱  → CourseEntry 목록 (챕터·슬라이드·스텝 단위)
    2. 청킹       → CourseChunk 목록 (한 번에 합성할 자연스러운 호흡 단위)
    3. 생성·검수  → 청크마다 한 번 생성하고 즉시 독립 Whisper로 받아쓰기.
                   깨끗하면 거기서 끝내고, 아니면 다음 시드로 다시 시도한다.
    4. 판정       → 통과 / 확인 권장 / 재생성 필요로 나눠 manifest에 기록
    5. 트랙 조립  → 패드·갭을 삽입해 단일 WAV로 이어붙임 + ffmpeg 정규화
    6. 강제 정렬  → Qwen3-ForcedAligner 로 단어별 시작·종료 ms 계산
    7. 타임라인   → 스텝별 startMs/endMs/transitionAtMs 산출 → manifest.json

CLI 진입점:
    python -m local_tts_engine.course_pilot \\
        --reference ref.wav \\
        --reference-text ref.txt \\
        --output-dir outputs/ch00-5m
"""

from __future__ import annotations

import argparse
import gc
import json
import numpy as np
import platform
import soundfile as sf
import subprocess
import sys
import tempfile
import time
from dataclasses import asdict
from importlib.metadata import version
from pathlib import Path
from typing import Any

from .course.alignment import (
    alignment_tokens,
    clean_alignment_token,
    entry_alignment_slices,
    load_or_create_alignment,
    merge_step_record_parts,
)
from .course.audio import (
    chunk_gap_after,
    gap_after,
    milliseconds_to_samples,
    trim_and_fade_audio,
)
from .course.script import (
    chapter_lesson_files,
    chapter_slide_order,
    course_entries,
    course_lesson_catalog,
    course_page_catalog,
    course_pronunciation_dictionary,
    forced_pause_milliseconds,
    group_course_entries,
    is_narration_direction,
    lesson_title_from_source,
    normalize_script_text,
    parse_script,
    production_pronunciation,
    report_unresolved_terms,
    slide_ids_from_source,
    split_forced_pause_segments,
    strip_markdown,
    report_naturalness_warnings,
)
from .course.serialization import stable_digest, write_json
from .course.settings import (
    ALIGNER_REPOSITORY,
    AUDIO_TRIM_STAT_KEYS,
    COURSE_SETTING_OVERRIDES,
    DEFAULT_SOURCE_PROJECT,
    EDGE_FADE_MS,
    EDGE_PAD_MS,
    END_PAD_MS,
    FORCED_PAUSE_LINE_PATTERN,
    FORCED_PAUSE_TOKEN_PATTERN,
    LESSON_FILE_PATTERN,
    LOCAL_PRONUNCIATION_PATH,
    LOCAL_QUALITY_ASR_PATH,
    MAX_CHUNK_CHARS,
    MAX_CHUNK_ENTRIES,
    MAX_FORCED_PAUSE_MS,
    MAX_INTERNAL_SILENCE_MS,
    MIN_FORCED_PAUSE_MS,
    SLIDE_GAP_MS,
    SLIDE_VISUAL_LEAD_MS,
    START_PAD_MS,
    STEP_GAP_MS,
    STEP_VISUAL_LEAD_MS,
    TARGET_INTERNAL_SILENCE_MS,
    UNTRIMMED_AUDIO_STATS,
)
from .course.types import CourseChunk, CourseEntry
from .english_voice import (
    EnglishVoiceRouter,
    LANGUAGE_GAP_MS,
    match_english_level,
    read_routed_timings,
    read_routed_transcript,
    speech_segments,
)
from .pilot import (
    DEFAULT_SEED,
    MODEL_SPECS,
    normalize_audio,
    probe_audio,
    resolve_model_path,
    sha256_file,
    sha256_text,
    snapshot_revision,
)
from .pronunciation import apply_pronunciation
from .prosody import MIN_INTERNAL_PAUSE_MS, PROSODY_POLICY, WORD_EDGE_GUARD_MS
from .restarts import RESTART_POLICY
from .speech_quality import (
    ASR_LICENSE,
    ASR_REPOSITORY,
    LEXICAL_FAILURE_DISTANCE,
    LEXICAL_WARNING_DISTANCE,
    MAX_AUTOMATIC_ATTEMPTS,
    MIN_LEXICAL_KEY_LENGTH,
    asr_reading_windows,
    better_evaluation,
    choose_best_candidate,
    chunk_severity,
    evaluate_candidate,
    quality_summary,
    read_timed_words,
    review_candidate_prosody,
)
from .transcript_coverage import (
    COVERAGE_POLICY,
    omission_recovery_parts,
    repeated_omissions,
    saved_omissions,
)

# Existing CLI scripts import these helpers here; implementation lives in course/.


def adapter_identity(adapter_path: Path | None, adapter_scale: float) -> dict[str, Any] | None:
    """Return immutable adapter metadata for cache keys and manifests."""
    if adapter_path is None:
        return None
    weights = adapter_path / "adapters.safetensors"
    config = adapter_path / "adapter_config.json"
    if not weights.is_file() or not config.is_file():
        raise FileNotFoundError(f"LoRA 어댑터 파일이 없습니다: {adapter_path}")
    if not 0 < adapter_scale <= 1:
        raise ValueError("강의 제작용 adapter-scale은 0보다 크고 1 이하여야 합니다.")
    value = {
        "path": str(adapter_path.resolve()),
        "weightsSha256": sha256_file(weights),
        "configSha256": sha256_file(config),
        "scale": adapter_scale,
    }
    return {**value, "identitySha256": stable_digest(value)}


def apply_adapter_scale(model: Any, adapter_scale: float) -> int:
    """Continuously scale every loaded LoRA module and return the module count."""
    if not 0 < adapter_scale <= 1:
        raise ValueError("LoRA 적용 강도는 0보다 크고 1 이하여야 합니다.")
    scaled_modules = 0
    for _, module in model.named_modules():
        if all(hasattr(module, name) for name in ("lora_a", "lora_b", "scale")):
            module.scale *= adapter_scale
            scaled_modules += 1
    return scaled_modules


def create_preview(source: Path, destination: Path) -> None:
    """WAV를 AAC 192kbps M4A로 변환해 미리듣기 파일을 생성한다.

    브라우저나 모바일에서 바로 재생 가능한 포맷으로 변환한다.
    오류 메시지만 표시하고 진행 로그는 숨긴다(-loglevel error).
    """
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


def metal_peak_memory_gb(mx: Any) -> float:
    """Report the peak Metal allocation across every model this run loaded.

    The generator and the independent reader are resident together now, so the
    per-clip figure the TTS model reports no longer describes the run. MLX has
    moved this call between namespaces, and an unreadable number is not worth
    failing a finished lecture over.
    """
    namespace = getattr(mx, "metal", None)
    for call in (
        getattr(mx, "get_peak_memory", None),
        getattr(namespace, "get_peak_memory", None) if namespace is not None else None,
    ):
        if not callable(call):
            continue
        try:
            return round(float(call()) / 1024**3, 3)
        except Exception:  # noqa: BLE001 - a diagnostic must never end a run
            continue
    return 0.0


def read_independent_word_times(audio_path: Path, text: str) -> list[dict[str, Any]]:
    """Load the installed aligner only for a suspected pause, then release it.

    This is independent of Whisper and does not read/write the subtitle alignment
    cache. The normal full alignment phase still runs after TTS/ASR are released.
    """
    import mlx.core as mx
    from mlx_audio.stt.utils import load_model
    from mlx_audio.utils import get_model_path

    aligner = load_model(resolve_model_path(ALIGNER_REPOSITORY, get_model_path))
    try:
        result = aligner.generate(audio=str(audio_path), text=text, language="English")
        return [
            {"text": item.text, "startMs": round(item.start_time * 1000), "endMs": round(item.end_time * 1000)}
            for item in result.items
        ]
    finally:
        del aligner
        gc.collect()
        mx.clear_cache()


def generate_candidate_audio(generate: Any, arguments: dict[str, Any], parts: list[str] | None = None,
                             *, voice_router: EnglishVoiceRouter | None = None) -> dict[str, Any]:
    """Make a normal take or join punctuation-bounded recovery pieces."""
    texts = parts or [arguments["text"]]
    if parts and " ".join(texts) != " ".join(arguments["text"].split()):
        raise ValueError("누락 복구 조각이 원래 발음문과 다릅니다.")
    routing = voice_router.identity(arguments["text"]) if voice_router else {}
    segments = [segment for text in texts for segment in (
        speech_segments(text, voice_router.dictionary) if routing else [{"text": text, "language": arguments.get("lang_code", "Korean")}]
    )]
    pieces, cleanups, part_records = [], [], []
    rate, generation_ms, peak, cursor = None, 0, 0.0, 0
    previous_language = None
    for segment in segments:
        text, language = segment["text"], segment["language"]
        started = time.perf_counter()
        call_arguments = {**arguments, "text": text}
        results = list(voice_router.generate(generate, call_arguments, language) if routing else generate(**call_arguments))
        generation_ms += round((time.perf_counter() - started) * 1000)
        if not results:
            raise RuntimeError("음성 후보에서 오디오가 생성되지 않았습니다.")
        rate = rate or int(results[0].sample_rate)
        if any(int(result.sample_rate) != rate for result in results):
            raise RuntimeError("음성 후보 조각의 샘플레이트가 일치하지 않습니다.")
        raw = np.concatenate([np.asarray(result.audio) for result in results])
        audio, cleanup = trim_and_fade_audio(raw, rate)
        if pieces:
            gap_ms = LANGUAGE_GAP_MS if routing and previous_language != language else STEP_GAP_MS
            gap = np.zeros(round(gap_ms * rate / 1000), dtype=audio.dtype)
            pieces.append(gap)
            cursor += len(gap)
        part_records.append({"text": text, "startMs": round(cursor * 1000 / rate),
                             "durationMs": round(len(audio) * 1000 / rate),
                             **({"language": language, "startSample": cursor, "endSample": cursor + len(audio)} if routing else {})})
        pieces.append(audio)
        cleanups.append(cleanup)
        cursor += len(audio)
        previous_language = language
        peak = max(peak, *(float(result.peak_memory_usage) for result in results))
    cleanup = dict(cleanups[0])
    if parts or routing:
        cleanup.update({
            "trimmedTailMs": cleanups[-1]["trimmedTailMs"],
            "shortenedSilenceCount": sum(c["shortenedSilenceCount"] for c in cleanups),
            "shortenedSilenceMs": sum(c["shortenedSilenceMs"] for c in cleanups),
        })
    if parts:
        cleanup["recovery"] = {"strategy": COVERAGE_POLICY, "gapMs": STEP_GAP_MS, "parts": part_records}
    combined = np.concatenate(pieces)
    if routing:
        match_english_level(combined, rate, part_records)
        cleanup["voiceRouting"] = {**routing, "sampleRate": rate, "segments": part_records}
    return {"audio": combined, "sampleRate": rate, "cleanup": cleanup,
            "generationMs": generation_ms, "peakMemoryGb": peak}


def resolve_chunk_take(
    chunk: CourseChunk,
    *,
    attempt_limit: int,
    synthesize: Any,
    review: Any | None,
    synthesize_recovery: Any | None = None,
    initial_omissions: list[dict[str, Any]] | None = None,
) -> dict[str, Any]:
    """Generate takes of one chunk until one reads cleanly, and report the choice.

    Every chunk is read back, but a chunk that reads correctly on the first seed
    stops there.  Retries are therefore paid for only where something is
    actually wrong, which is what makes it affordable to check the whole lecture
    rather than only the lines with risky words in them.

    ``review`` of ``None`` disables reading back entirely, leaving exactly one
    take per chunk.
    """
    if attempt_limit < 1:
        raise ValueError("최소 한 번은 생성해야 합니다.")
    candidates: list[dict[str, Any]] = []
    evaluations: list[dict[str, Any]] = []
    recovery_parts = omission_recovery_parts(chunk.tts_text, initial_omissions or []) if synthesize_recovery else []
    for attempt in range(1, attempt_limit + 1):
        next_parts = omission_recovery_parts(chunk.tts_text, repeated_omissions(evaluations)) if synthesize_recovery else []
        # Once recovering, do not return to the input that already failed just
        # because a recovered take has a different pronunciation warning.
        parts = next_parts or recovery_parts
        recovery_parts = parts
        candidate = synthesize_recovery(chunk, attempt, parts) if parts else synthesize(chunk, attempt)
        candidates.append(candidate)
        if review is None:
            break
        evaluations.append(review(chunk, candidates[-1]))
        if parts:
            evaluations[-1]["recovery"] = {"strategy": COVERAGE_POLICY, "parts": parts}
        if evaluations[-1]["passed"]:
            break

    if review is None:
        best: dict[str, Any] = {"passed": True, "attempt": 1, "disabled": True}
        selected = candidates[0]
        severity = "ok"
    else:
        best = choose_best_candidate(evaluations)
        selected = next(
            candidate
            for candidate in candidates
            if int(candidate["attempt"]) == int(best["attempt"])
        )
        severity = chunk_severity(evaluations, best)

    first = chunk.entries[0]
    return {
        "candidates": candidates,
        "selected": selected,
        "severity": severity,
        "record": {
            "chunkKey": chunk.key,
            "chapter": first.chapter,
            "slideId": first.slide_id,
            "slideNumber": first.slide_number,
            "guarded": any(
                entry.source_text != entry.tts_text or entry.unresolved_tokens
                for entry in chunk.entries
            ),
            "unresolvedTokens": list(
                dict.fromkeys(
                    token for entry in chunk.entries for token in entry.unresolved_tokens
                )
            ),
            "candidates": evaluations,
            "selected": best,
            "severity": severity,
        },
    }


def synthesize_excerpt(
    source_project: Path,
    output_dir: Path,
    reference_path: Path,
    reference_text_path: Path,
    target_seconds: float,
    start_chapter: str,
    start_slide: str | None,
    seed: int,
    adapter_path: Path | None = None,
    adapter_scale: float = 1.0,
    start_page: int | None = None,
    end_page: int | None = None,
    model_key: str = "qwen3-tts",
    use_cache: bool = True,
    automatic_quality: bool = True,
    quality_attempts: int = MAX_AUTOMATIC_ATTEMPTS,
    recovery_findings_path: Path | None = None,
) -> None:
    """강의 대본 일부를 TTS로 합성하고 정렬된 manifest.json을 생성한다.

    흐름:
        1. 대본 → CourseEntry → CourseChunk 목록 생성
        2. 청크마다 생성 → 즉시 받아쓰기 → 깨끗하면 중단, 아니면 다음 시드
        3. 목표 길이(target_seconds)에 가장 가까운 청크 수 선택
        4. TTS·Whisper 해제 → ForcedAligner 로드 (Metal 메모리 재사용)
        5. 청크별 단어 정렬 (캐시 히트 시 재사용)
        6. 클립 조립 → 정규화 → 미리듣기 M4A 생성
        7. 스텝별 절대 타이밍 계산 → manifest.json 저장

    Metal 메모리 관리:
        생성기와 판독기는 함께 상주한다 (대략 TTS 11.6GB + Whisper 1.6GB).
        둘 다 끝난 뒤 del/gc.collect()/mx.clear_cache()로 해제해
        ForcedAligner 가 쓸 Metal 메모리를 확보한다.

    조기 종료:
        모든 청크를 검수하되 재시도는 실제로 문제가 있을 때만 한다. 첫 시드가
        깨끗하면 그 청크의 생성은 한 번으로 끝나므로, 검수를 켜도 정상적인
        레슨은 이전의 3배 생성보다 빨라진다.
    """
    import mlx.core as mx
    from mlx_audio.tts.utils import load_model as load_tts_model
    from mlx_audio.utils import get_model_path

    if end_page is None and target_seconds <= 0:
        raise ValueError("목표 길이는 0초보다 커야 합니다.")
    if not 1 <= quality_attempts <= 5:
        raise ValueError("자동 음성 후보 수는 1~5 사이여야 합니다.")
    recovery_findings = json.loads(recovery_findings_path.read_text(encoding="utf-8")) if recovery_findings_path else []
    if not isinstance(recovery_findings, list) or any(not isinstance(f, dict) for f in recovery_findings):
        raise ValueError("누락 복구 기록은 검수 항목 목록이어야 합니다.")

    page_count: int | None = None
    if start_page is not None:
        order = chapter_slide_order(source_project / "deck")
        page_count = len(order)
        if start_page < 1 or start_page > page_count:
            raise ValueError(f"시작 페이지는 1~{page_count} 사이여야 합니다.")
        if end_page is not None and (end_page < start_page or end_page > page_count):
            raise ValueError(f"끝 페이지는 {start_page}~{page_count} 사이여야 합니다.")
        start_chapter, start_slide = order[start_page - 1]
    elif end_page is not None:
        raise ValueError("끝 페이지를 사용하려면 시작 페이지도 지정해야 합니다.")

    if model_key not in MODEL_SPECS:
        raise ValueError(f"지원하지 않는 TTS 모델입니다: {model_key}")
    if adapter_path is not None and model_key != "qwen3-tts":
        raise ValueError("현재 LoRA 음성 어댑터는 Qwen3-TTS에서만 사용할 수 있습니다.")
    spec = MODEL_SPECS[model_key]
    # Qwen 강의 생성은 A/B 파일럿보다 안정적인 파라미터로 오버라이드한다.
    settings = (
        {**spec.settings, **COURSE_SETTING_OVERRIDES}
        if model_key == "qwen3-tts"
        else dict(spec.settings)
    )
    entries = course_entries(
        source_project,
        start_chapter,
        start_slide,
        end_slide_number=end_page,
    )
    report_naturalness_warnings(entries)
    report_unresolved_terms(entries)
    chunks = group_course_entries(entries)
    initial_pad_ms = START_PAD_MS + entries[0].pause_before_ms
    pronunciation = course_pronunciation_dictionary(source_project)
    reference_text = reference_text_path.read_text(encoding="utf-8").strip()
    reference_hash = sha256_file(reference_path)
    reference_text_hash = sha256_text(reference_text)
    adapter = adapter_identity(adapter_path, adapter_scale)

    # 출력 디렉터리 구조 생성
    output_dir.mkdir(parents=True, exist_ok=True)
    clips_dir = output_dir / "clips/native"       # 트리밍된 네이티브 클립 WAV
    alignments_dir = output_dir / "clips/alignment"  # 단어 정렬 JSON 캐시
    clips_dir.mkdir(parents=True, exist_ok=True)
    alignments_dir.mkdir(parents=True, exist_ok=True)

    # The independent reader is loaded before the generator and stays resident.
    # A take can then be judged the moment it exists, so a chunk that reads
    # correctly on the first seed costs one generation instead of three.
    quality_model = None
    quality_model_path: Path | None = None
    quality_revision: str | None = None
    quality_load_ms = 0
    quality_evaluation_ms = 0
    if automatic_quality:
        from mlx_audio.stt.utils import load_model as load_stt_model

        quality_model_path = (
            LOCAL_QUALITY_ASR_PATH
            if (LOCAL_QUALITY_ASR_PATH / "config.json").is_file()
            else resolve_model_path(ASR_REPOSITORY, get_model_path)
        )
        quality_revision = snapshot_revision(quality_model_path)
        started = time.perf_counter()
        quality_model = load_stt_model(quality_model_path)
        quality_load_ms = round((time.perf_counter() - started) * 1000)

    model_path = resolve_model_path(spec.repository, get_model_path)
    revision = snapshot_revision(model_path)
    load_started = time.perf_counter()
    training_wrapper = None
    if adapter_path is None:
        model = load_tts_model(model_path)
    else:
        from mlx_tune import FastTTSModel

        training_wrapper, _ = FastTTSModel.from_pretrained(
            model_name=str(model_path),
            max_seq_length=512,
        )
        training_wrapper = FastTTSModel.get_peft_model(
            training_wrapper,
            r=16,
            lora_alpha=16,
            lora_dropout=0.0,
            target_modules=[
                "q_proj", "k_proj", "v_proj", "o_proj",
                "gate_proj", "up_proj", "down_proj",
            ],
            random_state=seed,
        )
        training_wrapper.load_adapter(str(adapter_path))
        scaled_modules = apply_adapter_scale(training_wrapper.model, adapter_scale)
        if scaled_modules == 0:
            raise RuntimeError("강도를 조절할 LoRA 모듈을 찾지 못했습니다.")
        training_wrapper.model.eval()
        model = training_wrapper.full_model
    load_ms = round((time.perf_counter() - load_started) * 1000)

    voice_router = EnglishVoiceRouter(pronunciation, training_wrapper.model if training_wrapper else None) if model_key == "qwen3-tts" else None

    # 루프 전 초기화 (첫 번째 클립에서 샘플레이트가 결정된다)
    target_samples: int | None = None
    native_rate: int | None = None
    cursor_samples: int | None = None
    selected_chunks: list[dict[str, Any]] = []
    generation_ms = 0
    cache_hits = 0
    peak_memory_gb = 0.0

    def synthesize_candidate(chunk: CourseChunk, attempt: int, parts: list[str] | None = None) -> dict[str, Any]:
        """Generate or load one deterministic candidate for a course chunk."""
        nonlocal generation_ms, cache_hits, peak_memory_gb
        seed_basis = stable_digest(
            {
                "chunkKey": chunk.key,
                "ttsText": chunk.tts_text,
                "requestedSeed": seed,
                "attempt": attempt,
            }
        )
        candidate_seed = (
            seed ^ int(seed_basis[:8], 16) ^ ((attempt - 1) * 0x9E3779B1)
        ) & 0xFFFFFFFF
        cache_hash = stable_digest(
            {
                "schemaVersion": 9,
                "model": spec.repository,
                "modelRevision": revision,
                "settings": {"language": spec.language, **settings},
                "referenceSha256": reference_hash,
                "referenceTextSha256": reference_text_hash,
                "entryKeys": [entry.key for entry in chunk.entries],
                "ttsText": chunk.tts_text,
                "pauseBeforeMs": [entry.pause_before_ms for entry in chunk.entries],
                "seed": candidate_seed,
                "attempt": attempt,
                "adapter": adapter,
                "edgePadMs": EDGE_PAD_MS,
                "edgeFadeMs": EDGE_FADE_MS,
                "maxInternalSilenceMs": MAX_INTERNAL_SILENCE_MS,
                "targetInternalSilenceMs": TARGET_INTERNAL_SILENCE_MS,
                **({"recovery": {"policy": COVERAGE_POLICY, "parts": parts, "gapMs": STEP_GAP_MS}} if parts else {}),
                **({"voiceRouting": voice_router.identity(chunk.tts_text)} if voice_router and voice_router.identity(chunk.tts_text) else {}),
            }
        )
        clip_path = clips_dir / f"{chunk.key}--take-{attempt}--{cache_hash[:12]}.wav"
        clip_meta_path = clip_path.with_suffix(".json")
        if use_cache and clip_path.is_file():
            info = sf.info(clip_path)
            rate = int(info.samplerate)
            frames = int(info.frames)
            trim_info = {
                **UNTRIMMED_AUDIO_STATS,
                **(
                    json.loads(clip_meta_path.read_text(encoding="utf-8"))
                    if clip_meta_path.is_file()
                    else {}
                ),
            }
            cache_hits += 1
        else:
            mx.random.seed(candidate_seed)
            generation_args = {
                "text": chunk.tts_text,
                "ref_audio": str(reference_path),
                "lang_code": spec.language,
                "verbose": False,
                **settings,
            }
            if model_key == "qwen3-tts":
                generation_args["ref_text"] = reference_text
            if parts:
                print(f"[구절 누락 복구] {chunk.key}: 후보 {attempt}, 원문 그대로 {len(parts)}조각 합성", flush=True)
            generated = generate_candidate_audio(model.generate, generation_args, parts, voice_router=voice_router)
            generation_ms += generated["generationMs"]
            rate, audio, trim_info = generated["sampleRate"], generated["audio"], generated["cleanup"]
            sf.write(clip_path, audio, rate, subtype="PCM_24")
            write_json(clip_meta_path, trim_info)
            frames = len(audio)
            peak_memory_gb = max(peak_memory_gb, generated["peakMemoryGb"])
        return {
            "attempt": attempt,
            "hash": cache_hash,
            "seed": candidate_seed,
            "audioPath": str(clip_path.resolve()),
            "frames": frames,
            "sampleRate": rate,
            "durationMs": round(frames * 1000 / rate),
            **trim_info,
        }

    quality_records: list[dict[str, Any]] = []

    def read_once(audio_path: str, temperature: float, language: str = "ko") -> str:
        """Run the independent ASR over one file that fits in a single window."""
        result = quality_model.generate(
            audio_path,
            language=language,
            task="transcribe",
            temperature=temperature,
            return_timestamps=False,
            condition_on_previous_text=False,
            max_tokens=768,
        )
        return result.text

    def transcribe(audio_path: str, temperature: float, routing: dict | None = None) -> tuple[str, list]:
        """Read one clip back, never handing the ASR more than one window.

        A clip longer than the ASR window is read in pieces cut at interior
        silence and the readings are joined.  See ASR_WINDOW_SECONDS for the
        measurements behind this: reading a 31-second clip whole dropped a
        clause on every seed, which the severity rules then reported as a page
        the model consistently misreads.
        """
        nonlocal quality_evaluation_ms
        started = time.perf_counter()
        if routing:
            result = read_routed_transcript(Path(audio_path), routing, read_once, temperature)
            quality_evaluation_ms += round((time.perf_counter() - started) * 1000)
            return result
        samples, rate = sf.read(audio_path, dtype="float32", always_2d=True)
        mono = np.mean(samples, axis=1, dtype=np.float32)
        windows = asr_reading_windows(mono, rate)
        if len(windows) == 1:
            text = read_once(audio_path, temperature)
        else:
            readings: list[str] = []
            with tempfile.TemporaryDirectory(prefix="tts-asr-window-") as scratch:
                for index, (begin, end) in enumerate(windows):
                    window_path = Path(scratch) / f"window-{index}.wav"
                    sf.write(window_path, mono[begin:end], rate)
                    readings.append(read_once(str(window_path), temperature).strip())
            text = " ".join(reading for reading in readings if reading)
        quality_evaluation_ms += round((time.perf_counter() - started) * 1000)
        return text, []

    def evaluate(chunk: CourseChunk, candidate: dict[str, Any]) -> dict[str, Any]:
        """Judge one take, ruling out decoder noise before blaming the take.

        A first reading that finds nothing wrong is trusted. A reading that does
        find something gets a second, differently decoded opinion, and the clip
        keeps whichever reading is kinder — evidence only stands when it
        survives every attempt to read the audio.
        """
        nonlocal quality_evaluation_ms
        def read(temperature: float) -> dict[str, Any]:
            recognized, english_checks = transcribe(candidate["audioPath"], temperature, candidate.get("voiceRouting"))
            result = evaluate_candidate(
                expected_text=chunk.tts_text,
                recognized_text=recognized,
                audio_path=Path(candidate["audioPath"]),
                dictionary=pronunciation,
                required_pronunciations=chunk.required_pronunciations,
                attempt=int(candidate["attempt"]),
                seed=int(candidate["seed"]),
                speech_parts=candidate.get("voiceRouting", {}).get("segments"),
            )
            if english_checks:
                result["englishChecks"] = english_checks
                mismatches = sum(not item["passed"] for item in english_checks)
                if mismatches:
                    result["warnings"].append("영어 구절 받아쓰기 확인 필요")
                    result["passed"] = False
                    result["score"] += 10 * mismatches
            return result

        evaluation = read(0.0)
        if not evaluation["passed"]:
            evaluation = better_evaluation(evaluation, read(0.2))
        started = time.perf_counter()
        evaluation = review_candidate_prosody(
            evaluation,
            lambda path, temperature: read_routed_timings(quality_model, path, temperature, candidate["voiceRouting"]) if candidate.get("voiceRouting") else read_timed_words(quality_model, path, temperature),
            read_independent_word_times,
        )
        quality_evaluation_ms += round((time.perf_counter() - started) * 1000)
        evaluation["hash"] = candidate["hash"]
        return evaluation

    for index, chunk in enumerate(chunks):
        take = resolve_chunk_take(
            chunk,
            attempt_limit=quality_attempts if automatic_quality else 1,
            synthesize=synthesize_candidate,
            review=evaluate if automatic_quality else None,
            synthesize_recovery=synthesize_candidate if automatic_quality else None,
            initial_omissions=saved_omissions(chunk.tts_text, recovery_findings, pronunciation) if automatic_quality else [],
        )
        candidates = take["candidates"]
        selected = take["selected"]
        severity = take["severity"]
        guarded = take["record"]["guarded"]
        quality_records.append(take["record"])
        if automatic_quality:
            status = {"ok": "통과", "warning": "확인 권장", "failed": "재생성 필요"}[severity]
            print(
                f"[자동 음성 검수 {index + 1}/{len(chunks)}] "
                f"{chunk.key}: 후보 {take['record']['selected']['attempt']}"
                f"/{len(candidates)} {status}"
            )

        rate = int(selected["sampleRate"])
        frames = int(selected["frames"])

        # 첫 번째 클립에서 샘플레이트와 목표 샘플 수를 확정한다
        if native_rate is None:
            native_rate = rate
            target_samples = round(target_seconds * native_rate)
            cursor_samples = milliseconds_to_samples(initial_pad_ms, native_rate)
        if rate != native_rate:
            raise RuntimeError("캐시된 클립의 샘플레이트가 서로 다릅니다.")
        assert cursor_samples is not None and target_samples is not None

        # 현재 클립의 타임라인 위치 기록
        start_sample = cursor_samples
        end_sample = start_sample + frames
        selected_chunks.append(
            {
                "chunk": chunk,
                "key": chunk.key,
                "candidateOptions": candidates,
                "guarded": guarded,
                "severity": severity,
                "hash": selected["hash"],
                "seed": selected["seed"],
                "audioPath": selected["audioPath"],
                "frames": frames,
                "sampleRate": rate,
                "startSample": start_sample,
                "endSample": end_sample,
                "startMs": round(start_sample * 1000 / rate),
                "endMs": round(end_sample * 1000 / rate),
                "durationMs": round(frames * 1000 / rate),
                **({"voiceRouting": selected["voiceRouting"]} if selected.get("voiceRouting") else {}),
                **{
                    key: selected[key]
                    for key in (
                        "trimmedHeadMs",
                        "trimmedTailMs",
                        "shortenedSilenceCount",
                        "shortenedSilenceMs",
                    )
                },
            }
        )

        # 페이지 묶음 모드는 지정된 마지막 페이지의 마지막 스텝까지 전부 포함한다.
        if end_page is not None:
            if index + 1 == len(chunks):
                break
            following = chunks[index + 1]
            cursor_samples = end_sample + milliseconds_to_samples(
                chunk_gap_after(chunk, following), rate
            )
            continue

        # 30초/시간 기반 모드는 목표 길이에 가장 가까운 청크에서 끝낸다.
        # 강제 무음으로 나뉜 스텝은 뒷부분까지 포함해야 한 화면의 대본이 잘리지 않는다.
        last_entry = chunk.entries[-1]
        if last_entry.part_index + 1 < last_entry.part_count:
            if index + 1 >= len(chunks):
                raise RuntimeError(f"{last_entry.key}의 이어지는 음성 조각이 없습니다.")
            following = chunks[index + 1]
            cursor_samples = end_sample + milliseconds_to_samples(
                chunk_gap_after(chunk, following), rate
            )
            continue
        total_if_finished = end_sample + milliseconds_to_samples(END_PAD_MS, rate)
        if total_if_finished >= target_samples:
            # 현재 청크를 포함하는 것이 목표에 더 가까운지, 이전 청크까지가 더 가까운지 비교
            if len(selected_chunks) > 1:
                previous_end = int(selected_chunks[-2]["endSample"])
                without_current = previous_end + milliseconds_to_samples(END_PAD_MS, rate)
                if abs(without_current - target_samples) < abs(
                    total_if_finished - target_samples
                ):
                    selected_chunks.pop()
            break
        # 다음 청크 시작 위치: 현재 끝 + 적절한 갭
        if index + 1 >= len(chunks):
            # Running out of lecture before reaching the target length deserves
            # this sentence, not an IndexError one line short of it. The loop
            # otherwise always leaves through a break, so this is the only way
            # the target can go unmet.
            raise RuntimeError("강의 끝까지 생성해도 목표 길이에 도달하지 못했습니다.")
        following = chunks[index + 1]
        cursor_samples = end_sample + milliseconds_to_samples(
            chunk_gap_after(chunk, following), rate
        )

    # Generation and review are finished together, so both models can go before
    # forced alignment claims the Metal memory they were using.
    del voice_router
    del model
    if training_wrapper is not None:
        del training_wrapper
    if quality_model is not None:
        del quality_model
    gc.collect()
    mx.clear_cache()

    kept_chunk_keys = {item["key"] for item in selected_chunks}
    quality_records = [
        record for record in quality_records if record["chunkKey"] in kept_chunk_keys
    ]
    quality_result = quality_summary(quality_records)

    # Candidate selection can change duration. Rebuild every absolute clip position
    # before alignment, subtitles, and capture consume the timeline.
    cursor_samples = milliseconds_to_samples(initial_pad_ms, native_rate)
    for index, item in enumerate(selected_chunks):
        item["startSample"] = cursor_samples
        item["endSample"] = cursor_samples + int(item["frames"])
        item["startMs"] = round(item["startSample"] * 1000 / native_rate)
        item["endMs"] = round(item["endSample"] * 1000 / native_rate)
        item["durationMs"] = round(int(item["frames"]) * 1000 / native_rate)
        if index + 1 < len(selected_chunks):
            cursor_samples = item["endSample"] + milliseconds_to_samples(
                chunk_gap_after(item["chunk"], selected_chunks[index + 1]["chunk"]),
                native_rate,
            )

    # 정렬 캐시가 모두 있으면 aligner를 로드하지 않는다 (시간·메모리 절약)
    aligner_paths = [
        alignments_dir / f"{item['key']}--{item['hash'][:12]}.json"
        for item in selected_chunks
    ]
    missing_alignment = not use_cache or any(not path.is_file() for path in aligner_paths)
    aligner = None
    aligner_revision = None
    alignment_load_ms = 0
    alignment_ms = 0
    if missing_alignment:
        from mlx_audio.stt.utils import load_model as load_stt_model

        aligner_path = resolve_model_path(ALIGNER_REPOSITORY, get_model_path)
        aligner_revision = snapshot_revision(aligner_path)
        started = time.perf_counter()
        aligner = load_stt_model(aligner_path)
        alignment_load_ms = round((time.perf_counter() - started) * 1000)

    for item, alignment_path in zip(selected_chunks, aligner_paths):
        started = time.perf_counter()
        item["words"] = load_or_create_alignment(
            item["chunk"], item, aligner, alignment_path, use_cache=use_cache
        )
        alignment_ms += round((time.perf_counter() - started) * 1000)

    if aligner is not None:
        del aligner
        gc.collect()
        mx.clear_cache()
    # aligner를 로드하지 않은 경우(전체 캐시 히트)에도 revision 을 기록하기 위해 캐시를 확인
    if aligner_revision is None:
        cached_aligner = resolve_model_path(ALIGNER_REPOSITORY, get_model_path)
        aligner_revision = snapshot_revision(cached_aligner)

    # ─── 최종 트랙 조립 ───────────────────────────────────────────────────────
    # 오프닝 무음 → 클립1 → 갭 → 클립2 → 갭 → ... → 엔딩 무음
    assert native_rate is not None
    pieces: list[np.ndarray] = [
        np.zeros(milliseconds_to_samples(initial_pad_ms, native_rate), dtype=np.float32)
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
    # 청크 내 상대 타이밍(ms) → 트랙 전체 절대 타이밍으로 변환한다.
    step_records: list[dict[str, Any]] = []
    for item in selected_chunks:
        chunk: CourseChunk = item["chunk"]
        slices = entry_alignment_slices(chunk, item["words"])
        for entry, words in zip(chunk.entries, slices):
            if not words:
                raise RuntimeError(f"{entry.key}에 정렬된 단어가 없습니다.")
            # 청크 시작 시점을 더해 절대 시간으로 변환
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

    step_records = merge_step_record_parts(step_records)

    # ─── 스텝별 화면 전환 타이밍 계산 ────────────────────────────────────────
    # transitionAtMs: 다음 스텝 발화 시작 직전에 화면을 전환해 시각적 리듬을 맞춘다.
    total_ms = int(final_probe["durationMs"])
    for index, record in enumerate(step_records):
        # 이 스텝의 화면이 활성화되는 시점 (이전 스텝의 전환 시점)
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
            # 같은 슬라이드면 짧은 리드, 슬라이드 전환이면 긴 리드
            visual_lead = STEP_VISUAL_LEAD_MS if same_slide else SLIDE_VISUAL_LEAD_MS
            # 현재 발화가 끝난 시점과 다음 발화 직전 중 더 늦은 시점을 전환점으로 사용
            transition = max(int(record["speechEndMs"]), next_speech - visual_lead)
        else:
            # 마지막 스텝은 트랙 끝까지
            transition = total_ms
        record["startMs"] = visual_start
        record["endMs"] = transition
        record["transitionAtMs"] = transition
        record["durationMs"] = transition - visual_start

    # ─── manifest.json 생성 ──────────────────────────────────────────────────
    quality_by_chunk = {item["chunkKey"]: item for item in quality_records}
    selected_entries = [entry for item in selected_chunks for entry in item["chunk"].entries]
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
            "selectedAttempt": quality_by_chunk[item["key"]]["selected"].get("attempt", 1),
            "qualityPassed": quality_by_chunk[item["key"]]["selected"].get("passed", True),
            "qualitySeverity": quality_by_chunk[item["key"]].get("severity", "ok"),
            **({"voiceRouting": item["voiceRouting"]} if item.get("voiceRouting") else {}),
        }
        for item in selected_chunks
    ]

    metadata = {
        "schemaVersion": 9,
        "cachePolicy": "enabled" if use_cache else "disabled",
        "title": (
            f"강의 {start_page}~{end_page}페이지 {model_key} 묶음"
            if end_page is not None
            else f"강의 시작 {target_seconds / 60:g}분 {model_key} 파일럿"
        ),
        "model": spec.repository,
        "modelRevision": revision,
        "modelLicense": spec.license,
        "adapter": adapter,
        "aligner": {
            "model": ALIGNER_REPOSITORY,
            "revision": aligner_revision,
            "license": "Apache-2.0",
        },
        "pronunciation": {
            "dictionaryEntries": len(pronunciation),
            "changedEntries": sum(item.source_text != item.tts_text for item in selected_entries),
            "unresolved": [
                {
                    "chapter": item.chapter,
                    "slideId": item.slide_id,
                    "slideNumber": item.slide_number,
                    "step": item.step,
                    "tokens": list(item.unresolved_tokens),
                }
                for item in selected_entries
                if item.unresolved_tokens
            ],
        },
        "naturalness": {
            "policy": "ko-counter-v1",
            "changedEntries": sum(bool(item.naturalness_checks) for item in selected_entries),
            "checks": [
                {
                    "chapter": item.chapter,
                    "slideId": item.slide_id,
                    "slideNumber": item.slide_number,
                    "step": item.step,
                    "changes": list(item.naturalness_checks),
                }
                for item in selected_entries
                if item.naturalness_checks
            ],
            "warnings": [
                {
                    "chapter": item.chapter,
                    "slideId": item.slide_id,
                    "slideNumber": item.slide_number,
                    "step": item.step,
                    "messages": list(item.naturalness_warnings),
                }
                for item in selected_entries
                if item.naturalness_warnings
            ],
        },
        "quality": {
            "enabled": automatic_quality,
            "model": ASR_REPOSITORY if automatic_quality else None,
            "revision": quality_revision,
            "license": ASR_LICENSE if automatic_quality else None,
            "maxAttempts": quality_attempts if automatic_quality else 1,
            "secondOpinion": automatic_quality,
            "coverageGate": {"enabled": automatic_quality, "policy": COVERAGE_POLICY,
                             "recoveryAfterRepeatedOmissions": 2, "sharesAttemptLimit": True},
            "prosodyGate": {
                "enabled": automatic_quality,
                "policy": PROSODY_POLICY,
                "minimumPauseMs": MIN_INTERNAL_PAUSE_MS,
                "wordEdgeGuardMs": WORD_EDGE_GUARD_MS,
                "secondOpinion": True,
                "confirmationModel": ALIGNER_REPOSITORY,
            },
            "restartGate": {"enabled": automatic_quality, "policy": RESTART_POLICY},
            "lexicalGate": {
                "enabled": automatic_quality,
                "minimumKeyLength": MIN_LEXICAL_KEY_LENGTH,
                "warningDistance": LEXICAL_WARNING_DISTANCE,
                "failureDistance": LEXICAL_FAILURE_DISTANCE,
            },
            "summary": quality_result,
            "chunks": quality_records,
        },
        "seed": seed,
        "settings": {"language": spec.language, **settings},
        "sourceProject": str(source_project.resolve()),
        "sourceContract": (
            json.loads((source_project / "production-input.json").read_text(encoding="utf-8"))["sourceContract"]
            if (source_project / "production-input.json").is_file() else None
        ),
        "start": {"chapter": start_chapter, "slide": start_slide},
        "targetSeconds": target_seconds,
        "pageRange": {
            "start": start_page,
            "end": end_page,
            "totalPages": page_count,
            "mode": "bundle" if end_page is not None else "preview",
        },
        "reference": {
            "path": str(reference_path.resolve()),
            "sha256": reference_hash,
            "transcriptPath": str(reference_text_path.resolve()),
            "transcriptSha256": reference_text_hash,
        },
        "timing": {
            "startPadMs": START_PAD_MS,
            "initialPauseMs": entries[0].pause_before_ms,
            "stepGapMs": STEP_GAP_MS,
            "slideGapMs": SLIDE_GAP_MS,
            "endPadMs": END_PAD_MS,
            "edgePadMs": EDGE_PAD_MS,
            "edgeFadeMs": EDGE_FADE_MS,
            "maxInternalSilenceMs": MAX_INTERNAL_SILENCE_MS,
            "targetInternalSilenceMs": TARGET_INTERNAL_SILENCE_MS,
            "stepVisualLeadMs": STEP_VISUAL_LEAD_MS,
            "slideVisualLeadMs": SLIDE_VISUAL_LEAD_MS,
            "forcedPauseMinMs": MIN_FORCED_PAUSE_MS,
            "forcedPauseMaxMs": MAX_FORCED_PAUSE_MS,
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
            "generatedCandidates": sum(len(item["candidateOptions"]) for item in selected_chunks),
            "characters": sum(len(item["source_text"]) for item in step_records),
            "cacheHits": cache_hits,
        },
        "performance": {
            "modelLoadMs": load_ms,
            "generationMs": generation_ms,
            "qualityLoadMs": quality_load_ms,
            "qualityEvaluationMs": quality_evaluation_ms,
            "alignmentLoadMs": alignment_load_ms,
            "alignmentMs": alignment_ms,
            "peakMetalMemoryGb": round(peak_memory_gb, 3),
            "peakProcessMetalMemoryGb": metal_peak_memory_gb(mx),
            "residentReviewer": automatic_quality,
        },
        "normalization": normalization,
        "audioPath": str(final_track.resolve()),
        "previewPath": str(preview.resolve()),
        **final_probe,
        "chunks": chunk_manifest,
        **({"voiceRouting": {"policy": "english-speaker-only-v1", "englishAdapter": None,
              "englishReferenceMode": "speaker-only", "accentEnforced": False,
              "changedChunks": sum(bool(item.get("voiceRouting")) for item in chunk_manifest)}}
           if any(item.get("voiceRouting") for item in chunk_manifest) else {}),
        "entries": step_records,
        "software": {
            "python": platform.python_version(),
            "mlxAudio": version("mlx-audio"),
            "mlx": version("mlx"),
        },
    }
    write_json(output_dir / "manifest.json", metadata)
    if automatic_quality:
        review_pages = ", ".join(
            f"{page['slideNumber']}페이지" for page in quality_result["needsReview"]
        )
        listen_pages = ", ".join(
            f"{page['slideNumber']}페이지" for page in quality_result["listenSuggested"]
        )
        print(
            f"[자동 음성 검수] {quality_result['passedChunks']}/{quality_result['totalChunks']} 통과"
            + (f" · 재생성 권장 {review_pages}" if review_pages else "")
            + (f" · 확인 권장 {listen_pages}" if listen_pages else "")
        )
    # 터미널에는 핵심 통계만 출력한다 (전체 manifest는 파일 참조)
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


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source-project", type=Path, default=DEFAULT_SOURCE_PROJECT,
                        help="udemy-agent 저장소 루트 경로")
    parser.add_argument("--output-dir", type=Path, required=True,
                        help="결과물을 저장할 디렉터리 (없으면 자동 생성)")
    parser.add_argument("--reference", type=Path, required=True,
                        help="음성 복제에 사용할 참조 WAV 파일")
    parser.add_argument("--reference-text", type=Path, required=True,
                        help="참조 음성의 전사문 텍스트 파일")
    parser.add_argument("--target-seconds", type=float, default=300.0,
                        help="생성할 오디오 목표 길이 (초, 기본 300 = 5분)")
    parser.add_argument("--start-chapter", default="ch00",
                        help="생성 시작 챕터 (예: ch00)")
    parser.add_argument("--start-slide",
                        help="생성 시작 슬라이드 ID (생략하면 챕터 첫 슬라이드)")
    parser.add_argument("--start-page", type=int,
                        help="전체 강의 기준 1-based 시작 페이지 (chapter/slide보다 우선)")
    parser.add_argument("--end-page", type=int,
                        help="묶음 제작의 1-based 끝 페이지 (해당 페이지 마지막 스텝 포함)")
    parser.add_argument("--seed", type=int, default=DEFAULT_SEED,
                        help=f"MLX 난수 시드 (기본값: {DEFAULT_SEED})")
    parser.add_argument("--model", choices=sorted(MODEL_SPECS), default="qwen3-tts",
                        help="로컬 TTS 모델 (기본값: qwen3-tts)")
    parser.add_argument("--adapter", type=Path,
                        help="MLX-Tune LoRA 어댑터 디렉터리")
    parser.add_argument("--adapter-scale", type=float, default=1.0,
                        help="LoRA 적용 강도 (0보다 크고 1 이하, 기본 1.0)")
    parser.add_argument("--no-cache", action="store_true",
                        help="기존 TTS 클립과 정렬 결과를 읽지 않고 모두 새로 생성")
    parser.add_argument("--no-auto-quality", action="store_true",
                        help="독립 Whisper 받아쓰기와 재시도를 끄고 시드 하나로만 생성")
    parser.add_argument("--quality-attempts", type=int, default=MAX_AUTOMATIC_ATTEMPTS,
                        help=f"검수를 통과하지 못한 청크의 최대 시도 수 (1~5, 기본 {MAX_AUTOMATIC_ATTEMPTS})")
    parser.add_argument("--recovery-findings", type=Path,
                        help="기존 누락 검수 기록. 현재 발음문과 정확히 같은 청크만 첫 후보부터 나눠 합성")
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
        adapter_path=args.adapter,
        adapter_scale=args.adapter_scale,
        start_page=args.start_page,
        end_page=args.end_page,
        model_key=args.model,
        use_cache=not args.no_cache,
        automatic_quality=not args.no_auto_quality,
        quality_attempts=args.quality_attempts,
        recovery_findings_path=args.recovery_findings,
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
