import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createTrainingImportService, TRAINING_IMPORT_EXTENSIONS } from '../../electron-app/main/training-import.mjs';
import { ROOT } from '../../electron-app/main/paths.mjs';

const execute = promisify(execFile);
const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex');

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'training-import-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const datasetRoot = path.join(root, 'datasets');
  const originalDirectory = path.join(root, 'originals');
  await fs.mkdir(originalDirectory);
  const first = path.join(originalDirectory, '같은 이름.m4a');
  const secondDirectory = path.join(originalDirectory, 'nested');
  await fs.mkdir(secondDirectory);
  const second = path.join(secondDirectory, '같은 이름.MP3');
  await fs.writeFile(first, 'original recording one');
  await fs.writeFile(second, 'original recording two');
  const calls = [];
  const service = createTrainingImportService({ datasetRoot, requireRuntimeTool: key => key,
    runProcess: async (stage, executable, args) => {
      calls.push({ stage, executable, args });
      if (executable === 'ffmpeg') {
        await fs.writeFile(args.at(-1), `converted ${args[args.indexOf('-i') + 1]}`);
      } else {
        const directory = args[args.indexOf('--output-dir') + 1];
        const sourceDirectory = args[args.indexOf('--source-dir') + 1];
        const sourcePaths = (await fs.readdir(sourceDirectory)).map(file => path.join(sourceDirectory, file));
        await fs.writeFile(path.join(directory, 'manifest.json'), JSON.stringify({ schemaVersion: 1,
          displayName: args[args.indexOf('--display-name') + 1], referenceAudio: sourcePaths[0],
          sources: sourcePaths.map(file => ({ path: file })), stats: { clips: sourcePaths.length, transcribed: 0 } }));
      }
    } });
  return { root, datasetRoot, first, second, service, calls };
}

test('여러 원본을 고유한 복사본으로 분할하고 원본·기존 데이터·모델은 그대로 둔다', async t => {
  const f = await fixture(t);
  await fs.mkdir(path.join(f.datasetRoot, 'existing'), { recursive: true });
  await fs.writeFile(path.join(f.datasetRoot, 'existing', 'keep.txt'), 'keep');
  const before = await Promise.all([f.first, f.second].map(file => fs.readFile(file)));

  const result = await f.service.importDataset({ displayName: '  새로운 사람  ', files: [f.first, f.second] });

  assert.match(result.id, /^voice-[a-z0-9]+-[0-9a-f]{8}$/);
  assert.equal(result.displayName, '새로운 사람');
  assert.equal(result.sourceCount, 2);
  assert.equal(result.clips, 2);
  assert.equal(result.transcribed, 0);
  assert.deepEqual(await fs.readdir(path.join(result.directory, 'source')), ['source-0001.wav', 'source-0002.wav']);
  assert.deepEqual(await Promise.all([f.first, f.second].map(file => fs.readFile(file))), before);
  assert.equal(await fs.readFile(path.join(f.datasetRoot, 'existing', 'keep.txt'), 'utf8'), 'keep');
  assert.equal(f.calls.length, 3);
  assert.ok(f.calls.every(call => call.stage === 'training'));
  for (const call of f.calls.slice(0, 2)) {
    assert.equal(call.executable, 'ffmpeg');
    assert.equal(call.args[call.args.indexOf('-ar') + 1], '48000');
    assert.equal(call.args[call.args.indexOf('-ac') + 1], '1');
    assert.equal(call.args[call.args.indexOf('-c:a') + 1], 'pcm_s24le');
    assert.ok(call.args.includes('-n'));
  }
  const segment = f.calls[2].args;
  assert.deepEqual(segment.slice(0, 3), ['-m', 'local_tts_engine.finetune_dataset', 'segment']);
  assert.equal(segment[segment.indexOf('--reference') + 1], path.join(result.directory, 'source', 'source-0001.wav'));
  const manifest = JSON.parse(await fs.readFile(path.join(result.directory, 'manifest.json'), 'utf8'));
  assert.equal(manifest.sources.length, 2);
  assert.deepEqual(manifest.originalSources.map(source => [source.path, source.sha256]), [
    [await fs.realpath(f.first), hash(before[0])], [await fs.realpath(f.second), hash(before[1])],
  ]);
  assert.ok(manifest.originalSources.every(source => /^[0-9a-f]{64}$/.test(source.derivedAudioSha256)));
  const again = await f.service.importDataset({ displayName: '다른 데이터', files: [f.first] });
  assert.notEqual(again.id, result.id);
  assert.equal((await fs.readdir(f.datasetRoot)).length, 3);
});

test('표시 이름·원본 경로·확장자·빈 파일·중복을 실행 전에 검증한다', async t => {
  const f = await fixture(t);
  const empty = path.join(f.root, 'empty.wav');
  await fs.writeFile(empty, '');
  for (const invalid of [
    { displayName: '', files: [f.first] },
    { displayName: '이름'.repeat(41), files: [f.first] },
    { displayName: '목소리', files: [] },
    { displayName: '목소리', files: ['relative.wav'] },
    { displayName: '목소리', files: [path.join(f.root, 'missing.wav')] },
    { displayName: '목소리', files: [path.join(f.root, 'not-audio.txt')] },
    { displayName: '목소리', files: [empty] },
    { displayName: '목소리', files: [f.first, f.first] },
  ]) await assert.rejects(f.service.importDataset(invalid));
  assert.equal(f.calls.length, 0);
  await assert.rejects(fs.stat(f.datasetRoot), { code: 'ENOENT' });
  assert.ok(TRAINING_IMPORT_EXTENSIONS.includes('m4a'));
});

test('변환·분할 실패와 취소는 새 폴더만 정리하고 원본을 보존한다', async t => {
  const f = await fixture(t);
  await fs.mkdir(path.join(f.datasetRoot, 'existing'), { recursive: true });
  for (const failAt of [1, 3]) {
    let calls = 0;
    const service = createTrainingImportService({ datasetRoot: f.datasetRoot, requireRuntimeTool: key => key,
      runProcess: async (_stage, executable, args) => {
        if (++calls === failAt) throw new Error('작업을 중지했습니다.');
        if (executable === 'ffmpeg') await fs.writeFile(args.at(-1), 'partial derivative');
      } });
    await assert.rejects(service.importDataset({ displayName: '실패 검사', files: [f.first, f.second] }), /중지/);
    assert.deepEqual(await fs.readdir(f.datasetRoot), ['existing']);
  }
  assert.equal(await fs.readFile(f.first, 'utf8'), 'original recording one');
  assert.equal(await fs.readFile(f.second, 'utf8'), 'original recording two');
});

test('FFmpeg가 만든 작은 실제 WAV를 분할해 학습 데이터 계약을 확인한다', async t => {
  const ffmpeg = 'ffmpeg';
  const python = path.join(ROOT, '.venv', 'bin', 'python');
  try { await execute(ffmpeg, ['-version']); await fs.access(python); }
  catch { t.skip('로컬 FFmpeg/Python이 없는 환경'); return; }
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'training-import-real-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const original = path.join(root, 'original stereo.wav');
  await execute(ffmpeg, ['-nostdin', '-hide_banner', '-loglevel', 'error', '-f', 'lavfi',
    '-i', 'sine=frequency=220:duration=3:sample_rate=44100', '-ac', '2', '-c:a', 'pcm_s16le', original]);
  const originalBytes = await fs.readFile(original);
  const service = createTrainingImportService({ datasetRoot: path.join(root, 'datasets'),
    requireRuntimeTool: key => key === 'ffmpeg' ? ffmpeg : python,
    runProcess: (_stage, executable, args) => execute(executable, args, {
      cwd: ROOT, env: { ...process.env, PYTHONPATH: path.join(ROOT, 'src') }, maxBuffer: 1024 * 1024,
    }) });

  const result = await service.importDataset({ displayName: '검사 목소리', files: [original] });

  assert.deepEqual(await fs.readFile(original), originalBytes);
  const manifest = JSON.parse(await fs.readFile(path.join(result.directory, 'manifest.json'), 'utf8'));
  assert.equal(manifest.displayName, '검사 목소리');
  assert.equal(manifest.sources[0].sampleRate, 48000);
  assert.equal(manifest.stats.clips, 1);
  assert.equal(manifest.stats.transcribed, 0);
  const rows = (await fs.readFile(path.join(result.directory, 'metadata.jsonl'), 'utf8')).trim().split('\n').map(JSON.parse);
  assert.equal(rows[0].channels, 1);
  assert.equal(rows[0].reviewStatus, 'pending');
  assert.equal(rows[0].text, '');
  const { stdout } = await execute(python, ['-m', 'local_tts_engine.finetune_dataset', 'validate', '--dataset-dir', result.directory],
    { cwd: ROOT, env: { ...process.env, PYTHONPATH: path.join(ROOT, 'src') } });
  assert.equal(JSON.parse(stdout).clips, 1);
});
