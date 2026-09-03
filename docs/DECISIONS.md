# 결정 기록

## 2026-08-23 — 로컬 우선

- 결정: ElevenLabs 결제를 보류하고 로컬 TTS 파일럿을 먼저 수행한다.
- 이유: 전체 대본은 157,838자이며 반복 수정이 예상된다. M4 Max 36GB를 이미
  보유해 로컬 추론의 경제성이 높다.
- 검증 후보: Qwen3-TTS 1.7B Base, Chatterbox Multilingual V3.
- 미결: 실제 한국어 품질, 음색 유사도, 장문 안정성, 생성 성능.

## 2026-08-23 — 데이터는 외부 정본 참조 (2026-08-26에 대체됨)

- 결정: 713MB 음성 폴더를 새 저장소에 중복 복사하지 않는다.
- 이유: 원본 훼손과 중복 데이터 불일치를 피한다.
- 정본: `/Users/jaehoseo/Desktop/vswrk/edu/udemy-agent/deck/voice/`.

이후 모델, 라이선스, 음성 프로필, 연동 방식이 확정될 때 이 파일에 날짜와
근거를 추가한다.

## 2026-08-26 — 제작 자산을 local-tts-engine으로 이관

- 사용자 결정에 따라 개인 음성 원본과 정제본 20개(약 688MB)를
  `data/private/voice/`로 복사하고 원본과 차이가 없음을 `rsync` 검증으로
  확인했다. 이후 이 경로를 불변 정본으로 사용한다.
- 기존 `udemy-agent/deck/voice/`는 즉시 삭제하지 않고 복구용 사본으로 남겼다.
- 기존 자막·타임라인·오디오 약 191MB는
  `artifacts/production/captions/`, 완성 MP4 2개 약 114MB는
  `artifacts/production/videos/`로 이관했다. 중간 WebM 원본은 이관하지 않았다.
- 강의 대본과 슬라이드 UI, 캡처 실행 코드는 계속 `udemy-agent`에 둔다.
- 앱의 모든 경로는 `artifacts/app-settings.json`에 저장하며 설정 화면에서
  바꿀 수 있다.

## 2026-08-26 — 텍스트 다중 후보와 앱 영상 캐시 우회

- 임의 텍스트를 2~8개의 서로 다른 시드로 생성하고, 최대 2개씩 병렬 처리해
  사용자가 직접 듣고 하나를 `selected.wav`로 고르는 기능을 추가했다.
- 독립 CLI의 캐시는 호환성을 위해 유지한다. Electron 앱의 강의 제작과 영상
  목소리 재생성은 `--no-cache`를 전달해 TTS 클립과 강제 정렬 결과를 읽지 않는다.
- Playwright 캡처도 Chromium HTTP 캐시 비활성화, no-cache 헤더와 매 실행
  cache-busting URL을 사용한다.

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

## 2026-08-25 — 파인튜닝은 데이터 준비와 학습을 분리

- Qwen 공식 경로는 12Hz 1.7B/0.6B Base의 단일 화자 전체 SFT이며,
  `audio`·`text`·동일한 `ref_audio`가 든 JSONL과 CUDA를 요구한다.
  - https://github.com/QwenLM/Qwen3-TTS/blob/main/finetuning/README.md
- 현재 사용 중인 MLX-Audio 0.5.0에는 공식 학습 경로가 없다. Apple Silicon용
  Qwen3-TTS LoRA 구현은 별도 실험 프로젝트에 있으나 실제 학습 백엔드로 아직
  채택하지 않았다.
  - https://github.com/Blaizzy/mlx-audio
  - https://github.com/akashicMarga/mlx-audio-train
- 결정: 먼저 53분 정본을 읽기 전용으로 유지하면서 3~14초 클립, Qwen3-ASR
  초벌 전사, 사람 검수표와 공식 JSONL 내보내기 절차만 준비한다. 학습·모델
  다운로드·외부 업로드는 별도 승인 전까지 실행하지 않는다.
- 결과: 5개 정본 3,200.525초를 398개 클립으로 분할했다. 중앙값 7.99초,
  최대 13.919초이며 강제 절단은 0개다. 녹음 당시 Git 대본과 ASR을 대조하고
  대표 10개를 사용자가 청취했다. 글자 단위 완전 일치와 사용자 확인을 통과한
  92개·12.252분만 1차 세트로 승인했고, 말실수 2개는 제외했다. 나머지 304개는
  필요할 때만 추가 검수하도록 보류했다.

## 2026-08-25 — MLX-Tune LoRA v1과 제작 강도 0.60 선택

- MLX-Tune 0.6.0은 Apache-2.0이며 Apple Silicon에서 Qwen3-TTS LoRA 학습을
  지원한다. 기존 추론 환경과 분리된 `.venv-train`에서만 사용한다.
  - https://github.com/ARahim3/mlx-tune
  - https://github.com/ARahim3/mlx-tune/blob/main/examples/20_qwen3_tts_finetuning.py
- 첫 실행은 기존 `mlx-community/Qwen3-TTS-12Hz-1.7B-Base-bf16` 가중치를
  재사용한다. rank 16, learning rate 2e-5, batch 1의 보수적 LoRA로 시작한다.
- 공식 Qwen CUDA 전체 SFT와 동일한 경로가 아니므로 결과는 MLX-Tune LoRA다.
- 실행 결과: 승인된 train 82개를 60 optimizer step(gradient accumulation 4)으로
  학습했다. 평균 손실은 1.0072, 마지막 구간은 약 0.82, 학습 시간은 35.3초,
  peak Metal 메모리는 7.235GB였다. rank 16 어댑터 크기는 67MB다.
- 저장 어댑터를 새 프로세스에서 다시 불러와 같은 문장·참조·시드로 A/B 음성을
  생성했고 Qwen3-ASR 대조에서 목표 문장을 보존했다.
- 청취 비교의 핵심은 LoRA v1 자체의 채택 여부가 아니라 적용 강도였다. `1.00`은
  사람 발화의 노이즈와 과한 학습 흔적이 많이 들렸고, `0.60`은 강의에 듣기 좋은
  목소리를 유지하면서 AI 특유의 슬롭을 가장 잘 줄였다.
- 최종 제작 프로필은 Qwen3-TTS 1.7B Base BF16 + 짧은 참조 음성·전사 +
  `jaeho-ko-r16-v1` LoRA 강도 `0.60`이다. LoRA v1은 현재 제작에 채택된
  어댑터다.
- 추가 파인튜닝이나 제작 강도 변경은 명확한 품질 가설과 사용자 청취 승인 전에는
  진행하지 않는다.

## 2026-09-03 — 첫 판매 형태는 로컬 데스크톱 유료 베타

- 결정: 현재 코드를 인터넷 서비스로 바로 노출하지 않는다. 첫 고객 제품은 Apple
  Silicon에서 음성 원본과 결과물을 로컬 처리하는 데스크톱 앱으로 잡는다.
- 이유: 현재의 품질·비용·개인정보 장점을 유지하면서 계정, 다중 사용자 저장소,
  GPU 작업 큐와 음성 데이터 삭제 시스템을 한꺼번에 새로 만들지 않아도 된다.
- 첫 유료 범위는 텍스트 개인 음성 후보와 기존 영상 음성 교체다. 전용
  `udemy-agent` 계약에 의존하는 강의 영상 자동 제작은 고객 입력 형식을 분리한
  뒤 공개한다.
- 개인 제작 프로필 `jaeho-ko-r16-v1`, 학습 데이터와 참조 음성은 고객 빌드에
  넣지 않는다. 고객 음성은 본인 또는 명시적 허가를 받은 음성이라는 확인 기록을
  요구한다.
- 제품화 상세: `docs/PRODUCTIZATION.md`.

## 2026-09-03 — 상업 배포 라이선스와 플랫폼 정책 재확인

- Qwen3-TTS 1.7B Base 모델 카드는 Apache-2.0을 표시하고 한국어와 짧은 참조
  음성 기반 복제를 지원한다.
  - https://huggingface.co/Qwen/Qwen3-TTS-12Hz-1.7B-Base
- MLX-Audio 저장소의 현재 라이선스는 MIT다.
  - https://github.com/Blaizzy/mlx-audio/blob/main/LICENSE
- FFmpeg는 기본 LGPL 2.1 이상이지만 사용한 선택 기능에 따라 GPL이 적용될 수
  있다. 현재 로컬 FFmpeg 8.1.1은 `--enable-gpl --enable-libx264` 구성이고 영상
  명령도 `libx264`를 사용한다. 이 바이너리는 고객 앱에 그대로 묶지 않으며,
  배포용 코덱 경로와 소스 제공·고지 의무를 별도로 검토한다. 이 기록만으로 법률
  판단을 대신하지 않는다.
  - https://ffmpeg.org/legal.html
- Electron 고객 빌드는 현재처럼 context isolation, renderer sandbox, IPC sender
  검증과 외부 탐색 차단을 유지하고, 서명·hardened runtime·Apple 공증을 거친다.
  - https://www.electronjs.org/docs/latest/tutorial/security
  - https://developer.apple.com/documentation/Xcode/preparing-your-app-for-distribution
- YouTube는 본인 음성 복제를 보이스오버에 쓰는 경우를 공개가 필요 없는 예시로
  들지만, 실제 타인의 음성·초상을 허가 없이 쓰는 문제는 별도다. 또한 반복적이고
  대량 생산된 저가치 템플릿 콘텐츠는 수익화에 부적합할 수 있으므로 제품은 업로드
  수가 아니라 창작자의 독창성과 검수 시간을 개선하는 도구로 설명한다.
  - https://support.google.com/youtube/answer/14328491
  - https://support.google.com/youtube/answer/1311392
  - https://support.google.com/youtube/answer/17133929
