# 결정 기록

## 2026-08-23 — 로컬 우선

- 결정: ElevenLabs 결제를 보류하고 로컬 TTS 파일럿을 먼저 수행한다.
- 이유: 전체 대본은 157,838자이며 반복 수정이 예상된다. M4 Max 36GB를 이미
  보유해 로컬 추론의 경제성이 높다.
- 검증 후보: Qwen3-TTS 1.7B Base, Chatterbox Multilingual V3.
- 미결: 실제 한국어 품질, 음색 유사도, 장문 안정성, 생성 성능.

## 2026-08-23 — 데이터는 외부 정본 참조

- 결정: 713MB 음성 폴더를 새 저장소에 중복 복사하지 않는다.
- 이유: 원본 훼손과 중복 데이터 불일치를 피한다.
- 정본: `/Users/jaehoseo/Desktop/vswrk/edu/udemy-agent/deck/voice/`.

이후 모델, 라이선스, 음성 프로필, 연동 방식이 확정될 때 이 파일에 날짜와
근거를 추가한다.

## 2026-08-23 — 첫 로컬 A/B 후보와 라이선스 재검증

- 결정: Qwen3-TTS 1.7B Base BF16과 Chatterbox Multilingual V3를 같은
  참조 음성·대본으로 먼저 비교한다. 최종 모델은 사용자 청취 뒤에만 고른다.
- Qwen 근거: 2026-01-22 공개, 한국어 및 zero-shot 복제 지원, Apache-2.0.
  - https://huggingface.co/Qwen/Qwen3-TTS-12Hz-1.7B-Base
- Chatterbox 근거: Multilingual V3는 한국어 포함 23개 언어를 지원하고 이전
  버전보다 음색 유사도와 환각 억제를 개선했으며, 모델과 코드가 MIT다.
  - https://huggingface.co/ResembleAI/chatterbox
  - https://huggingface.co/mlx-community/chatterbox-multilingual-v3
- MLX-Audio 근거: Apple Silicon용 Qwen3-TTS voice cloning과 Chatterbox V3
  실행 경로를 공식 문서에서 확인했다. 설치 버전은 0.5.0이다.
  - https://github.com/Blaizzy/mlx-audio/blob/main/docs/models/tts/qwen3-tts.md
  - https://github.com/Blaizzy/mlx-audio/blob/main/docs/models/tts/chatterbox.md

## 2026-08-23 — Fish Audio는 첫 로컬 상업 후보에서 제외

- S2.1 Pro는 2026-06-23 공개된 Fish Audio의 최신 모델이지만 현재 공식 사용
  경로는 클라우드 API이며, 공개 글은 요청 데이터 보관 가능성과 기간 한정 무료
  제공을 명시한다. 로컬 우선·개인 음성 비공개 목표와 맞지 않는다.
  - https://fish.audio/blog/s2-1-pro-free-api/
- 로컬 공개 가중치는 S2 Pro다. 한국어와 zero-shot 복제를 지원하지만 Fish Audio
  Research License는 상업적 이용에 별도 서면 라이선스를 요구한다. 이번 결과는
  유료 강의에 사용될 예정이므로 라이선스 확보 전에는 생성 후보로 넣지 않는다.
  - https://huggingface.co/fishaudio/s2-pro
  - https://huggingface.co/fishaudio/s2-pro/blob/main/LICENSE.md

## 2026-08-23 — Qwen3-TTS를 로컬 기준 모델로 선택

- 사용자 A/B 청취 결과 Qwen3-TTS 1.7B Base BF16이 Chatterbox Multilingual
  V3보다 확실히 낫다고 판정했다. Chatterbox는 후속 파일럿에서 제외한다.
- Confucius4-TTS는 사용자가 별도로 조사하며, 현재 로컬 제작 기준선은
  Qwen3-TTS로 고정한다.
- 강의 시작부터 실제 음성 10분 1.14초를 생성했다. CH00과 CH01 초반의
  19개 화면·66개 스텝·4,661자를 포함하며, 로컬 ASR 대조 유사도는 97.11%,
  2초 이상 비정상 무음은 없었다. 장문 사용 승인은 사용자 청취 뒤에만 한다.

## 2026-08-24 — 강의용 연속 호흡·강제 정렬 파이프라인

- 사용자 리뷰에서 스텝·슬라이드 전환 시 간헐적인 끊김, `똑-같이`처럼 늘어지는
  운율, 약 1초 빠른 자막이 발견됐다. Qwen 모델만의 문제가 아니라 스텝별 독립
  생성, 고정 무음, 글자 수 비례 자막, 브라우저 녹화 시작시각 추정이 겹친
  파이프라인 문제로 판정했다.
- 같은 슬라이드의 2~4개 스텝을 최대 300자까지 한 번에 생성한다. 강의 생성은
  temperature 0.75, top_p 0.95로 낮춰 이상 운율의 재발 가능성을 줄인다.
- 생성 클립의 앞뒤 무음을 정리하고 24ms 경계 페이드를 적용한다. 클립 경계는
  같은 슬라이드 200ms, 슬라이드 사이 350ms다. 내부 무음은 700ms를 넘는
  이상치만 480ms로 줄여 일반적인 호흡은 보존한다.
- 발음용 문장과 자막 원문을 계속 분리한다. `똑같이`는 로컬 발음 사전에서
  `똑까치`로만 치환하고 화면 자막은 원문을 유지한다.
- 실제 자막과 화면 전환 시각은 Qwen3-ForcedAligner 0.6B 8-bit의 단어 단위
  정렬 결과를 사용한다. 모델은 Apache-2.0이며 MLX 캐시 용량은 약 1.28GB다.
  - https://huggingface.co/Qwen/Qwen3-ForcedAligner-0.6B
  - https://huggingface.co/mlx-community/Qwen3-ForcedAligner-0.6B-8bit
- Playwright 녹화는 벽시계 차이로 자르지 않는다. 캡처 직전 흰색 동기 프레임을
  기록하고 원본 WebM에서 해당 프레임의 종료 PTS를 찾아 정확히 자른다.

## 2026-08-24 — 수정 파이프라인 5분 리뷰본

- 최종 리뷰본은 CH00 시작 9개 화면·36개 스텝·2,396자를 13개 연속 호흡
  클립으로 생성했다. 길이는 의미 단위를 자르지 않은 4분 50.045초다.
- 첫 음성은 0.974초, 첫 자막은 0.920초이며 60ms의 자막 선행 표시만 둔다.
  시작 여백을 제외하면 700ms 이상 무음은 없다.
- 영상은 H.264 1920×1080 25fps, 음성은 AAC 48kHz mono다. 영상과 음성
  스트림 길이 차이는 5ms다.
- 사용자 청취 승인 전에는 전체 강의로 확장하지 않는다.
