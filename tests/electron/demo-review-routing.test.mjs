import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { buildReviewPage, collectReview } from '../../electron-app/main/editing/demo-review.mjs';

// 후보를 들을 때 "이 후보는 영어를 따로 읽었나"를 화면에서 바로 봐야 한다.
async function reviewDir(t, routing) {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), 'demo-review-'));
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  const outDir = path.join(base, 'demo-fixture');
  const sceneDir = path.join(outDir, 'demo', 'narration', 'ask');
  await fs.mkdir(sceneDir, { recursive: true });
  await fs.writeFile(path.join(outDir, 'demo', 'edit-plan.json'), JSON.stringify({
    durationMs: 4000, totalFrames: 100, maxSpeed: 4, fps: 25,
    segments: [{ sourceStartMs: 0, sourceEndMs: 4000, outStartMs: 0, outEndMs: 4000, speed: 1 }],
    scenes: [{ id: 'ask', outStartMs: 0, outEndMs: 4000, sourceStartMs: 0, sourceEndMs: 4000, steps: [] }],
  }));
  await fs.writeFile(path.join(outDir, 'demo', 'script.json'), JSON.stringify({
    scenes: [{ id: 'ask', text: '한 문장', status: 'approved',
      voice: { candidates: ['narration/ask/candidate-01.wav'], selected: 'narration/ask/candidate-01.wav' } }],
  }));
  await fs.writeFile(path.join(sceneDir, 'candidate-01.json'),
    JSON.stringify({ durationMs: 2000, seed: 7, voiceRouting: routing }));
  return outDir;
}

test('영어를 따로 읽은 후보는 검수 화면에 구간 수가 보인다', async t => {
  const outDir = await reviewDir(t, {
    policy: 'english-speaker-only-v1', gapMs: 120,
    segments: [{ text: '이걸', language: 'Korean' }, { text: '"Ship it"', language: 'English' }],
  });
  const data = collectReview(outDir);
  assert.equal(data.scenes[0].candidates[0].voiceRouting.policy, 'english-speaker-only-v1');
  assert.match(buildReviewPage(data), /영어 1구간/);
});

test('영어가 없던 후보는 구간 표시 없이 null로 남는다', async t => {
  const data = collectReview(await reviewDir(t, null));
  assert.equal(data.scenes[0].candidates[0].voiceRouting, null);
  assert.ok(!buildReviewPage(data).includes('영어 '), '없는 구간을 지어내지 않는다');
});
