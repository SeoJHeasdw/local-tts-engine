"""Course production constants and default paths."""

import re
from pathlib import Path
from typing import Any


# ─── 프로젝트 경로 ────────────────────────────────────────────────────────────
# 기본값은 udemy-agent 저장소 절대 경로. CLI로 재정의 가능.
DEFAULT_SOURCE_PROJECT = Path("/Users/jaehoseo/Desktop/vswrk/edu/udemy-agent")

# 로컬 발음 교체 사전 위치. 존재하지 않으면 빈 목록으로 처리.
LOCAL_PRONUNCIATION_PATH = Path(__file__).parents[3] / "config/production-pronunciation.ko.json"
LOCAL_QUALITY_ASR_PATH = (
    Path(__file__).parents[3] / "artifacts/models/whisper-large-v3-turbo-asr-fp16"
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


LESSON_FILE_PATTERN = re.compile(r"^(\d+)-L(\d+)(?:\.(\d+))?-")
