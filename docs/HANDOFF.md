# 현재 상태

갱신: 2026-09-30. 지금 남은 일과 결과 위치만 둔다. 지난 경위는 git 기록에 있다.

## 남은 일

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
- **Bob Level 3 제출 영상 — v2 청취:** 첫 판(`IBM Bob Level 3 - 서제호.mp4`, 8분 6초)에서 사용자가 영어 낱말
  발음을 지적해, 엔진에 대문자 영단어 표기 정리와 영어 낱말 받아쓰기로 후보 고르기를 넣고
  ([QUALITY](QUALITY.md#생성과-독립-판독)) 영어가 많은 8장면을 새 엔진으로 다시 만든 `… v2.mp4`(8분 4초)가
  `output/edits/2026-09-30/bob-level3-final/`에 있다. 두 판을 들어 비교한다: README 2:36(understand),
  MIGRATION.md 6:06(document), 그 밖에 다시 만든 곳 0:21·0:48·2:23·3:09·4:26·6:24. 목소리는 자동 검사
  기준으로 골랐고 청취 전이다. 새 판에서도 영어 낱말의 상당수가 받아쓰기에 한글로 적혀(판독 신호가 닿는
  범위가 제한적) 개선 폭은 들어서 판단해야 한다. 다시 찍거나 고칠 때: 장면 목소리는 `npm run demo -- voice
  <폴더> --scene <id>`, 굽기는 `render <폴더> --quality standard`, 잇기는 `bob-level3-final/parts.txt`로
  `ffmpeg -f concat -safe 0 -c copy`. 촬영은 [APP-DEMO-DESIGN](APP-DEMO-DESIGN.md#8-bob-사람이-띄운-앱에-붙는다-2026-09-30)과
  `/Users/jaehoseo/Desktop/vswrk/bob/level3-demo/`(시나리오·장표·연습 저장소)에 있다.
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
| Bob Level 3 제출 영상 첫 판·v2 (목소리는 자동 검사로 고름, 청취 전) | `output/edits/2026-09-30/bob-level3-final/` — 장면별 원본은 같은 날짜의 `bob-level3-*` |

후속 편집은 최신 수정본의 PCM·타임라인·자막에서 시작한다. 원래 manifest 음성으로 돌아가면
이미 고친 부분을 덮는다. 예: CH02 L04의 193.295–203.055초는 사용자가 고른 `앤쓰로픽` 후보다.
CH03 L02의 `한 끗이 → 한 끄시`는 사전에만 반영했다.
