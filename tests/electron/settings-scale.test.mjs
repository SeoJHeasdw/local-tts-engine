import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { settingsAdapterScale } from '../../electron-app/shared/index.mjs';
import { createSettingsService } from '../../electron-app/main/settings.mjs';

const APP_DIR = fileURLToPath(new URL('../../electron-app', import.meta.url));

// 2026-09-21: 설정 막대가 0.001 단위라 화면에는 0.60으로 보이는데 0.603이 저장됐다. 그 값은
// 승인값(0.60)이 아니어서 사이드바가 "제작 목소리" 대신 "음성 설정"을 띄웠고, 앱 데모 목소리는
// 0.603으로 만들어졌다. 강도는 화면이 보이는 자리(0.01)까지만 둔다.
test('목소리 반영 강도는 0.01 단위로 읽고 저장한다', () => {
  assert.equal(settingsAdapterScale(0.603), 0.6);
  assert.equal(settingsAdapterScale(0.605), 0.61);
  assert.equal(settingsAdapterScale('0.6'), 0.6);
  assert.equal(settingsAdapterScale(undefined), 0.6);
  assert.equal(settingsAdapterScale(Number.NaN), 0.6);
  assert.equal(settingsAdapterScale(5), 1);
  assert.equal(settingsAdapterScale(0), 0.1);
});

test('예전에 0.603으로 저장된 설정도 0.60으로 읽어 승인값과 같게 본다', async () => {
  const fakeFs = {
    readdir: async () => [],
    readFile: async () => JSON.stringify({ modelId: 'qwen3-tts', adapterScale: 0.603 }),
  };
  const settings = await createSettingsService({ fs: fakeFs, state: {} }).readAppSettings();
  assert.equal(settings.adapterScale, 0.6);
});

test('설정 막대는 화면에 보이는 자리만큼만 움직인다', async () => {
  const html = await fs.readFile(path.join(APP_DIR, 'renderer', 'index.html'), 'utf8');
  assert.match(html, /id="global-scale" type="range" min="0\.1" max="1" step="0\.01"/);
});
