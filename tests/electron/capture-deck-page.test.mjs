import assert from "node:assert/strict";
import { test } from "node:test";
import { chromium } from "playwright";
import {
  advanceToEntry, assertDeckPageHealthy, gotoFirstEntry, prepareDeckPage, replayFirstEntry,
} from "../../electron-app/main/capture/deck-page.mjs";

const profile = { width: 1920, height: 1080 };
const first = { key: "opening:0", slideId: "opening", slideNumber: 1, step: 0, chapter: "ch00" };
const second = { ...first, key: "opening:1", step: 1 };
const within = (promise) => Promise.race([
  promise,
  new Promise((_, reject) => setTimeout(() => reject(new Error("3D 실패 알림을 받지 못했습니다.")), 1000)),
]);

async function createDeckPage(browser, { firstDrawMs = 80, nextDrawMs = 120, worldClass = "ow" } = {}) {
  const page = await browser.newPage({ viewport: profile });
  const html = `
    <style>html,body{margin:0}.stage{width:1920px;height:1080px}section,canvas{display:block;width:100%;height:100%}</style>
    <div class="stage"><section data-capture-slide="opening"><div class="${worldClass}"><canvas width="1920" height="1080"></canvas></div></section></div>
    <script>
      const channel = new BroadcastChannel("udemy-deck-sync");
      let canvas = document.querySelector("canvas");
      let step = 0, runKey = 0;
      const report = () => channel.postMessage({ type: "nav", deck: "course", nav: { index: 0, step, runKey } });
      channel.onmessage = (event) => { if (event.data?.type === "hello") report(); };
      document.addEventListener("keydown", (event) => {
        if (event.key === "Enter") {
          step = 0;
          runKey++;
          report();
          ${firstDrawMs >= 0 ? `setTimeout(() => { canvas.dataset.ready = "true"; canvas.dataset.frames = "1"; }, ${firstDrawMs});` : ""}
        } else if (event.key === "ArrowRight") {
          step++;
          report();
          setTimeout(() => { canvas.dataset.frames = String(Number(canvas.dataset.frames) + 1); }, ${nextDrawMs});
        } else if (event.key === "r") {
          step = 0;
          runKey++;
          const old = canvas, replacement = old.cloneNode(false);
          replacement.removeAttribute("data-ready");
          replacement.removeAttribute("data-frames");
          old.dispatchEvent(new Event("webglcontextlost", { cancelable: true }));
          old.replaceWith(replacement);
          canvas = replacement;
          report();
          ${firstDrawMs >= 0 ? `setTimeout(() => { canvas.dataset.ready = "true"; canvas.dataset.frames = "1"; }, ${firstDrawMs});` : ""}
        }
      });
    </script>
  `;
  await page.route("http://127.0.0.1:48123/", (route) => route.fulfill({
    status: 200, contentType: "text/html", body: html,
  }));
  await page.goto("http://127.0.0.1:48123/");
  return page;
}

test("덱 촬영은 첫 3D draw와 다음 큐 draw를 확인하고 렌더 실패를 전파한다", { timeout: 15000 }, async (t) => {
  let browser;
  try {
    browser = await chromium.launch({ headless: true });
  } catch (error) {
    if (/MachPortRendezvousServer[\s\S]*Permission denied/.test(error.message)) {
      t.skip("현재 macOS 작업 샌드박스가 Chromium 실행을 막습니다.");
      return;
    }
    throw error;
  }
  const pages = [];
  t.after(async () => {
    for (const page of pages) await page.close().catch(() => {});
    await browser.close();
  });

  const page = await createDeckPage(browser);
  pages.push(page);
  let failed;
  const notified = new Promise((resolve) => { failed = resolve; });
  await prepareDeckPage(page, profile, { onCaptureFailure: failed });
  await gotoFirstEntry(page, first);
  assert.deepEqual(await page.evaluate(() => ({ ready: document.querySelector("canvas").dataset.ready,
    frames: document.querySelector("canvas").dataset.frames })), { ready: "true", frames: "1" });

  const started = Date.now();
  await advanceToEntry(page, first, second);
  assert.ok(Date.now() - started >= 80, "다음 큐의 3D draw 전에 전환 성공으로 처리하면 안 됩니다.");
  assert.equal(await page.evaluate(() => document.querySelector("canvas").dataset.frames), "2");

  await page.evaluate(() => document.querySelector(".ow").dataset.fallback = "true");
  assert.match((await within(notified)).message, /3D 대체 화면/);
  await assert.rejects(() => assertDeckPageHealthy(page), /3D 대체 화면/);

  const lostPage = await createDeckPage(browser, { firstDrawMs: 0 });
  pages.push(lostPage);
  let reportLoss;
  const lost = new Promise((resolve) => { reportLoss = resolve; });
  await prepareDeckPage(lostPage, profile, { onCaptureFailure: reportLoss });
  await gotoFirstEntry(lostPage, first);
  await lostPage.evaluate(() => document.querySelector("canvas").dispatchEvent(
    new Event("webglcontextlost", { cancelable: true }),
  ));
  assert.match((await within(lost)).message, /WebGL 컨텍스트가 소실/);
  await assert.rejects(() => assertDeckPageHealthy(lostPage), /WebGL 컨텍스트가 소실/);

  const startupFailurePage = await createDeckPage(browser, { firstDrawMs: -1 });
  pages.push(startupFailurePage);
  await prepareDeckPage(startupFailurePage, profile);
  await startupFailurePage.evaluate(() => document.querySelector(".ow").dataset.fallback = "true");
  await assert.rejects(() => gotoFirstEntry(startupFailurePage, first), /3D 대체 화면/);

  const disposedPage = await createDeckPage(browser, { firstDrawMs: 0 });
  pages.push(disposedPage);
  const disposalNotifications = [];
  await prepareDeckPage(disposedPage, profile, { onCaptureFailure: (error) => disposalNotifications.push(error) });
  await gotoFirstEntry(disposedPage, first);
  await disposedPage.evaluate(() => {
    const canvas = document.querySelector("canvas");
    canvas.dispatchEvent(new Event("webglcontextlost", { cancelable: true }));
    canvas.remove();
  });
  await new Promise((resolve) => setTimeout(resolve, 50));
  await assertDeckPageHealthy(disposedPage);
  assert.equal(disposalNotifications.length, 0);

  const replayPage = await createDeckPage(browser);
  pages.push(replayPage);
  const replayNotifications = [];
  await prepareDeckPage(replayPage, profile, { onCaptureFailure: (error) => replayNotifications.push(error) });
  await gotoFirstEntry(replayPage, first);
  const oldCanvas = await replayPage.evaluate(() => document.querySelector("canvas").dataset.frames);
  const replayMs = await replayFirstEntry(replayPage, first);
  assert.ok(replayMs >= 60);
  assert.equal(oldCanvas, "1");
  assert.equal(await replayPage.evaluate(() => document.querySelector("canvas").dataset.ready), "true");
  assert.equal(replayNotifications.length, 0, "정상적인 remount는 WebGL 소실로 처리하지 않습니다.");

  const plainCanvasPage = await createDeckPage(browser, { firstDrawMs: -1, worldClass: "plain-chart" });
  pages.push(plainCanvasPage);
  await prepareDeckPage(plainCanvasPage, profile);
  await gotoFirstEntry(plainCanvasPage, first);
  assert.equal(await plainCanvasPage.evaluate(() => document.querySelector("canvas").dataset.ready), undefined);
});
