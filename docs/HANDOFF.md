# 프로젝트 인수인계

> 작성일: 2026-08-24
> 상태: Qwen3-TTS 수정 파이프라인 5분 리뷰본 생성 완료, 사용자 청취 대기

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

원본은 모두 다음 정본 저장소에 있다.

`/Users/jaehoseo/Desktop/vswrk/edu/udemy-agent/deck/voice/`

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
- 713MB 음성 폴더와 모델 가중치는 중복 복사하지 않았다. 절대 경로로 참조한다.

## 9. 2026-08-24 현재 구현 상태

섹션 6의 A/B 계획은 완료된 과거 계획이다. 사용자 청취 결과 Qwen3-TTS 1.7B
Base BF16을 기준 모델로 선택했고 Chatterbox V3는 제외했다.

강의용 생성기는 `src/local_tts_engine/course_pilot.py`다.

- 같은 슬라이드의 2~4개 스텝, 최대 300자를 한 호흡으로 생성
- 생성 온도 0.75, top_p 0.95
- 앞뒤 무음 정리, 24ms 경계 페이드
- 같은 슬라이드 클립 간격 200ms, 슬라이드 간격 350ms
- 700ms 초과 내부 무음만 480ms로 축소
- `config/production-pronunciation.ko.json`에서 제작용 발음 예외 관리
- Qwen3-ForcedAligner 0.6B 8-bit로 실제 단어 시각 생성
- `export_udemy.py`가 정렬값을 기존 Node 타임라인 계약으로 전달

`udemy-agent/deck/tools/narration.mjs`는 정렬 단어로 SRT/VTT와 화면 자막을
만들고, 다음 스텝 첫 단어 120ms 전에 화면을 전환한다. Playwright의 가변 녹화
지연은 흰색 동기 마커 프레임으로 측정해 제거한다.

현재 리뷰 산출물:

- 로컬 음성·매니페스트:
  `artifacts/course-pilots/2026-08-24/qwen3-tts-first-5m/`
- 최종 자막 영상:
  `/Users/jaehoseo/Desktop/vswrk/edu/udemy-agent/deck/render/narration/qwen3-first-5m/qwen3-first-5m-captioned.mp4`
- SRT/VTT/타임라인:
  같은 `qwen3-first-5m/` 디렉터리

리뷰본 수치:

- 4분 50.045초, 9개 화면, 36개 스텝, 13개 음성 클립
- 첫 음성 0.974초, 첫 자막 0.920초
- 시작 여백 외 700ms 이상 무음 0건
- H.264 1920×1080 25fps, AAC 48kHz mono, 22.96MB
- 로컬 테스트 12개 통과

다음 단계는 사용자가 이 5분 영상을 듣고 어색한 단어·호흡·전환 시각을 구체적으로
표시하는 것이다. 승인 전에는 CH01 전체나 전체 7~8시간으로 확장하지 않는다.
