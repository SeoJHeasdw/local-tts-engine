# Local TTS Engine 작업 지침

Apple Silicon Mac에서 개인 음성·자막·화면 촬영으로 강의 영상을 만드는 로컬 엔진이다.
강의 대본과 화면(덱)은 `/Users/jaehoseo/Desktop/vswrk/edu/udemy-agent`에 있다.
Python은 3.13.12이며, 검사 환경은 `.venv`, MLX 제작 환경은 `.venv-train`이다.

## 시작과 마무리

- 현재 상태와 남은 일은 `docs/HANDOFF.md`에 있다. 다른 문서는 그 작업을 할 때 읽는다.
- 음성·제작 작업 전에는 `python3.13 scripts/check_context.py`로 덱 연결과 음성 정본을 확인한다.
- 작업 트리의 기존 수정은 보존한다. 코드를 바꿨으면 `npm run check`로 마무리한다.

## 사용자가 정한 규칙

- 제작 목소리는 Qwen3-TTS 1.7B Base + `jaeho-ko-r16-v1` LoRA 0.60과 참조 음성·전사다.
  모델·목소리 기본값은 사용자가 직접 듣고 승인해야 바꾼다. 모델 선택과 LoRA 학습은 끝났다.
- 품질이 속도·자원 절약보다 우선이다. 품질과 비용을 맞바꿔야 하면 효과와 손실을
  설명하고 사용자가 정한다.
- 사전에 없는 용어가 있어도 제작을 멈추지 않는다. 완성 후 검수·페이지 재생성에서
  처리하며, 사전에 자동 등록하지 않는다.
- 요청받은 범위만 생성한다. 설치나 모델 다운로드 전에는 목적과 예상 용량을 알린다.

## 데이터와 경계

- 음성 원본·정제본(`data/private/voice/`)은 불변이다. 덮어쓰기·이동·재인코딩하지 않는다.
- 모델 가중치·음성·생성물·캐시·`.env`·토큰은 커밋하지 않는다. API 키나 로그인 세션을
  요청하거나 기록하지 않는다.
- 새 모델·음성·코드 의존성은 상업용 라이선스를 확인하고 `docs/DECISIONS.md`에 출처와 날짜를 남긴다.
- 대본·슬라이드·화면은 `udemy-agent`, 음성·자막·타임라인·촬영·완성 영상은 이 저장소가
  소유한다. 덱을 고치기 전에는 그 저장소의 지침과 `NARRATION-PIPELINE.md`,
  `VIDEO-PACING-GUIDELINES.md`를 읽는다.
- 덱 화면의 약속을 아는 코드는 `electron-app/main/capture/deck-page.mjs` 하나에 두고,
  덱의 대본·편집점 판정은 `capture/deck-source.mjs`로만 부른다.
- 클립·해시·타임라인 계약, Python CLI 이름, 저장된 검수 명령이 쓰는 `scripts/` 경로는 유지한다.

## 보고와 문서

- 사용자에게는 한국어로 결론부터 간결하게 보고한다. 자동 검사 통과와 사람의 청취·시청
  승인은 구분해서 말한다.
- README는 사용법, HANDOFF는 현재 상태·결과 위치, ARCHITECTURE는 구조·데이터 계약,
  QUALITY는 음성 검수, VIDEO-QUALITY는 영상 규격·측정, DECISIONS는 승인·라이선스를 맡는다.
- 문서에는 현재 규칙과 상태만 둔다. 경위와 작업 일지는 커밋 메시지에 남기고 문서에 쌓지 않는다.
