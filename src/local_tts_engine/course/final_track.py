"""Audit the assembled, normalized lecture track without changing clip verdicts."""

from __future__ import annotations

import subprocess
import tempfile
from pathlib import Path
from typing import Any, Callable

import numpy as np
import soundfile as sf

from ..speech_quality import apply_english_checks, comparison_text, evaluate_candidate, review_transcriptions


def _rms(samples: np.ndarray) -> float:
    return float(np.sqrt(np.mean(np.asarray(samples, dtype=np.float64) ** 2))) if len(samples) else 0.0


def _read_range(file: sf.SoundFile, start: int, stop: int) -> np.ndarray:
    file.seek(start)
    return file.read(stop - start, dtype="float32", always_2d=False)


def _output_range(chunk: dict[str, Any], source_rate: int, output_rate: int) -> tuple[int, int]:
    return (
        round(int(chunk["startSample"]) * output_rate / source_rate),
        round(int(chunk["endSample"]) * output_rate / source_rate),
    )


def _comparison_samples(source: np.ndarray, source_rate: int, output_rate: int) -> np.ndarray:
    """Put the reference on the delivered sample grid using audio resampling.

    Linear interpolation attenuates high frequencies between native samples.
    Comparing it with FFmpeg's band-limited output can falsely report lost
    speech. Resample only the reference; leave the delivered waveform intact.
    """
    if source_rate == output_rate:
        return source
    result = subprocess.run([
        "ffmpeg", "-v", "error", "-f", "f32le", "-ar", str(source_rate),
        "-ac", "1", "-i", "pipe:0", "-ar", str(output_rate), "-ac", "1",
        "-f", "f32le", "pipe:1",
    ], input=np.asarray(source, dtype="<f4").tobytes(), capture_output=True, check=True)
    return np.frombuffer(result.stdout, dtype="<f4")


def _waveform_similarity(source: np.ndarray, output: np.ndarray, source_rate: int,
                         output_rate: int) -> tuple[float, float | None, float | None]:
    """Compare the whole clip and its audible quarter-second spans."""
    if len(source) < 100 or len(output) < 100:
        return 0.0, None, None
    source = _comparison_samples(source, source_rate, output_rate)
    # The reference is now on the same sample grid as the delivered waveform.
    # Every output sample participates. Strided sampling can hide corruption
    # entirely when the damaged samples fall between the inspected positions.
    positions = np.arange(len(output), dtype=np.float64)
    output_view = np.asarray(output, dtype=np.float64)
    best = -1.0
    best_source_view: np.ndarray | None = None
    for delay in range(-8, 9, 2):
        source_view = np.interp(
            positions + delay,
            np.arange(len(source)), source,
            left=0.0, right=0.0,
        )
        denominator = np.linalg.norm(source_view) * np.linalg.norm(output_view)
        if denominator:
            similarity = float(np.dot(source_view, output_view) / denominator)
            if similarity > best:
                best, best_source_view = similarity, source_view
    if best_source_view is None:
        return best, None, None
    window = max(100, round(0.25 * output_rate))
    local_similarities: list[float] = []
    audible_gains: list[float] = []
    for start in range(0, len(output_view), window):
        source_part = best_source_view[start:start + window]
        output_part = output_view[start:start + window]
        if len(source_part) < 100 or _rms(source_part) < 0.001:
            continue
        denominator = np.linalg.norm(source_part) * np.linalg.norm(output_part)
        local_similarities.append(float(np.dot(source_part, output_part) / denominator) if denominator else 0.0)
        audible_gains.append(_rms(output_part) / _rms(source_part))
    # Constant normalization gain is legitimate, but a locally near-muted
    # spoken span is signal loss even when its cosine similarity stays one.
    # Use the best constant normalization gain over all samples, weighted by
    # source energy. A median over windows can itself become near-zero when
    # most quiet spoken windows disappear behind one retained louder phrase.
    source_energy = float(np.dot(best_source_view, best_source_view))
    reference_gain = float(np.dot(best_source_view, output_view)) / source_energy if source_energy else 0.0
    gain_ratio = min(audible_gains) / reference_gain if audible_gains and reference_gain > 0 else None
    return best, min(local_similarities) if local_similarities else None, gain_ratio


def _gap_has_signal(file: sf.SoundFile, start: int, stop: int) -> bool:
    """Read the complete gap in bounded blocks; a short defect may miss its center."""
    window = max(1, round(file.samplerate * 0.1))
    for offset in range(start, stop, window):
        if _rms(_read_range(file, offset, min(stop, offset + window))) >= 0.001:
            return True
    return False


def inspect_final_track(native_track: Path, final_track: Path, chunks: list[dict[str, Any]]) -> dict[str, Any]:
    """Check placement, gaps and retained waveform in bounded clip-sized reads."""
    issues: list[dict[str, Any]] = []
    records: list[dict[str, Any]] = []
    with sf.SoundFile(native_track) as native, sf.SoundFile(final_track) as final:
        if native.channels != 1 or final.channels != 1:
            raise RuntimeError("완성 음성 무결성 검사는 모노 WAV를 요구합니다.")
        source_rate, output_rate = native.samplerate, final.samplerate
        while True:
            block = final.read(65_536, dtype="float32")
            if not len(block):
                break
            if not np.all(np.isfinite(block)):
                issues.append({"code": "invalid-final-samples"})
                break
        expected_frames = round(native.frames * output_rate / source_rate)
        duration_difference_ms = round((final.frames - expected_frames) * 1000 / output_rate, 3)
        if abs(duration_difference_ms) > 30:
            issues.append({"code": "duration-mismatch", "detail": f"완성 WAV 길이가 조립본과 {duration_difference_ms:+g}ms 다릅니다."})
        previous_end = 0
        for chunk in chunks:
            key = str(chunk["key"])
            native_start, native_stop = int(chunk["startSample"]), int(chunk["endSample"])
            output_start, output_stop = _output_range(chunk, source_rate, output_rate)
            if not 0 <= native_start < native_stop <= native.frames or not 0 <= output_start < output_stop <= final.frames:
                issues.append({"code": "chunk-out-of-range", "chunkKey": key})
                continue
            source, _ = sf.read(chunk["audioPath"], dtype="float32")
            assembled = _read_range(native, native_start, native_stop)
            rendered = _read_range(final, output_start, output_stop)
            if len(assembled) != len(source) or not np.array_equal(assembled, source):
                issues.append({"code": "assembly-mismatch", "chunkKey": key})
            native_rms, final_rms = _rms(source), _rms(rendered)
            similarity, local_similarity, local_gain_ratio = (
                _waveform_similarity(source, rendered, source_rate, output_rate)
                if native_rms >= 0.001 and final_rms >= 0.001 else (None, None, None))
            if native_rms >= 0.001 and final_rms < 0.001:
                issues.append({"code": "missing-speech", "chunkKey": key})
            elif similarity is not None and similarity < 0.85:
                issues.append({"code": "waveform-changed", "chunkKey": key, "similarity": round(similarity, 4)})
            elif local_similarity is not None and local_similarity < 0.95:
                issues.append({"code": "local-waveform-changed", "chunkKey": key,
                               "similarity": round(local_similarity, 4)})
            elif local_gain_ratio is not None and local_gain_ratio < 0.1:
                issues.append({"code": "local-signal-loss", "chunkKey": key,
                               "minimumGainRatio": round(local_gain_ratio, 6)})
            if not np.all(np.isfinite(rendered)):
                issues.append({"code": "invalid-samples", "chunkKey": key})
            records.append({
                "chunkKey": key, "startMs": round(output_start * 1000 / output_rate),
                "endMs": round(output_stop * 1000 / output_rate),
                "nativeRms": round(native_rms, 6), "finalRms": round(final_rms, 6),
                "similarity": round(similarity, 4) if similarity is not None else None,
                "minimumLocalSimilarity": round(local_similarity, 4) if local_similarity is not None else None,
                "minimumLocalGainRatio": round(local_gain_ratio, 6) if local_gain_ratio is not None else None,
            })
            if native_start > previous_end:
                gap_start = round(previous_end * output_rate / source_rate)
                gap_end = output_start
                margin = round(0.03 * output_rate)
                if gap_end - gap_start > 2 * margin:
                    # Skip only resampler ringing at the two speech edges.
                    if _gap_has_signal(final, gap_start + margin, gap_end - margin):
                        issues.append({"code": "unexpected-gap-speech", "beforeChunkKey": key})
            previous_end = native_stop
        if native.frames > previous_end:
            gap_start = round(previous_end * output_rate / source_rate)
            if _gap_has_signal(final, min(final.frames, gap_start + round(0.03 * output_rate)), final.frames):
                issues.append({"code": "unexpected-tail-speech"})
    return {
        "status": "failed" if issues else "ok",
        "sourceSampleRate": source_rate, "finalSampleRate": output_rate,
        "durationDifferenceMs": duration_difference_ms,
        "issues": issues, "chunks": records,
    }


def _mapped_routing(routing: dict[str, Any] | None, source_rate: int, output_rate: int,
                    frames: int) -> dict[str, Any] | None:
    if not routing:
        return None
    segments = []
    for segment in routing["segments"]:
        start = round(int(segment["startSample"]) * output_rate / source_rate)
        end = min(frames, round(int(segment["endSample"]) * output_rate / source_rate))
        segments.append({**segment, "startSample": start, "endSample": end})
    return {**routing, "sampleRate": output_rate, "segments": segments}


def review_final_track(
    final_track: Path,
    chunks: list[dict[str, Any]],
    source_rate: int,
    dictionary: list[dict[str, Any]],
    original_records: list[dict[str, Any]],
    transcribe: Callable[[str, float, dict[str, Any] | None], tuple[str, list]],
) -> dict[str, Any]:
    """Read actual final-track slices with the existing Korean/English gates.

    This is a second ASR opinion on the delivered waveform. Its result is kept
    separate from the original candidate decision and from human listening.
    """
    originals = {item["chunkKey"]: item for item in original_records}
    reviews: list[dict[str, Any]] = []
    with sf.SoundFile(final_track) as final, tempfile.TemporaryDirectory(prefix="tts-final-track-") as scratch:
        output_rate = final.samplerate
        for index, chunk in enumerate(chunks):
            start, stop = _output_range(chunk, source_rate, output_rate)
            segment = _read_range(final, start, stop)
            original = originals[chunk["key"]]["selected"]
            path = (Path(scratch) / f"final--{index:04d}--{chunk['key']}--take-{original['attempt']}.wav").resolve()
            sf.write(path, segment, output_rate, subtype="PCM_24")
            routing = _mapped_routing(chunk.get("voiceRouting"), source_rate, output_rate, len(segment))

            def read(temperature: float) -> dict[str, Any]:
                recognized, english_checks = transcribe(str(path), temperature, routing)
                result = evaluate_candidate(
                    expected_text=chunk["chunk"].tts_text,
                    recognized_text=recognized,
                    audio_path=path,
                    dictionary=dictionary,
                    required_pronunciations=chunk["chunk"].required_pronunciations,
                    attempt=int(original["attempt"]),
                    seed=int(chunk["seed"]),
                    speech_parts=routing["segments"] if routing else None,
                )
                return apply_english_checks(result, english_checks)

            result = review_transcriptions(read)
            new_concerns = (set(result["failures"]) | set(result["warnings"])) - (
                set(original.get("failures", [])) | set(original.get("warnings", []))
            )
            # A broad label such as "받아쓰기 불일치" can describe two different
            # missing words. Keep the delivered track's distinct transcript
            # visible even when its warning labels match the selected take.
            if (not result["passed"] and not new_concerns
                    and comparison_text(result["recognizedText"], dictionary)
                    != comparison_text(original.get("recognizedText", ""), dictionary)):
                new_concerns.add("선택 후보와 완성 음성의 받아쓰기 차이")
            reviews.append({
                "chunkKey": chunk["key"],
                "chapter": chunk["chunk"].entries[0].chapter,
                "slideId": chunk["chunk"].entries[0].slide_id,
                "slideNumber": chunk["chunk"].entries[0].slide_number,
                "startMs": round(start * 1000 / output_rate),
                "endMs": round(stop * 1000 / output_rate),
                "passed": result["passed"],
                "recognizedText": result["recognizedText"],
                "failures": result["failures"],
                "warnings": result["warnings"],
                "contentChecks": result.get("contentChecks", []),
                "englishChecks": result.get("englishChecks", []),
                "transcriptReview": result["transcriptReview"],
                "newConcerns": sorted(new_concerns),
            })
    needs_review = [
        {"chapter": item["chapter"], "slideId": item["slideId"], "slideNumber": item["slideNumber"]}
        for item in reviews if not item["passed"]
    ]
    unique_pages = list(dict.fromkeys(
        (page["chapter"], page["slideId"], page["slideNumber"]) for page in needs_review
    ))
    return {
        "status": "needs-review" if needs_review else "ok",
        "policy": "final-normalized-track-per-chunk-asr-v1",
        "humanApproved": False,
        "needsReview": [
            {"chapter": chapter, "slideId": slide_id, "slideNumber": number}
            for chapter, slide_id, number in unique_pages
        ],
        "chunks": reviews,
    }
