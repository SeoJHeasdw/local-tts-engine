# 아키텍처와 데이터 계약

## 책임과 코드 위치

`udemy-agent`는 강의 대본·화면·자료와 그 소스 고정, 이 저장소는 개인 음성·TTS 작업·
자막·타임라인·화면 촬영·완성 영상을 소유한다. 실행법은 [README](../README.md)에 있다.

| 위치 | 책임 |
| --- | --- |
| `electron-app/main.mjs` | Electron 실행 진입점 |
| `electron-app/main/application.mjs` | 서비스 조립과 앱 수명 |
| `electron-app/main/runtime.mjs`, `job-process.mjs` | 프로세스 실행·진행 이벤트·중지·일시정지 |
| `electron-app/main/production.mjs` | 입력 고정 → 합성 → 자막 → 촬영 → 검증·발행 |
| `electron-app/main/recording.mjs` | 디스플레이 수동 녹화의 시작·정지·결과 기록 |
| `electron-app/main/capture/` | 화면 촬영: 규격·인코딩·프레임 전송·사이트 서버, 디스플레이 목록·녹화, 앱 조작 |
| `electron-app/main/workers/` | 별도 프로세스로 도는 입력 고정·자막·촬영·녹화·앱 데모 진입점 |
| `electron-app/main/voices.mjs` | 텍스트·페이지 음성 후보와 학습 작업 |
| `electron-app/main/editing/` | 합치기·페이지 교체·구간 편집·미리듣기 |
| `electron-app/main/`의 나머지 서비스 | 경로·설정·목록·파일·미디어·결과·IPC·창 관리 |
| `electron-app/renderer/app.js` | 초기화·화면 전환·제작 진행 |
| `electron-app/renderer/job-pace.mjs` | 단계별 실측으로 내는 이 편·전체 남은 시간 |
| `electron-app/renderer/controllers/` | 검수·클립 편집·최근 결과·화면 녹화 화면 |
| `electron-app/shared/` | 옵션·이름·타임라인·검수·시간 계산·촬영 규격·자막 cue·데모 시나리오와 편집 계획 |
| `src/local_tts_engine/course_pilot.py` | 강의 생성 CLI 조립 |
| `src/local_tts_engine/course/` | 대본 입력·청킹·오디오·정렬·직렬화 |
| `src/local_tts_engine/course_catalog.py` | 생성 모델을 로드하지 않는 목록 CLI |
| `src/local_tts_engine/`의 나머지 모듈 | 발음·독립 검수·텍스트 후보·내보내기·학습 |
| `scripts/`, `tests/` | 수동 운영 도구와 회귀 검사 |

## 의존성 규칙

- Electron은 진입점에서 서비스에 주입한다. 서비스는 Electron을 직접 import하지 않는다.
- `main`과 `renderer`는 서로의 구현을 import하지 않는다. 공통 계산은 `shared`에 두고
  `shared`에서 상위 계층을 참조하지 않는다.
- renderer의 의존성 전체에는 Node·Electron이 없어야 한다. Node용 공유 모음은
  `shared/index.mjs`, 브라우저는 필요한 개별 모듈을 사용한다.
- Python `course/`는 `course_pilot` 조립 모듈을 역참조하지 않는다. 기존 CLI·helper
  import와 저장된 검수 명령의 `scripts/` 경로는 호환 계약이다.
- `npm run check:architecture`가 경로 단절·계층 역참조·순환·브라우저 의존성을 검사한다.
  동작 검사는 실제 서비스·컨트롤러를 import하며 소스 조각 평가로 구현을 복제하지 않는다.

## 제작 흐름과 복구

```text
preload IPC → 제작 서비스 → 독립 입력 준비 → Python 합성·검수·정렬
            → export → 자막 → 촬영 → 파일 검증 → 발행
```

`main/workers/prepare-input.mjs`가 덱의 `tools/production.mjs`를 별도 프로세스로
실행한다. 화면·대본·자료·순서를 `.production-input`에 고정하고 전후 해시, 선택 ID·
스텝, 챕터 린터를 검사한다. 영상이면 타입 검사·정적 빌드도 수행한다. 한 챕터의 모든
레슨은 이 입력을 사용한다. 제작은 고정한 입력을 읽기만 하며 고쳐 쓰지 않는다.

내보내기·자막·촬영은 preset 이름이 아니라 타임라인 파일과 결과 폴더를 직접 받는다.
영상 범위·음성 정의는 `exportContract`가 manifest에서 만들어 인자로 넘긴다.
덱의 `narration.config.json`은 레슨 목록을 읽는 입력일 뿐 제작 중 쓰지 않는다.

촬영은 `main/workers/capture.mjs`가 별도 프로세스로 돈다. 중지 버튼이 프로세스
그룹째 끝낼 수 있고 페이지 충돌이 앱을 죽이지 않는다. 안에서는 규격
(`shared/video-quality.mjs`), 프레임 전송(`capture/recorder.mjs`), 인코딩
(`capture/encoding.mjs`), 사이트 서버(`capture/site.mjs`)가 화면 종류와 무관하게
동작하고, 덱 고유의 조작만 `capture/deck-page.mjs`에 모인다. 대본·편집점 판정은
덱이 소유하므로 `capture/deck-source.mjs`가 얼려 둔 입력의 `tools/production.mjs`를
불러 쓴다. 소스 판본 검사를 건너뛰려면 `--no-source-check`를 명시해야 한다.

발음 처리는 각 레슨의 `course_entries`에서 한 번 수행한다. 미등록 용어는 합성을
막지 않고 실제 청크 시각과 함께 완료 후 검수 대상으로 남긴다. 상세는 [QUALITY](QUALITY.md).
`sourceContract`는 manifest → export timeline → 검수·촬영 기록으로 전달한다.
촬영 전 타임라인의 ID·구도·videoBeats가 고정한 사이트와 일치하는지 확인한다.

중지는 프로세스 그룹에 SIGTERM, 남으면 3초 뒤 SIGKILL을 보낸다. 촬영 중 일시정지는
현재 편 뒤에 처리한다.

남은 시간은 한 편의 단계(목소리·자료 연결·자막·촬영·검증)마다 실제 소요를 모아
남은 단계의 몫을 더해 낸다. 촬영은 강의 길이만큼 실시간으로 돌므로 합성 직후
`unit-duration`으로 보낸 음성 길이를 쓰고, 아직 합성하지 않은 편은 페이지당 소요로
잡는다. 실제 정지 시간과 시스템 절전(`powerMonitor`) 시간은 경과에서 제외한다.
단계별·페이지당 속도와 촬영 비율은 화질별로 브라우저 저장소에 남겨 다음 실행의
첫 편에 시작값으로 쓰되, 이번 실행의 실측이 곧 앞서도록 무게를 낮춰 넣는다.
레슨 분할 제작은 개별 실패를 기록하고 나머지를 계속하되 사용자 중지는 즉시 전파한다.

| 기록 | 의미 |
| --- | --- |
| `.production-input/production-input.json` | 고정 입력·선택 범위의 판본 |
| 음성 `manifest.json` | 발음문·실제 음성 길이·정렬·검수 근거 |
| 레슨 `validation-report.json` | 파일 검사·음성 확인 항목·결과 위치 |
| 챕터 `chapter-report.json` | 완료·실패 레슨과 원인 |
| `artifacts/active-job.json` | 명시적 이어하기의 옵션·완료·실패 기록 |

실패 시 입력을 보존하고 성공·중지·이어하기 기록 삭제 때 정리한다. 이어하기는 완료
레슨의 실제 파일·화질·판본·해시를 검사한다. 실패 레슨의 음성·정렬·촬영은 새로 실행한다.
새 작업은 과거 완성본을 자동으로 건너뛰지 않으며 앱의 생성 캐시는 항상 꺼져 있다.

## 화면 녹화

디스플레이 하나를 사람이 시작·정지하는 녹화다. 강의 제작 흐름과 따로 돌고 내레이션은
다듬기의 구간 음성 교체로 넣는다. `main/workers/record-display.mjs`가 별도 프로세스로
`capture/record-display.mjs`를 돌린다. 화면은 `capture/displays.mjs`가 avfoundation
목록에서 `Capture screen N`을 이름으로 찾고, 녹화 직전에 다시 조회해 번호를 얻는다.

| 조작 | 경로 | 결과 |
| --- | --- | --- |
| 정지 | `finishJobProcesses`: 작업자 PID에만 SIGUSR1 → ffmpeg stdin에 `q` | 무음 트랙을 붙이고 검증해 남긴다 |
| 취소 | 공통 `cancelJobProcesses`: 그룹에 SIGTERM | 이번 녹화 폴더를 지운다 |
| 일시정지 | 거절 | SIGSTOP은 영상에 공백을 만든다 |

정지 신호를 그룹에 보내면 ffmpeg가 SIGUSR1로 죽어 파일을 닫지 못한다. 정지에는 강제
종료 시계가 없고 `job.cancelled`를 쓰지 않는다. ffmpeg는 늘 파이프 stdin으로 띄운다.
작업자는 단계를 `[record] {"phase":…}` 줄로 알리고 실행기가 `record-phase` 사건으로 바꾼다.

결과는 `editOutputRoot/<날짜>/<이름>/`에 `<이름>.mp4`, `.capture.json`, 편집 결과와 같은
모양의 `validation-report.json`(`operation: "record-display"`, `warnings`)으로 남아
최근 결과·이름 변경·다듬기가 그대로 받는다. 검증에 실패한 녹화는 지우지 않고 실패로
기록한다. 규격과 측정은 [VIDEO-QUALITY](VIDEO-QUALITY.md#화면-녹화)에 있다.

## 앱 데모 촬영

직접 만든 앱을 자동으로 조작하며 찍는다. 강의 촬영과 방향이 반대다. 덱은 대본이 화면을
끌고 가지만(음성 → 타임라인 → 촬영) 앱 데모는 화면을 먼저 찍고 대본이 맞춘다. AI 응답의
내용과 길이를 미리 알 수 없기 때문이다. 결정 근거는 [APP-DEMO-DESIGN](APP-DEMO-DESIGN.md).

```text
demo record  앱 띄우기 → 동사 실행 + RGB 무손실 녹화 → demo/scenes.json
Claude·사용자  scenes.json의 화면 글을 근거로 demo/script.json 대본, status=approved
demo voice   장면마다 목소리 후보 → 사람이 듣고 voice.selected에 적는다
demo render  edit-plan.json → ffmpeg 한 번 → 자막 → 검증·보고서
```

| 위치 | 책임 |
| --- | --- |
| `shared/demo-scenario.mjs` | 시나리오 검증·정규화: 동사·선택자·자리표시자·제한 시간. 순수 |
| `shared/demo-plan.mjs` | scenes.json + 내레이션 길이 → 편집 계획. 순수 |
| `main/capture/app-page.mjs` | 앱 띄우기(electron·web), 준비·서버·ready 대기, 에뮬레이션, 동사 실행, 장면 기록 |
| `main/capture/cursor-overlay.mjs` | 페이지에 넣는 커서·클릭 표시. 실제 마우스 사건을 따라 그린다 |
| `main/capture/record-app.mjs` | `record` 한 번: 작업 폴더·무손실 녹화·scenes.json |
| `main/editing/demo-render.mjs` | 편집 계획 → ffmpeg 한 번, 음성·자막, 검증·보고서 |
| `main/editing/demo-review.mjs` | 결과 폴더 → `review.html`. 영상·구간·확대·대본·검증을 한 쪽에 모은다 |
| `main/workers/demo.mjs` | CLI 진입점: `record`·`voice`·`render` |

**앱을 아는 것은 시나리오 파일뿐이다.** 촬영 엔진은 앱 이름을 모른다. 덱 고유의 조작이
`deck-page.mjs`에 모이듯 앱 고유의 사정은 시나리오에 모인다. 시나리오는 그 앱의 저장소가
가진다(`demo/scenarios/<이름>.json`). 이 저장소에는 시나리오를 두지 않는다 — 앱이 바뀌면
같이 바뀌어야 하기 때문이다. RICE 시나리오는 `bob/rice/demo/scenarios/rice-core-flow.json`이다.

시나리오의 동사는 `click`·`type`·`press`·`hover`·`scroll`·`waitFor`·`waitGone`·`pause`다.
대상은 선택자 문자열이거나 `{ role, name, exact }`·`{ placeholder }`·`{ text }`·`{ label }`
중 하나다. 글자로 찾는 버튼은 `exact: true`로 둔다("승인"이 "승인하고 적용"에 걸리지 않게).
`{scenario}`는 시나리오 파일 폴더, `{work}`는 이번 촬영의 작업 폴더이며 끝나면 지운다.
장면의 대본은 시나리오에 두지 않는다 — 찍은 뒤 `script.json`에 쓴다.

| 기록 | 의미 |
| --- | --- |
| `demo/raw.mkv` | RGB 무손실 원본. 다시 찍지 않고 고치기 위해 남긴다 |
| `demo/scenes.json` | 장면·걸음의 시각(ms)·좌표(CSS px)·장면 끝 화면의 글 |
| `demo/script.json` | 장면별 대본·확정 상태·목소리 후보와 고른 것 |
| `demo/edit-plan.json` | 구간·배율·멈춤·확대 키프레임·내레이션 자리 |
| `validation-report.json` | `operation: "app-demo"`. 최근 결과·다듬기·합치기가 그대로 받는다 |
| `review.html` | 사람이 보고 판단하는 화면. 렌더가 끝나면 다시 쓰고 CLI가 연다 |

편집 계획은 프레임 단위로 센다. 밀리초로 자르면 배율마다 반 프레임이 남아 최종 프레임
수가 계획과 어긋난다. 감는 것은 `waitFor`·`waitGone`뿐이고 사람 동작은 1배다. 장면 목표
길이는 `max(내레이션 + 0.8초, 감을 수 있는 만큼 감은 원본)`이며, 감아도 짧으면 장면 끝
화면을 멈춰 채운다. 확대는 누른 자리를 중심으로 걸고 z=1에서는 중심이 화면 한가운데가
되도록 가둔다. 규격·측정은 [VIDEO-QUALITY](VIDEO-QUALITY.md#앱-데모-촬영)에 있다.

검수 화면은 검증에 실패해도 만든다. 무엇이 어긋났는지 보려면 영상을 봐야 하기 때문이다.
결과 폴더의 mp4를 모두 실어 해상도를 바꿔 가며 같은 자리를 비교하고, 대본·목소리가 아직
없어도 열린다 — 그때 판단할 것이 화면·배율·확대다.

## 타임라인과 편집

`sourceText`/`source_text`는 자막 원문, `ttsText`/`tts_text`는 발음문이다. 생성 후
실제 오디오와 ForcedAligner 단어 시각으로 화면·자막을 배치한다. `[Ns]` 단독 줄은
0.1~10초 무음이며 자막에 노출하지 않는다. 읽을 문장 없는 마커는 입력 오류다.

페이지 교체는 선택 음성과 그 길이 차이만 반영한다. 여러 교체는 뒤에서부터 적용하고
다른 페이지의 검수·확인 키·자막을 보존한다. 교체된 판독은 다시 청취할 대상으로 표시한다.
최신 수정본의 PCM·타임라인을 사용하며 원본 manifest로 되돌리지 않는다.

영상 스트림 복사·재인코딩·해상도·프레임률 보존 기준은 [VIDEO-QUALITY](VIDEO-QUALITY.md)에
모아 둔다. 구간 편집은 `match-audio`에서 화면 길이를 음성에 맞추고, `keep-video`에서
짧은 음성은 무음으로 채우되 긴 음성은 거절한다. 무음은 0.05~2초, 준비 음성 교체는
0.05~120초다. 미리듣기는 실제 WAV를 자르며 오래된 응답을 버리고 임시 파일은 최근 8개만 둔다.

미디어 정보 조회는 요청당 최대 4개씩 실행하고 같은 요청의 중복 파일 조회만 공유한다.
이 내부 병렬 조회는 실패 뒤 새 배정을 멈추고 이미 실행 중인 작업을 기다린다.
이는 레슨별 제작 실패 후 다음 레슨으로 진행하는 정책과 별개다.

완성 영상은 같은 이름의 `.timeline.json`을 갖고 이름 변경 시 연결 파일도 이동한다.
삭제는 UI 확인 후 휴지통으로 보낸다. 원본·완성본·개인 음성·가중치는 자동 정리하지 않는다.
`review.status=approved`와 사용자 확인 키는 자동 파일 검사와 독립적으로 저장한다.
