import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";


const APP_DIR = path.dirname(fileURLToPath(import.meta.url));
const renderer = path.join(APP_DIR, "renderer");


test("대기 상태 문구 대신 아이콘과 툴팁을 사용한다", async () => {
  const [html, css] = await Promise.all([
    fs.readFile(path.join(renderer, "index.html"), "utf8"),
    fs.readFile(path.join(renderer, "styles.css"), "utf8"),
  ]);
  assert.doesNotMatch(html, />준비됨</);
  assert.match(html, /id="create-top-status"[^>]+data-tooltip=/);
  assert.match(html, /id="open-model-settings"[^>]+data-tooltip=/);
  assert.match(css, /\[data-tooltip\]:hover::after/);
  assert.match(css, /\[data-tooltip\]:focus-visible::after/);
});


test("새 영상의 중복 요약 패널은 대기 중 숨기고 작업 중에만 사용한다", async () => {
  const [html, script] = await Promise.all([
    fs.readFile(path.join(renderer, "index.html"), "utf8"),
    fs.readFile(path.join(renderer, "app.js"), "utf8"),
  ]);
  assert.match(html, /id="job-workspace"/);
  assert.match(html, /class="card progress-card hidden"/);
  assert.doesNotMatch(html, /id="idle-hero"|id="brief-scope"|id="brief-voice"/);
  assert.match(script, /classList\.toggle\("hidden", view === "idle"\)/);
});

test("새 영상은 레슨·페이지·챕터 전체의 세 가지 제작 범위를 제공한다", async () => {
  const [html, script] = await Promise.all([
    fs.readFile(path.join(renderer, "index.html"), "utf8"),
    fs.readFile(path.join(renderer, "app.js"), "utf8"),
  ]);
  assert.match(html, /data-mode="lesson"[^>]*>레슨/);
  assert.match(html, /data-mode="page"[^>]*>페이지 직접 선택/);
  assert.match(html, /data-mode="chapter"[^>]*>챕터 전체/);
  assert.doesNotMatch(html, /30초 미리보기/);
  assert.doesNotMatch(html, /id="chapter-jump"|id="select-chapter-range"/);
  assert.match(html, /data-chapter-mode="single"[^>]*>한 영상으로 제작/);
  assert.match(html, /data-chapter-mode="lesson"[^>]*>레슨 단위로 나눠 제작/);
  assert.doesNotMatch(script, /productionMode === "preview"|data-mode="preview"/);
  assert.match(script, /chapterMode: productionMode === "chapter" \? chapterMode : "single"/);
});


test("최근 결과는 열기만 기본 행동으로 두고 나머지를 더 보기 메뉴에 둔다", async () => {
  const [script, css] = await Promise.all([
    fs.readFile(path.join(renderer, "app.js"), "utf8"),
    fs.readFile(path.join(renderer, "styles.css"), "utf8"),
  ]);
  assert.match(script, /class="open-button"/);
  assert.match(script, /class="result-menu"/);
  assert.match(script, /확인 완료로 표시/);
  assert.match(script, /Finder에서 보기/);
  assert.match(script, /class="status-symbol/);
  assert.match(script, /shouldOpenMenuUpward\(availableBelow, popover\.offsetHeight\)/);
  assert.match(script, /\["results-menu-bottom", "results-menu-outside"\]\.includes\(initialView\)/);
  assert.match(script, /initialView === "results-menu-outside"\) \$\("#output-list"\)\.click\(\)/);
  assert.match(css, /\.result-menu\.open-upward > div/);
  assert.match(css, /\.output-item:has\(\.result-menu\[open\]\)/);
  assert.match(css, /\.output-item:hover,\.output-item:focus-within/);
  assert.doesNotMatch(css, /\.output-item:hover[^}]*transform/);
  assert.doesNotMatch(script, /<summary data-tooltip="더 보기"/);
  assert.match(script, /if \(!event\.target\.closest\("\.result-menu"\)\) closeResultMenus\(\)/);
  assert.match(script, /event\.key !== "Escape"/);
});


test("완료 화면은 권장 요약과 전용 검수 화면 진입을 제공한다", async () => {
  const html = await fs.readFile(path.join(renderer, "index.html"), "utf8");
  assert.match(html, /id="review-latest"/);
  assert.match(html, /id="view-review"/);
  assert.match(html, /id="review-player"/);
  assert.match(html, /id="review-findings-list"/);
  assert.doesNotMatch(html, /id="finding-dialog"|data-operation="voice"/);
});

test("결과를 편집으로 넘기는 통로가 preload와 main 양쪽에 있다", async () => {
  const [preload, main] = await Promise.all([
    fs.readFile(path.join(APP_DIR, "preload.cjs"), "utf8"),
    fs.readFile(path.join(APP_DIR, "main.mjs"), "utf8"),
  ]);
  assert.match(preload, /adoptResultVideo: \(target\) => ipcRenderer\.invoke\("studio:adopt-result-video", target\)/);
  assert.match(main, /ipcMain\.handle\("studio:adopt-result-video"/);
});

test("최근 영상 결과는 전용 검수 화면에서 열린다", async () => {
  const script = await fs.readFile(path.join(renderer, "app.js"), "utf8");
  // 확인 완료로 내린 항목은 최근 결과에서도 빠져야 한다. 한 화면에서만
  // 처리되면 그 버튼이 무엇을 한 것인지 알 수 없다.
  assert.match(script, /visibleVoiceFindings\(item\.voiceFindings, item\.review\?\.clearedFindings\)/);
  assert.match(script, /openReview\(target\)/);
  assert.doesNotMatch(script, /findingsPanel\.className = "output-findings"/);
});

test("목소리 확인은 제작 실패가 아니라 별도 확인 항목이다", async () => {
  const main = await fs.readFile(path.join(APP_DIR, "main.mjs"), "utf8");
  // File and video checks decide success; the voice verdict rides alongside.
  const checksBlock = main.slice(main.indexOf("async function validateResult("), main.indexOf("async function runPipeline("));
  assert.doesNotMatch(checksBlock, /label: "음성 발음/);
  assert.match(checksBlock, /voiceFindings,/);
  assert.match(checksBlock, /listenSuggested: voiceQuality\?\.listenSuggested \|\| \[\]/);
});

test("후보를 만들 때는 생성기와 판독기가 함께 올라가므로 한 번에 하나만 돌린다", async () => {
  const main = await fs.readFile(path.join(APP_DIR, "main.mjs"), "utf8");
  const block = main.slice(main.indexOf("async function runVoiceCandidates("), main.indexOf("async function runTextVoiceCandidates("));
  assert.doesNotMatch(block, /mapWithConcurrency/);
  assert.match(block, /qualityAttempts: 1/);
  assert.match(block, /assertPageReplaceable\(chosenRecord\(options\.videoToken, "video"\), options\)/);
});

test("완성 영상은 자기 타임라인을 데리고 발행된다", async () => {
  const main = await fs.readFile(path.join(APP_DIR, "main.mjs"), "utf8");
  const block = main.slice(main.indexOf("async function publishVideo("), main.indexOf("async function validateResult("));
  assert.match(block, /path\.join\(renderDir, "timeline\.json"\)/);
  assert.match(block, /path\.join\(outputDir, videoTimelineFileName\(target\)\)/);
  assert.match(main, /publishVideo\(videoPath, studio, options\.name, options\.title, renderDir\)/);
});
