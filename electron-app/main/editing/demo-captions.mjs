// 앱 데모 자막을 완성본에 굽는 그림을 만든다.
//
// 이 맥의 ffmpeg에는 libass·drawtext가 없어 글자를 ffmpeg로 그릴 수 없다(2026-09-21 확인).
// 그래서 강의와 같은 자막 모양(capture/caption-style.mjs)을 브라우저로 그려 투명 PNG로 뜨고,
// 렌더가 overlay 하나로 겹친다. 자막 한 줄이 그림 한 장이고 시각은 ffconcat 목록이 정한다 —
// 자막이 수백 줄이어도 ffmpeg 입력은 하나다. 화면 아래 띠만 뜬다. 전체를 뜨면 4K에서 한 장이
// 커지고 겹칠 자리도 넓어진다.
//
// 기본은 굽지 않는다(자막 파일만, 설계 6절). 켤 때만 이 길을 지난다.
import fs from "node:fs";
import path from "node:path";
import { captionOverlayCss } from "../capture/caption-style.mjs";

/**
 * 자막이 들어가는 화면 아래 띠. 자막은 한 줄 24자·두 줄까지이고(shared/captions.mjs)
 * 아래 72/1080에서 위로 쌓이므로 아래 1/4이면 그림자까지 들어간다. 짝수로 맞춘다 —
 * yuv420p로 겹칠 때 색 표본이 두 줄 단위다.
 */
export function captionBand(profile) {
  const height = Math.round(profile.height / 4 / 2) * 2;
  return { x: 0, y: profile.height - height, width: profile.width, height };
}

/**
 * ffconcat 목록. 자막 사이는 빈 그림으로 채워 시간축이 끊기지 않게 한다. 겹치는 자막은
 * 앞의 것이 끝난 뒤부터 보인다. 마지막 그림은 한 번 더 적는다 — ffconcat은 마지막 줄의
 * `duration`을 그 다음 줄이 있어야 지킨다.
 */
export function captionConcatList(cues, { files, blank, totalMs }) {
  const lines = ["ffconcat version 1.0"];
  const push = (file, ms) => {
    if (ms > 0) lines.push(`file '${file}'`, `duration ${(ms / 1000).toFixed(3)}`);
  };
  let at = 0;
  cues.forEach((cue, index) => {
    const start = Math.min(totalMs, Math.max(at, cue.startMs));
    const end = Math.min(totalMs, cue.endMs);
    push(blank, start - at);
    at = start;
    if (end > start) {
      push(files[index], end - start);
      at = end;
    }
  });
  push(blank, totalMs - at);
  lines.push(`file '${blank}'`);
  return `${lines.join("\n")}\n`;
}

async function launchChromium() {
  const { chromium } = await import("playwright");
  return chromium.launch({ headless: true });
}

/**
 * 자막 줄마다 투명 PNG를 떠서 ffconcat 목록을 쓴다. 만든 폴더는 부른 쪽이 굽고 나서 지운다.
 * `launch`는 검사가 브라우저 대신 쓸 수 있게 열어 둔다.
 */
export async function renderCaptionFrames({ cues, profile, dir, totalMs, launch = launchChromium }) {
  fs.mkdirSync(dir, { recursive: true });
  const band = captionBand(profile);
  const browser = await launch();
  try {
    const page = await browser.newPage({ viewport: { width: profile.width, height: profile.height }, deviceScaleFactor: 1 });
    // 강의 오버레이는 나타날 때 0.1초 흐려졌다 선다. 그림 한 장에는 그 사이가 없다.
    await page.setContent(`<!doctype html><html><head><meta charset="utf-8"><style>
      html, body { margin: 0; background: transparent; }
      ${captionOverlayCss(profile.width, profile.height)}
      #narration-caption-overlay { transition: none; }
    </style></head><body><div id="narration-caption-stage">
      <div id="narration-caption-overlay" data-visible="true"></div>
    </div></body></html>`);
    await page.evaluate(() => document.fonts.ready);
    const shoot = async (text, file) => {
      await page.evaluate(value => { document.getElementById("narration-caption-overlay").textContent = value; }, text);
      await page.screenshot({ path: path.join(dir, file), omitBackground: true, clip: band });
    };
    const blank = "blank.png";
    await shoot("", blank);
    const files = [];
    for (const [index, cue] of cues.entries()) {
      const file = `cue-${String(index + 1).padStart(4, "0")}.png`;
      await shoot(cue.text, file);
      files.push(file);
    }
    const list = path.join(dir, "captions.ffconcat");
    fs.writeFileSync(list, captionConcatList(cues, { files, blank, totalMs }), "utf8");
    return { list, band, count: files.length };
  } finally {
    await browser.close();
  }
}
