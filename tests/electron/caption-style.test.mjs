import test from 'node:test';
import assert from 'node:assert/strict';
import { captionOverlayCss } from '../../electron-app/main/capture/caption-style.mjs';
import { CAPTION_STYLES, DEFAULT_CAPTION_STYLE, captionStyleId, requireCaptionStyle } from '../../electron-app/shared/caption-styles.mjs';
import { normalizeOptions } from '../../electron-app/shared/options.mjs';

test('기본 자막 모양은 그림자이고, 모르는 값은 기본으로 돌아간다', () => {
  assert.equal(DEFAULT_CAPTION_STYLE, 'shadow');
  assert.equal(captionStyleId('box'), 'box');
  for (const raw of [undefined, null, '', 'neon', 'constructor', '__proto__']) assert.equal(captionStyleId(raw), 'shadow');
  assert.deepEqual(Object.keys(CAPTION_STYLES), ['shadow', 'box']);
});

test('명령줄은 모르는 자막 모양을 조용히 바꾸지 않고 멈춘다', () => {
  assert.equal(requireCaptionStyle('box'), 'box');
  assert.throws(() => requireCaptionStyle('boks'), /shadow, box/);
  assert.throws(() => requireCaptionStyle(true), /shadow, box/);
});

test('그림자 모양은 예전 자막 CSS와 같고, 박스는 글자 길이만큼 쓰는 불투명 회색이다', () => {
  const shadow = captionOverlayCss(1920, 1080);
  assert.equal(captionOverlayCss(1920, 1080, 'shadow'), shadow);
  assert.equal(captionOverlayCss(1920, 1080, 'neon'), shadow, '모르는 값은 그림자');
  assert.match(shadow, /text-shadow:\s+0 2px 3px/);
  assert.doesNotMatch(shadow, /border-radius/);

  const box = captionOverlayCss(1920, 1080, 'box');
  assert.ok(box.startsWith(shadow.trimEnd()), '박스는 기본 모양 위에 덧씌운다');
  assert.match(box, /width: max-content/, '박스 너비는 글자 길이를 따른다');
  assert.match(box, /background: #3a3e46;/, '불투명 회색(투명도 없음)');
  assert.match(box, /text-shadow: none/);
  assert.match(box, /#narration-caption-overlay:empty \{ display: none; \}/, '자막 사이 빈 그림에는 박스가 없다');
});

test('출력 크기에 맞춰 늘려도 박스 모양은 무대 좌표로 그린다', () => {
  assert.match(captionOverlayCss(3840, 2160, 'box'), /scale\(2, 2\)/);
});

test('작업 옵션은 자막 모양을 고르고 모르는 값은 기본으로 둔다', () => {
  const raw = { name: 'lesson-a', mode: 'lesson', startPage: 1, endPage: 1, deliverable: 'video' };
  assert.equal(normalizeOptions({ ...raw, captionStyle: 'box' }).captionStyle, 'box');
  assert.equal(normalizeOptions({ ...raw, captionStyle: 'neon' }).captionStyle, 'shadow');
  assert.equal(normalizeOptions(raw).captionStyle, 'shadow');
});

test('박스는 실제 브라우저에서 자막 길이에 맞춰 너비가 달라지고 빈 자막에는 없다', async t => {
  const { chromium } = await import('playwright');
  const browser = await chromium.launch({ headless: true });
  t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width: 1920, height: 1080 } });
  await page.setContent(`<!doctype html><html><head><meta charset="utf-8"><style>
    html, body { margin: 0; background: #fff; }
    ${captionOverlayCss(1920, 1080, 'box')}
    #narration-caption-overlay { transition: none; }
  </style></head><body><div id="narration-caption-stage"><div id="narration-caption-overlay" data-visible="true"></div></div></body></html>`);
  const measure = text => page.evaluate(value => {
    const element = document.getElementById('narration-caption-overlay');
    element.textContent = value;
    const rect = element.getBoundingClientRect();
    const style = getComputedStyle(element);
    return { width: Math.round(rect.width), height: Math.round(rect.height), display: style.display,
      background: style.backgroundColor, centerX: Math.round(rect.left + rect.width / 2) };
  }, text);

  const short = await measure('네.');
  const long = await measure('엔진으로 처리하는 개방형 데이터 아키텍처입니다.');
  const two = await measure('운영 책임을 확인한 뒤 고객과\n함께 정합니다.');
  assert.equal(short.background, 'rgb(58, 62, 70)', '불투명 회색');
  assert.ok(short.width < 150, `짧은 자막은 박스도 작다 (${short.width}px)`);
  assert.ok(long.width > short.width * 4, `긴 자막은 박스도 길다 (${long.width}px)`);
  assert.ok(two.height > long.height * 1.6, '두 줄이면 박스가 아래로 두 줄만큼 선다');
  assert.ok(long.width <= 1480 && two.width <= 1480);
  for (const box of [short, long, two]) assert.equal(box.centerX, 960, '박스는 가운데에 선다');
  assert.equal((await measure('')).display, 'none', '글자가 없으면 박스를 그리지 않는다');
});
