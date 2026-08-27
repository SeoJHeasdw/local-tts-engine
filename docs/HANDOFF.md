# 프로젝트 인수인계

> 작성일: 2026-08-25
> 상태: 로컬 제작 앱 고도화 완료 — 텍스트 다중 후보, 경로 설정, 자산 이관, 영상 캐시 우회 적용

## 1. 사용자의 목표

한국어 AI Agent 온라인 강의의 대본을 사용자의 목소리로 TTS 생성하고, 기존
자동화가 자막·슬라이드·영상까지 합성하게 한다. 대본이 자주 바뀌므로 원하는
구간만 다시 생성할 수 있어야 하며, 전체 강의와 반복 수정에서 글자당 과금이
생기지 않는 것이 중요하다.

사용자는 먼저 CH01 파일럿으로 품질을 확인하고, 통과한 뒤 범위를 늘리길 원한다.
자막 스타일과 영상 화면 리듬은 이미 별도 파이프라인에서 많이 개선되었다.

## 2. 로컬 우선으로 바꾼 이유

- 현재 강의 나레이션: 157,838자, 965개 스텝, 추정 약 7시간 58분
- CH01: 37,801자, 192개 스텝
- 클라우드 TTS는 전체 1회 생성과 수정 재생성에 지속적인 크레딧이 든다.
- 사용자 장비는 MacBook M4 Max, 통합 메모리 36GB다.
- 결론: ElevenLabs 결제는 보류하고 Apple Silicon 로컬 추론을 먼저 검증한다.

로컬이 음질 면에서 무조건 우월하다는 결론은 아니다. 비용과 수정 자유도는
유리하지만 한국어 발음, 사용자 음색 유사도, 장문 안정성은 반드시 A/B 청취로
판정한다.

## 3. 확보한 사용자 음성

원본은 2026-08-26부터 다음 로컬 정본 저장소에 있다.

`/Users/jaehoseo/Desktop/vswrk/edu/local-tts-engine/data/private/voice/`

이관 전 위치인 `udemy-agent/deck/voice/`는 삭제하지 않고 복구용 사본으로
남겼다. 두 위치의 20개 파일은 이관 직후 차이가 없음을 확인했다.

| 구분 | 상태 |
| --- | --- |
| 원본 다섯 파일 | DJI Mic Mini 2 녹음, 합계 약 54분 23초 |
| 정제 마스터 | 48kHz, mono, PCM 24-bit, 유효 53분 20초 |
| 업로드용 파생본 | 48kHz, mono, MP3 256kbps |
| 파일별 음량 | 약 -25.11~-25.05 LUFS |
| 파일별 true peak | 약 -2.96~-2.84 dBTP |

사용자는 말이 꼬이면 약 3초 멈춘 뒤 다시 읽는 규칙을 지켰고, 표시된 실패
테이크는 정제본에서 제거했다. EQ, 노이즈 제거, 음색 보정은 적용하지 않았다.

정제 파일과 수치의 정본:

- `deck/voice/training/pvc/README.md`
- `deck/voice/training/pvc/manifest.json`
- `deck/voice/training/pvc/master-wav/`

53분 전체를 첫 zero-shot 요청에 쓰지 않는다. 잡음·호흡·억양이 안정적인
10~20초를 먼저 고르고 정확한 전사문과 짝지어 사용한다. 전체 세트는 향후
미세조정 또는 다른 공급자 학습용으로 보존한다.

## 4. 기존 제작 파이프라인

정본 문서:

- `/Users/jaehoseo/Desktop/vswrk/edu/udemy-agent/NARRATION-PIPELINE.md`
- `/Users/jaehoseo/Desktop/vswrk/edu/udemy-agent/VIDEO-PACING-GUIDELINES.md`
- `/Users/jaehoseo/Desktop/vswrk/edu/udemy-agent/deck/narration/README.md`

기존 Node 도구 `deck/tools/narration.mjs`는 이미 다음을 구현한다.

- 마크다운 대본을 화면 ID와 스텝 단위로 파싱
- 자막 원문과 발음 사전 적용 TTS 문장을 분리
- 공급자·모델·목소리·텍스트를 포함한 해시 캐시
- 실제 오디오 길이 측정, 타임라인과 SRT/VTT 생성
- Playwright 슬라이드 자동 캡처
- H.264/AAC 영상과 화면 자막 합성본 생성
- 한 스텝만 고치면 해당 음성 클립만 재생성

로컬 엔진은 이 계약을 대체하지 않고 새로운 TTS provider로 연결한다.

## 5. 모델 후보

### 1순위

Qwen3-TTS 1.7B Base를 MLX-Audio로 실행한다.

- 한국어 지원
- 짧은 참조 음성 기반 voice clone
- 재사용 가능한 voice prompt 후보
- Apple Silicon용 MLX 경로

### 비교군

Chatterbox Multilingual V3를 같은 MLX-Audio 환경에서 실행한다.

- 한국어 지원
- 짧은 참조 음성 기반 zero-shot clone
- Qwen과 동일 원문·동일 참조·동일 출력 포맷으로 비교

Fish Speech는 라이선스와 운영 복잡도 때문에 첫 비교군에서 제외했다.

모델과 라이브러리의 최신 라이선스·설치법은 실제 설치 시 공식 저장소에서
다시 확인한다. 과거 검토 시 Qwen3-TTS는 Apache-2.0, MLX-Audio와 Chatterbox는
MIT로 확인했지만 이 문장만으로 상업 이용 결정을 확정하지 않는다.

## 6. 다음 작업의 정확한 범위

1. 공식 설치법과 현재 Apple Silicon 호환 버전을 확인한다.
2. 사용자가 이미 쓰는 Python 3.13.12로 독립 가상환경을 만든다.
3. Qwen3-TTS 1.7B Base와 Chatterbox V3를 설치·다운로드한다.
4. 정제 음성에서 10~20초 참조 후보를 2~3개 고르고 전사문을 맞춘다.
5. CH01의 동일한 30~60초 대본을 두 모델로 생성한다.
6. 생성 시간, 최대 메모리, 오류와 반복을 기록한다.
7. 사용자가 두 파일을 블라인드에 가깝게 듣고 승인한다.
8. 승자만 기존 `narration.mjs`에 `local` provider로 연결한다.

첫 작업에서 미세조정, CH01 전체 생성, 전체 7~8시간 생성까지 진행하지 않는다.

## 7. 사용자의 품질 성향

- 활자와 빠른 정보 밀도에 익숙하고 일반 영상을 2배속으로 보는 편이다.
- 강의가 답답해지는 것을 매우 민감하게 느낀다.
- 과장된 AI 억양보다 오래 들어도 피곤하지 않은 설명체를 선호한다.
- 오타, 뭉개진 억양, 버벅임을 수정 가능하게 만들려는 것이 TTS의 핵심 목적이다.
- 말뿐인 계획보다 짧은 완성 샘플을 직접 듣고 보는 방식의 검증을 선호한다.

따라서 모델 선택에서도 첫인상보다 10분 이상 들을 때의 피로도, 문장 끝 억양의
반복, 영어 약어 발음을 중요하게 본다.

## 8. 복제하지 않은 것

- 이 대화의 내부 세션 상태 자체는 파일로 복제할 수 없다. 대신 이 문서와
  `AGENTS.md`에 필요한 결론과 다음 지점을 영구화했다.
- 로그인 세션, API 키, 토큰은 보안상 복제하지 않았다.
- 모델 가중치와 Hugging Face 공용 캐시는 복제하지 않았다.

## 9. 2026-08-25 현재 구현 상태

섹션 6의 A/B 계획은 완료된 과거 계획이다. 현재 제작 프로필은 Qwen3-TTS 1.7B
Base BF16 + 짧은 참조 음성·전사 + `jaeho-ko-r16-v1` LoRA 강도 `0.60`이다.
Chatterbox V3는 제외했다. `0.60`은 LoRA `1.00`에서 두드러진 사람 발화 노이즈와
과한 AI 특성을 줄여 장시간 강의에 가장 적합하다고 사용자가 승인한 값이다.

강의용 생성기는 `src/local_tts_engine/course_pilot.py`다.

- 같은 슬라이드의 2~4개 스텝, 최대 300자를 한 호흡으로 생성
- 생성 온도 0.75, top_p 0.95
- 앞뒤 무음 정리, 24ms 경계 페이드
- 같은 슬라이드 클립 간격 200ms, 슬라이드 간격 750ms
- 700ms 초과 내부 무음만 480ms로 축소
- `config/production-pronunciation.ko.json`에서 제작용 발음 예외 관리
- Qwen3-ForcedAligner 0.6B 8-bit로 실제 단어 시각 생성
- `export_udemy.py`가 정렬값을 기존 Node 타임라인 계약으로 전달

`udemy-agent/deck/tools/narration.mjs`는 정렬 단어로 SRT/VTT와 화면 자막을
만들고, 다음 스텝 첫 단어 120ms 전에 화면을 전환한다. Playwright의 가변 녹화
지연은 마젠타 동기 마커 프레임으로 측정해 제거한다.

### 완성된 산출물 (2026-08-25)

| 항목 | 경로 |
| --- | --- |
| TTS 음성·매니페스트 | `artifacts/course-pilots/2026-08-25/qwen3-tts-first-10m/` |
| 최종 자막 영상 | `deck/render/narration/qwen3-first-10m/qwen3-first-10m-captioned.mp4` |
| SRT/VTT/타임라인 | 같은 `qwen3-first-10m/` 디렉터리 |

영상 수치:

- 9분 47.4초, 19개 화면, 67개 스텝, 26개 음성 청크
- H.264 1920×1080 25fps, AAC 48kHz mono, 55.2 MB, 자막 199큐
- 첫 슬라이드: `open-cover` (1.3초 시작), 마지막: `promptify-promptify`
- Metal 메모리 peak 11.6 GB

이전 old 산출물:

- `artifacts/course-pilots/2026-08-23-old/`, `2026-08-24-old/`
- `deck/render/narration/qwen3-first-10m-old/`, `qwen3-first-5m-old/`

### 레슨 단위 preset 설계 (2026-08-25)

영상 수정 시 해당 레슨 구간만 재합성할 수 있도록 레슨 단위 preset을
`udemy-agent/deck/narration.config.json`에 추가했다.

| preset | 제목 | 슬라이드 범위 | 장수 |
| --- | --- | --- | --- |
| `ch00` | CH00 강의 프레임 전체 | `open-cover` → `open-say-2` | 11장 |
| `ch01-l00` | CH01 L00 챕터 프레임 | `frame-genai-cover` | 1장 |
| `ch01-l01` | CH01 L01 일을 시키는 방법 | `promptify-shot` → `promptify-lanes-gap` | 18장 |
| `ch01-l02` | CH01 L02 LLM은 무엇인가 | `llm-open` → `llm-recap` | 28장 |
| `ch01-l03` | CH01 L03 생성형 AI의 구조적 한계 | `genai-limit-say-1` → `genai-limit-say-3` | 7장 |
| `ch01-l04` | CH01 L04 RAG란 무엇인가 | `rag-open` → `rag-recap` | 8장 |
| `ch01-l05` | CH01 L05 RAG 도입 이유 | `rag-why-say` → `rag-why-def` | 3장 |
| `ch01-l06` | CH01 L06 RAG가 못 하는 것 | `rag-why-split` → `rag-gap-say-3` | 6장 |
| `ch01-l07` | CH01 L07 Agent란 무엇인가 | `agent-def-warn-1` → `agent-def-scale` | 13장 |
| `ch01-l08` | CH01 L08 RAG와 Agent의 차이 | `rag-vs-agent-say` → `rag-vs-agent-design-principle` | 6장 |
| `ch01-l09` | CH01 L09 Workflow와 Agent의 차이 | `rag-vs-agent-case` → `workflow-check-2` | 13장 |
| `ch01-l10` | CH01 L10 Agent가 필요한 이유 | `agent-cost-say` → `agent-cost-check` | 3장 |
| `ch01-l11` | CH01 L11 Agent 도입 금지 | `agent-dont-warn` → `agent-dont-plan` | 4장 |
| `ch01-l00-end` | CH01 L00 챕터 요약·전환 | `frame-genai-chapter-summary` → `frame-genai-next-question` | 2장 |

### 다음 세션의 작업 순서

CH01 레슨별 TTS 생성 → export → captions → capture 순서로 진행한다.
**한 레슨씩 승인받아 다음으로 넘어간다.**

각 레슨 생성 명령 패턴:

```bash
# TTS 생성 (예: L01)
cd /Users/jaehoseo/Desktop/vswrk/edu/local-tts-engine
.venv/bin/python -m local_tts_engine.course_pilot \
  --reference artifacts/benchmarks/2026-08-23/reference.wav \
  --reference-text artifacts/benchmarks/2026-08-23/reference.txt \
  --output-dir artifacts/course-pilots/$(date +%Y-%m-%d)/ch01-l01 \
  --start-chapter ch01 \
  --start-slide promptify-shot \
  --target-seconds <예상초> \
  --seed 20260825

# export
.venv/bin/python -m local_tts_engine.export_udemy \
  --source-dir artifacts/course-pilots/$(date +%Y-%m-%d)/ch01-l01 \
  --deck-root /Users/jaehoseo/Desktop/vswrk/edu/udemy-agent/deck \
  --preset ch01-l01 \
  --provider qwen3-local

# captions + capture
cd /Users/jaehoseo/Desktop/vswrk/edu/udemy-agent/deck
node tools/narration.mjs captions --preset ch01-l01 --provider qwen3-local
node tools/narration.mjs capture --preset ch01-l01 --provider qwen3-local --burn-captions
```

레슨별 예상 길이 (대본 글자 수 기준 추정, 실측 필요):

| preset | 예상 길이 | `--target-seconds` |
| --- | --- | --- |
| ch01-l01 | ~15분 | 900 |
| ch01-l02 | ~25분 | 1500 |
| ch01-l03 | ~5분 | 300 |
| ch01-l04 | ~7분 | 420 |
| ch01-l05 | ~3분 | 180 |
| ch01-l06 | ~6분 | 360 |
| ch01-l07 | ~11분 | 660 |
| ch01-l08 | ~6분 | 360 |
| ch01-l09 | ~10분 | 600 |
| ch01-l10 | ~2분 | 120 |
| ch01-l11 | ~4분 | 240 |

승인 전에는 다음 레슨으로 넘어가지 않는다.

## 10. 로컬 제작 앱 고도화 (2026-08-26)

Electron 앱에 독립된 `목소리 만들기` 화면을 추가했다.

- 텍스트만 입력해 2~8개 발화 후보 생성
- 전역 설정의 병렬 수에 따라 최대 2개씩 동시 생성
- 후보별 오디오 재생, 하나를 선택해 `selected.wav`로 보관
- 후보와 선택 결과는 `output/voices/<date>/<name>/`에 저장
- 각 후보는 새 시드로 추론하며 기존 오디오 결과를 읽지 않음
- 텍스트 후보의 서로 다른 시드는 비교 선택을 위한 의도적 다양성이다. 강의 TTS는
  고정된 제작 시드와 의미 단위 청킹을 사용하므로 후보 간 편차를 강의 생성의
  불안정성으로 해석하지 않는다.

모델 설정의 이전 버전에는 다음 경로 선택 항목이 있었고 값은 Git에서 제외되는
`artifacts/app-settings.json`에 저장된다.

- 강의 소스 프로젝트
- 내 목소리 원본
- TTS 작업 결과
- 텍스트 목소리 후보
- 자막·타임라인 결과
- 완성 영상 결과
- 참조 음성과 참조 전사문

이 개별 출력 경로 UI는 2026-08-27 단일 `output` 폴더 설정으로 대체됐다.
`udemy-agent`에는 강의 대본·슬라이드 UI와 캡처 실행 코드만 남는다.

앱의 강의 영상 제작은 항상 `course_pilot --no-cache`와 캡처 `--no-cache`를
사용한다. 음성 클립, ForcedAligner JSON, Chromium HTTP 캐시를 재사용하지
않는다. 독립 CLI의 기본 캐시 동작은 이전 호환성을 위해 유지한다.

## 11. 제작 화면 정보 패널 개편 (2026-08-26)

이 절의 정보 중심 패널은 2026-08-27 제품화 정리에서 더 간결한 작업 요약으로
대체됐다.

- 새 영상 화면의 `02 진행 상황` 빈 대기 화면을 `제작 브리프`로 교체했다.
  선택 범위, 제작 음성, 산출물, 자막 방식, 캐시 정책, 검증 단계와 저장 위치를
  실행 전에 실시간으로 보여 준다. 실행 중에는 단계 진행, 완료 후에는 검수 결과로
  같은 공간의 역할이 전환된다.
- 목소리 만들기의 안내 카드를 `발화 설계` 패널로 교체했다. 글자 수, 줄바꿈 호흡,
  후보 수, 병렬 계획, 현재 LoRA 프로필과 감지한 영문 용어를 실시간으로 표시한다.
- 텍스트 후보 입력의 줄바꿈을 더 이상 공백으로 합치지 않는다. 비어 있지 않은 각
  줄을 호흡 단위로 보존해 TTS에 전달한다.
- 큰 장식 아이콘과 중앙 정렬 안내문을 제거하고, 낮은 대비의 정보 카드와 짧은
  상태 라벨을 사용했다. `prefers-reduced-motion`도 반영한다.

## 12. 제작 탐색과 사람 검수 UX (2026-08-27)

- 새 영상 화면에 챕터 빠른 이동, 이전·다음 페이지, 챕터 전체 선택을 추가했다.
  현재 선택 범위의 챕터·페이지·스텝 수를 실행 전에 계산한다.
- 최근 결과에 이름 검색과 강의·목소리·편집·확인 필요 필터, 전체·청취 승인·확인
  필요 요약을 추가했다.
- 자동 검증과 사람의 최종 청취 판단을 분리했다. `청취 승인`은 각 결과의
  `validation-report.json` 안 `review` 필드에 기록하며 승인 취소도 지원한다.
- 모델 설정이 승인된 제작 프로필 `Qwen3-TTS + jaeho-ko-r16-v1 + 0.60`과 다르면
  실험 설정 경고를 표시하고, 승인값을 복원하는 버튼을 제공한다.
- 비차단 완료·오류 알림을 추가했다. 이때 넣었던 화면 전환·실행 단축키는 이후
  시각적 복잡도를 줄이는 과정에서 제거했다.

## 13. 결과물 폴더 단순화 (2026-08-27)

- 설정 화면에서 TTS·목소리 후보·자막·영상의 개별 출력 경로를 제거했다.
- 사용자는 `강의 소스`, `내 목소리 원본`, `결과물 폴더`만 선택한다. 참조 음성과
  전사문은 `고급 입력 설정`에 접어 두었다.
- 기본 결과물 폴더는 프로젝트의 `output/`이다. 앱이 `videos`, `voices`, `tts`,
  `projects`, `edits` 하위 폴더를 자동 생성한다.
- 기존 `artifacts/` 결과는 이동하거나 삭제하지 않는다. 최근 결과 목록과 열기,
  Finder 표시, 청취 승인은 레거시 경로에서도 계속 동작한다.

## 14. 기본 작업 흐름 제품화 (2026-08-27)

- 새 영상의 기본 범위를 페이지 번호가 아닌 `narration.config.json`의 실제 레슨
  이름으로 바꿨다. 개발용·파일럿 preset은 레슨 목록에서 제외한다.
- 결과 이름, 산출물 종류와 자막 옵션은 `세부 설정`으로 내렸다. 기본 화면은 레슨
  선택과 제작 시작에 집중한다.
- 제작 브리프의 캐시·동기화·검증 카드와 저장 경로를 제거하고 범위·목소리·결과만
  남겼다. 처리 방식은 접힌 설명에서 확인한다.
- 목소리 만들기의 별도 발화 분석 패널을 제거했다. 텍스트, 짧은 입력 피드백,
  생성 버튼만 기본 노출하고 후보 수와 결과 이름은 접었다.
- 최근 결과의 통계 카드와 seed 같은 개발 메타데이터를 제거하고, 사용자 언어로
  `파일 확인 완료`와 `직접 확인 완료`만 표시한다.
- 모델·어댑터·LoRA 강도·병렬 수와 파인튜닝은 `고급 모델 설정` 안으로 이동했다.

## 15. 가독성 정리 (2026-08-27)

- 사이드바의 `⌘1`~`⌘4` 표시와 숨은 키보드 단축키 동작을 제거했다.
- 실제 화면에 노출되는 글자는 최소 10px로 올렸다. 주요 입력·버튼·레슨·결과
  텍스트는 11~14px, 화면 제목은 36px로 조정했다.
- 이전 UI에서 제거된 제작 브리프, 결과 통계, 발화 분석 패널의 미사용 스타일도
  함께 삭제했다.
