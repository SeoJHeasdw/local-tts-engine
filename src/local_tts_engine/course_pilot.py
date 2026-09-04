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
    resolve_model_path,
    sha256_file,
    sha256_text,
    snapshot_revision,
)
from .pronunciation import (
    apply_pronunciation,
    merge_pronunciation_dictionaries,
    pronunciation_preflight,
)
from .speech_quality import (
    ASR_LICENSE,
    ASR_REPOSITORY,
    LEXICAL_FAILURE_DISTANCE,
    LEXICAL_WARNING_DISTANCE,
    MAX_AUTOMATIC_ATTEMPTS,
    MIN_LEXICAL_KEY_LENGTH,
    better_evaluation,
    choose_best_candidate,
    chunk_severity,
    evaluate_candidate,
    quality_summary,
)


# ─── 프로젝트 경로 ────────────────────────────────────────────────────────────
# 기본값은 udemy-agent 저장소 절대 경로. CLI로 재정의 가능.
DEFAULT_SOURCE_PROJECT = Path("/Users/jaehoseo/Desktop/vswrk/edu/udemy-agent")

# 로컬 발음 교체 사전 위치. 존재하지 않으면 빈 목록으로 처리.
LOCAL_PRONUNCIATION_PATH = Path(__file__).parents[2] / "config/production-pronunciation.ko.json"
LOCAL_QUALITY_ASR_PATH = (
    Path(__file__).parents[2] / "artifacts/models/whisper-large-v3-turbo-asr-fp16"
)

# MLX 포팅된 8비트 양자화 강제 정렬 모델 (TTS와 별도 Metal 페이즈에서 실행)
ALIGNER_REPOSITORY = "mlx-community/Qwen3-ForcedAligner-0.6B-8bit"


# ─── 타이밍 상수 (ms) ─────────────────────────────────────────────────────────
# 오프닝 패드: 비디오 플레이어가 첫 프레임을 렌더링하기 전에 발화가 잘리는 것을 방지.
START_PAD_MS = 1300
# 같은 슬라이드 내 스텝 전환 갭: 자연스러운 문장 간 호흡.
STEP_GAP_MS = 200
# 슬라이드 간 갭: 시각적 전환 애니메이션을 덮을 만큼 충분히 길게.
SLIDE_GAP_MS = 750
# 마지막 클립 이후 오디오 꼬리 패드.
END_PAD_MS = 600
# trim_and_fade_audio 가 유성음 경계에서 유지하는 최소 여백.
EDGE_PAD_MS = 65
# 클립 앞뒤에 적용하는 sin²/cos² 페이드 길이.
EDGE_FADE_MS = 24
# 이 값보다 긴 내부 무음 구간은 강제 단축 대상이 된다.
MAX_INTERNAL_SILENCE_MS = 700
# 단축 대상 무음 구간을 이 길이로 줄인다.
TARGET_INTERNAL_SILENCE_MS = 480
# 같은 슬라이드 내 다음 스텝의 첫 단어 몇 ms 전에 화면 전환할지.
STEP_VISUAL_LEAD_MS = 120
# 슬라이드 전환 시 첫 단어보다 더 이른 전환 시점 (슬라이드 빌드 애니메이션 고려).
SLIDE_VISUAL_LEAD_MS = 650
# 한 청크에 담을 최대 문자 수 (TTS 컨텍스트 한계 및 자연스러운 호흡 길이).
MAX_CHUNK_CHARS = 300
# 한 청크에 담을 최대 CourseEntry 수.
MAX_CHUNK_ENTRIES = 4
# 대본의 단독 줄 [2s], [1.5s] 같은 강제 무음 마커 허용 범위.
MIN_FORCED_PAUSE_MS = 100
MAX_FORCED_PAUSE_MS = 10_000
FORCED_PAUSE_LINE_PATTERN = re.compile(r"^\s*\[(\d+(?:\.\d+)?)s]\s*$", re.IGNORECASE)
FORCED_PAUSE_TOKEN_PATTERN = re.compile(r"\[(\d+(?:\.\d+)?)s]", re.IGNORECASE)

# Every clip carries the same trim statistics, including the degenerate clips
# that are too short or too quiet to trim. Manifest assembly and the clip cache
# both read all four keys, so a partial record is a crash and a poisoned cache
# entry rather than a missing detail.
AUDIO_TRIM_STAT_KEYS = (
    "trimmedHeadMs",
    "trimmedTailMs",
    "shortenedSilenceCount",
    "shortenedSilenceMs",
)
UNTRIMMED_AUDIO_STATS: dict[str, int] = {key: 0 for key in AUDIO_TRIM_STAT_KEYS}


# ─── 강의 생성 전용 파라미터 오버라이드 ──────────────────────────────────────
# A/B 비교(pilot.py)보다 temperature·top_p를 낮춰 발화 안정성을 높인다.
COURSE_SETTING_OVERRIDES: dict[str, Any] = {
    "temperature": 0.75,
    "top_p": 0.95,
}


# ─── 데이터 모델 ──────────────────────────────────────────────────────────────

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


# ─── 해시·텍스트 유틸리티 ─────────────────────────────────────────────────────

def stable_digest(value: Any) -> str:
    """임의 JSON 직렬화 가능 값을 결정적 SHA-256 해시로 변환한다.

    sort_keys=True 로 딕셔너리 키 순서를 고정해 Python 버전과 관계없이
    동일한 입력에 동일한 해시를 보장한다. 클립 캐시 키 계산에 사용된다.
    """
    payload = json.dumps(
        value,
        ensure_ascii=False,
        sort_keys=True,
        separators=(",", ":"),
    )
    return hashlib.sha256(payload.encode("utf-8")).hexdigest()


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
        if not spoken:
            raise ValueError("강제 무음 앞에는 읽을 문장이 있어야 합니다.")
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


# ─── 슬라이드 순서 결정 ───────────────────────────────────────────────────────

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


# ─── 레슨(영상 한 편) 카탈로그 ────────────────────────────────────────────────
# 레슨의 정본은 deck 의 레슨 파일 하나다 (chapters/<ch>/NN-LNN-<slug>.ts).
# 파일 하나가 영상 한 편이고, 파일 머리 주석 둘째 줄이 제목, 파일명의 NN 이
# 강의 순서다. 챕터 여는·닫는 화면처럼 단독으로 영상이 못 되는 조각은 deck
# 쪽에서 이미 앞뒤 레슨 파일 안에 들어가 있으므로 여기서 다시 묶지 않는다.

LESSON_FILE_PATTERN = re.compile(r"^(\d+)-L(\d+)(?:\.(\d+))?-")


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


# ─── CourseEntry 수집 ─────────────────────────────────────────────────────────

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
        for step in sorted(steps):
            segments = split_forced_pause_segments(steps[step])
            for part_index, (source_text, pause_before_ms) in enumerate(segments):
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

    if not started:
        marker = f"{start_chapter}/{start_slide or '<first>'}"
        raise ValueError(f"시작 화면 {marker}을 찾지 못했습니다.")
    if not entries:
        raise ValueError("선택한 페이지 범위에 대본이 없습니다.")
    return entries


# ─── 청킹 ────────────────────────────────────────────────────────────────────

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


# ─── 오디오 타이밍 계산 ───────────────────────────────────────────────────────

def milliseconds_to_samples(milliseconds: int, sample_rate: int) -> int:
    """밀리초를 샘플 수로 변환한다 (반올림)."""
    return round(milliseconds * sample_rate / 1000)


def gap_after(current: CourseEntry, following: CourseEntry) -> int:
    """두 연속 엔트리 사이에 삽입할 무음 갭(ms)을 결정한다.

    같은 슬라이드 내 전환은 짧게(STEP_GAP_MS),
    슬라이드 간 전환은 길게(SLIDE_GAP_MS) 설정한다.
    """
    if following.pause_before_ms:
        return following.pause_before_ms
    if current.chapter == following.chapter and current.slide_id == following.slide_id:
        return STEP_GAP_MS
    return SLIDE_GAP_MS


def chunk_gap_after(current: CourseChunk, following: CourseChunk) -> int:
    """두 연속 청크 사이에 삽입할 갭(ms)을 결정한다.

    청크의 마지막·첫 번째 엔트리를 기준으로 gap_after를 위임한다.
    """
    return gap_after(current.entries[-1], following.entries[0])


# ─── 파일 I/O ────────────────────────────────────────────────────────────────

def write_json(path: Path, value: Any) -> None:
    """부모 디렉터리를 자동 생성하고 JSON을 UTF-8로 저장한다."""
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(value, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


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


# ─── 오디오 후처리 ────────────────────────────────────────────────────────────

def trim_and_fade_audio(audio: np.ndarray, sample_rate: int) -> tuple[np.ndarray, dict[str, int]]:
    """Remove generated edge silence while preserving a short natural breath.

    처리 단계:
        1. RMS 기반 유성음 구간 감지 → 앞뒤 무음 트리밍 (EDGE_PAD_MS 여백 보존)
        2. 내부 과도 무음 압축: MAX_INTERNAL_SILENCE_MS 초과 구간을
           TARGET_INTERNAL_SILENCE_MS 로 줄임 (엣지 근처는 보호)
        3. 앞뒤 sin²/cos² 페이드 적용으로 클릭 노이즈 방지

    Returns:
        (처리된 오디오 배열, 처리 통계 딕셔너리)
        통계: trimmedHeadMs, trimmedTailMs, shortenedSilenceCount, shortenedSilenceMs
    """
    samples = np.asarray(audio, dtype=np.float32).reshape(-1)
    # 20ms 프레임, 10ms 홉으로 RMS 계산
    frame = max(1, milliseconds_to_samples(20, sample_rate))
    hop = max(1, milliseconds_to_samples(10, sample_rate))
    if len(samples) < frame:
        return samples, dict(UNTRIMMED_AUDIO_STATS)

    starts = np.arange(0, len(samples) - frame + 1, hop)
    rms = np.sqrt(
        np.array([np.mean(samples[start : start + frame] ** 2) for start in starts])
        + 1e-12  # 수치 안정성을 위한 epsilon
    )
    # 임계값: RMS 최대값의 1.25% 또는 고정 하한(5e-4) 중 큰 값
    threshold = max(5e-4, float(rms.max()) * 0.0125)
    voiced = np.flatnonzero(rms >= threshold)
    if not len(voiced):
        return samples, dict(UNTRIMMED_AUDIO_STATS)

    # 유성음 구간 앞뒤로 EDGE_PAD_MS 여백을 두고 트리밍
    pad = milliseconds_to_samples(EDGE_PAD_MS, sample_rate)
    start = max(0, int(starts[voiced[0]]) - pad)
    end = min(len(samples), int(starts[voiced[-1]]) + frame + pad)
    trimmed = samples[start:end].copy()

    # Qwen occasionally inserts a second-long pause between otherwise adjacent
    # sentences. Keep normal rhetorical pauses, but compact the rare outliers.
    # 트리밍 후 배열에서 다시 RMS를 계산해 내부 과도 무음 구간을 찾는다.
    starts = np.arange(0, max(0, len(trimmed) - frame + 1), hop)
    rms = np.sqrt(
        np.array([np.mean(trimmed[at : at + frame] ** 2) for at in starts])
        + 1e-12
    )
    silent = rms < threshold
    # 연속 무음 프레임의 시작/종료 인덱스를 런-렝스 인코딩 방식으로 수집
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
            # 조건: 엣지 보호 구간 안쪽 & 길이가 임계값 초과인 구간만 압축 대상
            if (
                silence_start > milliseconds_to_samples(EDGE_PAD_MS, sample_rate)
                and silence_end < len(trimmed) - milliseconds_to_samples(EDGE_PAD_MS, sample_rate)
                and duration_ms > MAX_INTERNAL_SILENCE_MS
            ):
                runs.append((silence_start, silence_end))
            run_start = None

    shortened_ms = 0
    if runs:
        # 압축 대상 구간들을 TARGET_INTERNAL_SILENCE_MS 로 줄여 이어 붙인다.
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

    # sin²(0→π/2) 페이드인, cos²(0→π/2) 페이드아웃 적용
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


# ─── 강제 정렬 ────────────────────────────────────────────────────────────────

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


def clean_alignment_token(token: str) -> str:
    """정렬 토큰에서 문자·숫자·아포스트로피만 남기고 구두점을 제거한다.

    ForcedAligner의 어휘에 없는 특수문자를 포함한 토큰을 정규화해
    텍스트와 정렬 결과의 토큰 수를 일치시킨다.
    유니코드 카테고리 L(문자), N(숫자)과 아포스트로피(')만 허용한다.
    """
    return "".join(
        char
        for char in token
        if char == "'" or unicodedata.category(char).startswith(("L", "N"))
    )


def alignment_tokens(text: str) -> list[str]:
    """텍스트를 공백으로 분리한 뒤 각 토큰을 clean_alignment_token으로 정규화한다.

    빈 문자열이 된 토큰은 제외한다 (순수 구두점 토큰 등).
    """
    return [cleaned for token in text.split() if (cleaned := clean_alignment_token(token))]


def entry_alignment_slices(
    chunk: CourseChunk,
    words: list[dict[str, Any]],
) -> list[list[dict[str, Any]]]:
    """청크 전체 단어 정렬 결과를 엔트리별로 분할한다.

    각 엔트리의 토큰 수를 세어 words 리스트를 순서대로 슬라이싱한다.
    토큰 수 불일치는 텍스트 전처리와 정렬 결과가 어긋난 것이므로 즉시 오류를 낸다.

    Returns:
        엔트리별 단어 정렬 딕셔너리 목록 (청크 엔트리 순서와 동일)
    """
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


def merge_step_record_parts(records: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Merge forced-pause speech parts back into one visual-step record."""
    merged: list[dict[str, Any]] = []
    for record in records:
        identity = (record["chapter"], record["slide_id"], int(record["step"]))
        previous_identity = (
            (merged[-1]["chapter"], merged[-1]["slide_id"], int(merged[-1]["step"]))
            if merged
            else None
        )
        if identity != previous_identity:
            merged.append(
                {
                    **record,
                    "key": f"{record['chapter']}--{record['slide_id']}--{record['step']}",
                    "alignment": {"words": list(record["alignment"]["words"])},
                    "chunkKeys": [record["chunkKey"]],
                    "audioPaths": [record["audioPath"]],
                    "forcedPauses": [],
                }
            )
            continue

        previous = merged[-1]
        pause_ms = int(record.get("pause_before_ms", 0))
        if pause_ms <= 0:
            raise RuntimeError(f"{record['key']}의 분할 음성에 강제 무음이 없습니다.")
        previous["source_text"] = f"{previous['source_text']} {record['source_text']}"
        previous["tts_text"] = f"{previous['tts_text']} {record['tts_text']}"
        for field in (
            "pronunciation_matches",
            "naturalness_checks",
            "naturalness_warnings",
            "required_pronunciations",
            "unresolved_tokens",
        ):
            previous[field] = tuple(
                dict.fromkeys([*previous.get(field, ()), *record.get(field, ())])
            )
        previous["speechEndMs"] = int(record["speechEndMs"])
        previous["alignment"]["words"].extend(record["alignment"]["words"])
        previous["chunkKeys"].append(record["chunkKey"])
        previous["audioPaths"].append(record["audioPath"])
        previous["forcedPauses"].append(
            {
                "durationMs": pause_ms,
                "nextSpeechStartMs": int(record["speechStartMs"]),
            }
        )
        previous["part_count"] = max(
            int(previous.get("part_count", 1)), int(record.get("part_count", 1))
        )
        previous["hash"] = stable_digest(
            [previous["hash"], record["hash"], pause_ms]
        )
    return merged


def load_or_create_alignment(
    chunk: CourseChunk,
    clip: dict[str, Any],
    aligner: Any,
    alignment_path: Path,
    use_cache: bool = True,
) -> list[dict[str, Any]]:
    """정렬 캐시가 있으면 읽고, 없으면 ForcedAligner로 생성한 뒤 저장한다.

    정렬은 계산 비용이 크므로 clip 해시가 포함된 파일명으로 캐싱한다.
    aligner=None 이면 캐시 파일이 반드시 존재해야 한다
    (TTS 완료 후 aligner를 로드하지 않은 상태에서 재실행할 때).

    Args:
        chunk:          정렬할 CourseChunk.
        clip:           오디오 경로와 해시를 담은 딕셔너리.
        aligner:        mlx_audio STT 모델 인스턴스 (캐시 히트 시 None 가능).
        alignment_path: 캐시 파일 경로.

    Returns:
        단어별 {"text", "startMs", "endMs"} 딕셔너리 목록.
    """
    if use_cache and alignment_path.is_file():
        return json.loads(alignment_path.read_text(encoding="utf-8"))["words"]
    if aligner is None:
        raise RuntimeError(f"{chunk.key} 정렬 캐시가 없지만 aligner가 로드되지 않았습니다.")

    result = aligner.generate(
        audio=clip["audioPath"],
        text=chunk.tts_text,
        # Space tokenization is deterministic for mixed Korean/English. This
        # forced-aligner API does not feed a separate language token to the model.
        # 공백 기반 토크나이저는 한국어/영어 혼합에서도 결정적이므로 "English" 고정.
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
    # 토큰 수 일관성 검증 후 캐시 저장
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


def resolve_chunk_take(
    chunk: CourseChunk,
    *,
    attempt_limit: int,
    synthesize: Any,
    review: Any | None,
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
    for attempt in range(1, attempt_limit + 1):
        candidates.append(synthesize(chunk, attempt))
        if review is None:
            break
        evaluations.append(review(chunk, candidates[-1]))
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


# ─── 핵심 생성 로직 ───────────────────────────────────────────────────────────

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
    naturalness_issues = [
        (entry, warning)
        for entry in entries
        for warning in entry.naturalness_warnings
    ]
    if naturalness_issues:
        details = "; ".join(
            f"{entry.slide_number}페이지 {warning}"
            for entry, warning in naturalness_issues[:8]
        )
        remaining = len(naturalness_issues) - 8
        if remaining > 0:
            details += f"; 외 {remaining}건"
        raise ValueError(f"한국어 자연스러움 사전검사 실패: {details}")
    chunks = group_course_entries(entries)
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

    # 루프 전 초기화 (첫 번째 클립에서 샘플레이트가 결정된다)
    target_samples: int | None = None
    native_rate: int | None = None
    cursor_samples: int | None = None
    selected_chunks: list[dict[str, Any]] = []
    generation_ms = 0
    cache_hits = 0
    peak_memory_gb = 0.0

    def synthesize_candidate(chunk: CourseChunk, attempt: int) -> dict[str, Any]:
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
            started = time.perf_counter()
            generation_args = {
                "text": chunk.tts_text,
                "ref_audio": str(reference_path),
                "lang_code": spec.language,
                "verbose": False,
                **settings,
            }
            if model_key == "qwen3-tts":
                generation_args["ref_text"] = reference_text
            results = list(model.generate(**generation_args))
            generation_ms += round((time.perf_counter() - started) * 1000)
            if not results:
                raise RuntimeError(f"{chunk.key} 후보 {attempt}에서 오디오가 생성되지 않았습니다.")
            rate = int(results[0].sample_rate)
            if any(int(result.sample_rate) != rate for result in results):
                raise RuntimeError(f"{chunk.key} 후보 {attempt}의 샘플레이트가 일치하지 않습니다.")
            raw_audio = np.concatenate([np.asarray(result.audio) for result in results])
            audio, trim_info = trim_and_fade_audio(raw_audio, rate)
            sf.write(clip_path, audio, rate, subtype="PCM_24")
            write_json(clip_meta_path, trim_info)
            frames = len(audio)
            peak_memory_gb = max(
                peak_memory_gb,
                *(float(result.peak_memory_usage) for result in results),
            )
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

    def transcribe(audio_path: str, temperature: float) -> str:
        """Read one clip back with the independent ASR."""
        nonlocal quality_evaluation_ms
        started = time.perf_counter()
        result = quality_model.generate(
            audio_path,
            language="ko",
            task="transcribe",
            temperature=temperature,
            return_timestamps=False,
            condition_on_previous_text=False,
            max_tokens=768,
        )
        quality_evaluation_ms += round((time.perf_counter() - started) * 1000)
        return result.text

    def evaluate(chunk: CourseChunk, candidate: dict[str, Any]) -> dict[str, Any]:
        """Judge one take, ruling out decoder noise before blaming the take.

        A first reading that finds nothing wrong is trusted. A reading that does
        find something gets a second, differently decoded opinion, and the clip
        keeps whichever reading is kinder — evidence only stands when it
        survives every attempt to read the audio.
        """
        def read(temperature: float) -> dict[str, Any]:
            return evaluate_candidate(
                expected_text=chunk.tts_text,
                recognized_text=transcribe(candidate["audioPath"], temperature),
                audio_path=Path(candidate["audioPath"]),
                dictionary=pronunciation,
                required_pronunciations=chunk.required_pronunciations,
                attempt=int(candidate["attempt"]),
                seed=int(candidate["seed"]),
            )

        evaluation = read(0.0)
        if not evaluation["passed"]:
            evaluation = better_evaluation(evaluation, read(0.2))
        evaluation["hash"] = candidate["hash"]
        return evaluation

    for index, chunk in enumerate(chunks):
        take = resolve_chunk_take(
            chunk,
            attempt_limit=quality_attempts if automatic_quality else 1,
            synthesize=synthesize_candidate,
            review=evaluate if automatic_quality else None,
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
            cursor_samples = milliseconds_to_samples(START_PAD_MS, native_rate)
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
    cursor_samples = milliseconds_to_samples(START_PAD_MS, native_rate)
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


def entries_for_item(item: dict[str, Any]) -> CourseEntry:
    """manifest entries 항목 딕셔너리를 CourseEntry 인스턴스로 복원한다.

    manifest.json을 다시 읽어 CourseEntry가 필요한 후처리에서 사용한다.
    """
    return CourseEntry(
        chapter=item["chapter"],
        slide_id=item["slide_id"],
        slide_number=int(item["slide_number"]),
        step=int(item["step"]),
        source_text=item["source_text"],
        tts_text=item["tts_text"],
    )


# ─── CLI ──────────────────────────────────────────────────────────────────────

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
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
