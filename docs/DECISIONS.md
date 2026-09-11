# 승인·라이선스 근거

현재 동작은 [QUALITY](QUALITY.md)와 [ARCHITECTURE](ARCHITECTURE.md)를 따른다.
여기에는 채택·기각을 유지해야 할 이유와 당시 확인 출처만 남긴다. 아래 날짜의
라이선스 확인 기록은 최신 재검증을 의미하지 않는다.

## 로컬 제작과 음성 선택

| 날짜 | 결정과 이유 |
| --- | --- |
| 2026-08-23 | 보유한 M4 Max에서 반복 수정 비용과 음성 비공개를 위해 로컬 제작 선택. Qwen3-TTS가 Chatterbox보다 낫다는 사용자 A/B 청취로 Qwen 채택 |
| 2026-08-25 | `jaeho-ko-r16-v1` LoRA 채택. 1.00의 발화 노이즈·과한 학습 흔적을 줄이고 장시간 청취에 적합했던 0.60 선택 |
| 2026-08-26 | 개인 음성 원본·정제본을 `data/private/voice/`로 이관하고 복사 전후 동일성 확인. 덱의 예전 음성은 복구용 사본으로 유지 |
| 2026-08-26 | 앱의 새 제작은 TTS·정렬·촬영 캐시 우회. 독립 CLI 캐시는 유지 |
| 2026-09-08 | 추가 강도 비교 후에도 제작값 0.60 유지 |
| 2026-09-09 | 영어 인용문은 비교 5번 `english-speaker-only-v1` 채택: LoRA 미적용, 본인 목소리 특징만 참조, English, 참조 전사 없음 |

LoRA 학습은 승인한 92클립·12.252분 중 train 82개로 수행했다. rank 16, learning
rate 2e-5, batch 1, gradient accumulation 4, 60 optimizer step이었다. 평균 손실
1.0072, 학습 35.3초, peak Metal 7.235GB, 어댑터 약 67MB를 기록했고 재로딩·청취를
확인했다. 이 수치는 과거 실행 근거이며 재학습 지시나 일반 성능 보증이 아니다.

## 영어 문장과 용어의 청취 선택

영어 문장 5번에 대한 승인을 개별 영어 단어 분리 합성으로 확대하지 않는다.
2026-09-09 Observation, Anthropic, Authentication/Authorization, permission denied의
단어별 전환 샘플 네 개는 모두 거절됐다. 실험·거절 구현은
`output/reviews/2026-09-09/selected-english-terms/`에 보존돼 있다.

2026-09-10 한국어 문장 전체에 영어 철자를 넣은 Observation 0.60·0.20은 모두
승인됐고 기존 0.60을 유지했다. 표본은
`unsplit-english-term/comparison-20260909-235104-467862`다. 후속 선별 용어 기록은
`output/reviews/2026-09-10/unsplit-remaining-terms/`에 있다.

| 용어 | 사용자 선택 |
| --- | --- |
| Observation, Anthropic, permission denied 및 붙임·밑줄 별칭 | 영어 철자를 한국어 문장 안에 유지하는 0.60 방식 채택 |
| Artificial Analysis, Intelligence Index, Boris Cherny, Y Combinator | 같은 전체 문장 방식 채택 |
| Authentication, Authorization | 새 방식 보류, 기존 한글 읽기 유지 |
| Attention Budget, knowledge cutoff | 새 방식 불채택, 기존 한글 읽기 유지 |

CH01·CH02의 해당 문장은 최신 수정본에서 이어 보정했다. CH01 첫 Anthropic은
영어 철자 0.60, CH02 L04의 후속 한 문장은 사용자가 고른 `앤쓰로픽` 후보다.
L04 선택을 전역 사전으로 확대하지 않는다. 결과·청취 기록 위치는 [HANDOFF](HANDOFF.md)에 있다.

미국식 발음은 청취 목표다. 영어 억양·강세·음색이나 모든 문맥의 품질을 자동 검사가
보증하지 않는다. 선택 당시 참조:
[Base voice clone 설명](https://github.com/QwenLM/Qwen3-TTS#voice-clone) (2026-09-09),
[Cambridge Anthropic 발음](https://dictionary.cambridge.org/us/pronunciation/english/anthropic) (2026-09-10).

## 검수 정책의 근거

| 날짜 | 결정과 근거 |
| --- | --- |
| 2026-08-24 | 스텝별 독립 생성과 글자 수 비례 자막의 끊김·시각 오차를 줄이기 위해 의미 단위 청킹과 실제 단어 정렬 채택 |
| 2026-09-03 | Qwen과 같은 계열의 자기평가 대신 독립 Whisper 판독 채택. 같은 계열의 발음 편향 공유를 피함 |
| 2026-09-03 | 철자가 아닌 자모 발음 공간에서 비교. `27B` 같은 ASR 표기차를 실제 오독과 구분 |
| 2026-09-03~04 | 숫자·단위의 읽기를 TTS 전에 정규화. Whisper는 `열 개`와 `십 개`를 모두 `10개`로 적을 수 있어 자연스러움 판단을 대신할 수 없음. 승인 예외 `50개 → 오십 개` 유지 |
| 2026-09-10 | `comparisonReading`이 있는 영어 용어는 선언 표기와 승인된 `comparisonVariants`로 검사. 전역 거리 문턱은 유지 |
| 2026-09-11 | 사전 누락으로 제작을 중단하거나 제작 중 발음 승인을 요구하지 않음. 완성 후 기존 확인·페이지 재생성 기능 사용 |
| 2026-09-11 | 레슨 분할 제작은 개별 실패 후 나머지를 계속하고 완료·실패 결과를 나눠 기록. 사용자 중지·공통 입력 오류는 전체 중단 |

Anthropic의 `안쓰로픽`과 `엔트로픽`은 모두 거리 0.100으로 문턱 0.15만으로
가려지지 않았다. 과거 3,090건 재판정에서 Anthropic 23건(안쓰로픽 9, 엔트로픽 14)을
확인 대상으로 올렸다. 두 표기 모두 미리 허용하지 않으며 사용자 청취 후 변형을
추가한다. 현재 관문·측정·한계는 [QUALITY](QUALITY.md#검수-관문을-유지하는-근거)에 있다.

2026-09-11 사용자가 지정한 번호 읽기는 `B-3102 → 비 삼일공이`, `R-042 → 알 공사이`다.
이는 읽기 지정이며 새 합성의 청취 승인과는 별개다. 다른 미등록 용어를 자동으로
사전에 등록하지 않는다. 이 결정은 음성 기본값·자동 검수·재시도 예산을 바꾸지 않는다.

## 모델·코드 라이선스 확인 기록

| 확인일 | 대상·당시 판단 | 출처 |
| --- | --- | --- |
| 2026-08-23, 09-03, 09-09 | Qwen3-TTS 1.7B Base: Apache-2.0, 제작 채택 | [모델 카드](https://huggingface.co/Qwen/Qwen3-TTS-12Hz-1.7B-Base), [공식 저장소](https://github.com/QwenLM/Qwen3-TTS) |
| 2026-08-23, 09-03 | MLX-Audio 0.5.0: MIT, Apple Silicon 추론 | [라이선스](https://github.com/Blaizzy/mlx-audio/blob/main/LICENSE), [Qwen 문서](https://github.com/Blaizzy/mlx-audio/blob/main/docs/models/tts/qwen3-tts.md) |
| 2026-08-23 | Chatterbox Multilingual V3: MIT. 비교 후 제작에서 제외 | [원본](https://huggingface.co/ResembleAI/chatterbox), [MLX 모델](https://huggingface.co/mlx-community/chatterbox-multilingual-v3), [MLX 문서](https://github.com/Blaizzy/mlx-audio/blob/main/docs/models/tts/chatterbox.md) |
| 2026-08-24 | Qwen3-ForcedAligner 0.6B: Apache-2.0, 단어 정렬 채택 | [원본](https://huggingface.co/Qwen/Qwen3-ForcedAligner-0.6B), [MLX 8-bit](https://huggingface.co/mlx-community/Qwen3-ForcedAligner-0.6B-8bit) |
| 2026-08-25 | MLX-Tune 0.6.0: Apache-2.0, `.venv-train`에서 LoRA 학습 | [저장소](https://github.com/ARahim3/mlx-tune), [Qwen 학습 예제](https://github.com/ARahim3/mlx-tune/blob/main/examples/20_qwen3_tts_finetuning.py) |
| 2026-09-03 | Whisper 원본 코드·가중치: MIT. 독립 검수에 MLX FP16 변환 모델 사용 | [Whisper 라이선스](https://github.com/openai/whisper/blob/main/LICENSE), [변환 모델](https://huggingface.co/mlx-community/whisper-large-v3-turbo-asr-fp16) |
| 2026-08-23 | Fish S2 Pro: 상업 이용에 별도 서면 라이선스 필요, 후보 제외. S2.1 Pro 클라우드 경로도 로컬·비공개 목표와 맞지 않아 제외 | [S2 Pro 라이선스](https://huggingface.co/fishaudio/s2-pro/blob/main/LICENSE.md), [S2.1 당시 안내](https://fish.audio/blog/s2-1-pro-free-api/) |

MLX-Tune LoRA는 Qwen의 공식 CUDA 전체 SFT와 다른 경로다.
[공식 학습 문서](https://github.com/QwenLM/Qwen3-TTS/blob/main/finetuning/README.md)는
2026-08-25 비교 근거이며, 이미 완료된 학습을 다시 시작하라는 지시가 아니다.

## 고객 배포 경계

2026-09-03 판단: 현재는 개인 로컬 도구다. 고객 배포 시 개인 어댑터·학습 데이터·
참조 음성을 포함하지 않으며 고객의 음성 권리 확인과 별도 입력 계약이 필요하다.

당시 FFmpeg 8.1.1은 GPL/libx264 구성으로 확인했고 현재 환경 진단은 nonfree 기능도
확인한다. 로컬 사용 바이너리를 고객 앱에 그대로 묶지 않는다. 배포 전 코덱·고지·
소스 제공 조건을 다시 검토한다. [FFmpeg 법적 안내](https://ffmpeg.org/legal.html).

Electron의 context isolation·renderer sandbox·IPC 송신자 검증을 유지한다.
외부 배포 시 서명·hardened runtime·공증을 검토한다. 당시 확인 출처:
[Electron 보안](https://www.electronjs.org/docs/latest/tutorial/security),
[Apple 배포 준비](https://developer.apple.com/documentation/Xcode/preparing-your-app-for-distribution).
