# 아키텍처와 연동 계약

## 책임 분리

```text
udemy-agent                           local-tts-engine
강의 대본·슬라이드 UI ── 제작 입력 ─▶ 모델 로드·음성 생성
캡처 실행 코드        ── 화면 프레임 ─▶ 타임라인·자막·완성 영상 보관
```

`local-tts-engine`은 제작 앱, 개인 음성 원본, TTS 작업, 자막·타임라인과 완성
영상을 책임진다. `udemy-agent`에는 강의 대본, 슬라이드 UI와 기존 캡처 실행
코드만 남긴다. 앱은 `export_udemy.py`로 타임라인 계약을 넘긴 뒤
`captions.mjs`와 `capture.mjs`를 각각 실행한다. 산출물 위치는 로컬 설정으로
지정한다. `narration.mjs`는 과거 명령의 하위 호환만 담당한다.

## 권장 구현 단계

### 1단계: 독립 CLI

개발과 벤치마크가 쉬운 명령부터 만든다.

```text
local-tts synthesize
  --model <model-key>
  --voice-profile <profile-key>
  --text-file <utf8-text>
  --output <wav-path>
  --metadata <json-path>
```

### 2단계: 재사용 음성 프로필

참조 음성, 정확한 전사와 모델별 prompt를 하나의 프로필로 묶는다. 원본 음성은
`data/private/voice/`의 불변 정본을 읽기 전용으로 사용하고 해시를 기록한다.

### 3단계: 기존 Node 파이프라인 연동

로컬 엔진 결과를 `deck/tools/course-media.mjs`의 타임라인 계약으로 내보낸다.
자막 생성은 `deck/tools/captions.mjs`, 화면 촬영·영상 결합은
`deck/tools/capture.mjs`로 분리한다. 예전 `narration.mjs captions/capture`
명령은 기존 자동화가 깨지지 않도록 호환 진입점으로만 유지한다.

### 4단계: 로컬 제작 허브

Electron 앱이 강의 소스 경로와 모든 산출물 경로를 로컬 JSON에 저장한다.
임의 텍스트는 2~8개 후보로 생성해 사용자가 직접 선택하고, 강의 영상 제작은
항상 TTS·정렬·브라우저 캐시를 우회한다.

텍스트 후보는 비교를 위해 후보마다 다른 시드를 쓴다. 강의 제작은 고정 시드와
의미 단위 청킹을 사용하므로 캐시를 우회해도 생성 조건은 재현 가능하게 유지한다.

## 요청 필드

| 필드 | 뜻 |
| --- | --- |
| `sourceText` | 자막과 화면에 쓰는 수정 전 원문 |
| `ttsText` | 발음 사전을 적용해 모델에 보낼 문장 |
| `voiceProfile` | 사용자 음성 프로필 키 |
| `model` | 재현 가능한 모델·양자화 키 |
| `seed` | 모델이 지원할 때 재현성 확보용 값 |
| `outputPath` | 생성할 WAV 경로 |

## 대본 시간 제어

강의 대본에서 같은 화면 스텝의 자동 애니메이션과 발화를 맞춰야 할 때는
`[2s]`, `[1.5s]`처럼 단독 줄에 쓴 마커를 사용한다. 엔진은 마커 앞뒤를 별도
음성 조각으로 합성하고 지정한 무음을 삽입하지만, 화면 타임라인과 자막에서는
다시 하나의 스텝과 연속된 원문으로 내보낸다. 마커 자체는 읽거나 자막에 넣지
않는다. 허용 범위는 0.1~10초이며, 일반적인 문장 호흡은 TTS에 맡긴다.

한 줄 전체가 괄호인 제작 지시문은 TTS·자막에서 제외하지만 시간은 만들지
않는다. 실제 대기가 필요하면 괄호 설명 대신 `[Ns]`를 사용한다.

## 응답 메타데이터

| 필드 | 뜻 |
| --- | --- |
| `audioPath` | 최종 WAV 절대 경로 |
| `durationMs` | 실제 파일에서 측정한 길이 |
| `sampleRate` | 출력 샘플레이트 |
| `model` | 실제 사용한 모델과 리비전 |
| `voiceProfileHash` | 참조 음성과 전사 조합의 해시 |
| `textHash` | TTS 문장과 설정 조합의 해시 |
| `generationMs` | 순수 생성 소요 시간 |

## 캐시 정책

독립 CLI는 실험 재현성과 부분 재생성을 위해 해시 캐시를 지원한다. 캐시 키에는
최소한 아래 값을 모두 포함한다.

- `ttsText`
- 모델 저장소와 정확한 리비전
- 양자화 방식
- 음성 프로필 해시
- 언어·속도·seed 등 생성 설정
- 엔진 스키마 버전

같은 대본 한 스텝만 바뀌면 그 클립만 다시 생성되어야 한다. 모델이나 음성
프로필이 바뀌면 전체 길이가 달라질 수 있으므로 기존 타임라인은 다시 만든다.

로컬 제작 앱은 `course_pilot --no-cache`와 캡처의 `--no-cache`를 항상 전달한다.
따라서 앱에서 만드는 영상은 기존 음성 클립, 강제 정렬 JSON, Chromium HTTP
캐시를 읽지 않는다.

## 파일 정책

- 모델은 사용자 공용 Hugging Face 캐시에 둔다.
- 벤치마크 출력은 `artifacts/`에 두고 Git에서 제외한다.
- 소스 녹음은 `data/private/voice/`를 읽기 전용으로 사용한다.
- 앱에서는 단일 `outputRoot`만 설정하고 기본값은 프로젝트의 `output/`이다.
- `output/videos`, `output/voices`, `output/tts`, `output/projects`, `output/edits`는
  앱이 자동으로 만들고 관리한다.
- 실제 입력 경로와 `outputRoot`는 `artifacts/app-settings.json`에 저장한다.
- 이전 `artifacts/course-pilots`, `artifacts/voice-candidates`,
  `artifacts/production`, `artifacts/video-edits` 결과는 읽기 호환만 유지한다.

## 결과 검수 상태

앱의 자동 검증과 사용자 청취 승인은 서로 다른 상태다. 자동 검증은 음성·영상
파일, 실제 길이, 타임라인과 자막 범위를 검사한다. 사용자가 결과를 직접 들은 뒤
누르는 `청취 승인`은 같은 산출물 폴더의 `validation-report.json`에 선택 필드로
추가한다.

```json
{
  "review": {
    "status": "approved",
    "updatedAt": "2026-08-27T00:00:00.000Z"
  }
}
```

승인 취소는 `status`를 `pending`으로 바꾼다. 자동 검증 결과는 이 동작으로
변경하지 않는다.

## 자동 발음 검수와 부분 재생성

강의 제작의 기본 음성 경로는 다음 폐루프를 사용한다.

```text
자막 원문
  → TTS 전용 발음문·숫자 정규화
  → 위험 청크 최대 3개 후보 생성
  → Qwen TTS 메모리 해제
  → Whisper large-v3-turbo 독립 받아쓰기·파형 검사
  → 통과 후보 중 최저 오류 후보 자동 선택
  → Qwen ForcedAligner 단어 시각 생성
```

위험 청크는 발음문이 원문과 달라졌거나 미해결 영문·숫자가 남은 청크다. 일반
한국어 청크도 Whisper 검사는 받지만 기본 후보는 하나만 만든다. 후보가 모두
실패해도 가장 나은 결과와 점수는 보존하고 `quality.summary.needsReview`에
챕터·화면 ID·페이지 번호를 기록한다. 앱은 이 페이지를 최근 결과에 표시한다.

페이지 타임라인이 있는 영상의 음성 재생성은 전체 오디오 트랙을 교체하지 않는다.
선택 페이지 앞·교체 구간·뒤를 분리하고 교체 구간만 새 길이에 맞춘 뒤 다시
잇는다. 이후 타임라인도 길이 차이만큼 이동해 다음 부분 수정이 가능하게 유지한다.
