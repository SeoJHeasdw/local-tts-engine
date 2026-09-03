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


test("제작 완료 패널이 목소리 확인 구간을 실제로 그린다", async () => {
  // The renderer used to define this and never call it, so a run that flagged a
  // page finished with an empty panel and the finding only lived in a file.
  const [html, script, css] = await Promise.all([
    fs.readFile(path.join(renderer, "index.html"), "utf8"),
    fs.readFile(path.join(renderer, "app.js"), "utf8"),
    fs.readFile(path.join(renderer, "styles.css"), "utf8"),
  ]);
  assert.match(html, /id="voice-quality-panel"/);
  assert.match(html, /id="voice-quality-list"/);
  // Audio-only runs have no video to repair, so their segments are shown but
  // not offered as a click that could only fail.
  assert.match(script, /renderCompleteVoiceFindings\(findings, report\.videoPath \? report\.target : null\)/);
  assert.match(script, /panel\.dataset\.repairable = target \? "yes" : "no"/);
  // Cleared when the next job starts, so a clean run never shows stale findings.
  assert.match(script, /renderCompleteVoiceFindings\(\[\]\);/);
  assert.match(css, /\.voice-quality-panel\[data-tone="failed"\]/);
});

test("확인 구간을 누르면 그 페이지가 채워진 영상 편집으로 넘어간다", async () => {
  const script = await fs.readFile(path.join(renderer, "app.js"), "utf8");
  assert.match(script, /async function openVoiceRepair\(target, finding\)/);
  assert.match(script, /api\.adoptResultVideo\(target\)/);
  assert.match(script, /\$\("\[data-view='edit'\]"\)\.click\(\)/);
  assert.match(script, /setEditOperation\("voice"\)/);
  assert.match(script, /setVoiceSource\("generate"\)/);
  assert.match(script, /\$\("#voice-start-page"\)\.value = String\(finding\.slideNumber\)/);
  assert.match(script, /\$\("#voice-end-page"\)\.value = String\(finding\.slideNumber\)/);
});

test("결과를 편집으로 넘기는 통로가 preload와 main 양쪽에 있다", async () => {
  const [preload, main] = await Promise.all([
    fs.readFile(path.join(APP_DIR, "preload.cjs"), "utf8"),
    fs.readFile(path.join(APP_DIR, "main.mjs"), "utf8"),
  ]);
  assert.match(preload, /adoptResultVideo: \(target\) => ipcRenderer\.invoke\("studio:adopt-result-video", target\)/);
  assert.match(main, /ipcMain\.handle\("studio:adopt-result-video"/);
});

test("최근 결과도 확인 구간을 시간과 함께 보여 준다", async () => {
  const script = await fs.readFile(path.join(renderer, "app.js"), "utf8");
  assert.match(script, /const findings = item\.voiceFindings \|\| \[\]/);
  assert.match(script, /summarizeVoiceFindings\(findings\)/);
  assert.match(script, /voiceFindingSummaryLine\(findings\)/);
  assert.match(script, /findingsPanel\.className = "output-findings"/);
  assert.match(script, /renderVoiceFindingRow\(finding, target\)/);
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
