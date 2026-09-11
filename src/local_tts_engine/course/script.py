"""Read lecture sources and prepare pronunciation-aware chunks without loading models."""

from __future__ import annotations

import json
import re
from pathlib import Path
from typing import Any

from ..pronunciation import merge_pronunciation_dictionaries, pronunciation_preflight
from .settings import (
    FORCED_PAUSE_LINE_PATTERN,
    FORCED_PAUSE_TOKEN_PATTERN,
    LESSON_FILE_PATTERN,
    LOCAL_PRONUNCIATION_PATH,
    MAX_CHUNK_CHARS,
    MAX_CHUNK_ENTRIES,
    MAX_FORCED_PAUSE_MS,
    MIN_FORCED_PAUSE_MS,
)
from .types import CourseChunk, CourseEntry


def strip_markdown(text: str) -> str:
    """마크다운 이미지 구문을 alt 텍스트로 치환하고 줄바꿈을 공백으로 평탄화한다.

    슬라이드 타이틀 등 짧은 문자열에서 불필요한 서식을 제거할 때 사용한다.
    """
    return (
        re.sub(r"!\[([^]]*)]\([^)]*\)", r"\1", text)
        .replace("\n", " ")
        .strip()
    )


def normalize_script_text(text: str) -> str:
    """대본 마크다운을 TTS에 적합한 평문으로 변환한다.

    처리 항목:
        - [링크 텍스트](URL) → 링크 텍스트만 남김
        - *강조*, _밑줄_, `코드`, ~취소선~ 등 인라인 마커 제거
        - 불릿 포인트(-, +) 앞 마커 제거
        - 연속 공백 정규화
    """
    text = re.sub(r"\[([^]]+)]\([^)]*\)", r"\1", text)
    text = re.sub(r"[*_`~]", "", text)
    text = re.sub(r"^\s*[-+]\s+", "", text, flags=re.MULTILINE)
    return re.sub(r"\s+", " ", text).strip()


def is_narration_direction(line: str) -> bool:
    """Return whether a whole line is a parenthesized production direction.

    Inline parentheses remain narration. Only a line whose entire Markdown-stripped
    content is wrapped in round parentheses is treated as a non-spoken direction.
    """
    normalized = re.sub(r"^[*_`~\s]+|[*_`~\s]+$", "", line)
    return any(
        normalized.startswith(opening) and normalized.endswith(closing)
        for opening, closing in (("(", ")"), ("（", "）"))
    )


def forced_pause_milliseconds(line: str) -> int | None:
    """Parse a standalone ``[Ns]`` marker and validate its duration."""
    match = FORCED_PAUSE_LINE_PATTERN.fullmatch(line)
    if not match:
        return None
    milliseconds = round(float(match.group(1)) * 1000)
    if not MIN_FORCED_PAUSE_MS <= milliseconds <= MAX_FORCED_PAUSE_MS:
        raise ValueError("강제 무음은 0.1초 이상 10초 이하로 입력해 주세요.")
    return milliseconds


def split_forced_pause_segments(text: str) -> list[tuple[str, int]]:
    """Split normalized script text into spoken segments and pause-before values."""
    matches = list(FORCED_PAUSE_TOKEN_PATTERN.finditer(text))
    if not matches:
        return [(text, 0)]
    segments: list[tuple[str, int]] = []
    cursor = 0
    pause_before_ms = 0
    for match in matches:
        spoken = text[cursor : match.start()].strip()
        if not spoken and cursor != 0:
            raise ValueError("강제 무음 앞에는 읽을 문장이 있어야 합니다.")
        if spoken:
            segments.append((spoken, pause_before_ms))
        pause_before_ms = forced_pause_milliseconds(match.group(0)) or 0
        cursor = match.end()
    spoken = text[cursor:].strip()
    if not spoken:
        raise ValueError("강제 무음 뒤에는 이어서 읽을 문장이 있어야 합니다.")
    segments.append((spoken, pause_before_ms))
    return segments


def parse_script(path: Path) -> dict[str, dict[int, str]]:
    """마크다운 대본 파일을 {슬라이드ID: {스텝번호: 텍스트}} 구조로 파싱한다.

    대본 형식 (deck/script/course/<ch>.md):
        ## <슬라이드ID>   ← ## 헤더로 슬라이드 구분
        ### 1             ← ### 숫자로 스텝 구분
        ...본문...
        ### 2
        ...본문...

    > 인용구, --- 구분선과 줄 전체가 괄호인 제작 지시문은 내레이션에서 제외한다.
      문장 안의 괄호 표현은 그대로 읽는다.
    """
    result: dict[str, dict[int, str]] = {}
    slide_id: str | None = None
    step: int | None = None
    buffer: list[str] = []

    def flush() -> None:
        """현재 버퍼의 텍스트를 result에 저장하고 버퍼를 초기화한다."""
        nonlocal buffer
        if slide_id is not None and step is not None:
            text = normalize_script_text("\n".join(buffer))
            if text:
                result.setdefault(slide_id, {})[step] = text
        buffer = []

    for line_number, raw in enumerate(path.read_text(encoding="utf-8").splitlines(), start=1):
        slide_match = re.match(r"^##\s+(.+?)\s*$", raw)
        step_match = re.match(r"^###\s+(\d+)\s*$", raw)
        if step_match:
            flush()
            step = int(step_match.group(1))
            continue
        if slide_match:
            flush()
            slide_id = slide_match.group(1).strip()
            step = None  # 슬라이드가 바뀌면 스텝 번호도 초기화
            continue
        pause_ms = forced_pause_milliseconds(raw)
        if step is not None and pause_ms is not None:
            buffer.append(f"[{pause_ms / 1000:g}s]")
            continue
        if step is not None and FORCED_PAUSE_TOKEN_PATTERN.search(raw):
            raise ValueError(
                f"{path}:{line_number} 강제 무음 [Ns]는 다른 문장 없이 단독 줄에 두세요."
            )
        # 구분선, 인용구와 한 줄짜리 괄호 제작 지시문은 내레이션에서 제외
        if (
            step is not None
            and not re.match(r"^---+\s*$", raw)
            and not raw.startswith(">")
            and not is_narration_direction(raw)
        ):
            buffer.append(raw)
    flush()
    return result


def production_pronunciation() -> list[dict[str, str]]:
    """로컬 프로덕션 발음 사전을 읽어 반환한다.

    config/production-pronunciation.ko.json 이 없으면 빈 목록을 반환해
    파일 부재가 오류가 아닌 '사전 없음'으로 처리된다.
    """
    if not LOCAL_PRONUNCIATION_PATH.is_file():
        return []
    return json.loads(LOCAL_PRONUNCIATION_PATH.read_text(encoding="utf-8"))


def course_pronunciation_dictionary(source_project: Path) -> list[dict[str, Any]]:
    """Load the deck dictionary and apply local production overrides."""
    deck_dictionary = json.loads(
        (source_project / "deck/narration/pronunciation.ko.json").read_text(encoding="utf-8")
    )
    return merge_pronunciation_dictionaries(
        deck_dictionary,
        production_pronunciation(),
    )


def slide_ids_from_source(source: str) -> list[str]:
    """TypeScript 파일에서 가장 바깥 레벨의 슬라이드 ID만 순서대로 읽는다."""
    matches = re.findall(
        r'^(\s+)id:\s*"([a-z0-9-]+)"',
        source,
        flags=re.MULTILINE,
    )
    if not matches:
        return []
    minimum_indent = min(len(indent.expandtabs(4)) for indent, _ in matches)
    return [
        slide_id
        for indent, slide_id in matches
        if len(indent.expandtabs(4)) == minimum_indent
    ]


def chapter_slide_order(deck_root: Path) -> list[tuple[str, str]]:
    """챕터 TypeScript 파일에서 슬라이드 ID를 순서대로 추출한다.

    deck/src/production/chapters/ch<NN>-*.ts 파일을 정렬된 순으로 읽고,
    각 파일에서 `id: "슬라이드ID"` 패턴을 찾아 (챕터, 슬라이드ID) 튜플 목록을 반환한다.
    이 순서가 전체 강의 슬라이드 번호의 기준이 된다.
    """
    chapters_dir = deck_root / "src/production/chapters"
    order: list[tuple[str, str]] = []
    for path in sorted(chapters_dir.glob("ch[0-9][0-9]-*.ts")):
        chapter = path.name[:4]  # 예: "ch00"
        source = path.read_text(encoding="utf-8")
        # 기존 단일 파일 챕터는 여기서 직접 읽는다. CH01처럼 레슨 파일로
        # 분리된 챕터는 상위 파일의 import/spread 순서와 같은 파일명 정렬로 읽는다.
        slide_ids = slide_ids_from_source(source)
        if not slide_ids:
            split_dir = chapters_dir / chapter
            for split_path in sorted(split_dir.glob("*.ts")):
                slide_ids.extend(
                    slide_ids_from_source(split_path.read_text(encoding="utf-8"))
                )
        if not slide_ids:
            raise ValueError(f"{path.name}에서 화면 ID를 찾지 못했습니다.")
        order.extend((chapter, slide_id) for slide_id in slide_ids)
    return order


def course_page_catalog(source_project: Path) -> list[dict[str, Any]]:
    """Return the canonical 1-based page list with each page's step range."""
    deck_root = source_project / "deck"
    order = chapter_slide_order(deck_root)
    script_cache: dict[str, dict[str, dict[int, str]]] = {}
    pages: list[dict[str, Any]] = []
    for page, (chapter, slide_id) in enumerate(order, start=1):
        if chapter not in script_cache:
            script_cache[chapter] = parse_script(deck_root / f"script/course/{chapter}.md")
        steps = script_cache[chapter].get(slide_id)
        if not steps:
            raise ValueError(f"{chapter}/{slide_id}의 대본이 없습니다.")
        ordered_steps = sorted(steps)
        pages.append(
            {
                "page": page,
                "chapter": chapter,
                "slideId": slide_id,
                "firstStep": ordered_steps[0],
                "lastStep": ordered_steps[-1],
                "stepCount": len(ordered_steps),
            }
        )
    return pages


def lesson_title_from_source(source: str) -> str:
    """레슨 파일 머리 주석에서 제목 한 줄을 읽는다.

    `* CH01 · L05 · 기업들이 RAG를 도입하는 이유  (12장)` 처럼 쓰여 있으면
    장수 꼬리를 떼고 `CH01 L05 · 기업들이 RAG를 도입하는 이유` 로 만든다.
    읽을 줄이 없으면 빈 문자열을 반환한다.
    """
    for raw in source.splitlines()[:6]:
        line = raw.strip().lstrip("*").strip()
        if not line.upper().startswith("CH"):
            continue
        line = re.sub(r"\s*\(\d+장\)\s*$", "", line)
        parts = [part.strip() for part in line.split("·") if part.strip()]
        if len(parts) >= 3 and re.fullmatch(r"L\d+(?:\.\d+)?", parts[1]):
            return f"{parts[0]} {parts[1]} · " + " · ".join(parts[2:])
        return " · ".join(parts)
    return ""


def chapter_lesson_files(deck_root: Path) -> list[dict[str, Any]]:
    """레슨 파일로 쪼개 둔 챕터의 레슨 파일을 강의 순서대로 반환한다.

    단일 파일로 남아 있는 챕터(ch00 등)는 레슨 경계가 없으므로 건너뛴다.
    그런 챕터는 narration.config.json 의 preset 이 계속 담당한다.
    """
    chapters_dir = deck_root / "src/production/chapters"
    lessons: list[dict[str, Any]] = []
    for path in sorted(chapters_dir.glob("ch[0-9][0-9]-*.ts")):
        chapter = path.name[:4]
        if slide_ids_from_source(path.read_text(encoding="utf-8")):
            continue  # 레슨으로 쪼개지 않은 챕터
        for split_path in sorted((chapters_dir / chapter).glob("*.ts")):
            source = split_path.read_text(encoding="utf-8")
            slide_ids = slide_ids_from_source(source)
            if not slide_ids:
                continue
            match = LESSON_FILE_PATTERN.match(split_path.name)
            if not match:
                raise ValueError(
                    f"{chapter}/{split_path.name} 에 레슨 번호가 없습니다. "
                    "레슨 파일 이름은 NN-LNN[.N]-<슬러그>.ts 여야 합니다."
                )
            lesson = f"l{int(match.group(2)):02d}"
            if match.group(3) is not None:
                lesson += f"-{match.group(3)}"
            lessons.append(
                {
                    "chapter": chapter,
                    "file": split_path.name,
                    "lesson": lesson,
                    "title": lesson_title_from_source(source),
                    "slideIds": slide_ids,
                }
            )
    return lessons


def course_lesson_catalog(
    deck_root: Path,
    pages: list[dict[str, Any]],
) -> list[dict[str, Any]]:
    """영상 한 편 단위의 레슨 목록을 페이지·스텝 수와 함께 반환한다."""
    page_of = {(page["chapter"], page["slideId"]): page for page in pages}
    lessons: list[dict[str, Any]] = []
    used_ids: set[str] = set()
    for entry in chapter_lesson_files(deck_root):
        chapter = entry["chapter"]
        selected = [
            page_of[(chapter, slide_id)]
            for slide_id in entry["slideIds"]
            if (chapter, slide_id) in page_of
        ]
        if not selected:
            continue
        lesson_id = f"{chapter}-{entry['lesson']}"
        if lesson_id in used_ids:
            raise ValueError(
                f"레슨 ID가 겹칩니다: {lesson_id} ({chapter}/{entry['file']}). "
                "한 챕터 안에서 L 번호는 한 번씩만 씁니다."
            )
        used_ids.add(lesson_id)
        lessons.append(
            {
                "id": lesson_id,
                "title": entry["title"] or lesson_id,
                "chapter": chapter,
                "file": entry["file"],
                "startPage": selected[0]["page"],
                "endPage": selected[-1]["page"],
                "pageCount": len(selected),
                "stepCount": sum(int(page["stepCount"]) for page in selected),
            }
        )
    return lessons


def course_entries(
    source_project: Path,
    start_chapter: str,
    start_slide: str | None = None,
    end_slide_number: int | None = None,
) -> list[CourseEntry]:
    """지정한 챕터·슬라이드부터 강의 끝까지의 CourseEntry 목록을 반환한다.

    발음 사전은 deck 저장소 내장 사전과 로컬 프로덕션 사전을 합쳐 적용한다.
    슬라이드 번호(slide_number)는 전체 강의 슬라이드 순서 기반 1-based 값이다.

    Args:
        source_project: udemy-agent 저장소 루트 경로.
        start_chapter:  생성을 시작할 챕터 (예: "ch00").
        start_slide:    None이면 챕터의 첫 슬라이드부터 시작.
    """
    deck_root = source_project / "deck"
    # deck 내장 발음 사전 로드 (영어 약어, 숫자 읽기 등)
    pronunciation = course_pronunciation_dictionary(source_project)
    order = chapter_slide_order(deck_root)
    # 슬라이드 전체 순서 → 1-based 번호 매핑
    global_numbers = {pair: index + 1 for index, pair in enumerate(order)}
    script_cache: dict[str, dict[str, dict[int, str]]] = {}
    entries: list[CourseEntry] = []
    started = False

    for chapter, slide_id in order:
        slide_number = global_numbers[(chapter, slide_id)]
        if end_slide_number is not None and slide_number > end_slide_number:
            break
        # 시작 지점에 도달할 때까지 건너뜀
        if not started:
            chapter_matches = chapter == start_chapter
            slide_matches = start_slide is None or slide_id == start_slide
            started = chapter_matches and slide_matches
        if not started:
            continue
        # 챕터 대본은 처음 접근 시 파싱해 캐시 (같은 챕터의 슬라이드를 반복 파싱 방지)
        if chapter not in script_cache:
            script_cache[chapter] = parse_script(deck_root / f"script/course/{chapter}.md")
        steps = script_cache[chapter].get(slide_id)
        if not steps:
            raise ValueError(f"{chapter}/{slide_id}의 대본이 없습니다.")
        ordered_steps = sorted(steps)
        pending_step_pause = 0
        for step_index, step in enumerate(ordered_steps):
            text = steps[step]
            trailing_pause = 0
            markers = list(FORCED_PAUSE_TOKEN_PATTERN.finditer(text))
            if markers and not text[markers[-1].end():].strip() and step_index + 1 < len(ordered_steps):
                # A recall question may end with [2s], with the answer in the
                # next visual step. Keep the wait outside TTS and attach it to
                # that next step; a marker without any following speech still
                # follows the existing validation error.
                marker = markers[-1]
                trailing_pause = forced_pause_milliseconds(marker.group(0)) or 0
                text = text[:marker.start()].strip()
                if not text:
                    raise ValueError("강제 무음 앞에는 읽을 문장이 있어야 합니다.")
            try:
                segments = split_forced_pause_segments(text)
            except ValueError as error:
                raise ValueError(
                    f"{chapter} {slide_number}페이지 {slide_id} {step}스텝: {error}"
                ) from error
            for part_index, (source_text, pause_before_ms) in enumerate(segments):
                if part_index == 0:
                    pause_before_ms += pending_step_pause
                preflight = pronunciation_preflight(source_text, pronunciation)
                entries.append(
                    CourseEntry(
                        chapter=chapter,
                        slide_id=slide_id,
                        slide_number=slide_number,
                        step=step,
                        source_text=source_text,
                        tts_text=preflight["ttsText"],
                        part_index=part_index,
                        part_count=len(segments),
                        pause_before_ms=pause_before_ms,
                        pronunciation_matches=tuple(
                            f"{item['from']} → {item['to']}"
                            for item in preflight["dictionaryMatches"]
                        ),
                        naturalness_checks=tuple(
                            f"{item['source']} → {item['reading']}"
                            for item in preflight["naturalnessChecks"]
                        ),
                        naturalness_warnings=tuple(preflight["naturalnessWarnings"]),
                        required_pronunciations=tuple(preflight["requiredPronunciations"]),
                        unresolved_tokens=tuple(
                            [*preflight["unresolvedAscii"], *preflight["unresolvedNumbers"]]
                        ),
                    )
                )
            pending_step_pause = trailing_pause

    if not started:
        marker = f"{start_chapter}/{start_slide or '<first>'}"
        raise ValueError(f"시작 화면 {marker}을 찾지 못했습니다.")
    if not entries:
        raise ValueError("선택한 페이지 범위에 대본이 없습니다.")
    return entries


def report_naturalness_warnings(entries: list[CourseEntry]) -> None:
    """Announce unresolved readings; production continues for post-production review."""
    issues = [(entry, warning) for entry in entries for warning in entry.naturalness_warnings]
    if not issues:
        return
    details = "; ".join(
        f"{entry.slide_number}페이지 {warning}" for entry, warning in issues[:8]
    )
    if len(issues) > 8:
        details += f"; 외 {len(issues) - 8}건"
    print(f"[발음 확인 예정] {details}")
    print("사전에 없는 용어도 제작을 계속합니다. 완성 후 영상 검수·수정에서 확인하세요.")


def report_unresolved_terms(entries: list[CourseEntry]) -> list[dict[str, Any]]:
    """Announce every term still spelled in Latin letters before generating.

    A term the dictionary never answered is read however the model feels that
    seed. That is what produced 런팀 and 과드레일, and it is invisible in the
    finished audio until someone listens to all seven hours. The reading is a
    decision, so it belongs in config/production-pronunciation.ko.json — printed
    here, and recorded in the manifest's pronunciation.unresolved, so it can be
    answered instead of discovered.

    Deliberately English spans are marked ``"literal": true`` in the dictionary
    and never reach this list. Missing terms and mixed identifiers are review
    findings, not fatal input errors. Explicit dictionary readings still take
    precedence; production does not persist new readings for unknown tokens.
    """
    unresolved = [
        {
            "chapter": entry.chapter,
            "slideNumber": entry.slide_number,
            "step": entry.step,
            "tokens": list(entry.unresolved_tokens),
        }
        for entry in entries
        if entry.unresolved_tokens
    ]
    if not unresolved:
        return unresolved
    tokens = sorted(
        {token for item in unresolved for token in item["tokens"]}, key=str.casefold
    )
    pages = sorted({int(item["slideNumber"]) for item in unresolved})
    print(
        f"[발음 미지정] {len(tokens)}종이 영문·숫자 그대로 합성됩니다. "
        f"읽는 법을 config/production-pronunciation.ko.json 에 지정하세요."
    )
    print(f"[발음 미지정] 용어: {', '.join(tokens[:24])}"
          + (f" 외 {len(tokens) - 24}종" if len(tokens) > 24 else ""))
    print(f"[발음 미지정] 페이지: {', '.join(str(page) for page in pages[:24])}"
          + (f" 외 {len(pages) - 24}장" if len(pages) > 24 else ""))
    return unresolved


def group_course_entries(entries: list[CourseEntry]) -> list[CourseChunk]:
    """Join nearby visual steps into one natural TTS breath.

    같은 슬라이드 안의 짧은 연속 스텝들을 하나의 청크로 묶어
    TTS 호출 횟수를 줄이고 문장 간 자연스러운 연결을 만든다.

    청킹 조건 (모두 만족해야 같은 청크에 추가):
        - 같은 챕터 + 같은 슬라이드
        - 현재 청크 항목 수가 MAX_CHUNK_ENTRIES 미만
        - 추가 후 누적 문자 수가 MAX_CHUNK_CHARS 이하
    """
    chunks: list[CourseChunk] = []
    current: list[CourseEntry] = []
    current_chars = 0

    for entry in entries:
        # 현재 청크와 같은 슬라이드인지 확인
        same_slide = bool(current) and (
            current[0].chapter == entry.chapter and current[0].slide_id == entry.slide_id
        )
        # 공백 1자 포함 추가 문자 수 계산
        added_chars = len(entry.tts_text) + (1 if current else 0)
        fits = (
            same_slide
            and entry.pause_before_ms == 0
            and len(current) < MAX_CHUNK_ENTRIES
            and current_chars + added_chars <= MAX_CHUNK_CHARS
        )
        if current and not fits:
            # 현재 청크를 확정하고 새 청크 시작
            chunks.append(CourseChunk(tuple(current)))
            current = []
            current_chars = 0
        current.append(entry)
        current_chars += len(entry.tts_text) + (1 if len(current) > 1 else 0)

    if current:
        chunks.append(CourseChunk(tuple(current)))
    return chunks
