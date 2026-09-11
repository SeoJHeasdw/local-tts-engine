import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createIpcService } from '../../electron-app/main/ipc.mjs';
import { RENDERER_DIR } from '../../electron-app/main/paths.mjs';
import { productionFixture } from './helpers/production.mjs';

test('실패 레슨 이어하기 안내도 기존 작업의 화질·경로·판본을 확인한다', async () => {
  const handlers = new Map(), state = { activeJob: null };
  let cleared = false;
  const ipc = createIpcService({
    state, ipcMain: { handle: (name, fn) => handlers.set(name, fn) },
    readActiveJob: async () => ({ options: { name: 'chapter', videoQuality: 'ultra',
      inputFingerprint: 'original', paths: { outputRoot: '/tmp/original-output' } },
      unitNames: ['l01', 'l02'], failedUnits: [{ name: 'l02' }] }),
    readAppSettings: async () => ({ paths: { outputRoot: '/tmp/new-output' } }),
    finishedUnitNames: async (units, studio, fingerprint) => {
      assert.ok(units.every(unit => unit.videoQuality === 'ultra'));
      assert.equal(studio.captionOutputRoot, '/tmp/original-output/projects');
      assert.equal(fingerprint, 'original');
      return ['l01'];
    },
    clearActiveJob: async () => { cleared = true; },
  });
  ipc.registerIpc();
  const event = { senderFrame: { url: pathToFileURL(path.join(RENDERER_DIR, 'index.html')).href } };
  const pending = await handlers.get('studio:get-resumable')(event);
  assert.deepEqual([pending.total, pending.done, pending.remaining, pending.failed], [2, 1, 1, 1]);
  state.activeJob = { state: 'running' };
  await assert.rejects(handlers.get('studio:discard-resumable')(event), /실행 중인 작업/);
  assert.equal(cleared, false);
});

test('이어하기 기록을 지워도 완성 영상은 남기고 보관 입력만 정리한다', async t => {
  const run = await productionFixture(t);
  run.failures.set('test-ch03-l02', 'voice');
  await run.service.runPipeline(run.options);
  const video = run.events.at(-1).report.units[0].videoPath;
  const before = await fs.readFile(video);
  await run.service.clearActiveJob();
  await assert.rejects(fs.access(run.recordPath), { code: 'ENOENT' });
  await assert.rejects(fs.access(run.project), { code: 'ENOENT' });
  assert.deepEqual(await fs.readFile(video), before);
});
