"""Immutable script steps and synthesis chunks."""

from __future__ import annotations

from dataclasses import dataclass


@dataclass(frozen=True)
class CourseEntry:
    """대본의 한 스텝(챕터·슬라이드·스텝 번호 + 원문 + TTS 텍스트)을 나타낸다.

    source_text: 자막용 원문 (발음 치환 전)
    tts_text:    TTS 입력용 텍스트 (발음 치환 후)
    naturalness_checks: 생성 전에 고유어/한자어 읽기를 결정한 기록
    """

    chapter: str        # 예: "ch00"
    slide_id: str       # 예: "intro-why-tts"
    slide_number: int   # 전체 슬라이드 목록 내 1-based 순번
    step: int           # 슬라이드 내 스텝 번호 (대본 ### N 헤더)
    source_text: str    # 원문 (자막, 검색, 교정용)
    tts_text: str       # 발음 치환이 적용된 TTS 입력 텍스트
    part_index: int = 0       # 한 스텝이 강제 무음으로 나뉜 경우의 0-based 조각 번호
    part_count: int = 1       # 같은 스텝 안의 전체 음성 조각 수
    pause_before_ms: int = 0  # 이 조각 직전에 삽입할 강제 무음
    pronunciation_matches: tuple[str, ...] = ()
    naturalness_checks: tuple[str, ...] = ()
    naturalness_warnings: tuple[str, ...] = ()
    required_pronunciations: tuple[str, ...] = ()
    unresolved_tokens: tuple[str, ...] = ()

    @property
    def key(self) -> str:
        """챕터·슬라이드·스텝을 조합한 고유 식별자 문자열."""
        base = f"{self.chapter}--{self.slide_id}--{self.step}"
        return f"{base}--part-{self.part_index + 1}" if self.part_count > 1 else base


@dataclass(frozen=True)
class CourseChunk:
    """TTS 한 번 호출에 합성되는 연속 CourseEntry 묶음.

    같은 슬라이드 내의 짧은 스텝들을 하나의 자연스러운 호흡으로 묶는다.
    청킹 조건: MAX_CHUNK_CHARS 이하 & MAX_CHUNK_ENTRIES 이하 & 같은 슬라이드.
    """

    entries: tuple[CourseEntry, ...]

    @property
    def key(self) -> str:
        """첫 스텝~마지막 스텝 범위를 나타내는 청크 식별자."""
        first = self.entries[0]
        last = self.entries[-1]
        first_key = (
            f"{first.step}-part-{first.part_index + 1}"
            if first.part_count > 1
            else str(first.step)
        )
        last_key = (
            f"{last.step}-part-{last.part_index + 1}"
            if last.part_count > 1
            else str(last.step)
        )
        return f"{first.chapter}--{first.slide_id}--{first_key}-to-{last_key}"

    @property
    def source_text(self) -> str:
        """청크 내 모든 스텝의 원문을 공백으로 이어 붙인 문자열."""
        return " ".join(entry.source_text for entry in self.entries)

    @property
    def tts_text(self) -> str:
        """청크 내 모든 스텝의 TTS 텍스트를 공백으로 이어 붙인 문자열."""
        return " ".join(entry.tts_text for entry in self.entries)

    @property
    def required_pronunciations(self) -> tuple[str, ...]:
        """Pronunciations that independent ASR must hear in this chunk."""
        return tuple(
            dict.fromkeys(
                pronunciation
                for entry in self.entries
                for pronunciation in entry.required_pronunciations
            )
        )
