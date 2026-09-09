import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createMediaService } from '../../electron-app/main/media.mjs';
import { mapWithConcurrency } from '../../electron-app/shared/jobs.mjs';

const tick = () => new Promise(resolve => setImmediate(resolve));

test('파일 40개를 가져와도 검사 동시 실행과 설정 읽기가 제한된다', async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'tts-probe-limit-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  let settingsReads = 0, probes = 0, active = 0, peak = 0;
  const media = createMediaService({
    readAppSettings: async () => { settingsReads++; return { paths: { outputRoot: directory } }; },
    requireRuntimeTool: () => 'ffprobe',
    runUtility: async () => {
      probes++; active++; peak = Math.max(peak, active);
      await tick(); active--;
      return JSON.stringify({ format: { duration: '1.25' }, streams: [{ codec_type: 'video' }] });
    },
  });
  const paths = Array.from({ length: 40 }, (_, index) => path.join(directory, `video-${index}.mp4`));
  const selected = await media.registerSelected(paths, 'video');
  t.diagnostic(JSON.stringify({ files: paths.length, probes, peak, settingsReads }));
  assert.equal(probes, 40);
  assert.ok(peak <= 4, `검사 프로세스 동시 실행: ${peak}`);
  assert.equal(settingsReads, 1);
  assert.deepEqual(selected.map(item => item.path), paths);
  assert.equal(new Set(selected.map(item => item.token)).size, 40);
  assert.ok(selected.every(item => item.durationMs === 1250));
});

test('같은 파일의 중복 선택은 한 번만 검사하되 다음 요청에서 다시 읽는다', async () => {
  let probes = 0, settingsReads = 0;
  const media = createMediaService({
    readAppSettings: async () => { settingsReads++; return {}; },
    requireRuntimeTool: () => 'ffprobe',
    runUtility: async () => {
      probes++;
      await tick();
      return JSON.stringify({ format: { duration: String(probes) } });
    },
  });
  const selected = await media.registerSelected(['/tmp/repeated.wav', '/tmp/repeated.wav'], 'audio', [{ name: '첫 선택' }, { name: '둘째 선택' }]);
  assert.equal(probes, 1);
  assert.equal(settingsReads, 0, '음성 파일은 강의 설정이 필요하지 않다');
  assert.notEqual(selected[0].token, selected[1].token);
  assert.deepEqual(selected.map(item => item.name), ['첫 선택', '둘째 선택']);
  const [fresh] = await media.registerSelected(['/tmp/repeated.wav'], 'audio');
  assert.equal(probes, 2);
  assert.equal(fresh.durationMs, 2000, '다음 요청에서 변경된 파일을 다시 확인해야 한다');
});

test('병렬 항목 실패 후에는 새 항목을 시작하지 않고 실행 중인 작업이 끝난 뒤 실패를 반환한다', async () => {
  const started = [];
  const failure = new Error('첫 작업 실패');
  const held = Promise.withResolvers();
  let settled = false;
  const result = mapWithConcurrency([0, 1, 2, 3], 2, async item => {
    started.push(item);
    if (item === 0) throw failure;
    if (item === 1) await held.promise;
    return item;
  }).then(value => { settled = true; return value; }, error => { settled = true; return error; });
  await tick();
  const settledBeforeDrain = settled;
  held.resolve();
  assert.equal(await result, failure);
  await tick();
  assert.equal(settledBeforeDrain, false, '실행 중 작업을 남겨둔 채 실패 완료를 알리면 안 된다');
  assert.deepEqual(started, [0, 1], '실패 뒤 남은 항목을 시작하면 안 된다');
});

test('병렬 성공 결과는 완료 순서와 관계없이 입력 순서를 유지한다', async () => {
  const first = Promise.withResolvers();
  const pending = mapWithConcurrency([0, 1, 2], 2, async item => {
    if (item === 0) await first.promise;
    if (item === 2) first.resolve();
    return item * 10;
  });
  assert.deepEqual(await pending, [0, 10, 20]);
  assert.deepEqual(await mapWithConcurrency([], 2, () => { throw new Error('빈 입력'); }), []);
});
