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
