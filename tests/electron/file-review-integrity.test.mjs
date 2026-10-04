import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import nativeFs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { fileSha256, renameMediaFile, reportDescribesVideo } from '../../electron-app/main/files.mjs';
import { createMediaService } from '../../electron-app/main/media.mjs';
import { createOutputsService } from '../../electron-app/main/outputs.mjs';
import { dateFolder, runtimePaths } from '../../electron-app/main/paths.mjs';

async function fixture(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'tts-file-integrity-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const put = async (name, text) => { const file = path.join(dir, name); await fs.writeFile(file, text); return file; };
  return { dir, put };
}

test('renaming refuses subtitle or timeline collisions without changing any file', async t => {
  const { dir, put } = await fixture(t);
  const video = await put('old.mp4', 'original video');
  await put('old.srt', 'original captions'); await put('old.timeline.json', 'original timeline');
  await put('new.srt', 'existing captions'); await put('new.timeline.json', 'existing timeline');
  await assert.rejects(renameMediaFile(video, 'new'), /같은 이름/);
  assert.equal(await fs.readFile(video, 'utf8'), 'original video');
  assert.equal(await fs.readFile(path.join(dir, 'new.srt'), 'utf8'), 'existing captions');
  assert.equal(await fs.readFile(path.join(dir, 'new.timeline.json'), 'utf8'), 'existing timeline');
  await assert.rejects(fs.access(path.join(dir, 'new.mp4')), { code: 'ENOENT' });
});

test('rename rolls back an incomplete move and never overwrites a concurrent destination', async t => {
  const { dir, put } = await fixture(t);
  const video = await put('old.mp4', 'original video'); await put('old.srt', 'original captions');
  let failed = false;
  await assert.rejects(renameMediaFile(video, 'new', { fs: { ...fs, unlink: async file => {
    if (!failed && file === path.join(dir, 'old.srt')) { failed = true; throw Object.assign(new Error('locked caption'), { code: 'EACCES' }); }
    return fs.unlink(file);
  } } }), /locked caption/);
  assert.deepEqual((await fs.readdir(dir)).sort(), ['old.mp4', 'old.srt']);
  assert.equal(await fs.readFile(video, 'utf8'), 'original video');
  assert.equal(await fs.readFile(path.join(dir, 'old.srt'), 'utf8'), 'original captions');
  await assert.rejects(renameMediaFile(video, 'new', { fs: { ...fs, link: async (from, to) => {
    if (to.endsWith('new.srt')) await fs.writeFile(to, 'concurrent captions', { flag: 'wx' });
    return fs.link(from, to);
  } } }), /같은 이름/);
  assert.equal(await fs.readFile(path.join(dir, 'new.srt'), 'utf8'), 'concurrent captions');
  assert.equal(await fs.readFile(video, 'utf8'), 'original video');
  await assert.rejects(fs.access(path.join(dir, 'new.mp4')), { code: 'ENOENT' });
});

test('only a byte-identical Finder rename inherits video review evidence', async t => {
  const { dir, put } = await fixture(t);
  const old = await put('old.mp4', 'approved video');
  const report = { videoPath: old, capture: { fileSha256: await fileSha256(old) }, review: { status: 'approved' } };
  const renamed = await renameMediaFile(old, 'renamed');
  assert.equal(await reportDescribesVideo(old, renamed, report), true);
  const unrelated = await put('unrelated.mp4', 'unrelated video');
  assert.equal(await reportDescribesVideo(old, unrelated, report), false);
  assert.equal(await reportDescribesVideo(old, unrelated), false, 'missing filename alone is no rename evidence');
  assert.equal(await reportDescribesVideo(unrelated, unrelated, { review: { status: 'approved' } }), false,
    'a legacy approval without a fingerprint cannot certify replacement bytes');
  assert.equal(await reportDescribesVideo(unrelated, unrelated, { capture: { fileSha256: 'invalid' } }), false);
  await fs.writeFile(path.join(dir, 'validation-report.json'), JSON.stringify(report));
  const media = createMediaService({ readAppSettings: async () => ({ paths: { outputRoot: dir } }),
    requireRuntimeTool: () => 'ffprobe', runUtility: async () => JSON.stringify({ format: { duration: 1 }, streams: [{ codec_type: 'video' }] }) });
  const [good, bad] = await media.registerSelected([renamed, unrelated], 'video');
  assert.equal(good.review.status, 'approved'); assert.equal(bad.review, null);
  await fs.writeFile(renamed, 'replacement at the same path');
  assert.equal(await reportDescribesVideo(renamed, renamed, report), false);
});

test('renaming on a volume without hard links uses exclusive copies', async t => {
  const { dir, put } = await fixture(t);
  const video = await put('old.mp4', 'original video'); await put('old.srt', 'original captions');
  const renamed = await renameMediaFile(video, 'new', { fs: { ...fs,
    link: async () => { throw Object.assign(new Error('hard links unsupported'), { code: 'ENOTSUP' }); },
  } });
  assert.equal(await fs.readFile(renamed, 'utf8'), 'original video');
  assert.equal(await fs.readFile(path.join(dir, 'new.srt'), 'utf8'), 'original captions');
  assert.deepEqual((await fs.readdir(dir)).sort(), ['new.mp4', 'new.srt']);
});

test('new output approvals bind video bytes and changed videos lose approval in the list', async t => {
  const { dir } = await fixture(t), studio = runtimePaths({ outputRoot: dir });
  const day = dateFolder(), name = 'approved-edit', directory = path.join(studio.editOutputRoot, day, name);
  await fs.mkdir(directory, { recursive: true });
  const video = path.join(directory, `${name}.mp4`), reportPath = path.join(directory, 'validation-report.json');
  await fs.writeFile(video, 'original video');
  await fs.writeFile(reportPath, JSON.stringify({ videoPath: video, summary: { ok: true }, review: { status: 'pending' } }));
  const outputs = createOutputsService({ readAppSettings: async () => ({ paths: { outputRoot: dir } }), state: {} });
  const target = { root: 'edit', day, name };
  const review = await outputs.setOutputReview(target, 'approved', studio);
  assert.equal(review.fileSha256, await fileSha256(video));
  assert.equal((await outputs.listOutputs(studio, { includeLegacy: false }))[0].review.status, 'approved');
  await fs.writeFile(video, 'replacement video');
  assert.equal((await outputs.listOutputs(studio, { includeLegacy: false }))[0].review.status, 'pending');
  await assert.rejects(outputs.setOutputReview(target, 'approved', studio), /검수 기록과 다릅니다/);
  assert.equal(JSON.parse(await fs.readFile(reportPath, 'utf8')).review.status, 'approved', 'read-only inspection preserves historical approval evidence');
  await fs.writeFile(reportPath, JSON.stringify({ summary: { ok: true }, review: { status: 'approved' } }));
  const missingIdentity = (await outputs.listOutputs(studio, { includeLegacy: false }))[0];
  assert.equal(missingIdentity.review.status, 'pending');
  assert.equal(missingIdentity.ok, null);
});

test('an approval stores the digest it checked rather than a later replacement digest', async t => {
  const { dir } = await fixture(t), studio = runtimePaths({ outputRoot: dir });
  const day = dateFolder(), name = 'approval-race', directory = path.join(studio.editOutputRoot, day, name);
  await fs.mkdir(directory, { recursive: true });
  const video = path.join(directory, `${name}.mp4`), reportPath = path.join(directory, 'validation-report.json');
  await fs.writeFile(video, 'heard video bytes');
  const heardDigest = await fileSha256(video);
  await fs.writeFile(reportPath, JSON.stringify({ videoPath: video, capture: { fileSha256: heardDigest }, summary: { ok: true } }));
  const outputs = createOutputsService({ readAppSettings: async () => ({ paths: { outputRoot: dir } }), state: {} });
  const original = nativeFs.createReadStream;
  let changed = false;
  nativeFs.createReadStream = (...args) => {
    const stream = original(...args);
    if (!changed && args[0] === video) stream.once('end', () => {
      changed = true; nativeFs.writeFileSync(video, 'unheard replacement bytes');
    });
    return stream;
  };
  syncBuiltinESMExports();
  try {
    const review = await outputs.setOutputReview({ root: 'edit', day, name }, 'approved', studio);
    assert.equal(changed, true);
    assert.equal(review.fileSha256, heardDigest);
    assert.notEqual(review.fileSha256, await fileSha256(video));
    assert.equal((await outputs.listOutputs(studio, { includeLegacy: false }))[0].review.status, 'pending');
  } finally { nativeFs.createReadStream = original; syncBuiltinESMExports(); }
});
