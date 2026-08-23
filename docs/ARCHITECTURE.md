# 아키텍처와 연동 계약

## 책임 분리

```text
udemy-agent                           local-tts-engine
대본 파싱·발음 사전 ── TTS 요청 ──▶ 모델 로드·음성 생성
타임라인·자막·영상   ◀─ WAV+메타 ── 음성 프로필·추론 캐시
```

`local-tts-engine`은 음성 생성만 책임진다. 슬라이드 캡처, 자막 cue 생성,
영상 합성은 기존 프로젝트에 남긴다.

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

참조 음성, 정확한 전사, 모델별 prompt/cache를 하나의 프로필로 묶는다. 원본
음성을 복사하지 않고 경로와 해시를 기록한다.

### 3단계: 기존 Node 파이프라인 연동

`deck/tools/narration.mjs`에 `local` provider를 추가한다. 초기에는 CLI를
호출하고, 반복 실행에서 모델 재로딩 비용이 크면 `127.0.0.1` 전용 HTTP
서비스로 바꾼다.

## 요청 필드

| 필드 | 뜻 |
| --- | --- |
| `sourceText` | 자막과 화면에 쓰는 수정 전 원문 |
| `ttsText` | 발음 사전을 적용해 모델에 보낼 문장 |
| `voiceProfile` | 사용자 음성 프로필 키 |
| `model` | 재현 가능한 모델·양자화 키 |
| `seed` | 모델이 지원할 때 재현성 확보용 값 |
| `outputPath` | 생성할 WAV 경로 |

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

## 캐시 키

최소한 아래 값을 모두 포함한다.

- `ttsText`
- 모델 저장소와 정확한 리비전
- 양자화 방식
- 음성 프로필 해시
- 언어·속도·seed 등 생성 설정
- 엔진 스키마 버전

같은 대본 한 스텝만 바뀌면 그 클립만 다시 생성되어야 한다. 모델이나 음성
프로필이 바뀌면 전체 길이가 달라질 수 있으므로 기존 타임라인은 다시 만든다.

## 파일 정책

- 모델은 사용자 공용 Hugging Face 캐시에 둔다.
- 벤치마크 출력은 `artifacts/`에 두고 Git에서 제외한다.
- 소스 녹음은 `udemy-agent/deck/voice/`를 읽기 전용으로 사용한다.
- 최종 강의용 음성은 기존 프로젝트가 지정하는 출력 경로에 생성한다.
