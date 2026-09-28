"""Generate an uncached, pronunciation-aware text voice in short spoken chunks.

The source text remains the caption/source record.  Each chunk has its own
pronunciation text, candidate seeds and (when requested) independent review.
"""

from __future__ import annotations

import argparse
import gc
import json
import sys
import tempfile
import time
from pathlib import Path
from typing import Any, Callable

import numpy as np
import soundfile as sf

from .course.settings import ALIGNER_REPOSITORY, LOCAL_QUALITY_ASR_PATH, STEP_GAP_MS
from .course.serialization import stable_digest
from .course.final_track import inspect_final_track
from .course.candidates import CandidateAudioError as CourseCandidateAudioError
from .course_pilot import (
    COURSE_SETTING_OVERRIDES,
    adapter_identity,
    apply_adapter_scale,
    apply_pronunciation,
    closure_refiner,
    generate_candidate_audio,
    production_pronunciation,
    write_json,
)
from .english_voice import EnglishVoiceRouter, read_routed_timings, read_routed_transcript
from .pilot import (
    MODEL_SPECS,
    normalize_audio,
    probe_audio,
    resolve_model_path,
    sha256_file,
    sha256_text,
    snapshot_revision,
)
from .korean_naturalness import NATIVE_COUNTER_PATTERN
from .pronunciation import (
    COUNTED_NUMBER_PATTERN,
    FRACTION_NUMBER_PATTERN,
    PARAMETER_SIZE_PATTERN,
    QWEN_MODEL_PATTERN,
    _dictionary_pattern,
    apply_pronunciation,
    is_english_sentence,
    pronunciation_preflight,
)
from .speech_quality import (
    ASR_REPOSITORY,
    MAX_AUTOMATIC_ATTEMPTS,
    apply_english_checks,
    asr_reading_windows,
    choose_best_candidate,
    chunk_severity,
    evaluate_candidate,
    read_timed_words,
    review_candidate_prosody,
    review_transcriptions,
)


MAX_TEXT_CHARS = 20_000
TARGET_CHUNK_CHARS = 220
MAX_CHUNK_CHARS = 300
MAX_UNBROKEN_CHARS = 800
_QUOTE_PAIRS = {'"': '"', "“": "”", "‘": "’", "「": "」", "『": "』"}
_SENTENCE_END = frozenset(".!?。！？")
_CLOSING_QUOTE = frozenset('"”’」』')
_CLAUSE_END = frozenset(",;:，；：、")


class CandidateAudioError(RuntimeError):
    """One seed returned unusable audio; another seed may still be valid."""


def load_text(path: Path) -> tuple[str, str]:
    """Return display text and its whole-input pronunciation reference."""
    source = "\n".join(
        normalized
        for line in path.read_text(encoding="utf-8").splitlines()
        if (normalized := " ".join(line.split()).strip())
    ).strip()
    if not source or not any(character.isalnum() for character in source):
        raise ValueError("합성할 텍스트를 입력해 주세요.")
    if len(source) > MAX_TEXT_CHARS:
        raise ValueError(f"한 번에 입력할 수 있는 텍스트는 {MAX_TEXT_CHARS:,}자까지입니다.")
    return source, apply_pronunciation(source, production_pronunciation())


def _protected_characters(text: str, dictionary: list[dict[str, Any]]) -> list[bool]:
    """Keep spans whose reading depends on text across a space together."""
    protected = [False] * len(text)
    index = 0
    while index < len(text):
        closing = _QUOTE_PAIRS.get(text[index])
        if closing is None:
            index += 1
            continue
        end = text.find(closing, index + 1)
        end = len(text) if end < 0 else end + 1
        protected[index:end] = [True] * (end - index)
        index = end
    for item in dictionary:
        if len(str(item.get("from", "")).split()) < 2:
            continue
        for match in _dictionary_pattern(item).finditer(text):
            protected[match.start():match.end()] = [True] * (match.end() - match.start())
    # The pronunciation layer reads these as one unit even when source words
    # have spaces ("1 개" -> "한 개", "1 분의 2" -> "일분의 이").
    # Splitting at such a space would make the chunk ASR validate the wrong
    # pronunciation, so protect exactly the patterns used by that layer.
    for pattern in (NATIVE_COUNTER_PATTERN, QWEN_MODEL_PATTERN,
                    PARAMETER_SIZE_PATTERN, FRACTION_NUMBER_PATTERN,
                    COUNTED_NUMBER_PATTERN):
        for match in pattern.finditer(text):
            protected[match.start():match.end()] = [True] * (match.end() - match.start())
    return protected


def _split_at_punctuation(text: str, dictionary: list[dict[str, Any]], *, clauses: bool) -> list[str]:
    protected = _protected_characters(text, dictionary)
    boundaries = []
    for index, character in enumerate(text):
        if character == "\n" and not protected[index]:
            boundaries.append(index + 1)
            continue
        if index + 1 < len(text) and not text[index + 1].isspace():
            continue
        if clauses:
            if character in _CLAUSE_END and not protected[index]:
                boundaries.append(index + 1)
        elif (character in _SENTENCE_END and not protected[index]) or (
            character in _CLOSING_QUOTE and index > 0
            and text[index - 1] in _SENTENCE_END
            and protected[index]
        ):
            boundaries.append(index + 1)
    result = []
    start = 0
    for end in [*boundaries, len(text)]:
        part = text[start:end].strip()
        if part:
            result.append(part)
        start = end
    return result


def _split_long_unit(text: str, dictionary: list[dict[str, Any]]) -> list[str]:
    if len(text) <= MAX_CHUNK_CHARS:
        return [text]
    clauses = _split_at_punctuation(text, dictionary, clauses=True)
    if len(clauses) > 1:
        return [part for clause in clauses for part in _split_long_unit(clause, dictionary)]

    result = []
    remaining = text
    while len(remaining) > MAX_CHUNK_CHARS:
        protected = _protected_characters(remaining, dictionary)
        boundaries = [index + 1 for index, character in enumerate(remaining)
                      if character.isspace() and not protected[index]]
        nearby = [end for end in boundaries if 60 <= end <= MAX_CHUNK_CHARS]
        if nearby:
            end = min(nearby, key=lambda value: (abs(value - TARGET_CHUNK_CHARS), -value))
        elif boundaries and boundaries[0] <= MAX_UNBROKEN_CHARS:
            # One quoted passage or identifier is better left whole than cut
            # blindly in the middle.  A very large indivisible span is an
            # explicit input problem rather than silently corrupted speech.
            end = boundaries[0]
        elif len(remaining) <= MAX_UNBROKEN_CHARS:
            break
        else:
            raise ValueError("긴 인용문·식별자에 나눌 경계가 없습니다. 문장 경계를 추가해 주세요.")
        result.append(remaining[:end].strip())
        remaining = remaining[end:].strip()
    if remaining:
        result.append(remaining)
    return result


def plan_text_chunks(source_text: str, dictionary: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Split only at speech-safe boundaries, then derive each pronunciation."""
    units = [part for sentence in _split_at_punctuation(source_text, dictionary, clauses=False)
             for part in _split_long_unit(sentence, dictionary)]
    if not units:
        raise ValueError("읽을 문장이 없습니다.")
    groups: list[list[str]] = []
    current: list[str] = []
    for unit in units:
        combined = " ".join([*current, unit])
        if current and len(combined) > TARGET_CHUNK_CHARS and (
            len(" ".join(current)) >= 80 or len(combined) > MAX_CHUNK_CHARS
        ):
            groups.append(current)
            current = []
        current.append(unit)
    if current:
        groups.append(current)
    chunks = []
    whole_english = is_english_sentence(source_text)
    for group in groups:
        source = " ".join(group)
        if whole_english:
            # The pronunciation layer protects an entire English passage from
            # Korean dictionary replacements. A short trailing chunk such as
            # "Tool." is still English even though it has fewer than the three
            # words needed to identify a standalone English passage.
            chunks.append({
                "sourceText": source, "ttsText": source, "changed": False,
                "dictionaryMatches": [], "naturalnessChecks": [],
                "naturalnessWarnings": [], "normalizedNumbers": [],
                "requiredPronunciations": [], "unresolvedAscii": [],
                "unresolvedNumbers": [],
            })
        else:
            chunks.append(pronunciation_preflight(source, dictionary))
    if " ".join(" ".join(chunk["sourceText"] for chunk in chunks).split()) != " ".join(source_text.split()):
        raise RuntimeError("청크 분할 중 읽을 텍스트가 달라졌습니다.")
    expected_reading = " ".join(apply_pronunciation(source_text, dictionary).split())
    actual_reading = " ".join(" ".join(chunk["ttsText"] for chunk in chunks).split())
    if actual_reading != expected_reading:
        raise RuntimeError("청크 분할 중 발음문이 달라졌습니다. 문장 경계를 추가해 주세요.")
    return chunks


def candidate_seed(requested_seed: int, chunk_index: int, text: str, attempt: int) -> int:
    """Stable per-chunk, per-attempt seed independent of process hash state."""
    basis = stable_digest({"requestedSeed": requested_seed, "chunkIndex": chunk_index,
                           "ttsText": text, "attempt": attempt})
    return (requested_seed ^ int(basis[:8], 16) ^ ((attempt - 1) * 0x9E3779B1)) & 0xFFFFFFFF


def validate_candidate_audio(generated: dict[str, Any]) -> tuple[int, np.ndarray]:
    """Reject seed-local empty, corrupt or silent output before writing a WAV."""
    try:
        rate = int(generated["sampleRate"])
        audio = np.asarray(generated["audio"], dtype=np.float32).reshape(-1)
    except (KeyError, TypeError, ValueError) as error:
        raise CandidateAudioError("생성된 오디오 형식이 올바르지 않습니다.") from error
    if rate <= 0 or not len(audio):
        raise CandidateAudioError("오디오가 비어 있습니다.")
    if not np.all(np.isfinite(audio)):
        raise CandidateAudioError("유효하지 않은 오디오 샘플이 있습니다.")
    if len(audio) / rate < 0.08 or float(np.sqrt(np.mean(audio ** 2))) < 0.001:
        raise CandidateAudioError("음성 신호가 충분하지 않습니다.")
    return rate, audio


def resolve_text_chunk_take(
    chunk: dict[str, Any],
    index: int,
    requested_seed: int,
    attempt_limit: int,
    synthesize: Callable[[dict[str, Any], int, int], dict[str, Any]],
    review: Callable[[dict[str, Any], dict[str, Any]], dict[str, Any]] | None = None,
) -> dict[str, Any]:
    """Spend retries on defects or failed independent review, keeping evidence."""
    if not 1 <= attempt_limit <= 5:
        raise ValueError("음성 후보 시도 수는 1~5 사이여야 합니다.")
    attempts: list[dict[str, Any]] = []
    valid: list[dict[str, Any]] = []
    evaluations: list[dict[str, Any]] = []
    for attempt in range(1, attempt_limit + 1):
        seed = candidate_seed(requested_seed, index, chunk["ttsText"], attempt)
        try:
            candidate = {**synthesize(chunk, attempt, seed), "attempt": attempt, "seed": seed}
        except CandidateAudioError as error:
            attempts.append({"attempt": attempt, "seed": seed, "status": "generation-failed",
                             "reason": str(error)})
            continue
        valid.append(candidate)
        evaluation = review(chunk, candidate) if review is not None else None
        if evaluation is not None:
            evaluations.append(evaluation)
        attempts.append({**candidate, "status": "generated", "quality": evaluation})
        if evaluation is None or evaluation["passed"]:
            break
    if not valid:
        raise RuntimeError(f"텍스트 청크 {index + 1}의 모든 후보가 오디오 생성에 실패했습니다.")
    if review is None:
        selected = valid[0]
        severity = "not-checked"
        selected_quality = None
    else:
        selected_quality = choose_best_candidate(evaluations)
        selected = next(value for value in valid if value["attempt"] == selected_quality["attempt"])
        severity = chunk_severity(evaluations, selected_quality)
    return {"attempts": attempts, "selected": selected, "quality": selected_quality,
            "severity": severity}


def _installed_model_path(repository: str, *, preferred: Path | None = None) -> Path:
    """Use already installed quality weights, never trigger a download here."""
    if preferred is not None and (preferred / "config.json").is_file():
        return preferred

    def unavailable(_: str) -> Path:
        raise FileNotFoundError(f"독립 음성 검수 모델이 로컬에 없습니다: {repository}")

    path = resolve_model_path(repository, unavailable)
    if not (path / "config.json").is_file():
        raise FileNotFoundError(f"독립 음성 검수 모델의 로컬 설정 파일이 없습니다: {path}")
    return path


def _read_local_independent_word_times(audio_path: Path, text: str,
                                       aligner_path: Path) -> list[dict[str, Any]]:
    """Load the independently cached aligner by exact path, never by repo ID."""
    import mlx.core as mx
    from mlx_audio.stt.utils import load_model

    aligner = load_model(aligner_path)
    try:
        result = aligner.generate(audio=str(audio_path), text=text, language="English")
        return [{"text": item.text, "startMs": round(item.start_time * 1000),
                 "endMs": round(item.end_time * 1000)} for item in result.items]
    finally:
        del aligner
        gc.collect()
        mx.clear_cache()


def _make_quality_reviewer(model: Any, dictionary: list[dict[str, Any]],
                           aligner_path: Path | None) -> Callable[[dict[str, Any], dict[str, Any]], dict[str, Any]]:
    def read_once(audio_path: str, temperature: float, language: str = "ko") -> str:
        return model.generate(audio_path, language=language, task="transcribe",
                              temperature=temperature, return_timestamps=False,
                              condition_on_previous_text=False, max_tokens=768).text

    def transcribe(audio_path: Path, temperature: float,
                   routing: dict[str, Any] | None) -> tuple[str, list[dict[str, Any]]]:
        if routing:
            return read_routed_transcript(audio_path, routing, read_once, temperature)
        samples, rate = sf.read(audio_path, dtype="float32", always_2d=True)
        mono = np.mean(samples, axis=1, dtype=np.float32)
        windows = asr_reading_windows(mono, rate)
        if len(windows) == 1:
            return read_once(str(audio_path), temperature), []
        readings = []
        with tempfile.TemporaryDirectory(prefix="tts-text-asr-") as scratch:
            for index, (begin, end) in enumerate(windows):
                path = Path(scratch) / f"window-{index}.wav"
                sf.write(path, mono[begin:end], rate)
                readings.append(read_once(str(path), temperature).strip())
        return " ".join(value for value in readings if value), []

    def review(chunk: dict[str, Any], candidate: dict[str, Any]) -> dict[str, Any]:
        audio_path = Path(candidate["audioPath"])
        routing = candidate.get("voiceRouting")

        def read(temperature: float) -> dict[str, Any]:
            recognized, english_checks = transcribe(audio_path, temperature, routing)
            result = evaluate_candidate(
                expected_text=chunk["ttsText"], recognized_text=recognized,
                audio_path=audio_path, dictionary=dictionary,
                required_pronunciations=chunk["requiredPronunciations"],
                attempt=candidate["attempt"], seed=candidate["seed"],
                speech_parts=routing.get("segments") if routing else None,
            )
            return apply_english_checks(result, english_checks)

        evaluation = review_transcriptions(read)
        return review_candidate_prosody(
            evaluation,
            lambda path, temperature: (
                read_routed_timings(model, path, temperature, routing) if routing
                else read_timed_words(model, path, temperature)
            ),
            (lambda path, text: _read_local_independent_word_times(path, text, aligner_path))
            if aligner_path is not None else None,
            dictionary=dictionary,
        )

    return review


def generate_candidate(
    *,
    model_key: str,
    text_path: Path,
    reference_path: Path,
    reference_text_path: Path,
    output_path: Path,
    metadata_path: Path,
    seed: int,
    adapter_path: Path | None = None,
    adapter_scale: float = 1.0,
    quality_review: bool = False,
    quality_attempts: int = MAX_AUTOMATIC_ATTEMPTS,
) -> dict[str, Any]:
    """Generate fresh chunks and optionally judge each by independent reading."""
    import mlx.core as mx
    from mlx_audio.tts.utils import load_model as load_tts_model
    from mlx_audio.utils import get_model_path

    if model_key not in MODEL_SPECS:
        raise ValueError(f"지원하지 않는 TTS 모델입니다: {model_key}")
    if adapter_path is not None and model_key != "qwen3-tts":
        raise ValueError("음성 어댑터는 Qwen3-TTS에서만 사용할 수 있습니다.")
    if not 1 <= quality_attempts <= 5:
        raise ValueError("자동 음성 후보 수는 1~5 사이여야 합니다.")

    source_text, _ = load_text(text_path)
    dictionary = production_pronunciation()
    chunks = plan_text_chunks(source_text, dictionary)
    tts_text = " ".join(chunk["ttsText"] for chunk in chunks)
    reference_text = reference_text_path.read_text(encoding="utf-8").strip()
    if not reference_text:
        raise ValueError("참조 음성 전사문이 비어 있습니다.")

    spec = MODEL_SPECS[model_key]
    settings = ({**spec.settings, **COURSE_SETTING_OVERRIDES}
                if model_key == "qwen3-tts" else dict(spec.settings))
    adapter = adapter_identity(adapter_path, adapter_scale)

    quality_model = None
    quality_model_path = None
    quality_revision = None
    quality_load_ms = 0
    quality_evaluation_ms = 0
    aligner_path = None
    try:
        aligner_path = _installed_model_path(ALIGNER_REPOSITORY)
    except FileNotFoundError:
        pass
    if quality_review:
        from mlx_audio.stt.utils import load_model as load_stt_model

        quality_model_path = _installed_model_path(ASR_REPOSITORY, preferred=LOCAL_QUALITY_ASR_PATH)
        quality_revision = snapshot_revision(quality_model_path)
        started = time.perf_counter()
        quality_model = load_stt_model(quality_model_path)
        quality_load_ms = round((time.perf_counter() - started) * 1000)

    model_path = resolve_model_path(spec.repository, get_model_path)
    revision = snapshot_revision(model_path)
    mx.random.seed(seed)
    mx.reset_peak_memory()
    load_started = time.perf_counter()
    training_wrapper = None
    if adapter_path is None:
        model = load_tts_model(model_path)
    else:
        from mlx_tune import FastTTSModel

        training_wrapper, _ = FastTTSModel.from_pretrained(
            model_name=str(model_path), max_seq_length=512,
        )
        training_wrapper = FastTTSModel.get_peft_model(
            training_wrapper, r=16, lora_alpha=16, lora_dropout=0.0,
            target_modules=["q_proj", "k_proj", "v_proj", "o_proj",
                            "gate_proj", "up_proj", "down_proj"],
            random_state=seed,
        )
        training_wrapper.load_adapter(str(adapter_path))
        if apply_adapter_scale(training_wrapper.model, adapter_scale) == 0:
            raise RuntimeError("강도를 조절할 LoRA 모듈을 찾지 못했습니다.")
        training_wrapper.model.eval()
        model = training_wrapper.full_model
    load_ms = round((time.perf_counter() - load_started) * 1000)

    router = (EnglishVoiceRouter(dictionary, training_wrapper.model if training_wrapper else None)
              if model_key == "qwen3-tts" else None)
    reviewer = (_make_quality_reviewer(quality_model, dictionary, aligner_path)
                if quality_model is not None else None)
    refine_closures = (closure_refiner(reference_path, lambda path, text: _read_local_independent_word_times(
        path, text, aligner_path)) if aligner_path is not None else None)
    chunk_dir = output_path.with_name(f"{output_path.stem}-chunks")
    chunk_dir.mkdir(parents=True, exist_ok=True)
    generation_ms = 0
    peak_memory_gb = 0.0
    selected_chunks = []
    final_track_chunks = []
    sample_rate = None
    cursor = 0
    pieces: list[np.ndarray] = []
    route_segments: list[dict[str, Any]] = []
    route_identity = None

    for index, chunk in enumerate(chunks):
        def synthesize(value: dict[str, Any], attempt: int, candidate_seed_value: int) -> dict[str, Any]:
            nonlocal generation_ms, peak_memory_gb
            mx.random.seed(candidate_seed_value)
            arguments: dict[str, Any] = {
                "text": value["ttsText"], "ref_audio": str(reference_path),
                "lang_code": spec.language, "verbose": False, **settings,
            }
            if model_key == "qwen3-tts":
                arguments["ref_text"] = reference_text
            started = time.perf_counter()
            try:
                generated = generate_candidate_audio(model.generate, arguments, voice_router=router,
                                                     refine=refine_closures)
            except CourseCandidateAudioError as error:
                raise CandidateAudioError(str(error)) from error
            finally:
                generation_ms += round((time.perf_counter() - started) * 1000)
            rate, audio = validate_candidate_audio(generated)
            path = chunk_dir / f"chunk-{index + 1:04d}-take-{attempt:02d}.wav"
            sf.write(path, audio, rate, subtype="PCM_24")
            peak_memory_gb = max(peak_memory_gb, generated["peakMemoryGb"])
            return {"audioPath": str(path.resolve()), "frames": len(audio),
                    "sampleRate": rate, "durationMs": round(len(audio) * 1000 / rate),
                    "cleanup": generated["cleanup"],
                    "voiceRouting": generated["cleanup"].get("voiceRouting")}

        def review(value: dict[str, Any], candidate: dict[str, Any]) -> dict[str, Any]:
            nonlocal quality_evaluation_ms
            started = time.perf_counter()
            result = reviewer(value, candidate)  # type: ignore[misc]
            quality_evaluation_ms += round((time.perf_counter() - started) * 1000)
            return result

        take = resolve_text_chunk_take(chunk, index, seed, quality_attempts,
                                       synthesize, review if reviewer else None)
        selected = take["selected"]
        unresolved = list(dict.fromkeys([*chunk.get("unresolvedAscii", []),
                                         *chunk.get("unresolvedNumbers", [])]))
        needs_listening = bool(unresolved or chunk.get("naturalnessWarnings"))
        severity = ("warning" if reviewer and take["severity"] == "ok" and needs_listening
                    else take["severity"])
        rate = int(selected["sampleRate"])
        if sample_rate is None:
            sample_rate = rate
        elif rate != sample_rate:
            raise RuntimeError("음성 청크의 샘플레이트가 서로 다릅니다.")
        if pieces:
            gap = np.zeros(round(STEP_GAP_MS * rate / 1000), dtype=np.float32)
            pieces.append(gap)
            cursor += len(gap)
        start_sample = cursor
        audio, _ = sf.read(selected["audioPath"], dtype="float32", always_2d=False)
        audio = np.asarray(audio, dtype=np.float32).reshape(-1)
        pieces.append(audio)
        cursor += len(audio)
        routing = selected.get("voiceRouting")
        if routing:
            route_identity = route_identity or {key: value for key, value in routing.items()
                                                if key not in {"segments", "sampleRate"}}
            route_segments.extend({**segment,
                                   "startSample": start_sample + segment["startSample"],
                                   "endSample": start_sample + segment["endSample"],
                                   "startMs": round((start_sample + segment["startSample"]) * 1000 / rate)}
                                  for segment in routing["segments"])
        else:
            route_segments.append({"text": chunk["ttsText"], "language": spec.language,
                                   "startSample": start_sample, "endSample": cursor,
                                   "startMs": round(start_sample * 1000 / rate),
                                   "durationMs": round(len(audio) * 1000 / rate)})
        selected_chunks.append({
            "index": index + 1, "sourceText": chunk["sourceText"], "ttsText": chunk["ttsText"],
            "startMs": round(start_sample * 1000 / rate), "endMs": round(cursor * 1000 / rate),
            "startSample": start_sample, "endSample": cursor,
            "selectedAudioPath": selected["audioPath"],
            "gapBeforeMs": STEP_GAP_MS if index else 0,
            "selectedAttempt": selected["attempt"], "selectedSeed": selected["seed"],
            "requiredPronunciations": chunk.get("requiredPronunciations", []),
            "unresolvedTokens": unresolved,
            "naturalnessWarnings": chunk.get("naturalnessWarnings", []),
            "needsListening": needs_listening,
            "severity": severity, "quality": take["quality"],
            "candidates": take["attempts"],
        })
        final_track_chunks.append({"key": f"text-{index + 1:04d}",
                                   "startSample": start_sample, "endSample": cursor,
                                   "audioPath": selected["audioPath"]})

    assert sample_rate is not None
    output_path.parent.mkdir(parents=True, exist_ok=True)
    native_path = output_path.with_name(f"{output_path.stem}-native.wav")
    sf.write(native_path, np.concatenate(pieces), sample_rate, subtype="PCM_24")
    normalization = normalize_audio(native_path, output_path)
    output_probe = probe_audio(output_path)
    final_track = inspect_final_track(native_path, output_path, final_track_chunks)
    selected_cleanups = [chunk["candidates"][chunk["selectedAttempt"] - 1]["cleanup"]
                         for chunk in selected_chunks]
    cleanup = {
        "trimmedHeadMs": sum(value["trimmedHeadMs"] for value in selected_cleanups),
        "trimmedTailMs": sum(value["trimmedTailMs"] for value in selected_cleanups),
        "shortenedSilenceCount": sum(value["shortenedSilenceCount"] for value in selected_cleanups),
        "shortenedSilenceMs": sum(value["shortenedSilenceMs"] for value in selected_cleanups),
        "chunkGapMs": STEP_GAP_MS,
    }
    voice_routing = ({**route_identity, "sampleRate": sample_rate, "segments": route_segments}
                     if route_identity else None)
    findings = [{"chunkIndex": chunk["index"], "startMs": chunk["startMs"],
                 "endMs": chunk["endMs"], "severity": chunk["severity"],
                 "sourceText": chunk["sourceText"], "ttsText": chunk["ttsText"],
                 "recognizedText": chunk["quality"]["recognizedText"],
                 "failures": chunk["quality"]["failures"],
                 "warnings": chunk["quality"]["warnings"],
                 "unresolvedTokens": chunk["unresolvedTokens"],
                 "naturalnessWarnings": chunk["naturalnessWarnings"]}
                for chunk in selected_chunks if chunk["quality"] is not None
                and chunk["severity"] != "ok"]
    quality_status = ("not-checked" if not quality_review else
                      "failed" if any(chunk["severity"] == "failed" for chunk in selected_chunks) else
                      "warning" if findings else "passed")
    metadata = {
        "schemaVersion": 2,
        "cachePolicy": "disabled", "modelKey": model_key, "model": spec.repository,
        "modelRevision": revision, "adapter": adapter, "seed": seed,
        "sourceText": source_text, "ttsText": tts_text, "textSha256": sha256_text(tts_text),
        "reference": str(reference_path.resolve()), "output": str(output_path.resolve()),
        "audioSha256": sha256_file(output_path),
        "chunks": selected_chunks,
        "cleanup": cleanup, "voiceRouting": voice_routing,
        "qualityReview": {
            "enabled": quality_review, "status": quality_status,
            "scope": "selected-chunk-audio-before-final-normalization",
            "attemptLimit": quality_attempts, "findings": findings,
            "asrModel": str(quality_model_path) if quality_model_path else None,
            "asrRevision": quality_revision,
            "independentAlignerAvailable": aligner_path is not None if quality_review else None,
        },
        "finalTrack": final_track,
        "normalization": normalization,
        "performance": {
            "modelLoadMs": load_ms, "qualityModelLoadMs": quality_load_ms,
            "generationMs": generation_ms, "qualityEvaluationMs": quality_evaluation_ms,
            "peakMetalMemoryGb": round(peak_memory_gb, 3),
        },
        **output_probe,
    }
    write_json(metadata_path, metadata)
    if final_track["status"] != "ok":
        raise RuntimeError("최종 정규화 음성의 조립·신호 무결성 검사에 실패했습니다. 기록을 확인해 주세요.")

    del router, reviewer, model, quality_model
    if training_wrapper is not None:
        del training_wrapper
    gc.collect()
    mx.clear_cache()
    print(json.dumps(metadata, ensure_ascii=False, indent=2))
    return metadata


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--model", choices=sorted(MODEL_SPECS), default="qwen3-tts")
    parser.add_argument("--text-file", type=Path, required=True)
    parser.add_argument("--reference", type=Path, required=True)
    parser.add_argument("--reference-text", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--metadata", type=Path, required=True)
    parser.add_argument("--seed", type=int, required=True)
    parser.add_argument("--adapter", type=Path)
    parser.add_argument("--adapter-scale", type=float, default=1.0)
    parser.add_argument("--quality-review", action="store_true")
    parser.add_argument("--quality-attempts", type=int, default=MAX_AUTOMATIC_ATTEMPTS)
    return parser


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    generate_candidate(
        model_key=args.model, text_path=args.text_file,
        reference_path=args.reference, reference_text_path=args.reference_text,
        output_path=args.output, metadata_path=args.metadata, seed=args.seed,
        adapter_path=args.adapter, adapter_scale=args.adapter_scale,
        quality_review=args.quality_review, quality_attempts=args.quality_attempts,
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
