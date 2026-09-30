# 승인·라이선스 근거

현재 동작은 [QUALITY](QUALITY.md)와 [ARCHITECTURE](ARCHITECTURE.md)를 따른다.
여기에는 채택·기각의 이유와 확인 출처만 남긴다. 날짜는 확인한 시점이다.

## 로컬 제작과 음성 선택

| 날짜 | 결정과 이유 |
| --- | --- |
| 2026-08-23 | 보유한 M4 Max에서 반복 수정 비용과 음성 비공개를 위해 로컬 제작 선택. Qwen3-TTS가 Chatterbox보다 낫다는 사용자 A/B 청취로 Qwen 채택 |
| 2026-08-25 | `jaeho-ko-r16-v1` LoRA 채택. 1.00의 발화 노이즈·과한 학습 흔적을 줄이고 장시간 청취에 적합했던 0.60 선택 |
| 2026-08-26 | 개인 음성 원본·정제본을 `data/private/voice/`로 이관하고 복사 전후 동일성 확인. 덱의 예전 음성은 복구용 사본으로 유지 |
| 2026-08-26 | 앱의 새 제작은 TTS·정렬·촬영 캐시 우회. 독립 CLI 캐시는 유지 |
| 2026-09-08 | 추가 강도 비교 후에도 제작값 0.60 유지 |
| 2026-09-09 | 영어 인용문은 비교 5번 `english-speaker-only-v1` 채택: LoRA 미적용, 본인 목소리 특징만 참조, English, 참조 전사 없음 |
| 2026-09-27 | VoiceStudio의 긴 글 분할·후보 결함 감지·완성 트랙 재검 개념만 독립 구현에 참고. 앱 코드나 모델 가중치는 가져오지 않았고, 승인된 Qwen3-TTS·개인 LoRA 0.60을 유지 |
| 2026-09-28 | 단어 안 폐쇄 보정 채택. 사용자가 CH00 3:46 `바깥과`는 보정이 확실히 낫고 0:17 `받고`·4:01 `자연스럽게`는 차이가 없다고 들었다. 기준은 사용자 녹음의 폐쇄 분포이며 낱말을 지정하지 않는다([QUALITY](QUALITY.md#단어-안-폐쇄-보정)) |
| 2026-09-28 | 텍스트 목소리·앱 데모의 청크 사이 쉼을 문장 쉼에 맞추고(영어 0.5초·한국어 0.42초) 문단 사이 0.8초로 정했다. 사용자가 두 판을 들어도 영어 차이를 가리기 어렵다며 판단을 위임했다. 문단 사이를 문장 사이보다 길게 두는 일반 내레이션 관행과 모델의 청크 안 쉼 측정을 따랐다. 강의 제작 간격은 그대로다. 근거는 `output/reviews/2026-09-28/english-long-narration/` |
| 2026-09-29 | 어댑터 0.60 유지. 어댑터 없음과 비교(용어 184개·시드 3개, CH04 문단): 문장 속 영어 용어는 없음이 조금 나았고(3회 정답 107 → 113) 한국어 받아쓰기 정확도는 같았다. 사용자는 한국어는 0.60이 미세하게 낫고 영어 단어는 대체로 없음이 낫다고 들었다. 한국어를 우선하고, 0.60에서 어색한 영어 용어는 사전의 한글 읽기로 둔다. 다음 세대 TTS 모델로 바꿀 때는 어댑터 없이 먼저 평가하고 부족할 때만 새로 학습한다(어댑터는 모델 가중치에 묶여 옮길 수 없다). 근거는 `output/reviews/2026-09-28/mixed-english-terms/어댑터 비교.md` |
| 2026-09-30 | 사용자가 영어 발음 개선을 영상 품질보다 우선으로 정하고, 어댑터 0.60을 유지한 채 두 가지를 채택: 대문자 영단어 표기 정리(README 0/3 → Readme 3/3)와 영어 낱말 받아쓰기로 후보 고르기·재시도(184개 기존 표본 추정 69.0% → 73.4%). 낱말별 사전 등록이나 어댑터 전환 없이 규칙으로 푼다. 근거는 `output/reviews/2026-09-30/english-spelling/`, [QUALITY](QUALITY.md#생성과-독립-판독). 다시 만든 Bob 영상 8장면의 블라인드 청취는 v2 4 · 첫 판 2 · 비슷함 2(`output/reviews/2026-09-30/english-ab/`) |
| 2026-09-30 | 영어 낱말 판정이 한글 받아쓰기도 읽는다. 받아쓰기가 맞게 읽은 영어 낱말을 한글로 적으면(트래디셔널 웹스피어) '안 들림'으로 보던 것을, CMU 발음 사전의 미국식 발음을 외래어 표기법으로 옮긴 읽기와 자모까지 같으면 들린 것으로 본다. 낱말별 등록 없이 규칙으로 푼다는 방향을 따랐고, 오차 허용 대신 표기 대안을 둔 것은 한 자모 차이가 대개 실제 오독(스냅샵·플랫)이었기 때문이다. 184개 표본 후보 선별 73.4% → 75.5%. 사용자는 `Bob`을 봅·붑으로 읽는 것을 싫어해 한 음절 낱말의 [ɑ]는 ㅏ만 인정한다. 이 판정으로 Bob 영상 v2의 네 문장을 기존 후보에서 다시 고른 v3가 블라인드 청취 3장면 모두 이겼다(`output/reviews/2026-09-30/bob-v3-ab/`). 근거는 `output/reviews/2026-09-30/english-hangul/`, [QUALITY](QUALITY.md#생성과-독립-판독) |
| 2026-09-28 | LoRA 0.50과 반복 패널티 1.05를 CH00 두 청크(시드 8개씩)로 비교. 0.50은 개선이 없고 1.05는 장단이 섞여 기본값을 유지했다. 들린 어색함은 나쁜 샘플링 뽑기라서 낱말 사이 끊김 관문을 더했다. 근거는 `output/reviews/2026-09-28/voice-diagnosis/` |

LoRA 학습은 승인한 92클립·12.252분 중 train 82개로 수행했다. rank 16, learning
rate 2e-5, batch 1, gradient accumulation 4, 60 optimizer step이었다. 평균 손실
1.0072, 학습 35.3초, peak Metal 7.235GB, 어댑터 약 67MB를 기록했고 재로딩·청취를
확인했다.

## 영어 문장과 용어의 청취 선택

영어 문장은 문장 단위로만 영어 목소리로 만든다. 낱말 단위 전환은
2026-09-09 Observation, Anthropic, Authentication/Authorization, permission denied의
샘플 네 개가 모두 거절됐다. 실험·거절 구현은
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
| RICE (2026-09-20) | 제품 이름이므로 같은 방식 채택. 다만 합성에 보내는 철자는 `Rice`다 |

2026-09-20 RICE는 사용자가 방식을 승인했다(앱 데모 내레이션에서 제품 이름으로 부른다).
사전 항목을 `라이스`에서 영어 철자 보호로 바꿨고 판독 비교 표기는 `라이스`로 남겼다.
제품 이름만 잡도록 이 항목에만 `caseSensitive`를 켰다 — 소문자 `rice`는 경로·영어 낱말이라
건드리지 않는다. 첫 완성본에서 사용자가 "알아이씨이"로 들린다고 지적해 `probe_term_pronunciation.py`로
같은 문장에 네 철자를 3회씩 재 봤다: `RICE`는 철자로 읽혀 불일치(들림 "알라이 씨"·"RIC"·"Rih"),
`Rice`·`rice`·`라이스`는 9회 모두 `라이스`로 거리 0.000이었다. 자막 원문은 `RICE`를 유지하고
발음문만 `Rice`로 보낸다. 근거는 `output/reviews/2026-09-20/app-demo-build/rice-spelling/`.

사용자가 "영어 최적화 세팅으로 그냥 영어를 생성하면 되지 않나"를 물어 같은 날 표본을
만들어 봤다(`output/reviews/2026-09-20/rice-english-voice/`). 영어 음성 경로로 보내도
대문자 `RICE`는 낱말로 서지 않아 판독에서 영어 구간이 통째로 빠졌고, `Rice`는 두 경로
모두 낱말로 읽혔다. **문제는 목소리가 아니라 철자였다.** 영어 목소리 채택 여부는 억양·
음색과 경계의 자연스러움에 대한 청취 판단으로 남아 있다 — 채택하려면 `speech_segments`의
"낱말 두 개 이상"과 inline 제외를 바꿔야 하고, 그 변경은 2026-09-09에 거절된 낱말 단위
영어 전환을 되살리는 것이므로 강의의 모든 inline 용어에 함께 적용된다. 이 사전은 강의 제작도 함께 쓰므로 CH04 L03·L04의 `RICE` 문장은 다음
제작부터 영어로 읽힌다. 이미 만든 영상은 그대로 둔다. 실제 소리는 첫 목소리 후보를
들을 때 확인한다 — 방식 승인과 청취 승인은 별개다.

2026-09-28 사용자가 "강제로 박아둔 영어→한글 매핑 중 지울 수 있는 것은 지우라"고 요청했다. 후보 184개를
실제 강의 문장에서 영어 철자로 3회씩 만들고, 제작 판독(`check_pronunciation`)으로 옛 한글 읽기를
지정 읽기로 삼아 검사했다. 3회 모두 맞은 107개를 문장 안 영어 철자 방식으로 바꿨다(덱에만 있던 8개는
로컬 항목으로 덮음). 1~2회 37개와 0회 40개는 한글 읽기를 유지한다(예: `Runtime`→룬타임, `Agentic`→
아젠틱, `RAG`→RH). 2026-09-29 사용자가 청취 페이지를 듣고 6개를 되돌렸다: `Agent`(에이잰트로 들림),
`Agent Loop`, `Agent to Agent`, `CEO Agent`, `Context Snapshot`(스냅숏), `Copilot`(코파일로트). 1~2회 목록에서
20개를 영어 철자로 골랐고(`Agent Runtime`, `Claude Code`, `Large Language Model`, `Tool Calling`, `eval` 등),
0회 40개는 모두 한글 유지다. 최종 영어 철자 항목은 121개다. 근거와 청취 페이지는
`output/reviews/2026-09-28/mixed-english-terms/`(`listen.html`, `results.json`, `applied.json`)다.
앞으로 만드는 강의(CH04 이후)는 바뀐 읽기를 쓰고, 이미 만든 영상은 그대로다.

2026-09-21 사용자가 첫 실행 영상의 목소리를 **승인했다** — 장면 6개 모두 1번 후보를
그대로 쓴다(`output/edits/2026-09-21/rice-first-run/demo/script.json`). 대본은 Claude
초안 그대로이며 자막도 함께 확인했다. 화면 규격은 같은 날 닫힌 값(1440p·4배·1.6배)을 쓴다.

2026-09-21 사용자가 완성본을 듣고 영어 목소리 표본을 **미채택**으로 정했다. `ask` 장면은
한국어 제작 목소리를 유지하고 `speech_segments`의 "낱말 두 개 이상"과 inline 제외는
그대로 둔다. 같은 청취로 앱 데모의 화면·속도 결정이 닫혔고 RICE 저장소 수정이
승인됐다. 무엇이 닫혔는지는 [APP-DEMO-DESIGN](APP-DEMO-DESIGN.md#6-파일럿-영상으로-닫은-결정-2026-09-21)에 있다.

CH01·CH02의 해당 문장은 최신 수정본에서 이어 보정했다. CH01 첫 Anthropic은
영어 철자 0.60, CH02 L04의 후속 한 문장은 사용자가 고른 `앤쓰로픽` 후보다.
L04 선택은 그 문장의 발음문에만 적용했고 전역 사전은 그대로다.

2026-09-29 사용자 기준: 영어 발음이 갈리면 미국식(General American)을 택한다. 영국식으로 들린 읽기
(`Context Snapshot`의 스냅숏)는 한글 읽기로 되돌린다.

미국식 발음은 청취로 판단한다. 자동 검사는 영어 억양·강세·음색을 보지 않는다. 선택 당시 참조:
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
| 2026-09-24 | 사용자가 한국어·연음·영어 자동화 진단과 개선 전반을 위임. 입력 보존·검수 사각지대·오탐을 개선 |
| 2026-09-28 | 자막 cue 경계를 대본 토큰 ↔ 정렬 단어 대응으로 정함. 토큰 수와 단어 수가 다르면 글자 수에 비례해 나누던 경로가 CH06 재촬영본에서 숫자·영문이 든 36스텝의 cue 41개를 최대 1.6초 어긋나게 했고, 스텝 마지막 cue만 보던 관문이 놓쳤다. 글자 비례는 정렬이 없을 때만 쓰고 관문은 모든 cue를 본다 |
| 2026-09-28 | 정렬 교정은 뭉개진 단어가 든 말덩어리 전체가 아니라 기준점 사이의 망가진 묶음만 음절 비례로 편다(`waveform-constrained-v3`). CH06 문장 중간 단어 1,203개를 독립 Whisper 단어 시각으로 판정: 0.15초 넘는 오차 97 → 88, 0.2초 넘는 오차 39 → 38, 원래 정렬보다 나빠진 단어 22 → 3. 같은 정렬 모델로 다시 정렬한 값은 모델의 체계적 오류를 되풀이해 판정 기준으로 쓰지 않았다 |
| 2026-09-24 | 실제 표본 청취: `하나에`는 괜찮음. `봇이`는 약간 뭉개지지만 강의에서 넘어갈 수준이며 개선되면 좋음 |

Anthropic의 `안쓰로픽`과 `엔트로픽`은 모두 거리 0.100으로 문턱 0.15만으로
가려지지 않았다. 과거 3,090건 재판정에서 Anthropic 23건(안쓰로픽 9, 엔트로픽 14)을
확인 대상으로 올렸다. 두 표기 모두 미리 허용하지 않으며 사용자 청취 후 변형을
추가한다. 현재 관문·측정·한계는 [QUALITY](QUALITY.md#검수-관문을-유지하는-근거)에 있다.

2026-09-11 사용자가 번호 읽기 `B-3102 → 비 삼일공이`, `R-042 → 알 공사이`를 지정했다.

## 화면 촬영의 소유와 브라우저 판본

2026-09-18 결정: 화면 촬영과 자막을 `udemy-agent`에서 이 저장소로 옮겼다. 영상
제작이 여기서 끝나는데 촬영 도구만 저쪽에 있어, 앱이 덱 CLI에 말을 걸려고 얼려 둔
입력의 `narration.config.json`을 제작 중에 고쳐 썼다 되돌리고 있었다. 이제
내보내기·자막·촬영이 타임라인 파일과 결과 폴더를 직접 받으므로 그 왕복이 없다.
덱 화면의 약속과 대본·편집점 판정은 덱에 남기고 한 지점에서만 부른다.

같은 날 브라우저 판본을 `playwright@1.62.0`(Chromium 1234)에 고정했다. 옮기면서
1.63.0(Chromium 1243)을 받았더니, 코드가 같은데도 4K에서 받는 프레임이 3초 시험
기준 95개에서 65개로 줄고 복제 프레임이 5~6개에서 41~47개로 늘었다(각 3회 측정,
1080p·1440p는 거의 동일). 브라우저를 올릴 때는 `npm run check:capture`로 세 화질을
다시 재고 [VIDEO-QUALITY](VIDEO-QUALITY.md)의 수치를 갱신한다.

2026-09-28 결정: 덱 촬영은 **페이지 시계를 멈추고 한 칸씩 넘겨 찍는다.** 실시간 스크린캐스트를
25fps 칸에 나눠 담으면 칸마다 담기는 페이지 시각이 16~70ms로 흔들려 일정하게 움직이는 작은 물체가
끊겨 보였다. 칸에 가장 가까운 장을 고르면 오차가 ±20ms로 줄지만 미래 프레임을 앞당기므로 쓰지
않았다. CDP 가상 시간은 rAF·CSS 시계를 움직이지 못하고 타임라인 정지와 함께 쓰면 캡처가 멈췄으며,
BeginFrame 제어는 macOS에서 지원하지 않아 페이지 안 시계 + CDP 타임라인 정지를 골랐다(사용자가
방식 선택을 위임). 촬영은 실시간보다 느려진다(CH00 1440p 1.27배). 근거는
[VIDEO-QUALITY](VIDEO-QUALITY.md#한-칸씩-찍기의-측정-2026-09-28).

2026-09-28 결정: 강의 영상의 정본은 **자막 없는 영상 + 자막 파일(SRT·VTT)**이다. 유튜브는 올린 영상 파일을
바꿀 수 없어 구운 자막의 오류가 그대로 남지만, 자막 파일은 올린 뒤에도 고칠 수 있고 자동 번역·검색에 쓰인다.
Udemy도 강의마다 VTT를 받는다. 자막 굽기는 쇼츠처럼 소리 없이 넘기는 파생 클립에만 쓴다. 새로 만들기의
'영상에 자막 포함'은 꺼짐이 기본이다(사용자가 유튜브 관점으로 정하도록 위임). 재촬영은 원본 영상의 설정을 따른다.

2026-09-21 결정: 화면 녹화의 **음성 포함은 쓰지 않는다.** 이 Mac의 ffmpeg 마이크 입력이
소리의 약 13%를 놓쳐 검증에 걸리고, 그 녹화에 내레이션을 넣으면 최대 0.7초 밀렸다(2026-09-18
측정). 녹화는 무음으로 받고 내레이션은 다듬기의 구간 음성 교체로 넣는다. 토글은 꺼짐이 기본인
채로 남아 있다.

## 모델·코드 라이선스 확인 기록

| 확인일 | 대상·당시 판단 | 출처 |
| --- | --- | --- |
| 2026-08-23, 09-03, 09-09, 09-24, 09-27 | Qwen3-TTS 1.7B Base: Apache-2.0, 제작 채택 유지. 상업 이용 가능한 원본 라이선스 재확인 | [모델 카드](https://huggingface.co/Qwen/Qwen3-TTS-12Hz-1.7B-Base), [공식 저장소](https://github.com/QwenLM/Qwen3-TTS) |
| 2026-08-23, 09-03, 09-24 | MLX-Audio 0.5.0: MIT, Apple Silicon 추론. 원본 라이선스 재확인 | [라이선스](https://github.com/Blaizzy/mlx-audio/blob/main/LICENSE), [Qwen 문서](https://github.com/Blaizzy/mlx-audio/blob/main/docs/models/tts/qwen3-tts.md) |
| 2026-08-23 | Chatterbox Multilingual V3: MIT. 비교 후 제작에서 제외 | [원본](https://huggingface.co/ResembleAI/chatterbox), [MLX 모델](https://huggingface.co/mlx-community/chatterbox-multilingual-v3), [MLX 문서](https://github.com/Blaizzy/mlx-audio/blob/main/docs/models/tts/chatterbox.md) |
| 2026-08-24, 09-24 | Qwen3-ForcedAligner 0.6B: Apache-2.0, 단어 정렬 채택. 원본 라이선스 재확인 | [원본](https://huggingface.co/Qwen/Qwen3-ForcedAligner-0.6B), [MLX 8-bit](https://huggingface.co/mlx-community/Qwen3-ForcedAligner-0.6B-8bit) |
| 2026-08-25 | MLX-Tune 0.6.0: Apache-2.0, `.venv-train`에서 LoRA 학습 | [저장소](https://github.com/ARahim3/mlx-tune), [Qwen 학습 예제](https://github.com/ARahim3/mlx-tune/blob/main/examples/20_qwen3_tts_finetuning.py) |
| 2026-09-03, 09-24 | Whisper 원본 코드·가중치: MIT, 원본 라이선스 재확인. 독립 검수에 기존 MLX FP16 변환 모델 사용 | [Whisper 라이선스](https://github.com/openai/whisper/blob/main/LICENSE), [변환 모델](https://huggingface.co/mlx-community/whisper-large-v3-turbo-asr-fp16) |
| 2026-08-23 | Fish S2 Pro: 상업 이용에 별도 서면 라이선스 필요, 후보 제외. S2.1 Pro 클라우드 경로도 로컬·비공개 목표와 맞지 않아 제외 | [S2 Pro 라이선스](https://huggingface.co/fishaudio/s2-pro/blob/main/LICENSE.md), [S2.1 당시 안내](https://fish.audio/blog/s2-1-pro-free-api/) |
| 2026-09-30 | CMU Pronouncing Dictionary(cmusphinx/cmudict 7479086, 135,166 낱말): BSD 2-clause 계열, 상업 이용 가능. 영어 낱말의 한글 받아쓰기 판정에 사용. 판을 고정하려고 `src/local_tts_engine/data/cmudict/`에 저작권 고지(`LICENSE`)와 함께 커밋했다. 모델 가중치가 아닌 텍스트 사전(약 3.6MB, 압축 0.9MB)이다 | [저장소](https://github.com/cmusphinx/cmudict), [라이선스](https://github.com/cmusphinx/cmudict/blob/master/LICENSE) |
| 2026-09-18 | Playwright 1.62.0: Apache-2.0, 화면 촬영용 브라우저 구동에 채택. 내려받는 Chromium은 BSD 계열이며 이 저장소에 커밋하지 않는다 | [라이선스](https://github.com/microsoft/playwright/blob/main/LICENSE), [Chromium 라이선스](https://chromium.googlesource.com/chromium/src/+/main/LICENSE) |
| 2026-09-27 | VoiceStudio 앱 코드 AGPL-3.0-only. 코드 이식 없이 설계 아이디어만 독립 구현. 기본 OmniVoice 사전학습 가중치는 CC-BY-NC이며 토크나이저에 별도 조건이 있어 상업 강의 음성으로 채택하지 않음 | [VoiceStudio 안내](https://github.com/debpalash/VoiceStudio/blob/main/LICENSE-NOTICE.md), [OmniVoice 모델 카드](https://huggingface.co/k2-fsa/OmniVoice), [토크나이저 조건](https://huggingface.co/k2-fsa/OmniVoice/blob/main/audio_tokenizer/LICENSE) |

MLX-Tune LoRA는 Qwen의 공식 CUDA 전체 SFT와 다른 경로다
([공식 학습 문서](https://github.com/QwenLM/Qwen3-TTS/blob/main/finetuning/README.md), 2026-08-25 비교).

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
