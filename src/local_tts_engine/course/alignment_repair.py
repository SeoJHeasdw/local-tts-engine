"""Constrain forced alignment to measured speech, without changing any audio.

Energy boundaries constrain timing but do not identify phonemes. Stable model
timestamps remain anchors; collapsed regions use explicitly recorded syllable
interpolation inside speech islands. Ambiguous boundaries stay review warnings.
"""
from __future__ import annotations

from copy import deepcopy
import math
import re
from typing import Any

from .alignment_audit import voiced_spans
from .settings import STEP_VISUAL_LEAD_MS, SLIDE_VISUAL_LEAD_MS

ALIGNMENT_REPAIR_VERSION = "waveform-constrained-v2"


def syllable_weight(text: str) -> float:
    hangul = len(re.findall(r"[가-힣]", text))
    other = re.sub(r"[가-힣\W_]", "", text)
    return max(1.0, hangul + len(other) * .45)


def _speech_islands(silences: list[dict], start: float, end: float, merge_gap_ms: int = 250) -> list[dict]:
    # A stop consonant can contain a short low-energy gap. Do not force a word
    # break there; pauses longer than 250 ms must separate interpolation groups.
    islands: list[dict] = []
    for span in voiced_spans(silences, start, end):
        if islands and span["startMs"] - islands[-1]["endMs"] <= merge_gap_ms:
            islands[-1]["endMs"] = span["endMs"]
        else:
            islands.append(dict(span))
    return islands


def _word_groups(words: list[dict], islands: list[dict]) -> list[tuple[int, int]]:
    """Monotone partition; acoustic duration and reliable model anchors agree."""
    n, m = len(words), len(islands)
    if m > n:
        return []  # Do not invent extra tokens or discard voiced islands.
    weights = [syllable_weight(word["text"]) for word in words]
    total_speech = sum(s["endMs"] - s["startMs"] for s in islands)
    unit = total_speech / sum(weights)
    reliability = [1.0] * n
    tiny = [word["endMs"] - word["startMs"] < max(80, weight * 60)
            for word, weight in zip(words, weights)]
    for i, collapsed in enumerate(tiny):
        if collapsed:
            reliability[i] = .02
            for neighbour in (i - 1, i + 1):
                if 0 <= neighbour < n:
                    reliability[neighbour] = min(reliability[neighbour], .3)
    # Consecutive near-zero predictions followed by an unassigned speech tail
    # are a failed model run, not usable anchors for the following words.
    if islands[-1]["endMs"] - words[-1]["endMs"] > 350:
        for i in range(n - 1):
            if tiny[i] and tiny[i + 1]:
                reliability[i:] = [.01] * (n - i)
                break
    costs = {(0, 0): (0.0, [])}
    for k, island in enumerate(islands):
        start, end = island["startMs"], island["endMs"]
        for used in range(k, n):
            prior = costs.get((k, used))
            if prior is None:
                continue
            for stop in range(used + 1, n - (m - k - 1) + 1):
                weight = sum(weights[used:stop])
                # A tiny waveform island cannot contain a multi-syllable word.
                # Do not satisfy a boundary metric by compressing a good anchor.
                if end - start < sum(max(80, w * 60) for w in weights[used:stop]):
                    continue
                ratio = (end - start) / max(1, weight * unit)
                duration_cost = 2.0 * math.log(max(.05, ratio)) ** 2 * (stop - used)
                anchor_cost = 0.0
                for index in range(used, stop):
                    mid = (words[index]["startMs"] + words[index]["endMs"]) / 2
                    distance = max(start - mid, mid - end, 0)
                    anchor_cost += reliability[index] * min(16, (distance / 180) ** 2)
                score = prior[0] + duration_cost + anchor_cost
                key = (k + 1, stop)
                if key not in costs or score < costs[key][0]:
                    costs[key] = (score, [*prior[1], (used, stop)])
    return costs.get((m, n), (0, []))[1]


def _place_words(words: list[dict], start: float, end: float) -> tuple[list[dict], bool]:
    """Preserve sound anchors; interpolate only an island with broken words."""
    result = deepcopy(words)
    suspect = any(w["endMs"] - w["startMs"] < max(80, syllable_weight(w['text']) * 60)
        or w["startMs"] < start - 180 or w["endMs"] > end + 180 for w in words)
    # Strong trailing drift is another indication that later anchors failed.
    suspect = suspect or end - words[-1]["endMs"] > 350
    if suspect:
        weights = [syllable_weight(w["text"]) for w in words]
        minimums = [max(80, weight * 60) for weight in weights]
        spare = max(0, end - start - sum(minimums))
        cursor, total = start, sum(weights)
        for i, (word, weight) in enumerate(zip(result, weights)):
            stop = end if i == len(words) - 1 else cursor + minimums[i] + spare * weight / total
            word.update(startMs=round(cursor), endMs=round(stop))
            cursor = stop
    else:
        for word in result:
            word["startMs"] = round(max(start, min(end, word["startMs"])))
            word["endMs"] = round(max(word["startMs"], min(end, word["endMs"])))
        result[0]["startMs"] = round(start)
        # Do not create a collapsed 64–79 ms syllable by shaving a healthy
        # 80 ms model word at an energy boundary only a few samples later.
        if (result[0]['endMs'] - result[0]['startMs'] < 80
            and words[0]['endMs'] - words[0]['startMs'] >= 80
            and start - 20 <= words[0]['startMs'] <= start):
            result[0]['startMs'] = words[0]['startMs']
        # The model uses an 80 ms timestamp grid. Preserve a sound endpoint
        # already within one grid interval plus rounding tolerance; a silence
        # threshold is not a more precise phonetic label.
        result[-1]["endMs"] = round(words[-1]['endMs'] if abs(words[-1]['endMs'] - end) <= 100 else end)
    return result, suspect


def repair_timeline(timeline: dict[str, Any], silences: list[dict], *,
                    speech_evidence: list[dict] | None = None) -> tuple[dict, dict]:
    """Return a new timeline and an auditable list of changed timing fields."""
    fixed = deepcopy(timeline)
    entries = fixed.get("entries", [])
    if not entries or not (fixed.get("totalMs", 0) > 0):
        raise ValueError("정렬을 교정할 타임라인이 비어 있습니다.")
    changes, warnings, unassigned = [], [], []
    # Keep valid transition points. A point inside speech may move only to a
    # nearby pause, bounded by the adjacent steps, never to a distant silence.
    for i, entry in enumerate(entries[:-1]):
        following = entries[i + 1]
        if not entry.get('alignment', {}).get('words') or not following.get('alignment', {}).get('words'):
            warnings.append({"type": "missing-transition-words", "entry": i})
            continue
        original = float(entry.get("transitionAtMs", entry["endMs"]))
        if any(s["startMs"] - 20 <= original <= s["endMs"] + 20 for s in silences):
            continue
        lower = max(entry["startMs"] + 80, entry["alignment"]["words"][0]["startMs"])
        upper = min(following["endMs"] - 80, following["alignment"]["words"][-1]["endMs"])
        candidates = []
        for silence in silences:
            if silence["startMs"] < lower or silence["endMs"] > upper:
                continue
            distance = max(silence["startMs"] - original, original - silence["endMs"], 0)
            if distance > 900:
                continue
            same_slide = entry["slideId"] == following["slideId"] and entry["chapter"] == following["chapter"]
            lead = STEP_VISUAL_LEAD_MS if same_slide else SLIDE_VISUAL_LEAD_MS
            point = min(silence["endMs"], max(silence["startMs"], silence["endMs"] - lead))
            candidates.append((distance, abs(point - original), point))
        if not candidates:
            warnings.append({"type": "no-nearby-transition-silence", "entry": i, "atMs": original})
            continue
        point = round(min(candidates)[2])
        entry.update(endMs=point, transitionAtMs=point, gapAfterMs=0)
        following["startMs"] = point
        changes.append({"type": "transition", "entry": i, "beforeMs": original, "afterMs": point})

    for i, entry in enumerate(entries):
        words = entry.get("alignment", {}).get("rawWords", entry.get("alignment", {}).get("words", []))
        if not words:
            warnings.append({"type": "missing-words", "entry": i})
            continue
        start = entry["startMs"]
        end = entry["endMs"] + entry.get("gapAfterMs", 0)
        effective_silences = silences
        spans = voiced_spans(silences, start, end)
        if len(spans) >= 2:
            tail = spans[-1]
            evidence = next((s for s in speech_evidence or []
                if abs(s['startMs'] - tail['startMs']) < 2 and abs(s['endMs'] - tail['endMs']) < 2), None)
            if (evidence and evidence.get('weakNonSpeechCandidate')
                and tail['endMs'] - tail['startMs'] <= 150
                and tail['startMs'] - spans[-2]['endMs'] >= 150
                and words[-1]['endMs'] <= tail['startMs'] + 80
                and words[-1]['startMs'] < spans[-2]['endMs']
                and all(w['endMs'] - w['startMs'] >= 80 for w in words[-2:])):
                effective_silences = sorted([*silences, tail], key=lambda s: s['startMs'])
                item = {'entry': i, 'type': 'unassigned-weak-tail', **evidence}
                unassigned.append(item)
                warnings.append(item)
        islands = _speech_islands(effective_silences, start, end)
        if not islands:
            warnings.append({"type": "missing-speech", "entry": i})
            continue
        groups = _word_groups(words, islands)
        if not groups:
            warnings.append({"type": "ambiguous-speech-islands", "entry": i})
            continue
        placed, interpolated = [], []
        for island, (a, b) in zip(islands, groups):
            revised, inferred = _place_words(words[a:b], island["startMs"], island["endMs"])
            # Only a failed region loses its internal model anchors. Finer
            # pauses there can separate e.g. a collapsed phrase and its final
            # sentence, while an unvoiced stop in a good word stays untouched.
            collapsed = [w['endMs'] - w['startMs'] < 80 for w in words[a:b]]
            severe = any(left and right for left, right in zip(collapsed, collapsed[1:]))
            severe = severe or (any(collapsed) and island['endMs'] - words[b - 1]['endMs'] > 350)
            if inferred and severe:
                finer = _speech_islands(effective_silences, island['startMs'], island['endMs'], 150)
                partitions = _word_groups(words[a:b], finer)
                if len(finer) > 1 and partitions:
                    revised = []
                    for piece, (left, right) in zip(finer, partitions):
                        placed_piece, _ = _place_words(words[a + left:a + right], piece['startMs'], piece['endMs'])
                        revised.extend(placed_piece)
            placed.extend(revised)
            if inferred:
                interpolated.append({"wordFrom": a, "wordTo": b, **island})
        entry["alignment"] = {**entry["alignment"], "rawWords": deepcopy(words), "words": placed,
            "correction": {"algorithmVersion": ALIGNMENT_REPAIR_VERSION,
                "interpolatedSpans": interpolated, "wordTimingHumanApproved": False}}
        entry["speechStartMs"], entry["speechEndMs"] = placed[0]["startMs"], placed[-1]["endMs"]
        entry["audio"] = {**entry.get("audio", {}), "durationMs": entry["endMs"] - entry["startMs"]}
        changed = [{"index": j, "text": a["text"], "before": [a["startMs"], a["endMs"]],
                    "after": [b["startMs"], b["endMs"]]}
            for j, (a, b) in enumerate(zip(words, placed)) if a != b]
        if changed:
            changes.append({"type": "words", "entry": i, "words": changed, "interpolatedSpans": interpolated})
    onset_map = {}
    for entry in entries:
        aligned = entry.get('alignment', {})
        for raw, placed in zip(aligned.get('rawWords', aligned.get('words', [])), aligned.get('words', [])):
            onset_map.setdefault(raw['startMs'], placed['startMs'])
    for entry in entries:
        for pause in entry.get('forcedPauses', []):
            # Duration describes inserted PCM silence and remains immutable.
            # Only the reference to the following corrected word onset moves.
            pause['nextSpeechStartMs'] = onset_map.get(pause.get('nextSpeechStartMs'), pause.get('nextSpeechStartMs'))
    details = {"algorithmVersion": ALIGNMENT_REPAIR_VERSION, "changes": changes, "warnings": warnings,
        "unassignedSpeechCandidates": unassigned,
        "audioModified": False, "lexicalTimingGuaranteed": False}
    fixed["alignmentRepair"] = {key: value for key, value in details.items() if key != "changes"}
    return fixed, details
