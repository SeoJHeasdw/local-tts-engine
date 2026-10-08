# 현재 상태

갱신: 2026-10-08. 지금 남은 일과 결과 위치만 둔다. 지난 경위는 git 기록에 있다.

## 엔진 검증

적대적 평가의 18개 결함을 수정하고 정상·실패·경합 회귀 검사를 추가했다. 반복 페이지
교체·후보 판본·작업 예약·중지·이어하기·승인 지문·설정 응답·자막·음성 무결성·영어 숫자·
정렬 캐시를 검증한다. 수정 근거와 자동 검사 결과는
`output/reviews/2026-10-04/adversarial-audit/수정 검증 보고서.md`에 있다.
기존 승인 CH00의 16청크 무결성과 정렬 캐시, 본인·팀장님 목소리의 승인 강도 0.60을
읽기 전용으로 확인했다. 기존 음성·영상·프로필과 제작 기본값은 유지했다.
파일 지문 없는 과거 영상 승인 기록은 보존하지만 현재 파일의 승인 표시로 자동 계승하지 않는다.
화면 기록 권한·Chromium·Electron·로컬 포트 권한이 필요한 검사는 여전히 완료되지 않는다.
새 합성·학습·촬영·사람의 청취·시청 승인은 이 코드 검증의 범위에 포함하지 않는다.

## 목소리 시스템

사람별 분석·검수본 학습은 `scripts/analyze_voice.py`·`scripts/train_voice.py`의 공용 명령을
사용한다. 데이터·표시 이름·평가 대본·출력 위치를 인자로 받으며 학습 계획 준비도 포함한다.
공통 실행값은 `config/voice-training.json`, 기존 본인 목소리의 호환 연결은
`config/legacy-voice.json`에 있다. 새 실행은 참조·학습 JSONL을 고정하고 저장된 어댑터 설정으로
합성한다. 절차는 [운영 CLI](../scripts/README.md), 계약은 [ARCHITECTURE](ARCHITECTURE.md)를 따른다.
기존 팀장님 결과·청취 승인·현재 선택값을 보존했으며 재학습은 하지 않았다.
설정은 일반·목소리 선택·새 목소리 만들기로 나뉜다. 녹음 가져오기·자동 준비·청취 검수·학습·
완료 후 검토를 앱에서 이어갈 수 있다. 목소리 선택에는 샘플 재생·선택 강도의 시험 음성 생성·
청취 확인·적용이 있으며, 일반 설정 저장과 임시 목소리 선택을 구분한다. 사용법은
[README](../README.md), 청취·강도·해시 계약은 [QUALITY](QUALITY.md)를 따른다.
화면 기록 권한 확인과 Chromium·Electron을 띄우는 검사는 현재 작업 환경의 권한 제한으로
완료되지 않는다. 목소리·학습 회귀 검사와 앱 모듈 구조 검사는 통과했다.

## 새 세션 시작점 (2026-10-08 밤 정리)

이번 세션에서 할 수 있는 코드·문서·자동 검사는 모두 끝냈고(`npm run check` 통과: 앱 672·Python 728), 아래는 사람이 해야 하거나
새 세션에서 시작할 일이다. **작업 트리의 변경은 모두 커밋하지 않았다.**

1. **앱을 다시 켜서 후보 비교 창을 눈으로 확인(사용자).** 켜 둔 앱은 옛 코드다.
2. **강의 전체 재촬영 준비.** 강의 경로도 같은 영어 규칙을 쓴다. 새로 만들면 음성이 바뀐 청크는 해시가 달라 다시 만들어진다.
3. **알고 있는 한계.**
   - 한글 읽기 표(`english_reading`)는 `coffee→커피`처럼 규칙으로 잡을 수 없는 관용 표기를 받지 못한다(`카피`만 안다). 표에는
     낱말마다 예외를 넣지 않고, 그런 낱말은 사전의 한글 읽기로 정한다(`coffee`는 2026-10-08에 사전에 넣었다). 모음 사이 l을 ㄹ 하나로 적은 표기(`데이리`)는 규칙으로 받는다.
   - 기존 타임라인을 읽어 고치는 스크립트(`scripts/generate_english_repairs.py`·`retrofit_course_english.py`·
     `compare_unsplit_english_term.py`)는 새 규칙으로 구간을 다시 계산한다. 새 규칙 이전에 만든 영상에는 맞지 않으면 오류로 멈춘다.
     새 규칙으로 읽기가 바뀌는 강의 청크는 1개뿐이고 강의는 다시 만들 예정이라 손대지 않았다.

## 남은 일

- **팀장님 목소리 — 학습·참조 연결·최종 합성 청취 승인 완료:** 설정 → 목소리의 `팀장님`은
  `artifacts/finetune-runs/2026-10-02/kkh-ko-r16-092309-b6bcaa-s20/`의 rank16·20스텝 어댑터다.
  참조는 같은 폴더의 `reference.wav`·`reference.txt`(원본8번, 7.66초)이며 해시와 연결을 확인했다.
  승인 강도는0.60이다. 기본 복제·10스텝·20스텝의 새 한국어·영어 혼합3문장 자동검수는 모두 통과,
  자동 점수는20스텝이 가장 좋았다. 보류 원본과의 화자 코사인은 기본0.988033 /10스텝0.989632 /
  20스텝0.990332다. 확률이나 사람의 청취 승인이 아니다. 결과는
  `output/reviews/2026-10-02/kkh-ko-r16-092309-b6bcaa/comparison.json`, 최종 음성은 같은 폴더의
  `lora-20/evaluation.wav`(또는 어댑터 실행 폴더의 `preview.wav`, 약22.4초)이다.
  검수 학습 준비본은 `artifacts/finetune-datasets/kkh-ko-reviewed-v1/`: 후보7개·59.76초,
  실제 train5개·43.50초 / val·test각1개다. 사람의 확인과 위임된 자동선별의 범위는
  `training-plan.json`·`metadata.jsonl`·`output/reviews/2026-10-01/kkh-voice-listening/listening-review.json`에 있다.
  원본과 기존 `jaeho-ko-r16-v1`0.60 기본값은 유지했다. `팀장님` 프로필은 등록됐고 사용자가 최종 음성을 'ok 굿 합격'으로 승인해
  `listeningStatus`는 approved다. 제작 목소리 전환은 사용자 선택으로 적용한다.
- **CH00 다시 제작(선택):** 지금 CH00(`studio-20260928-210855-ch00-full`)은 낱말 사이 끊김 관문까지 들어간
  판이다. 다시 만들면 단어 안 폐쇄 보정으로 3:46 `바깥과`의 끊김이 줄어든다. 10페이지의 '재생성 권장'은
  Whisper가 `셋뿐`을 `3분`으로 받아쓴 것이라 들어 보고 넘기면 된다. 진단·청취 비교는
  `output/reviews/2026-09-28/voice-diagnosis/`(`진단 결과.md`, `main/listen.html`, `closure-ab/listen.html`)에 있다.
- **CH06 새 판 시청:** 자막을 굽지 않은 영상과 같은 이름의 `.srt`·`.vtt`다. 음성은 청취 승인한 원본
  그대로이고, 화면이 새로 찍혀 검수 상태는 '대기'다. 옛 판과 기록은 `output/reviews/2026-09-28/ch06-archive/`에 있다.
- **CH04 이후 촬영:** CH01~CH03은 제작·청취 승인까지 끝났다.
- **덱 카드 테두리 끊김:** CH00 2~7초 카드 테두리 빛이 조금 끊긴다. 원인은 촬영이 아니라 덱이다.
  `udemy-agent`의 `opening-world/world.ts` `cardMaterial` 테두리가 너무 가늘어 계단 무늬가 흐른다
  (`fwidth`로 너비 보정 또는 두껍게). 측정은 [VIDEO-QUALITY](VIDEO-QUALITY.md#한-칸씩-찍기의-측정-2026-09-28).
- **앱 데모 구도 수정본 시청:** `output/edits/2026-09-22/rice-first-run-framing-v2/`. 확인 항목은
  `output/reviews/2026-09-22/app-demo-audit/구도 편집 사용법.md`에 있다.
- **Bob Level 3 제출 영상 — 제출본 v5 확정, 영상 작업 끝:** `output/edits/2026-09-30/bob-level3-final/IBM Bob Level 3 - 서제호 v5.mp4`
  (8분 9초, 자막 구움). 화면은 영상형 덱, 오프닝·Bob 화면 진입의 3D, 바뀌는 곳을 따라가는 확대이고, 음성은 사전의
  `Bob` → 밥, `Technology Expert Labs` → 테크놀로지 엑스퍼트 랩스로 `Bob`이 든 10개 장면을 새로 만든 것이다(나머지는
  v3 음성). 결과 폴더 이름은 `bob-level3-v4-*`이지만 지금 선택과 굽기는 v5다. 방식은
  [APP-DEMO-DESIGN](APP-DEMO-DESIGN.md#10-정지감-줄이기-bob-v4-2026-09-30).
  다시 고칠 때: 덱은 `bob/level3-demo/deck/motion.html` → `demo/motion-capture.mjs <원래 결과> <새 결과>`, Bob 화면은
  `demo/direct-camera.py`, 굽기는 `npm run demo -- render <폴더> --quality standard --burn-captions`, 잇기는
  `bob-level3-final/parts-v4.txt`로 `ffmpeg -f concat -safe 0 -c copy`. 첫 판·v2·v3도 같은 폴더에 있다.
- **watsonx.data Stand & Deliver 영상(팀장님 목소리) — v3 완성, 시청·청취 승인 대기:**
  `output/edits/2026-10-07/watsonx-data-final/watsonx.data Stand & Deliver - v3.mp4`(4분 45초, 1080p 25fps, 자막 구움).
  팀장님이 실습(라이브 데모)은 필요 없다고 해서(2026-10-07) 데모 대신 3D 설명 장면 `s6-fed`(관리 화면·federated query)·
  `s7-engines`(Presto·Spark와 create·pause·resume·scale·remove)로 12개 평가 항목을 채웠다. 구성은 open(S1~S5) → mid(S6·S7) →
  close(S8·S9)이고, 밝은 에디토리얼 덱 + 밝은 스튜디오 3D(Blender)라 Bob 영상과 겹치지 않는다. 자막은 밝은 바탕용 회색 박스
  (`--caption-style box`)로 굽는다. 음성은 `demo voice --voice 2026-10-02/kkh-ko-r16-092309-b6bcaa-s20`으로 장면당 후보 3개를 만들어
  **자동 검사로 골랐다(`demo/last-picks.txt`) — 사람의 청취 승인이 아니다.** s6·s7의 선택 후보는 자동 검사 '실패', s1-open·s8-deploy는
  '경고'다(받아쓰기가 영어 용어를 한글로 적은 탓이 대부분, 아래 발음 오차율 문제와 같다). 소개 멘트의 이름·직함은 팀장님 답을 받으면 S1
  v3 청취에서 `catalog`는 "캐틀로그", `standalone`은 "스탠들론", `engine`은 "엔징"으로 들렸다. 앞 둘은 사전에 넣었고(2026-10-08, 테스트 포함)
  v3 음성에는 아직 옛 읽기가 남아 있다 — 고칠 때는 s6-fed·s7-engines(catalog)·s8-deploy(standalone)를 `demo voice --scene`으로 다시 만들어
  고른 뒤 `demo/build.sh`. `engine`은 받아쓰기가 `엔진`으로 적어 자동으로 못 가려 사전에 넣지 않았고, 같은 장면의 `resume`(레주메로 받아쓰기)·
  `storage`(스토레이지)도 후보다.
  첫 문장만 바꾼다. 작업 폴더는 `/Users/jaehoseo/Desktop/vswrk/ibm/watsonx-data-demo/`(`STORYBOARD.md`가 대본·구성).
  다시 만들 때: 대본·목소리를 바꾸고 `demo/build.sh [라벨]` 한 번(3D는 이벤트가 0.5초 넘게 바뀐 장면만, 촬영은 바뀐 장면만).
  장면을 더하려면 `deck/motion.html`(EV·LABELS·SCENES·마크업)과 `demo/events.mjs`·`render3d.mjs`·`motion-capture.mjs`의 장면 표,
  `deck/3d/<장면>.py`를 같이 고친다. 디버깅 Chrome(`.chrome-profile`)에 개인 계정 로그인 세션이 있으니 쓰지 않으면 닫고 폴더를 지운다.
- **자막 모양 선택(2026-10-08):** `--caption-style shadow|box`(앱은 "자막 굽기" 옆·제작 세부 설정·화면 재촬영의 "자막 모양").
  기본 `shadow`는 예전과 같다. 흰·밝은 바탕 영상은 `box`(글자 길이에 맞는 불투명 회색 박스). 구조는
  [ARCHITECTURE](ARCHITECTURE.md), 사용법은 [README](../README.md). 앱 화면의 새 선택 상자는 자동 검사만 통과했고 눈으로 열어 본 적은 없다.
- **후보 비교 창 따라 읽기·일치율(2026-10-08):** 텍스트 목소리 후보 창이 넓어지고(1120px) 입력 문장이 보인다. 재생하면
  읽는 단어가 따라 칠해지고 단어를 누르면 그 위치부터 들린다. 영어 음성 구간은 점선 밑줄, 후보 이름 옆에 받아쓰기 일치율,
  카드 아래에 검수 모델이 들은 말이 있다. 계약은 [ARCHITECTURE](ARCHITECTURE.md)의 `wordTimings`. 자동 검사와 Chromium에
  실제 CSS·모듈·실제 후보를 띄운 화면 확인은 통과했고(밝은·어두운 테마), 실제 Electron 앱 창에서 열어 본 적과 사람의 시청은
  없다. 이 변경 전에 만든 후보는 `wordTimings`가 없어 글만 보이고 따라 읽기는 하지 않는다.
- **영어는 영어 목소리로 — 텍스트 목소리·앱 데모·강의 제작 공통(2026-10-08):** 어디가 영어인지는 `language_spans.py` 한 곳에서
  정하고 발음 규칙·음성 라우팅·검수·누락 복구가 같은 답을 쓴다(규칙 전체는 [QUALITY](QUALITY.md)). 따옴표 없이 한국어 사이에
  쓴 영어 문장·절(`We all know that…, 하지만 …`, `Have a wonderful day!`)도 영어 목소리가 읽는다. 전에는 한국어 목소리가 읽고
  한국어 규칙이 영어를 고쳐 썼다(`a`→`에이`). 용어 나열(`Authorization, Attention Budget`)·약어 나열·사전이 구 전체를 덮는
  용어(`Agent to Agent`)는 영어 문장이 아니라서 한글 읽기를 따른다. 두 언어 사이 쉼은 글자에 따라 스크립트가 정한다(문장
  끝 290·370ms, 쉼표 200ms, 문장 중간 120ms). 텍스트 목소리는 한국어 문장과 영어 문장을 한 청크에 섞지 않는다. 영어 철자 그대로
  받아쓰기가 한글로 적은 영어(`디지털 트랜스포메이션`)는 발음 오차율에서 오차로 세지 않는다(한글 읽기가 영어 낱말의 읽기와
  자모까지 같을 때만, `fold_hangul_english`). 낱말 안 쉼 감시도 같은 방식(`fold_timed_english`)으로 영어 용어가 많은 청크에서 켜진다. 강의 대본 전체(1,192청크)에서 읽기가 바뀌는 곳은 1곳뿐이다(`ch03--openai-docs-config`의 UI 제목 `Guardrails and approvals`가 `가드레일즈 and approvals` 대신 영어 구로 읽힌다).
  이 영상들은 전부 다시 만들 예정이라 승인된 챕터의 발음문 보존은 목표가 아니다(사용자 결정). 사용자가 같은 글을 이전 방식과
  새 방식으로 들어 새 방식이 확실히 낫다고 확인했다(2026-10-08, `output/reviews/2026-10-08/english-scope/listen.html`).
- **다음: 한국어 문장 속 영어 낱말 한 번 더:** 사용자가 제출 수준은 충분하지만 한글+영어 조합을 다음에 다시 보자고
  했다. 남은 약점은 받아쓰기가 영어 철자로 적으면 소리를 못 가린다는 것('봅'·'래브스'가 `Bob`·`Lab's`로 적혔다)과
  아래 발음 오차율 문제다. Bob 영상의 `javax`(제치셔틀·ZX)·`PoX`(팍스·PUCS)도 흔들렸다.
- **합성어 띄어 쓰기 규칙 적용됨(2026-10-01):** 발음문에서 `Runtime` → `Run time`처럼 띄어 쓴다. 승인된
  챕터의 발음문은 그대로이고 CH04의 5곳만 바뀐다(`FactSet`·`reportlab`·`Stacklist`, 사전에 넣은 `GitHub` → 깃 허브).
  `Guard` → 가드도 사전에 넣었다. 강의 사전이 한글로 둔 합성어는 그대로 둔다. 표기로 안 바뀌는
  `Agentic`·`Sonnet`은 사전의 한글 읽기(에이전틱·소네트)를 유지한다. `깃 허브` 청취는
  `output/reviews/2026-10-01/english-spelling-compounds/hangul-probe2/`의 `01-GitHub--01-*`.
- **다음: 발음 오차율도 영어 용어의 한글 읽기를 인정하게:** 받아쓰기가 영어 용어를 한글로 적으면(`Proof of
  Experience` → 프루프 오브 익스피리언스) 발음 오차율이 부풀어 멀쩡한 후보가 '받아쓰기 불일치'로 실패한다
  (Bob v5 next-steps 0.15 대 영어로 적힌 후보 0.056). 오차율 비교에도 `english_reading`의 한글 읽기를 쓴다.
- **다음: 영상 연출 도구를 엔진 기능으로:** 사용자가 이런 제출·데모 영상을 여러 번 만들 예정이다. 지금은 Bob 폴더의
  전용 스크립트라, 다음 영상 전에 (1) 한 칸씩 찍는 영상형 덱 캡처, (2) 바뀌는 곳을 따라가는 카메라 연출,
  (3) 3D 장면 틀(Blender)을 앱 데모 엔진으로 옮긴다.
- **(선택) `봇이` 뭉개짐 개선:** 강의에서 넘어갈 수준이다. 6후보 비교 계획이
  `output/reviews/2026-09-24/speech-automation-audit/final-handoff/sample03-evidence/plan.json`에 있다.

## 결과 위치

| 대상 | 경로 |
| --- | --- |
| CH00 | `output/videos/studio-20260928-210855-ch00-full/` |
| CH01 전체·CH02 16편 | `output/edits/2026-09-10/ch01-ch02-english-retrofit-index/최신 영상 목록.md` |
| CH02 L04 후속 수정본 | `output/edits/2026-09-10/ch02-l04-anthropic-refined/` |
| CH03 | `output/videos/studio-20260911-161338-ch03-lessons-ch03-*` |
| CH06 새 판 | `output/videos/studio-20260927-174600-ch06-lessons-ch06-l01` ~ `-l05` |
| RICE 데모 | `output/edits/2026-09-20/rice-core-flow/`, `output/edits/2026-09-21/rice-first-run/` |
| RICE 첫 실행 구도 수정본 | `output/edits/2026-09-22/rice-first-run-framing-v2/` |
| 영어 긴 내레이션 점검 (Bob 영상 말투 표본) | `output/reviews/2026-09-28/english-long-narration/` |
| 영어 대문자 표기 점검 (README·MIGRATION.md·POM) | `output/reviews/2026-09-30/english-spelling/` |
| 문장 안 영어 용어 121개 전환 (청취 선택 완료) | `output/reviews/2026-09-28/mixed-english-terms/` — 되돌리기는 `apply.py --revert` |
| 영어 낱말 한글 받아쓰기 판정 측정 (552회 표본·Bob 8장면) | `output/reviews/2026-09-30/english-hangul/` |
| 늘 틀리는 영어 낱말의 표기 실험·합성어 규칙 회귀 측정 | `output/reviews/2026-10-01/english-spelling-compounds/` |
| Bob Level 3 제출 영상 첫 판·v2·v3·v4·v5 (제출본 v5) | `output/edits/2026-09-30/bob-level3-final/` — 장면별 원본은 같은 날짜의 `bob-level3-*`, v3 재선택 스크립트는 `bob-level3-v3/` |
| 영어 읽기 방식 청취 비교 (이전 / 영어 절·문장) | `output/reviews/2026-10-08/english-scope/listen.html` |
| watsonx.data Stand & Deliver 영상 v3 (회색 박스 자막, 4분 45초) | `output/edits/2026-10-07/watsonx-data-final/` — 구간별 원본은 `watsonx-data-deck-open·mid·close`, 촬영 결과는 `watsonx-data-motion-*` |

후속 편집은 최신 수정본의 PCM·타임라인·자막에서 시작한다. 원래 manifest 음성으로 돌아가면
이미 고친 부분을 덮는다. 예: CH02 L04의 193.295–203.055초는 사용자가 고른 `앤쓰로픽` 후보다.
CH03 L02의 `한 끗이 → 한 끄시`는 사전에만 반영했다.
