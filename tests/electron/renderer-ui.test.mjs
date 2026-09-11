import { readMainSource, readRendererSource } from "./helpers/sources.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";


const APP_DIR = fileURLToPath(new URL("../../electron-app", import.meta.url));
const renderer = path.join(APP_DIR, "renderer");


test("대기 상태 문구 대신 아이콘과 툴팁을 사용한다", async () => {
  const [html, css] = await Promise.all([
    fs.readFile(path.join(renderer, "index.html"), "utf8"),
    fs.readFile(path.join(renderer, "styles.css"), "utf8"),
  ]);
  assert.match(html, /id="create-top-status"[^>]+data-tooltip=/);
  assert.match(html, /id="open-model-settings"[^>]+data-tooltip=/);
  assert.match(css, /\[data-tooltip\]:hover::after/);
  assert.match(css, /\[data-tooltip\]:focus-visible::after/);
});


test("새 영상의 중복 요약 패널은 대기 중 숨기고 작업 중에만 사용한다", async () => {
  const html = await fs.readFile(path.join(renderer, "index.html"), "utf8");
  assert.match(html, /id="job-workspace"/);
  assert.match(html, /class="card progress-card hidden"/);
});

test("새 영상은 레슨·페이지·챕터 전체의 세 가지 제작 범위를 제공한다", async () => {
  const html = await fs.readFile(path.join(renderer, "index.html"), "utf8");
  assert.match(html, /data-mode="lesson"[^>]*>레슨/);
  assert.match(html, /data-mode="page"[^>]*>페이지 직접 선택/);
  assert.match(html, /data-mode="chapter"[^>]*>챕터 전체/);
  assert.match(html, /data-chapter-mode="single"[^>]*>한 영상으로 제작/);
  assert.match(html, /data-chapter-mode="lesson"[^>]*>레슨 단위로 나눠 제작/);
});


test("최근 결과는 열기만 기본 행동으로 두고 나머지를 더 보기 메뉴에 둔다", async () => {
  const [script, css] = await Promise.all([
    readRendererSource(),
    fs.readFile(path.join(renderer, "styles.css"), "utf8"),
  ]);
  assert.match(script, /class="open-button"/);
  assert.match(script, /class="result-menu"/);
  // '확인 완료'는 이제 항목 하나를 내리는 동작이다. 결과 전체를 직접 듣고
  // 승인하는 것과 같은 말을 쓰면 둘이 구분되지 않는다.
  // 다듬기의 항목별 '확인 완료'와는 다른 동작이므로 문구도 겹치지 않아야 한다.
  assert.match(script, /"청취 승인 취소" : "청취 승인으로 표시"/);
  assert.match(script, /Finder에서 보기/);
  // 파일 검증·목소리·청취 승인을 배지 셋으로 나눠 두면 셋을 합쳐 읽어야 상태를
  // 알 수 있다. 한 마디로 적는다.
  assert.match(script, /class="state-pill/);
  assert.match(script, /shouldOpenMenuUpward\(availableBelow, popover\.offsetHeight\)/);
  assert.match(script, /\["results-menu-bottom", "results-menu-outside"\]\.includes\(initialView\)/);
  assert.match(script, /initialView === "results-menu-outside"\) \$\("#output-list"\)\.click\(\)/);
  assert.match(css, /\.result-menu\.open-upward > div/);
  assert.match(css, /\.output-item:has\(\.result-menu\[open\]\)/);
  assert.match(css, /\.output-item:hover,\.output-item:focus-within/);
  assert.doesNotMatch(css, /\.output-item:hover[^}]*transform/);
  assert.match(script, /if \(!event\.target\.closest\("\.result-menu"\)\) outputs\.closeResultMenus\(\)/);
  assert.match(script, /event\.key !== "Escape"/);
});


test("완료 화면은 권장 요약과 전용 검수 화면 진입을 제공한다", async () => {
  const html = await fs.readFile(path.join(renderer, "index.html"), "utf8");
  assert.match(html, /id="review-latest"/);
  assert.match(html, /id="view-review"/);
  assert.match(html, /id="review-player"/);
  assert.match(html, /id="review-findings-list"/);
});

test("결과를 편집으로 넘기는 통로가 preload와 main 양쪽에 있다", async () => {
  const [preload, main] = await Promise.all([
    fs.readFile(path.join(APP_DIR, "preload.cjs"), "utf8"),
    readMainSource(),
  ]);
  assert.match(preload, /adoptResultVideo: \(target\) => ipcRenderer\.invoke\("studio:adopt-result-video", target\)/);
  assert.match(main, /ipcMain\.handle\("studio:adopt-result-video"/);
});

test("최근 영상 결과는 전용 검수 화면에서 열린다", async () => {
  const script = await readRendererSource();
  // 확인 완료로 내린 항목은 최근 결과에서도 빠져야 한다. 한 화면에서만
  // 처리되면 그 버튼이 무엇을 한 것인지 알 수 없다.
  assert.match(script, /visibleVoiceFindings\(item\.voiceFindings, item\.review\?\.clearedFindings\)/);
  assert.match(script, /openReview\(target\)/);
});

test("목소리 확인은 제작 실패가 아니라 별도 확인 항목이다", async () => {
  const main = await readMainSource();
  // File and video checks decide success; the voice verdict rides alongside.
  const checksBlock = main.slice(main.indexOf("async function validateResult("), main.indexOf("async function runPipeline("));
  assert.doesNotMatch(checksBlock, /label: "음성 발음/);
  assert.match(checksBlock, /voiceFindings,/);
  assert.match(checksBlock, /listenSuggested: voiceQuality\?\.listenSuggested \|\| \[\]/);
});

test("후보를 만들 때는 생성기와 판독기가 함께 올라가므로 한 번에 하나만 돌린다", async () => {
  const main = await readMainSource();
  const block = main.slice(main.indexOf("async function runVoiceCandidates("), main.indexOf("async function runTextVoiceCandidates("));
  assert.doesNotMatch(block, /mapWithConcurrency/);
  assert.match(block, /qualityAttempts: 1/);
  assert.match(block, /const video = chosenRecord\(options\.videoToken, "video"\)/);
  assert.match(block, /assertPageReplaceable\(video, options\)/);
});

test("완성 영상은 자기 타임라인을 데리고 발행된다", async () => {
  const main = await readMainSource();
  const block = main.slice(main.indexOf("async function publishVideo("), main.indexOf("async function validateResult("));
  assert.match(block, /path\.join\(renderDir, "timeline\.json"\)/);
  assert.match(block, /path\.join\(outputDir, videoTimelineFileName\(target\)\)/);
  assert.match(main, /publishVideo\(videoPath, studio, options\.name, options\.title, renderDir\)/);
});


// 두 시계는 '이 편'과 '전체'다. 5초마다 '약 12분'이 '약 11분'으로 바뀌면 멈춰
// 있는 것처럼 보인다. 매초 다시 그려 한 자리씩 줄어드는 것을 보여 준다.
test("남은 시간 두 시계는 1초마다 줄어든다", async () => {
  const [html, script, pace] = await Promise.all([
    fs.readFile(path.join(renderer, "index.html"), "utf8"),
    readRendererSource(),
    fs.readFile(path.join(renderer, "job-pace.mjs"), "utf8"),
  ]);
  assert.match(html, /id="job-eta"/);
  assert.match(html, /id="job-total-eta"/);
  assert.match(script, /creationState === "running"\) renderJobPace\(\); \}, 1_000\)/);
  // 1초마다 도는 자리다. 편 목록만 필요한 곳에서 남은 시간 추정을 다시 돌리지
  // 않고, 바뀌지 않은 글자와 aria-busy 를 매초 다시 적지 않는다.
  assert.match(script, /const units = pace\.unitStates\(\);/);
  assert.doesNotMatch(script, /pace\.snapshot\(\)\.units/);
  assert.match(script, /if \(element\.textContent !== label\) element\.textContent = label;/);
  assert.match(script, /element\.getAttribute\("aria-busy"\) !== busy/);
  assert.match(pace, /formatCountdown/);
  // 추정이 아직 없을 때 시계를 지어내지 않는다.
  assert.match(pace, /남은 시간 계산 중/);
});

// 왼쪽에 영상 자리가 있는데 오른쪽 작은 상자에만 놓을 수 있으면, 놓을 곳을 먼저
// 겨눠야 한다. 편집 화면 전체가 받고, 되돌려보낼 때는 무엇이 걸렸는지 말한다.
test("편집 화면 전체가 영상을 받고, 못 받은 파일은 이유를 말한다", async () => {
  const [script, main, css] = await Promise.all([
    readRendererSource(),
    readMainSource(),
    fs.readFile(path.join(renderer, "styles.css"), "utf8"),
  ]);
  assert.match(script, /attachNativeDrop\(\$\("#view-edit"\), "video"/);
  // FileList 는 contextBridge 를 건너오지 못한다. 건너편에서는 length 도 없는 빈
  // 객체가 되어 Array.from 이 0개를 내고, 놓은 파일이 통째로 사라졌다. Electron
  // 44 에서 실제 파일을 떨어뜨려 확인한 결과이며, File 배열은 그대로 건너온다.
  assert.match(script, /\[\.\.\.\(event\.dataTransfer\.files \|\| \[\]\)\]/);
  assert.match(script, /registerDroppedFiles\(chosen, kind\)/);
  assert.doesNotMatch(script, /registerDroppedFiles\(event\.dataTransfer\.files/);
  const preload = await fs.readFile(path.join(APP_DIR, "preload.cjs"), "utf8");
  // 약속이 깨지면 빈 목록을 조용히 보내지 않고 그 자리에서 말한다.
  assert.match(preload, /if \(!Array\.isArray\(files\)\) \{/);
  assert.doesNotMatch(preload, /Array\.from\(files \|\| \[\]\)/);
  assert.match(css, /#view-edit\.drag-over::after/);
  // 놓은 것이 무엇이었는지 말하지 않으면 왜 안 되는지 알 길이 없다.
  assert.match(main, /rejected\.push\(`\$\{name\}\(폴더\)`\)/);
  assert.match(main, /파일 경로를 읽지 못했습니다/);
  assert.match(main, /받는 형식은 \$\{kinds\} 입니다/);
  // ffmpeg 가 읽는 컨테이너는 고르기와 놓기가 같은 목록을 쓴다.
  assert.match(main, /const DROPPABLE = \{/);
  assert.match(main, /"\.avi"/);
  assert.doesNotMatch(main, /extensions: \["mp4", "mov", "mkv", "webm", "m4v"\]/);
  // 오류가 작업 기록에만 남으면 편집 화면에서는 보이지 않는다.
  assert.match(script, /showToast\(error\.message, "error"\);\n\s+appendEditLog/);
});

// 자르기·나누기·순서까지가 굽기 전에 정해지는 전부다. 구간을 숫자로만 정하게
// 두면 어디를 자르는지는 머릿속에 있고, 확인은 다 구운 뒤에야 된다.
test("편집기는 구간 막대와 나누기·복제·이어보기, 자판 길을 갖는다", async () => {
  const [html, css, script] = await Promise.all([
    fs.readFile(path.join(renderer, "index.html"), "utf8"),
    fs.readFile(path.join(renderer, "styles.css"), "utf8"),
    readRendererSource(),
  ]);
  for (const id of ["editor-trim-track", "editor-trim-band", "editor-trim-cursor",
    "editor-trim-in", "editor-trim-out", "editor-split", "editor-duplicate",
    "editor-preview-all", "editor-close", "editor-add"]) {
    assert.match(html, new RegExp(`id="${id}"`), id);
  }
  assert.match(css, /\.trim-handle \{/);
  assert.match(css, /\.trim-band \{/);
  // 담은 뒤에는 담기 상자가 아니라 모서리의 닫기 단추 하나면 된다.
  assert.match(html, /id="editor-close"[^>]*title="영상 닫기"/);
  assert.match(script, /function renderEditorShell\(\)/);
  // 자판 길은 화면에도 적어 둔다. 알기 전까지만 필요한 안내다.
  assert.match(html, /<kbd>I<\/kbd>/);
  assert.match(html, /<kbd>S<\/kbd>/);
  assert.match(script, /else if \(key === "s"\) \{ event\.preventDefault\(\); splitClip\(\); \}/);
});

test("확인할 부분은 영상 바로 아래에 있고, 고칠 자리와 페이지 이동은 옆 기둥이다", async () => {
  const [html, css] = await Promise.all([
    fs.readFile(path.join(renderer, "index.html"), "utf8"),
    fs.readFile(path.join(renderer, "styles.css"), "utf8"),
  ]);
  // 하루에 수백 번 누르는 것은 확인이다. 듣는 자리와 확인하는 자리가 한 기둥에
  // 있어야 그 한 걸음이 화면을 가로지르지 않는다. 고치는 폼과 페이지 막대는
  // 그보다 훨씬 덜 만지므로 옆으로 뺀다. 동작은 renderer-review 검사가 맡는다.
  const player = html.indexOf('id="review-player"');
  const findings = html.indexOf('id="review-findings"');
  const form = html.indexOf('id="review-form"');
  const rail = html.indexOf('class="card page-rail-card"');
  assert.ok(player < findings && findings < form, "영상 → 확인할 부분 → 고칠 자리 순서");
  assert.ok(form < rail, "페이지 막대는 오른쪽 기둥의 고칠 자리 아래");
  assert.ok(html.indexOf('id="review-findings"') < html.indexOf('id="polish-diff"'));
  // 확인 단추는 영상 바로 아래 줄에도 선다. 자판 길도 단추 위에 적어 둔다.
  assert.match(html, /class="transport-confirm" id="review-confirm"[^>]*>✓ 확인<kbd>Enter<\/kbd>/);
  assert.match(html, /id="voice-override-text"/);
  assert.match(css, /\.finding-group \{/);
  assert.match(css, /\.script-override \{/);
  assert.match(css, /\.transport-confirm \{/);
  // 왼쪽 기둥이 길어졌으므로 붙박이는 짧아진 오른쪽으로 옮겼다.
  assert.match(css, /\.review-sidebar \{[^}]*position: sticky/);
  assert.doesNotMatch(css, /\.review-stage \{[^}]*position: sticky/);
});


test("결과와 검수 화면 모두에서 파일 이름을 그 자리에서 바꾼다", async () => {
  const [script, css, preload, main] = await Promise.all([
    readRendererSource(),
    fs.readFile(path.join(renderer, "styles.css"), "utf8"),
    fs.readFile(path.join(APP_DIR, "preload.cjs"), "utf8"),
    readMainSource(),
  ]);
  assert.match(script, /title\.addEventListener\("dblclick", \(\) => editOutputName\(title, item, target\)\)/);
  assert.match(script, /\$\('#voice-video-name'\)\.addEventListener\('dblclick'/);
  assert.match(script, /api\.renameOutput\(target, value\)/);
  assert.match(script, /api\.renameVideo\(mediaState\.voiceVideo\.token, value\)/);
  assert.match(css, /\.rename-field \{/);
  assert.match(preload, /renameOutput: \(target, name\)/);
  assert.match(preload, /renameVideo: \(token, name\)/);
  assert.match(main, /ipcMain\.handle\("studio:rename-output"/);
  assert.match(main, /ipcMain\.handle\("studio:rename-video"/);
  // 영상만 바꿔 부르면 이름을 나눠 갖던 타임라인이 뒤에 남아 페이지를 잃는다.
  assert.match(main, /entry\.startsWith\(`\$\{previousStem\}\.`\)/);
  assert.match(main, /displayName: path\.basename\(next, path\.extname\(next\)\)/);
});


test("결과는 파일 이름 그대로 적히고, 지우기는 되돌릴 수 있게 휴지통으로 보낸다", async () => {
  const [script, main, preload] = await Promise.all([
    readRendererSource(),
    readMainSource(),
    fs.readFile(path.join(APP_DIR, "preload.cjs"), "utf8"),
  ]);
  assert.match(script, /outputRowTitle\(item\)/);
  assert.match(main, /fileName: videoPath \? path\.basename\(videoPath\) : null/);
  assert.match(script, /class="delete-button"/);
  assert.match(script, /api\.deleteOutput\(target\)/);
  assert.match(preload, /deleteOutput: \(target\)/);
  // 두 시간을 들인 결과다. 먼저 묻고, 그다음에도 지우지 않고 휴지통으로 보낸다.
  assert.match(main, /dialog\.showMessageBox\(state\.mainWindow, \{\s*type: "warning"/);
  assert.match(main, /for \(const item of directories\) await shell\.trashItem\(item\)/);
  // 강의 결과는 작업 폴더와 완성 영상 폴더로 나뉜다. 한쪽만 버리면 목록에서는
  // 사라졌는데 영상은 남는다.
  assert.match(main, /const published = path\.join\(store\.videoOutputRoot, target\.name\)/);
});


test("이름이 바뀐 영상도 같은 결과로 이어 준다", async () => {
  const main = await readMainSource();
  // Finder에서 이름을 고친 영상은 적어 둔 경로에 없다. 폴더에 그대로 있는데도
  // 열 수 없다거나 확인 항목이 사라졌다고 말하지 않는다.
  assert.match(main, /async function reportDescribesVideo\(/);
  assert.match(main, /await reportDescribesVideo\(report\.videoPath, value\.path\)/);
  assert.match(main, /file = await findVideo\(directory, target\.name\) \|\| file/);
  assert.match(main, /await existingFile\(report\.videoPath\) \|\| await findVideo\(dir, entry\.name\)/);
});


test("창 막대의 단추는 아이콘과 툴팁을 함께 갖고, 사이드바는 미끄러진다", async () => {
  const [html, css, script] = await Promise.all([
    fs.readFile(path.join(renderer, "index.html"), "utf8"),
    fs.readFile(path.join(renderer, "styles.css"), "utf8"),
    readRendererSource(),
  ]);
  assert.match(html, /id="sidebar-toggle"[^>]+data-tooltip="사이드바 접기"/);
  assert.match(html, /id="window-back"[^>]+data-tooltip="뒤로가기"/);
  assert.match(html, /id="window-forward"[^>]+data-tooltip="앞으로가기"/);
  assert.match(html, /class="panel-toggle-chevron"/);
  assert.match(script, /toggle\.dataset\.tooltip = label/);
  assert.match(script, /applySidebarCollapsed\(!document\.body\.classList\.contains\('sidebar-collapsed'\), \{ animate: true \}\)/);
  assert.match(css, /\.sidebar-motion \.sidebar \{/);
  assert.match(css, /\.sidebar-motion \.shell \{ transition: grid-template-columns/);
  // 창 왼쪽 끝 단추의 툴팁은 오른쪽 정렬이면 화면 밖으로 나간다.
  assert.match(css, /\.nav-tip::after \{ left: 0; right: auto; \}/);
});


// 접기는 두 폭 사이만 오간다. 어느 폭이 맞는지는 창 크기와 편 제목 길이에 따라
// 다르므로 경계선을 직접 잡아 정하고, 그 폭은 다음에 열 때도 남아 있어야 한다.
test("사이드바 경계선을 끌어 폭을 정하고 최소·최대 안에 가둔다", async () => {
  const [html, css, script] = await Promise.all([
    fs.readFile(path.join(renderer, "index.html"), "utf8"),
    fs.readFile(path.join(renderer, "styles.css"), "utf8"),
    readRendererSource(),
  ]);
  assert.match(html, /id="sidebar-resizer"[^>]+role="separator"/);
  assert.match(html, /id="sidebar-resizer"[^>]+tabindex="0"/);
  assert.match(css, /\.sidebar-resizer \{[^}]*left: var\(--sidebar-w\)/);
  assert.match(css, /\.sidebar-resizer \{[^}]*cursor: col-resize/);
  // 끄는 동안 미끄러지면 사이드바가 손보다 늦게 온다.
  assert.match(css, /\.sidebar-sizing \.sidebar,\n\.sidebar-sizing \.shell,\n\.sidebar-sizing \.sidebar-resizer \{ transition: none; \}/);
  assert.match(script, /SIDEBAR_WIDTH = \{ default: 226, min: 180, max: 420 \}/);
  assert.match(script, /setProperty\('--sidebar-w'/);
  assert.match(script, /pointermove/);
  // 좁은 창에서는 최대 폭도 함께 줄어야 본문이 남는다.
  assert.match(script, /viewport - SIDEBAR_CONTENT_FLOOR/);
  // 폭과 접힘은 같은 자리에서 함께 적힌다.
  assert.match(script, /localStorage\.setItem\(SIDEBAR_WIDTH_KEY/);
});


test("묶음이 행의 더 보기 메뉴를 잘라 내지 않는다", async () => {
  const css = await fs.readFile(path.join(renderer, "styles.css"), "utf8");
  const block = css.slice(css.indexOf(".output-group {"), css.indexOf(".output-group-head {"));
  assert.doesNotMatch(block, /overflow: hidden/);
  assert.match(css, /\.output-group:has\(\.result-menu\[open\]\) \{ position: relative; z-index: 40; \}/);
  assert.match(css, /\.output-group-body \.output-item:last-child \{[\s\S]*?border-radius/);
});
