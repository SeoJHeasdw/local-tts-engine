# 아키텍처와 변경 경계

## 저장소 책임

`udemy-agent`는 강의 대본·슬라이드·캡처 도구를 소유한다. 이 저장소는 개인 음성,
TTS 작업, 제작 앱, 자막·타임라인과 완성 영상을 소유한다. 두 저장소를 수정해야
할 때는 강의 소스의 `NARRATION-PIPELINE.md`, `VIDEO-PACING-GUIDELINES.md`를 먼저 읽는다.

## 코드 배치

```text
electron-app/
  main.mjs                    Electron 실행 진입점
  preload.cjs                 허용된 IPC API
  main/
    application.mjs           서비스 조립과 앱 수명
    paths.mjs                 프로젝트 경로·제작 기본값
    runtime-config.mjs        외부 실행 도구 탐색
    runtime.mjs               작업 실행과 진행 이벤트
    job-process.mjs           자식 프로세스·중지·일시정지
    settings.mjs, catalog.mjs  설정과 강의 목록
    production.mjs            입력 고정→TTS→자막→촬영→검증
    voices.mjs                페이지·텍스트 후보와 학습 작업
    media.mjs                 선택 파일 토큰과 미디어 정보
    files.mjs, outputs.mjs    파일·결과 목록·이름·검수 상태
    editing.mjs               편집 작업 분기
    editing/                  합치기·페이지 교체·구간 편집
    ipc.mjs, window.mjs       화면 요청과 창 관리
    workers/prepare-input.mjs 독립 입력 복사·검사 프로세스
  renderer/
    app.js                    초기화·화면 전환·제작 진행 연결
    controllers/              검수·클립 편집·최근 결과
    index.html, styles.css    화면·디자인 규칙
    motion.mjs, view-utils.mjs 화면 동작과 표시 계산
  shared/                     옵션·이름·타임라인·검수·시간 규칙
src/local_tts_engine/
  course_pilot.py             강의 생성 조립과 기존 CLI
  course/                    대본·청킹·오디오·정렬·직렬화
  course_catalog.py           모델을 로드하지 않는 목록 CLI
  text_candidate.py          텍스트 후보 CLI
  export_udemy.py             기존 덱 타임라인 계약으로 내보내기
  pronunciation.py 등         발음·받아쓰기·운율 검수
  finetune_*.py               데이터 준비·학습·평가
scripts/                     진단·수동 검수·복구 CLI
config/                      제작 사전·데이터 연결
tests/electron/              앱·실제 FFmpeg·화면 동작 검사
tests/test_*.py, fixtures/   Python 검사·재현 자료
```

## 의존성 규칙

- 실행 진입점은 서비스를 조립한다. 서비스는 Electron을 직접 가져오지 않으며,
  필요한 실행기·파일 선택·상태·UI API를 생성자 인자로 받는다.
- 앱 작업 상태와 창, 도구 경로는 `application`이 만든 상태를 공유한다.
  선택 파일과 검수 미리보기 등 기능별 상태는 소유 서비스 안에 둔다.
- `main`은 `renderer` 구현에 의존하지 않는다. 양쪽에서 쓰는 계산은 `shared`에 둔다.
- 브라우저 컨트롤러는 `main`, Node, Electron을 가져오지 않고 preload API를 사용한다.
- `shared`는 `main`·`renderer`를 역으로 참조하지 않는다. 브라우저는 Node 의존성이
  없는 모듈만 직접 가져온다. `shared/index.mjs`는 Node 측의 모음 진입점이다.
- Python `course`의 입력·오디오·정렬 모듈은 `course_pilot` 실행 조립에 역의존하지 않는다.
  기존 CLI 이름은 안정된 외부 계약이므로 내부 폴더 정리 때문에 바꾸지 않는다.
- `scripts`는 저장된 검수 실행 파일에서도 호출한다. 일회성 생성물은 여기에
  추가하지 않고 `output/reviews/` 또는 `artifacts/`에 둔다.

새 기능은 책임이 맞는 모듈에 넣는다. 공통 계산을 거대한 utils 파일에 계속 쌓거나,
테스트에서 실행 파일의 문자열 조각을 평가해 내부 함수를 호출하지 않는다.
`npm run check:architecture`가 경로 단절, 계층 역참조, 순환 의존성을 확인한다.

## 제작 흐름

```text
preload IPC → 작업 서비스 → 독립 Node 입력 준비 → Python 생성·검수
            → export → 덱 자막·캡처 도구 → 결과 검증·발행
```

시작 시 `udemy-agent/deck/tools/production.mjs`가 화면·대본·자료·순서를
`.production-input`에 고정한다. 전후 해시, 선택 ID와 스텝, 챕터 린터를 검사하고
영상이면 타입 검사와 정적 빌드까지 수행한다. 같은 챕터의 모든 레슨은 이 복사본을
사용한다. 원본의 narration.config를 제작 중 고치지 않는다.

입력 복사와 빌드는 별도 Node 프로세스이므로 앱 중지 요청을 막지 않는다.
`sourceContract`는 음성 manifest → export timeline → 검수 기록으로 전달한다.
촬영 전 실제 타임라인의 구도·videoBeats 검사와 사이트 계약 대조를 수행한다.

중지는 자식 프로세스 그룹에 SIGTERM을 보내고 남으면 3초 뒤 SIGKILL을 보낸다.
임시 입력 정리 뒤 종료 상태를 표시한다. 진행 중 stdout/stderr는 앱과 실행
터미널에 함께 전달한다. 중단 작업 기록은 `artifacts/active-job.json`이 담당한다.

## 생성·자막 계약

- `sourceText`/`source_text`는 자막 원문, `ttsText`/`tts_text`는 발음 치환문이다.
- 의미 단위의 짧은 청크를 생성하고 실제 파일의 길이를 잰다. 시간은 추정하지 않는다.
- 모델·참조·발음·운율 판정과 승인 정책은 [QUALITY](QUALITY.md)를 따른다.
- 단어 시각은 생성·검수 모델 해제 후 ForcedAligner로 얻어 기존 덱 계약으로 내보낸다.
- `[Ns]`는 단독 줄의 0.1~10초 강제 대기다. 문장 앞·사이·같은 페이지 다음 스텝
  앞에 실제 무음을 넣되 자막에는 노출하지 않는다. 마커만 있는 스텝은 입력 오류다.
- CLI 해시 캐시는 문장·모델 revision·참조 해시·언어·seed·설정을 포함한다.
  앱 강의 제작은 TTS·정렬·브라우저 캐시를 항상 우회한다.
- 캡처는 고정 사이트와 독립 서버를 사용하고 동기 마커의 실제 프레임 시각으로
  녹화 지연을 제거한다. 결과 파일·길이·타임라인·자막 검사가 제작 성패를 결정한다.

## 편집과 결과 보존

페이지 교체는 선택 범위의 음성만 바꾼다. 원본 앞뒤는 유지하고 길이 차이를
뒤쪽 타임라인에 반영한다. 여러 교체는 뒤쪽부터 적용해 원래 좌표를 유지한다.
단일·복수 페이지 진입점은 하나의 검증·렌더·기록 보존 경로를 사용한다.
두 경로 모두 화면 길이가 같으면 영상 스트림을 복사하고 기존 보고서 형식을 유지한다.
교체에 겹친 옛 판독은 `교체 후 청취 확인`으로 바꾸고 다른 경고·확인 키를 보존한다.
JSON/SRT/VTT도 화면과 같은 비율로 이동하며 문구·묶음은 유지한다. 새 단어
정렬을 추론하는 기능으로 설명하지 않는다.

구간 무음은 0.05~2초, 준비된 음성 교체는 0.05~120초다. `match-audio`는 음성을
자르거나 속도를 바꾸지 않고 화면을 조정한다. `keep-video`는 짧으면 무음을 채우고
길면 거절한다. 양끝 5ms 페이드를 적용한다. 미리듣기는 실제 WAV를 잘라 재생하며
오래된 선택의 응답을 버린다. 미리보기 임시 파일은 최근 8개와 앱 종료 때 정리한다.

클립 합치기는 필요한 클립만 정규화하고 규격이 맞는 전체 클립은 복사한다.
자르기의 시작점은 음성 트랙 유무와 관계없이 영상에 적용한다. 페이지 타임라인도
남은 범위에 맞춰 이어 붙인다.

파일 선택·합치기의 입력 정보 검사는 요청당 최대 4개씩 실행한다. 파일 선택은
설정을 한 번 읽고 같은 파일의 검사를 해당 요청 안에서만 공유한다. 새 요청은
파일을 다시 읽는다. 합치기 정규화는 앞서 읽은 입력 정보를 재사용한다.
이는 TTS·정렬·촬영 캐시와 별개인 미디어 정보 조회 정책이다.

병렬 작업에서 하나가 실패하면 새 항목 배정을 멈추고 이미 시작한 작업이
끝난 뒤 첫 오류를 전달한다. 다른 작업을 남겨둔 채 실패 완료 상태로 바뀌어
새 제작과 자원이 겹치는 것을 막는다.

완성 영상은 자기 이름의 `.timeline.json`을 함께 갖는다. 이름 변경은 연결 파일과
검수 기록도 함께 옮긴다. 삭제는 UI 확인 후 작업·영상 폴더를 휴지통으로 보낸다.
기존 결과·정본·가중치를 소스 정리나 앱 업그레이드 과정에서 자동 삭제하지 않는다.

`validation-report.json`의 자동 검사와 `review.status=approved`는 별개다.
사용자 확인 키는 결과에 저장하며 취소할 수 있다. 새 수정본의 전체 청취 상태는
pending이다. 최신 수정본을 다시 편집할 때는 최신 PCM·타임라인·자막과 그 해시를
기준으로 삼는다.

## 검증과 문서 유지

`npm test`는 `tests/electron`과 Python 검사를 실행한다. 미디어 회귀 검사는
짧은 합성 신호와 실제 FFmpeg를 사용하며 개인 음성이나 모델 다운로드를 요구하지 않는다.
모델 대체물을 쓰는 파이프라인 검사와 실제 TTS 생성·사용자 청취 승인은 구분한다.

README는 실행·폴더 안내, HANDOFF는 현재 상태, 이 문서는 책임·계약,
QUALITY는 음성 검수, DECISIONS는 승인·라이선스 근거를 소유한다.
완료된 UI 변경이나 일회성 실행 로그는 이 문서들에 반복해서 누적하지 않는다.
