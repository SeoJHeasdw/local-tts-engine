import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createStudio } from '../../electron-app/main/application.mjs';
import { APP_DIR, ROOT, RENDERER_DIR } from '../../electron-app/main/paths.mjs';

test('분리된 서비스를 조립해 창과 모든 preload 요청을 등록하고 안전하게 종료한다', async () => {
  const handlers = new Map();
  const windows = [];
  class Window {
    constructor(options) {
      this.options = options;
      this.webContents = { setWindowOpenHandler() {}, on() {} };
      windows.push(this);
    }
    loadFile(file) { this.file = file; }
    once() {}
  }
  const studio = createStudio({
    app: {}, BrowserWindow: Window, dialog: {}, shell: {},
    ipcMain: { handle(name, callback) {
      assert.ok(!handlers.has(name), `중복 IPC 등록: ${name}`);
      handlers.set(name, callback);
    } },
  });
  await studio.start();
  assert.equal(path.dirname(APP_DIR.replace(/\/$/, '')), ROOT);
  assert.equal(windows[0].file, path.join(RENDERER_DIR, 'index.html'));
  assert.equal(windows[0].options.webPreferences.contextIsolation, true);
  assert.equal(windows[0].options.webPreferences.sandbox, true);
  const preload = await fs.readFile(path.join(APP_DIR, 'preload.cjs'), 'utf8');
  const channels = [...preload.matchAll(/ipcRenderer\.invoke\(["']([^"']+)["']/g)].map(match => match[1]);
  assert.ok(channels.length > 20);
  for (const channel of channels) assert.ok(handlers.has(channel), `연결되지 않은 요청: ${channel}`);
  assert.doesNotThrow(() => studio.stop(), '작업 없는 앱 종료도 동작해야 한다');
  let stopped = false;
  studio.state.activeJob = { children: new Set([{ pid: 0, kill() { stopped = true; } }]) };
  studio.stop();
  assert.equal(stopped, false, 'PID 없는 프로세스에는 종료 신호를 보내지 않는다');
});
