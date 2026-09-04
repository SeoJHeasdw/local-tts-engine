#!/usr/bin/env python3.13
"""Report dictionary readings that could lose a whole syllable unnoticed.

§27 of docs/HANDOFF.md settles what this may and may not measure. A vowel that
shifts by one is how people actually talk, and the gate passes it on purpose —
in a long reading such a slip is always under 0.15, so counting those would flag
almost every entry and teach nobody anything. A *syllable* that disappears is a
different thing: 런타임 → 런팀 is the misreading this repository exists for.

So this asks one question per entry. If a syllable of this reading vanished,
would anyone hear about it? Readings long enough to absorb a lost syllable
inside the match gate are listed.

A listed entry is not a bug. A long reading may be the only natural one, and
naturalness wins — the point is to notice, when choosing between readings that
sound equally good, that the shorter one is also the one you can watch.
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))

from local_tts_engine.course_pilot import (  # noqa: E402
    DEFAULT_SOURCE_PROJECT,
    course_pronunciation_dictionary,
)
from local_tts_engine.korean_phonetics import (  # noqa: E402
    HANGUL_START,
    phonetic_key,
    pronunciation_distance,
)
from local_tts_engine.speech_quality import (  # noqa: E402
    PRONUNCIATION_MATCH_DISTANCE,
    PRONUNCIATION_WARNING_DISTANCE,
)


def hangul_syllables(text: str) -> list[int]:
    return [index for index, ch in enumerate(text) if HANGUL_START <= ord(ch) <= 0xD7A3]


def near_misses(reading: str) -> list[tuple[str, str]]:
    """Drop each syllable in turn: 런타임 → 런임·런타, 엔에잇엔 → 엔잇엔."""
    positions = hangul_syllables(reading)
    if len(positions) < 2:
        return []
    return [
        (reading[:index] + reading[index + 1:], "음절 하나 사라짐")
        for index in positions
    ]


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source-project", type=Path, default=DEFAULT_SOURCE_PROJECT)
    parser.add_argument("--json", type=Path, help="결과를 JSON으로도 저장")
    args = parser.parse_args(argv)

    rows = []
    for item in course_pronunciation_dictionary(args.source_project):
        if item.get("literal"):
            continue
        reading = str(item["to"])
        key = phonetic_key(reading)
        misses = near_misses(reading)
        if not key or not misses:
            continue
        worst = min(
            (pronunciation_distance(key, phonetic_key(text)), text, why)
            for text, why in misses
        )
        rows.append({
            "from": str(item["from"]),
            "to": reading,
            "jamo": len(key),
            "closestMiss": worst[1],
            "kind": worst[2],
            "distance": round(worst[0], 4),
            "verdict": (
                "사각지대" if worst[0] <= PRONUNCIATION_MATCH_DISTANCE
                else "경고로 잡힘" if worst[0] <= PRONUNCIATION_WARNING_DISTANCE
                else "실패로 잡힘"
            ),
        })

    rows.sort(key=lambda row: (row["distance"], -row["jamo"]))
    blind = [row for row in rows if row["verdict"] == "사각지대"]
    print(f"사전 항목 {len(rows)}개 중, 음절 하나가 사라져도 관문을 통과하는 것 "
          f"{len(blind)}개 (일치 관문 {PRONUNCIATION_MATCH_DISTANCE})\n")
    print(f"{'from':22} {'to':20} {'자모':>4} {'음절 하나 빠지면':16} {'거리':>6}")
    for row in blind:
        print(f"{row['from'][:22]:22} {row['to'][:20]:20} {row['jamo']:>4} "
              f"{row['closestMiss'][:16]:16} {row['distance']:>6.3f}")
    if args.json:
        args.json.parent.mkdir(parents=True, exist_ok=True)
        args.json.write_text(json.dumps(rows, ensure_ascii=False, indent=2) + "\n",
                             encoding="utf-8")
        print(f"\n전체: {args.json}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
