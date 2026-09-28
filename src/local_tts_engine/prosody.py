"""Conservative, acoustic checks for pauses inside a spoken Korean word.

ASR spacing is not evidence of a pause. A finding needs an actual quiet interval,
speech on both sides, and a complete word mapped from the timed transcript to
the requested text. Sentence/word boundaries and unmatched readings are excluded.
The boundary checks cover the one kind of word gap that is equally a split: a
pause inside a unit the pronunciation layer built (사 초) or inside the noun
phrase around a substituted English term (있는 ‖ 에이아이), and in English
the gap right after a word that opens a phrase (to ‖ approve).
This is a pause detector, not a general score for naturalness or intonation.
"""

from __future__ import annotations

import math
import re
import unicodedata
from difflib import SequenceMatcher
from pathlib import Path
from typing import Any

import numpy as np
import soundfile as sf

from .course.alignment import clean_alignment_token


PROSODY_POLICY = "ko-intraword-pause-v3"
MIN_INTERNAL_PAUSE_MS = 250
WORD_EDGE_GUARD_MS = 100
MIN_TIMING_PROBABILITY = 0.8
MIN_UNASSIGNED_VOICED_MS = 80
PAUSE_WARNING = "단어 내부 끊김 확인 필요"

BOUNDARY_POLICY = "cohesive-boundary-pause-v2"
# A stop or affricate closure (사 초, 구십구 퍼센트) is quiet for up to about
# 120 ms in these voices; the CH00 take the user heard as "사 … 초" had 180 ms.
READING_INNER_PAUSE_MS = 150
# Same bar as a pause inside a word. The CH00 take heard as "있는 … 에이아이" had 350 ms.
TERM_LEAD_PAUSE_MS = 250
# English words a fluent speaker does not pause after: they open the phrase
# that follows (to ‖ approve, the ‖ database). A long English take had 400 ms
# in "a person to ‖ approve it" (2026-09-28). Words that can end a phrase are
# left out: particles (log in, turn on), object pronouns (her), demonstratives
# (that), auxiliaries and "but", which a narrator may hold for effect.
ENGLISH_PHRASE_OPENERS = frozenset(
    "a an the to of for with from into onto at by than and or my your our their its".split()
)
# One Qwen aligner frame (12.5 Hz).
BOUNDARY_SLACK_MS = 80
BOUNDARY_WARNING = "낱말 사이 끊김 확인 필요"


def _quiet_frames(audio_path: Path) -> tuple[np.ndarray, float] | None:
    """Mark each 10 ms frame quiet or voiced by the production threshold."""
    audio, rate = sf.read(audio_path, dtype="float32", always_2d=True)
    samples = np.mean(audio, axis=1, dtype=np.float32)
    frame = max(1, round(rate * 0.01))
    usable = len(samples) // frame * frame
    if not usable or not np.isfinite(samples).all():
        return None
    rms = np.sqrt(np.mean(samples[:usable].reshape(-1, frame) ** 2, axis=1))
    return rms < max(5e-4, float(rms.max()) * 0.0125), frame * 1000 / rate


def interior_silences(audio_path: Path) -> list[dict[str, int]]:
    """Find quiet runs; never cut or otherwise change the supplied audio."""
    measured = _quiet_frames(audio_path)
    if measured is None:
        return []
    quiet, frame_ms = measured
    active = np.flatnonzero(~quiet)
    if not len(active):
        return []
    edges = np.diff(np.r_[False, quiet, False].astype(np.int8))
    result = []
    for start, end in zip(np.flatnonzero(edges == 1), np.flatnonzero(edges == -1)):
        start_ms, end_ms = round(start * frame_ms), round(end * frame_ms)
        if start <= active[0] or end > active[-1]:
            continue
        if end_ms - start_ms >= MIN_INTERNAL_PAUSE_MS:
            result.append({"startMs": start_ms, "endMs": end_ms, "durationMs": end_ms - start_ms})
    return result


def lead_term_readings(dictionary: list[dict[str, Any]] | None) -> list[str]:
    """Readings the dictionary substitutes for Latin-script source terms."""
    return [
        str(item["to"]) for item in dictionary or []
        if item.get("to") and re.search(r"[A-Za-z]", str(item.get("from", "")))
    ]


def _punctuated(character: str) -> bool:
    return unicodedata.category(character).startswith("P")


# Words that open a new phrase even though they end in a closed syllable, so a
# pause after them is the speaker's (결국 ‖ 에이전트는), not a split noun phrase.
_PHRASE_OPENERS = frozenset(
    "하지만 그렇지만 물론 반면 대신 일단 결국 즉 그럼 지금 오늘 사실 역시 항상 이미 아직 단 한편 만약 결론 그럼에도".split()
)
# Particles and endings after which a Korean phrase may end (절·논항 경계).
_PHRASE_ENDINGS = (
    "은", "는", "을", "를", "만", "면", "뿐", "든", "처럼", "만큼", "도록", "듯", "씩", "쯤", "랑",
)
_DETERMINERS = frozenset(
    "이 그 저 새 각 본 한 두 세 네 첫 옛 온 몇 어느 무슨 어떤 모든 여러 이런 그런 저런 다른 같은 전체 해당 다음 이번".split()
)
# Stems whose -은 form modifies a noun (같은, 많은, 남은); a noun's topic -은 is the
# same spelling, so only these are decided.
_ADNOMINAL_EUN_STEMS = frozenset("같 많 작 좋 높 낮 짧 좁 넓 깊 적 옳 싫 늦 남 받 맡 얻 찾 읽 믿 붙 괜찮".split())


def _closed(syllable: str) -> bool:
    code = ord(syllable) - 0xAC00
    return 0 <= code < 11172 and code % 28 > 0


def modifies_next(token: str) -> bool:
    """Whether a Korean word is a modifier or compound head of the next noun.

    A pause between 있는 and 에이아이, 고르던 and 에이전트, or 상담 and 에이전트 splits
    one noun phrase; after 만들면, 그런데 or 경로는 a phrase may end. Only forms
    that decide this without a morphological analyzer count: determiners,
    -던/-의, X한, -는 after a closed syllable or 하/되/라/다, listed -은
    adjectives, and a closed final syllable that is no particle or ending
    (adnominal -ㄴ/-ㄹ, or a bare noun). Anything else is left undecided.
    """
    word = unicodedata.normalize("NFKC", token)
    word = "".join(character for character in word if character.isalnum())
    if not word or not all("가" <= character <= "힣" for character in word):
        return False
    if word in _DETERMINERS:
        return True
    if word in _PHRASE_OPENERS or len(word) < 2:
        return False
    last, before = word[-1], word[-2]
    if word.endswith(("던", "의")) or last == "한":
        return True
    if last == "는":
        return _closed(before) or before in ("하", "되", "라", "다")
    if last == "은":
        return word[:-1] in _ADNOMINAL_EUN_STEMS or before in _ADNOMINAL_EUN_STEMS
    return _closed(last) and not word.endswith(_PHRASE_ENDINGS)


def boundary_targets(
    expected_text: str,
    readings: list[str] | tuple[str, ...],
    term_readings: list[str] | tuple[str, ...] = (),
) -> list[dict[str, Any]]:
    """Word boundaries where a pause splits a unit the pronunciation layer built.

    Inside a multi-word reading (사 초, 구십구 퍼센트, 에이전트 루프) any pause
    beyond a stop closure breaks the unit. Before a substituted English term,
    lectures paused 2.2 times as often as elsewhere, but mostly where a phrase
    may end anyway (만들면 ‖ 에이전틱). Only a term inside a noun phrase is a
    target: after a modifier (있는 ‖ 에이아이) or another bare term (에이아이 ‖
    에이전트의). In English, a boundary right after a phrase opener (to ‖
    approve, the ‖ database) is a target. Punctuated boundaries are never
    targets. Boundary k lies between tokens k and k+1, split by the same
    whitespace rule as the forced aligner.
    """
    tokens = [token for token in expected_text.split() if clean_alignment_token(token)]
    keys = [_compact(token) for token in tokens]
    terms = {_compact(reading) for reading in term_readings}

    def open_boundary(index: int) -> bool:
        return not _punctuated(tokens[index][-1]) and not _punctuated(tokens[index + 1][0])

    def inside_noun_phrase(index: int) -> bool:
        return modifies_next(tokens[index]) or keys[index] in terms

    targets: dict[int, dict[str, Any]] = {}
    # Longest first, so 에이아이 rather than its prefix 에이 names a boundary.
    for reading in sorted(dict.fromkeys(str(value) for value in readings), key=len, reverse=True):
        parts = [key for key in (_compact(part) for part in reading.split()) if key]
        if not parts:
            continue
        leads = _compact(reading) in terms
        for start in range(len(keys) - len(parts) + 1):
            span = keys[start:start + len(parts)]
            if span[:-1] != parts[:-1] or not span[-1].startswith(parts[-1]):
                continue
            for index in range(start, start + len(parts) - 1):
                if open_boundary(index):
                    targets.setdefault(index, {"boundary": index, "kind": "inside-reading", "reading": reading,
                                               "minimumPauseMs": READING_INNER_PAUSE_MS})
            if leads and start > 0 and open_boundary(start - 1) and inside_noun_phrase(start - 1):
                targets.setdefault(start - 1, {"boundary": start - 1, "kind": "before-term", "reading": reading,
                                               "minimumPauseMs": TERM_LEAD_PAUSE_MS})
    for index, token in enumerate(tokens[:-1]):
        # Keep the apostrophe: it's is a clause, its opens a noun phrase.
        word = clean_alignment_token(unicodedata.normalize("NFKC", token).replace("’", "'")).casefold()
        if word in ENGLISH_PHRASE_OPENERS and open_boundary(index):
            targets.setdefault(index, {"boundary": index, "kind": "after-english-opener", "reading": word,
                                       "minimumPauseMs": TERM_LEAD_PAUSE_MS})
    return [targets[index] for index in sorted(targets)]


def _longest_quiet(quiet: np.ndarray, frame_ms: float, start_ms: float, end_ms: float) -> dict[str, int] | None:
    first = max(0, math.floor(start_ms / frame_ms))
    last = min(len(quiet), math.ceil(end_ms / frame_ms))
    best: tuple[int, int] | None = None
    run_start = None
    for index in range(first, last + 1):
        if index < last and quiet[index]:
            run_start = index if run_start is None else run_start
            continue
        if run_start is not None and (best is None or index - run_start > best[1] - best[0]):
            best = (run_start, index)
        run_start = None
    if best is None:
        return None
    begin, finish = round(best[0] * frame_ms), round(best[1] * frame_ms)
    return {"startMs": begin, "endMs": finish, "durationMs": finish - begin}


def boundary_pause_checks(
    expected_text: str,
    words: list[dict[str, Any]],
    audio_path: Path,
    targets: list[dict[str, Any]],
) -> dict[str, Any]:
    """Measure silence at each target boundary between independently aligned words.

    ``words`` come from the forced aligner run on ``expected_text``: one word
    per token, clip-relative. Its 80 ms frames can place a boundary a frame
    early or late, so the search window is widened by that much on each side.
    A misplaced word can shorten the measured pause, never lengthen it.
    """
    base: dict[str, Any] = {
        "policy": BOUNDARY_POLICY, "checks": [],
        "targets": [{key: target[key] for key in ("boundary", "kind", "reading")} for target in targets],
    }
    if not targets:
        return {**base, "status": "no-targets"}
    if not words:
        return {**base, "status": "alignment-unavailable"}
    tokens = [token for token in expected_text.split() if clean_alignment_token(token)]
    if len(words) != len(tokens):
        return {**base, "status": "alignment-mismatch"}
    measured = _quiet_frames(audio_path)
    if measured is None:
        return {**base, "status": "audio-unreadable"}
    quiet, frame_ms = measured
    checks = []
    for target in targets:
        index = target["boundary"]
        try:
            left_start, left_end = float(words[index]["startMs"]), float(words[index]["endMs"])
            right_start, right_end = float(words[index + 1]["startMs"]), float(words[index + 1]["endMs"])
        except (KeyError, TypeError, ValueError):
            continue
        times = (left_start, left_end, right_start, right_end)
        if not all(math.isfinite(value) for value in times) or not (0 <= left_start < left_end <= right_start < right_end):
            continue
        pause = _longest_quiet(quiet, frame_ms, left_end - BOUNDARY_SLACK_MS, right_start + BOUNDARY_SLACK_MS)
        if pause is None or pause["durationMs"] < target["minimumPauseMs"]:
            continue
        checks.append({
            "kind": target["kind"], "status": "warning", "reason": BOUNDARY_WARNING,
            "term": f"{clean_alignment_token(tokens[index])} {clean_alignment_token(tokens[index + 1])}",
            "reading": target["reading"], "startMs": round(left_start), "endMs": round(right_end),
            "pauseStartMs": pause["startMs"], "pauseEndMs": pause["endMs"],
            "pauseDurationMs": pause["durationMs"], "minimumPauseMs": target["minimumPauseMs"],
        })
    return {**base, "status": "checked", "checks": checks}


def _compact(text: str) -> str:
    return "".join(c for c in unicodedata.normalize("NFKC", text).casefold() if c.isalnum())


def _periodic_voice_ms(samples: np.ndarray, rate: int, start_ms: float, end_ms: float, threshold: float) -> int:
    """Measure sustained periodic signal, so breath/noise alone cannot confirm.

    This is a signal-presence test, not a pitch or naturalness score. Overlapping
    40ms frames count by their 10ms hop, conservatively excluding the frame tail.
    """
    region = samples[max(0, round(start_ms * rate / 1000)):round(end_ms * rate / 1000)]
    frame, hop = max(1, round(rate * 0.04)), max(1, round(rate * 0.01))
    lags = np.arange(max(1, round(rate / 500)), min(frame - 1, round(rate / 60)) + 1)
    voiced = 0
    for offset in range(0, len(region) - frame + 1, hop):
        x = region[offset:offset + frame].astype(np.float64)
        x -= x.mean()
        if float(np.sqrt(np.mean(x * x))) < threshold:
            continue
        correlation = np.correlate(x, x, mode="full")[frame - 1:]
        energy = np.r_[0.0, np.cumsum(x * x)]
        denominator = np.sqrt(energy[frame - lags] * (energy[frame] - energy[lags]))
        if float(np.max(correlation[lags] / np.maximum(denominator, 1e-12))) >= 0.55:
            voiced += 1
    return round(voiced * hop * 1000 / rate)


def _unassigned_speech_checks(
    primary: list[dict[str, Any]], words: list[dict[str, Any]], audio_path: Path,
) -> list[dict[str, Any]]:
    """Corroborate speech an independent aligner left outside all word spans.

    A forced aligner can end 똑똑하게 at a pause and omit the following syllables.
    Its empty word gap is then contradicted by sustained voiced audio that the
    independent ASR assigned to the same word. Speech belonging to an adjacent
    aligned word, edge padding, silence, or breath alone is not evidence.
    """
    if not primary or not words:
        return []
    audio, rate = sf.read(audio_path, dtype="float32", always_2d=True)
    samples = np.mean(audio, axis=1, dtype=np.float32)
    frame = max(1, round(rate * 0.01))
    usable = len(samples) // frame * frame
    if not usable or not np.isfinite(samples).all():
        return []
    rms = np.sqrt(np.mean(samples[:usable].reshape(-1, frame) ** 2, axis=1))
    threshold = max(5e-4, float(rms.max()) * 0.0125)
    duration_ms = len(samples) * 1000 / rate
    spans = []
    for word in words:
        try:
            start, end = float(word["startMs"]), float(word["endMs"])
        except (KeyError, TypeError, ValueError):
            return []
        if not (math.isfinite(start) and math.isfinite(end) and 0 <= start < end <= duration_ms + 20):
            return []
        if spans and start < spans[-1][2]:
            return []
        spans.append((_compact(str(word.get("text", ""))), start, end))
    results = []
    for check in primary:
        for index, (term, start, end) in enumerate(spans):
            if term != check["term"] or end <= check["startMs"] or start >= check["endMs"]:
                continue
            regions = []
            # Require a real neighboring word: an unaligned clip edge cannot
            # establish whether extra sound belongs to this word or another.
            if index + 1 < len(spans) and end <= check["pauseStartMs"] + WORD_EDGE_GUARD_MS:
                regions.append((
                    "unassigned-voiced-tail", max(check["pauseEndMs"], end),
                    min(check["endMs"], spans[index + 1][1] - WORD_EDGE_GUARD_MS),
                ))
            if index > 0 and start >= check["pauseEndMs"] - WORD_EDGE_GUARD_MS:
                regions.append((
                    "unassigned-voiced-head", max(check["startMs"], spans[index - 1][2] + WORD_EDGE_GUARD_MS),
                    min(check["pauseStartMs"], start),
                ))
            for evidence, begin, finish in regions:
                if finish - begin < MIN_UNASSIGNED_VOICED_MS:
                    continue
                voiced_ms = _periodic_voice_ms(samples, rate, begin, finish, threshold)
                if voiced_ms >= MIN_UNASSIGNED_VOICED_MS:
                    results.append({**check, "confirmationEvidence": evidence, "unassignedVoicedMs": voiced_ms})
                    break
            else:
                continue
            break
    return results


def confirm_pause_checks(
    primary: dict[str, Any], expected_text: str, words: list[dict[str, Any]],
    pauses: list[dict[str, int]], audio_path: Path, duration_ms: int,
) -> dict[str, Any]:
    """Combine two word timings with waveform coverage, preserving uncertainty."""
    second = pause_checks(expected_text, words, pauses, duration_ms=duration_ms)
    def identity(check):
        return check["term"], check["pauseStartMs"], check["pauseEndMs"]
    direct = {identity(check) for check in second["checks"]}
    confirmed = {
        identity(check): {**check, "confirmationEvidence": "both-word-spans"}
        for check in primary["checks"] if identity(check) in direct
    }
    residual = _unassigned_speech_checks(
        [check for check in primary["checks"] if identity(check) not in confirmed], words, audio_path,
    )
    confirmed.update({identity(check): check for check in residual})
    return {
        **primary, "policy": PROSODY_POLICY,
        "checks": [confirmed[identity(c)] for c in primary["checks"] if identity(c) in confirmed],
        "secondOpinion": True, "secondStatus": second["status"],
        "confirmation": "independent-alignment-and-waveform" if words else "unavailable",
        "confirmationWords": words,
        "unconfirmedChecks": [c for c in primary["checks"] if identity(c) not in confirmed],
    }


def pause_checks(
    expected_text: str,
    words: list[dict[str, Any]],
    pauses: list[dict[str, int]],
    *,
    duration_ms: int | None = None,
) -> dict[str, Any]:
    """Compare measured silence against complete, confidently timed words.

    ``words`` use clip-relative startMs/endMs and optional probability. The
    production caller supplies Whisper probabilities; stored forced alignments
    may omit them for offline inspection. Exact character mapping deliberately
    skips ambiguous number, foreign-term and ASR spelling substitutions.
    """
    base: dict[str, Any] = {"policy": PROSODY_POLICY, "checks": [], "mappedWords": 0}
    if not pauses:
        return {**base, "status": "checked", "timingRequired": False}
    if not words:
        return {**base, "status": "timing-unavailable", "timingRequired": True}

    expected = unicodedata.normalize("NFKC", expected_text).casefold()
    positions = [i for i, c in enumerate(expected) if c.isalnum()]
    # Quoting a term does not detach its Korean particle: “프롬프트화”라고 is
    # heard as 프롬프트화라고. Whitespace and actual pause punctuation still
    # separate tokens; quotation marks inside a word do not.
    token_spans = [
        match for match in re.finditer(r'''[가-힣](?:[가-힣]|["'“”‘’](?=[가-힣]))+''', expected)
        if len(_compact(match.group())) >= 2
    ]
    owners = {i: n for n, match in enumerate(token_spans) for i in range(match.start(), match.end())}
    expected_keys = _compact(expected)
    texts = [_compact(str(word.get("text", ""))) for word in words]
    heard_keys = "".join(texts)
    matcher = SequenceMatcher(None, expected_keys, heard_keys, autojunk=False)
    if matcher.ratio() < 0.9:
        return {**base, "status": "text-unmatched", "timingRequired": True}
    mapping = {
        block.b + offset: block.a + offset
        for block in matcher.get_matching_blocks()
        for offset in range(block.size)
    }
    groups: dict[int, list[dict[str, Any]]] = {}
    cursor = 0
    previous_end = 0.0
    for index, (word, text) in enumerate(zip(words, texts)):
        mapped = [mapping.get(i) for i in range(cursor, cursor + len(text))]
        cursor += len(text)
        try:
            start, end = float(word["startMs"]), float(word["endMs"])
            probability = float(word.get("probability", 1.0))
        except (KeyError, TypeError, ValueError):
            continue
        valid_time = all(math.isfinite(x) for x in (start, end, probability))
        valid_time = valid_time and 0 <= start < end and start >= previous_end
        if duration_ms is not None:
            valid_time = valid_time and end <= duration_ms + 20
        previous_end = max(previous_end, end) if math.isfinite(end) else previous_end
        if not text or not valid_time or probability < MIN_TIMING_PROBABILITY or None in mapped:
            continue
        if mapped != list(range(mapped[0], mapped[0] + len(text))):
            continue
        ids = {owners.get(positions[i]) for i in mapped}
        if len(ids) != 1 or None in ids:
            continue
        owner = ids.pop()
        groups.setdefault(owner, []).append({
            "text": text, "startMs": start, "endMs": end, "index": index,
            "window": word.get("window", 0),
        })

    checks = []
    for owner, parts in groups.items():
        term = _compact(token_spans[owner].group())
        if "".join(part["text"] for part in parts) != term:
            continue
        if len({part["window"] for part in parts}) != 1:
            continue  # A read-window seam is not a reliable word boundary.
        if [p["index"] for p in parts] != list(range(parts[0]["index"], parts[0]["index"] + len(parts))):
            continue
        base["mappedWords"] += 1
        start, end = parts[0]["startMs"], parts[-1]["endMs"]
        for pause in pauses:
            if start + WORD_EDGE_GUARD_MS <= pause["startMs"] and pause["endMs"] <= end - WORD_EDGE_GUARD_MS:
                checks.append({
                    "kind": "intraword-pause", "term": term, "status": "warning",
                    "reason": PAUSE_WARNING,
                    "startMs": round(start), "endMs": round(end),
                    "pauseStartMs": pause["startMs"], "pauseEndMs": pause["endMs"],
                    "pauseDurationMs": pause["durationMs"],
                })
    return {**base, "status": "checked" if base["mappedWords"] else "text-unmatched", "timingRequired": True, "checks": checks}
