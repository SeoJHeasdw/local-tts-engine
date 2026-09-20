# 앱 데모 촬영 설계도

확정: 2026-09-18. **구현 전 계획**이다. 결정은 사용자 인터뷰로, 전제는 같은 날 RICE를
고치지 않고 실제로 띄워 잰 값(10절)으로 닫았다. 다음 세션은 15절 순서대로 바로 개발한다.
측정 스크립트와 결과는 `output/reviews/2026-09-18/app-demo-spike/`에 있다. 촬영 규격은
[VIDEO-QUALITY](VIDEO-QUALITY.md), 디스플레이 녹화는 [ARCHITECTURE](ARCHITECTURE.md#화면-녹화)를 따른다.

## 1. 목적

직접 만든 Electron·웹 앱을 **자동으로 조작하며 찍고** 한국어 내레이션을 붙여 유튜브용 제품
소개 영상을 만든다. 판매가 아니라 "이런 걸 만드는 사람"임을 보이는 용도다. 저장소 40개 중
솔루션이라 할 5개가 대상이고, 첫 대상은 **RICE**(`/Users/jaehoseo/Desktop/vswrk/bob/rice`),
다음은 **IBM Bob**이다. RICE는 README에 IBM 내부용이라 적혀 있지만 사용자가 두 달간 혼자
만든 챌린지 출품작이며 공개해도 된다고 확인했다(2026-09-18).

강의 덱 촬영과 방향이 반대다. 덱은 대본이 화면을 끌고 간다(음성 → 타임라인 → 촬영).
앱 데모는 **화면이 먼저**이고 대본이 맞춘다. AI 응답의 내용과 길이를 미리 알 수 없어서다.

## 2. 결정

| 항목 | 결정 |
| --- | --- |
| 방식 | **찍고 나서 내레이션을 붙인다.** AI 응답은 실제 Ollama가 낸다. AI 장면의 대본은 찍은 뒤 실제 결과에 맞춰 쓴다 |
| 대본 | 장면별 초안은 Claude가 촬영 기록을 보고 쓰고, 사용자가 고친다 |
| 목소리 | 한국어 제작 목소리(Qwen3-TTS + LoRA 0.60). 장면마다 후보를 만들고 사람이 듣고 고른다 |
| 첫 데모 | **핵심 흐름 한 장면**: 채팅 요청 → 실행 계획 → 승인 → 결과, 30~60초 |
| 찍는 범위 | 앱 창의 내용만(CDP 스크린캐스트). 알림·다른 창·OS 메뉴가 끼지 않는다 |
| 연출 | 보이는 커서, 클릭 표시, 사람 속도의 타이핑, 클릭 지점 자동 확대, AI 대기 빨리 감기 |
| 화질 | 손실 압축은 한 번뿐이다. RGB 무손실로 받아 편집을 모두 적용한 뒤 한 번 인코딩한다 |
| 결과 위치 | `output/edits/<날짜>/<이름>/`, `operation: "app-demo"`. 최근 결과·다듬기·합치기가 그대로 받는다 |

만들지 않는 것: 녹화한 응답을 재생하는 가짜 모델, 배경음악, 네이티브 macOS 앱·터미널 도구
지원(디스플레이 녹화로 간다), 로그인 자동화, 이번 단계의 앱 화면 메뉴(CLI 먼저).

## 3. 재사용과 신규

| 재사용 | 신규 |
| --- | --- |
| `capture/recorder.mjs`: CDP 프레임 수신·시각 정렬·크기 검사 | 시나리오 실행: 앱 띄우기·동사 실행·장면 기록 |
| `capture/encoding.mjs`: 최종 인코딩 규격·스트림 검증 | 커서 오버레이: 커서·클릭 표시를 페이지에 그린다 |
| `text_candidate` CLI: 제작 목소리 후보 | 편집 계획: 빨리 감기·멈춤·확대·내레이션 위치 |
| 자막 cue·SRT/VTT, 구간 교체, 합치기 | 렌더: 계획을 ffmpeg 한 번 인코딩으로 |

촬영 엔진은 이미 "화면 종류와 무관한 부분"과 "덱만의 조작(`deck-page.mjs`)"으로 나뉘어 있다.
앱 데모는 두 번째 자리에 앱 조작을 넣는다. **앱을 아는 것은 시나리오 파일뿐**이고 엔진은
앱 이름을 모른다.

## 4. 흐름

```text
npm run demo -- record <시나리오>   앱 띄우기 → 동사 실행 + RGB 무손실 녹화 → scenes.json
Claude                              scenes.json을 읽고 script.json 초안(장면별 대본)
사용자                              script.json 수정·확정
npm run demo -- voice <결과 폴더>    장면마다 목소리 후보 3개 → 사람이 듣고 고름
npm run demo -- render <결과 폴더>   edit-plan.json → 한 번 인코딩 → 자막 → 검증·보고서
```

`record`만 다시 하면 새 촬영이고, 대본·목소리·계획만 바꾸면 `render`만 다시 돈다.
다시 찍지 않고 고칠 수 있게 무손실 원본(`raw.mkv`)을 결과 폴더에 남긴다.

## 5. 시나리오

위치는 앱 저장소의 `demo/scenarios/<이름>.json`이다. RICE 수정 승인 전인 파일럿은 이 저장소의
`config/demo/rice-core-flow.json`에 두고, 승인 뒤 rice 저장소로 옮긴다.

```json
{
  "schemaVersion": 1,
  "name": "rice-core-flow",
  "app": {
    "kind": "electron",
    "cwd": "/Users/jaehoseo/Desktop/vswrk/bob/rice/rice-app",
    "prepare": ["bash", "{scenario}/bundle-rice.sh", "{work}/app"],
    "server": { "command": ["npx", "vite", "--config", "vite.renderer.config.ts", "--port", "5173", "--strictPort"],
                "url": "http://localhost:5173" },
    "executable": "node_modules/electron/dist/Electron.app/Contents/MacOS/Electron",
    "args": ["{work}/app"],
    "window": "http://localhost:5173",
    "env": { "NODE_ENV": "development", "RICE_HOME": "{work}/home", "RICE_RUNTIME_DIR": "../rice-runtime" },
    "files": { "home/config.yaml": "provider:\n  kind: ollama\n  model: qwen3.6:35b-a3b-q4_K_M\n  base_url: http://localhost:11434\n  configured: true\n  show_thinking: true\nui:\n  workspace_path: /tmp/rice-demo/workspace\n" },
    "ready": { "console": "runtime connected", "timeoutMs": 60000 }
  },
  "viewport": { "width": 1920, "height": 1080, "scale": 2 },
  "scenes": [
    { "id": "ask", "steps": [
      { "type": { "placeholder": "RICE에게 메시지" }, "text": "작업 폴더에 '촬영 체크리스트.md' 파일을 만들고 영상 촬영 체크리스트 5개를 적어 줘." },
      { "press": "Enter" } ] },
    { "id": "approve", "steps": [
      { "waitFor": { "role": "button", "name": "승인", "exact": true }, "timeoutMs": 180000 },
      { "pause": 1500 },
      { "click": { "role": "button", "name": "승인", "exact": true } } ] },
    { "id": "result", "textFrom": "main", "steps": [
      { "waitGone": "[role=status][aria-label=\"Pondering\"]", "timeoutMs": 300000 },
      { "pause": 3000 } ] }
  ]
}
```

| 동사 | 뜻 | 기록 |
| --- | --- | --- |
| `click` | 커서를 옮겨 누른다 | 대상 상자·누른 점 |
| `type` | 눌러 초점을 준 뒤 사람 속도로 친다(글자당 35~70ms 흔들림) | 대상 상자·입력 글 |
| `press` | 키 하나 | 키 |
| `hover`·`scroll` | 커서만 옮기기, 부드러운 스크롤 | 대상 상자 |
| `waitFor`·`waitGone` | 나타날 때까지·사라질 때까지. **빨리 감기 대상** | 시작·끝 시각 |
| `pause` | 그대로 기다림 | 시각 |

- 대상은 두 가지로 적는다. 문자열은 CSS(또는 Playwright 선택자), 객체는 `getBy*`로 옮긴다:
  `{ "role", "name", "exact" }`·`{ "placeholder" }`·`{ "text", "exact" }`·`{ "label" }`. 글자로 찾는
  버튼은 `exact: true`로 둔다("승인"이 "승인하고 적용"·"승인됨"에 걸리지 않게).
- 걸음마다 `"zoom": false`로 확대를 끌 수 있다. 장면의 `textFrom`(기본 `main`)은 장면 끝에 그
  영역의 글을 `screenText`로 남긴다. 대본 초안의 근거다.
- `{scenario}`는 시나리오 파일 폴더, `{work}`는 이번 촬영의 작업 폴더다(결과 폴더의 `demo/work`,
  끝나면 지운다). 상대 경로는 `cwd` 기준이다.
- 장면의 대본은 시나리오에 두지 않는다. 찍은 뒤 `script.json`에 쓴다.

## 6. RICE 띄우기 (RICE 무수정, 측정으로 확인)

RICE는 React 19 + Electron 43 + Python 런타임(`rice-runtime`) + Ollama다. 소스에서 띄우면
`isDev`가 참이라 `localhost:5173`을 읽고 DevTools를 연다. 그래서 다음 순서로 띄운다.

1. `bundle-rice.sh`(측정 폴더에 있음, 파일럿 때 `config/demo/`로 옮긴다): esbuild로 `electron/main.ts`(ESM)·`preload.ts`(CJS)를
   작업 폴더에 묶고 `package.json`을 둔다. rice의 `dist-electron`은 건드리지 않는다.
2. 렌더러 개발 서버를 :5173에 띄운다. `ELECTRON_RUN_AS_NODE`를 **반드시 지운다**
   (VSCode 안에서 켜져 있어 Electron이 Node로 뜬다).
3. Playwright `_electron.launch`로 rice의 Electron 바이너리를 띄운다. `--user-data-dir={work}/profile`을
   준다. 주지 않으면 `~/Library/Application Support/<package 이름>`에 캐시가 남는다(측정 때 22MB).
4. 창 URL이 `http://localhost:5173`인 페이지를 고르고, 모든 창의 `webContents.closeDevTools()`를 부른다.
5. 콘솔의 `[RICE] runtime connected`를 기다린다(0.8~1.3초). Ollama는 미리 떠 있어야 한다.
6. CDP `Emulation.setDeviceMetricsOverride({ width: 1920, height: 1080, deviceScaleFactor: 2, mobile: false })`.
7. 끝나면 `app.close()`. RICE의 `before-quit`이 런타임을 거둔다. 남은 프로세스를 확인한다.

| 필요한 것 | 지금 RICE에 있는 것 |
| --- | --- |
| 격리 데이터 | `RICE_HOME`(대화·스킬·작업 폴더가 모두 그 아래). 홈·임시 폴더 **자체**는 거절하고 하위 폴더는 받는다 |
| 온보딩 on/off | `config.yaml`의 `provider.configured`(false면 언어 선택 → 3D 시네마틱) |
| 응답 완료 | `[role=status][aria-label="Pondering"]`. 턴 동안만 있다(`ChatScreen`의 `workProgress`) |
| 승인 | 버튼 글자 "승인"(거부는 "거부") |
| 보이는 작업 폴더 | `ui.workspace_path`. 영상에 나오므로 짧고 사용자 이름이 없는 경로로 둔다 |
| 누를 곳 | 탐색은 영어 `aria-label`(Home, Chat…), 나머지는 한국어 글자 |

마켓 서버(:7070)는 띄우지 않았다. 콘솔의 `ERR_CONNECTION_REFUSED`는 그 때문이며 핵심 흐름에는
영향이 없다. 마켓 화면을 찍을 때만 `rice-platform`을 함께 띄운다.

RICE에 권장하는 변경(사용자 승인 후, 14절): 데모 모드(빌드된 화면·DevTools 없음), `data-demo`
표식, 3D 애니메이션 시간 배율, 긴 작업 폴더 경로가 "저장 위치" 글자와 겹치는 문제 확인.

## 7. 촬영과 화질

- **크기.** 창으로는 1920×1080을 못 만든다(`setContentSize`가 내장 화면 작업 영역에 막혀 1920×1006).
  에뮬레이션으로 CSS 1920×1080 · 2배를 주면 스크린캐스트가 정확히 3840×2160 PNG를 준다.
  레이아웃은 1080p 그대로다.
- **원본.** recorder에 RGB 무손실 인자를 준다:
  `-f image2pipe -vcodec png -framerate 25 -i pipe:0 -c:v libx264rgb -qp 0 -preset veryfast -f matroska raw.mkv`.
  색 변환(`captureEncodingArgs`)은 최종 인코딩에서 한 번만 한다. 덱과 같은 색 경로다.
- **recorder 변경.** `finish({ endAt })`를 더한다. 주면 프레임 수를 `captureFrameCount(endAt − 시작, fps)`로
  줄여 그 시각에서 끝낸다. 지금 `finish()`는 `begin`에서 정한 수까지 마지막 화면을 채운다.
  `begin`에는 시나리오 제한 시간으로 넉넉한 상한을 준다. 덱 촬영의 동작은 바꾸지 않는다.
- **최종.** 25fps, slow/CRF 16, `captureEncodingArgs`. 출력 기본은 1440p다(14절). 확대 구간이
  4K 원본에서 잘리므로 1440p에서 또렷하다.

## 8. 기록·대본·목소리·자막

`demo/scenes.json`: 시각은 녹화 시작 기준 ms, 좌표는 CSS px(픽셀은 × scale).

```json
{ "schemaVersion": 1, "scenario": "rice-core-flow", "viewport": { "width": 1920, "height": 1080, "scale": 2 },
  "durationMs": 48900, "frames": { "written": 1223, "duplicated": 60 },
  "scenes": [ { "id": "approve", "startMs": 5200, "endMs": 24100,
    "steps": [ { "verb": "waitFor", "startMs": 5200, "endMs": 22800 },
               { "verb": "click", "startMs": 24300, "endMs": 24900, "box": { "x": 1236, "y": 459, "w": 62, "h": 32 }, "point": { "x": 1267, "y": 475 } } ],
    "screenText": "장면 끝에 보이는 응답 글(대본 초안의 근거)" } ] }
```

`demo/script.json`: `{ "scenes": [{ "id", "text", "status": "draft|approved", "voice": { "candidates": [], "selected": null } }] }`.
대본을 확정(`approved`)해야 `voice`가 돈다. 목소리는 `local_tts_engine.text_candidate`를 장면마다
씨앗을 달리해 3번 부른다(`--model --text-file --reference --reference-text --output --metadata --seed
--adapter --adapter-scale`, `voices.mjs`의 `runTextVoiceCandidates`와 같은 인자). 고르는 것은 사람이다.
자동 검사는 청취 승인을 대신하지 않는다.

자막은 기본으로 파일(SRT·VTT, 유튜브 자막)만 만든다. 장면 대본을 문장으로 나눠 그 장면 음성 길이에
글자 수 비례로 놓는다. 영상에 굽기와 정렬기 사용은 14절.

## 9. 편집 계획과 렌더

장면마다 원본 구간 V, 내레이션 길이 N을 비교한다.

- **빨리 감기:** `waitFor`·`waitGone`·AI 생성 구간만 감는다. 배율은 필요한 만큼, 최대 `maxSpeed`
  (시작값 4배, 파일럿에서 눈으로 정함). 사람 동작(`click`·`type`)은 1배다.
- **길이:** 장면 목표 T = max(N + 0.8초, 감을 수 있는 만큼 감은 V). 내레이션은 장면 시작 0.3초 뒤에 둔다.
  감은 V가 T보다 짧으면 장면 끝 화면을 멈춰 채운다.
- **확대:** `click`·`type`의 점을 중심으로 걸음 0.3초 전부터 0.6초 동안 1.0→1.6배(코사인 이징),
  걸음 끝 0.8초 뒤 0.6초 동안 되돌아온다. 다음 확대가 1.5초 안이면 되돌지 않고 옮겨 간다.
  화면 밖으로 나가지 않게 중심을 가둔다.

`demo/edit-plan.json`에 구간(`srcStartMs`·`srcEndMs`·`speed`·`holdMs`), 확대 키프레임(`atMs`·`z`·`cx`·`cy`),
장면별 내레이션 위치를 적는다. 렌더는 한 번의 ffmpeg다: 구간마다 `trim`→`setpts=(PTS−STARTPTS)/speed`
→`fps=25`(감을 때 프레임을 고르게 버림)→`tpad=stop_mode=clone`(멈춤) → `concat` →
`zoompan(d=1, s=2560x1440, fps=25)` → `captureEncodingArgs`. 음성은 장면별 WAV를 `adelay`로 놓고
합쳐 AAC 48kHz 모노 192k(덱과 같은 서명). 검증은 규격·프레임 수 = 계획 길이·음성 길이다.

## 10. 측정 (2026-09-18, M4 Max, RICE be80947, qwen3.6:35b-a3b-q4_K_M)

| 장면 · 촬영 크기 | 길이 | 받은 프레임 | 복제 / 25fps 칸 | 최장 정지 |
| --- | ---: | ---: | ---: | ---: |
| 언어 선택 화면 · 4K | 6초 | 137 | 24 / 150 | 2프레임 |
| 채팅 핵심 흐름 · 4K | 30초 | 947 | 49 / 750 | 8프레임 |
| 3D 시네마틱 · 1080p | 10초 | 331 | 23 / 250 | 3프레임 |
| 3D 시네마틱 · 1440p | 10초 | 175 | 77 / 250 | 3프레임 |
| 3D 시네마틱 · 4K | 10초 | 93 | 158 / 250 | 8프레임 |

- **기동:** 창 0.4~1.4초, 런타임 연결 0.8~1.3초.
- **핵심 흐름(도구 사용 요청):** 실행 계획 2.7초, 승인 카드 17.8초, 승인 뒤 완료 41.1초. 파일이
  데모 작업 폴더에 실제로 생겼다. 모델이 조용히 생각하는 구간은 화면 변화가 10초 가까이 없다.
  첫 시도는 글자 변화로 완료를 판정해 10초 만에 끝났다고 잘못 봤다. 완료는 Pondering으로만 본다.
- **3D 시네마틱은 4K에서 초당 약 9장**이라 끊겨 보이고 1080p에서만 부드럽다. 채팅 화면은 4K로 충분하다.
  병목은 4K PNG 인코딩으로 보인다.
- **무손실 원본:** 4K 채팅 30초를 다시 인코딩해 veryfast 9MB·ultrafast 41MB, 둘 다 약 12초(실시간의
  2배 이상 빠름). veryfast 결과는 RGB 픽셀 해시가 원본과 같았다. 입력이 한 번 압축된 영상이라
  실제 원본은 더 클 수 있다.
- **확대:** 같은 영역 1.6배를 1440p로 냈을 때 4K 원본은 또렷, 1080p 원본은 글자가 뭉개졌다.
  4K 무손실 → `zoompan` → 1440p 4초가 0.9초에 끝났다.
- **Electron `--user-data-dir`:** Electron 43에서 지정한 폴더를 그대로 썼다.

## 11. 코드 배치

| 파일 | 책임 |
| --- | --- |
| `shared/demo-scenario.mjs` | 시나리오 검증·정규화: 동사·선택자·자리표시자·제한 시간. 순수 |
| `shared/demo-plan.mjs` | scenes.json + 내레이션 길이 → edit-plan.json. 순수 |
| `main/capture/app-page.mjs` | 앱 띄우기(electron·web), 준비·서버·ready 대기, 에뮬레이션, 동사 실행, 장면 기록, 종료·정리 |
| `main/capture/cursor-overlay.mjs` | 페이지에 넣을 커서·클릭 표시. 실제 마우스 이벤트를 따라 그린다(hover가 진짜로 일어나게) |
| `main/capture/recorder.mjs` | 변경: `finish({ endAt })` |
| `main/capture/record-app.mjs` | `record` 한 번: 작업 폴더·무손실 녹화·scenes.json |
| `main/editing/demo-render.mjs` | edit-plan → ffmpeg 한 번, 음성 합치기, 자막, 검증·보고서 |
| `main/workers/demo.mjs` | CLI 진입점: `record`·`voice`·`render`. `package.json`에 `"demo"` |
| `config/demo/rice-core-flow.json`, `bundle-rice.sh` | 파일럿 시나리오와 RICE 묶기 |
| `tests/fixtures/demo-app/` | 작은 Electron 앱: 입력창·버튼·2초 뜨는 `[role=status]`·결과 글 |

결과 폴더: `<이름>.mp4`, `.capture.json`, `validation-report.json`(`operation: "app-demo"`),
`demo/`(`raw.mkv`, `scenes.json`, `script.json`, `narration/<장면>/candidate-0N.wav`, `edit-plan.json`,
`captions.srt|vtt|json`). 취소하면 결과 폴더를 지운다(화면 녹화와 같다).

## 12. 테스트

`npm run check`에는 RICE·Ollama를 넣지 않는다.

- 단위: 시나리오 검증, 편집 계획(빨리 감기 상한·멈춤·확대 병합·가두기), `finish({ endAt })`,
  `zoompan` 식 생성.
- 통합: `tests/fixtures/demo-app`을 우리 devDependency Electron으로 띄워 640×360 · 1배로 시나리오를
  돌린다. scenes.json 시각·`waitGone`·무손실 프레임 수를 보고, 합성 내레이션(lavfi 사인파)으로
  `render`해 최종 길이 = 계획 길이를 확인한다. 웹 쪽은 `check_capture`처럼 정적 페이지로 한 번.
- RICE 파일럿은 사람이 돌리고 시청해 확인한다.

## 13. Bob으로 넘어갈 때

녹화 먼저·대본 나중, 커서, 확대, 편집 계획은 그대로다. 다른 점은 Bob에 약속을 넣을 수 없다는 것이다.

| 항목 | RICE | Bob (VSCode 1.126 기반, Bob 2.0.3) |
| --- | --- | --- |
| 띄우기 | 무수정 우회 기동(측정 완료) | `--remote-debugging-port`로 띄워 `connectOverCDP`(미확인) |
| 선택자 | `aria-label`·글자 | 역할·글자. 업데이트에 약하다 |
| 응답 완료 | Pondering 사라짐(측정 완료) | 화면 상태 관찰(미확인, 가장 큰 위험) |
| 데이터 | `RICE_HOME` 격리 | 연습용 프로젝트를 git으로 되돌린다 |

## 14. 남은 결정

1. **3D 시네마틱을 넣을 때:** ① 그 장면만 1080p(무수정, 확대하면 뭉개짐) ② RICE 데모 모드에
   애니메이션 시간 배율(¼ 속도로 찍어 4배로 감음, 4K 부드러움, RICE 수정) — 권장 ③ JPEG
   스크린캐스트(손실 한 번 더, 재 보고 승인 필요).
2. **출력 해상도:** 1440p 권장(확대가 또렷하고 덱 기본과 같음). 4K로 내면 확대 구간을 1.6배
   늘려야 해서 그 구간만 덜 또렷하다.
3. **빨리 감기 최대 배율:** 시작값 4배, 파일럿 영상을 보고 정한다.
4. **자막:** 파일만(기본) 또는 영상에 굽기. 정렬은 문장 비례(기본) 또는 기존 정렬기.
5. **RICE 변경 승인:** 데모 모드, `data-demo`, 시간 배율, 작업 폴더 경로 겹침.
6. **앞뒤 제목 장면:** 덱 슬라이드로 만들지는 파일럿 뒤에 정한다.

## 15. 작업 순서 (다음 세션)

1. 확인: 우리 Electron 44 + Playwright 1.62 `_electron`으로 fixture 앱이 뜨는지(측정은 Electron 43),
   에뮬레이션 상태의 `page.mouse` 좌표, `zoompan`의 느린 확대에서 정수 좌표 떨림이 보이는지.
2. `shared/demo-scenario.mjs`·`shared/demo-plan.mjs`와 단위 테스트.
3. recorder `finish({ endAt })`, `app-page.mjs`·`cursor-overlay.mjs`·`record-app.mjs`, fixture 통합 테스트.
4. `demo-render.mjs`와 `workers/demo.mjs`(`record`·`voice`·`render`), 합성 내레이션 통합 테스트.
5. RICE 파일럿: `config/demo/rice-core-flow.json`으로 `record` → Claude가 대본 초안 → 사용자 수정 →
   `voice` → 사용자가 고름 → `render` → 사용자 시청. 빨리 감기 배율·출력 해상도를 여기서 정한다.
6. 문서: ARCHITECTURE·README·VIDEO-QUALITY·HANDOFF. 이 설계도는 근거만 남긴다.
7. 그 뒤: RICE 데모 모드(승인 시), Bob 확인(13절), 앱 화면 메뉴.
