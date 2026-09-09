"""Conservative clause omissions and a text-preserving retry plan.

This is evidence from an independent transcript, not proof that every missing
word was inaudible. Only contiguous multi-word deletions qualify. Substitutions,
spelling/spacing changes and short pronunciation differences keep their gates.
"""

from __future__ import annotations

import re
from difflib import SequenceMatcher
from typing import Any

from .korean_phonetics import phonetic_variants
from .pronunciation import QUOTED_ENGLISH_PATTERN, apply_pronunciation, is_english_sentence

COVERAGE_POLICY = "ko-clause-omission-v1"
OMISSION_REASON = "받아쓰기에서 구절 누락"
WORD = re.compile(r"[가-힣]+|[A-Za-z0-9]+")


def clause_omissions(expected: str, recognized: str, dictionary=None) -> list[dict[str, Any]]:
    # Expected text is already the exact TTS input. Normalize each token for
    # matching without losing its original character offsets.
    left = list(WORD.finditer(expected))
    right = list(WORD.finditer(apply_pronunciation(recognized, dictionary or [])))
    keys = lambda words: [phonetic_variants(word.group())[0] for word in words]
    a, b = keys(left), keys(right)
    if not a or not b:
        return []
    checks = []
    operations = SequenceMatcher(None, a, b, autojunk=False).get_opcodes()
    for index, (kind, i, j, k, l) in enumerate(operations):
        if kind != "delete":
            continue
        # Repeated clauses admit several equally valid edit alignments. Keep
        # the earliest heard occurrence: marketer's tools remain, developer's
        # clause disappears, not the first occurrence of 지시와 on the page.
        following = operations[index + 1] if index + 1 < len(operations) else None
        limit = following[2] if following and following[0] == "equal" else j
        while j < limit and k < len(b) and a[i] == a[j] == b[k]:
            i, j, k = i + 1, j + 1, k + 1
        words = left[i:j]
        if len(words) < 3 or any(not re.fullmatch(r"[가-힣]+", w.group()) for w in words):
            continue
        if sum(len(w.group()) for w in words) < 10:
            continue
        start, end = words[0].start(), words[-1].end()
        checks.append({
            "kind": "omission", "status": "failed", "reason": OMISSION_REASON,
            "expectedStart": start, "expectedEnd": end,
            "text": expected[start:end], "wordCount": len(words),
        })
    return checks


def omission_recovery_parts(text: str, checks: list[dict[str, Any]]) -> list[str]:
    """Separate affected sentences/clauses at existing punctuation only.

    No word or punctuation is rewritten. Parts are rejoined and independently
    reviewed as one candidate; entry keys and caption source remain unchanged.
    """
    # A quoted English sentence is one utterance read in the English voice, and
    # the voice is chosen per part from the quote marks the part still carries.
    # Cutting between them — which the sentence stop inside "Agents are tools.
    # Use them." invites — hands both halves back to the Korean voice with the
    # Korean adapter, silently undoing the approved English routing and the
    # word-level English check along with it. Those positions are not cuts.
    protected = [match.span() for match in QUOTED_ENGLISH_PATTERN.finditer(text)
                 if is_english_sentence(match.group(1))]
    outside = lambda position: not any(begin < position < end for begin, end in protected)
    sentences = [0, *[m.end() for m in re.finditer(r"[.!?。！？]\s+", text) if outside(m.end())], len(text)]
    cuts = {0, len(text)}
    for check in checks:
        start, end = int(check["expectedStart"]), int(check["expectedEnd"])
        if not 0 <= start < end <= len(text) or text[start:end] != check["text"]:
            continue
        begin = max(p for p in sentences if p <= start)
        finish = min(p for p in sentences if p >= end)
        cuts.update((begin, finish))
        cuts.update(m.end() for m in re.finditer(r"[,;，；]\s+", text)
                    if begin < m.end() < finish and outside(m.end()))
    bounds = sorted(cuts)
    parts = [text[a:b].strip() for a, b in zip(bounds, bounds[1:]) if text[a:b].strip()]
    if len(parts) < 2 or len(parts) > 8 or any(len(WORD.findall(p)) < 2 for p in parts):
        return []
    if " ".join(parts) != " ".join(text.split()):
        return []
    return parts


def repeated_omissions(evaluations: list[dict[str, Any]]) -> list[dict[str, Any]]:
    if len(evaluations) < 2:
        return []
    identity = lambda c: (c.get("expectedStart"), c.get("expectedEnd"), c.get("text"))
    previous = {identity(c) for c in evaluations[-2].get("contentChecks", []) if c.get("kind") == "omission"}
    return [c for c in evaluations[-1].get("contentChecks", [])
            if c.get("kind") == "omission" and identity(c) in previous]


def saved_omissions(text: str, findings: list[dict[str, Any]], dictionary=None) -> list[dict[str, Any]]:
    """A manual repair can use prior failures without spending two more takes.

    Match the entire current TTS input exactly. Old page numbers or a repeated
    keyword cannot transfer a repair to an edited/different script.
    """
    for finding in findings:
        if (finding.get("expectedText") == text and finding.get("severity") == "failed"
                and int(finding.get("attempts", 0)) >= 2):
            checks = clause_omissions(text, str(finding.get("recognizedText", "")), dictionary)
            if checks:
                return checks
    return []
