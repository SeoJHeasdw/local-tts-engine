import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { createVoicesService } from '../../electron-app/main/voices.mjs';

// 영어를 따로 읽었는지는 후보 목록 파일만 보고 답할 수 있어야 한다. 기록이
// 없으면 "영어가 없었다"와 "기록하지 않았다"가 같아 보인다.
function service(metadataByPath) {
  const written = new Map();
  const voices = createVoicesService({
    chosenRecord: () => ({}), emit() {},
    requireRuntimeTool: () => '/python', runProcess: async () => {},
    registerSelected: async files => files.map((file, index) => ({ token: `candidate-${index}` })),
    inspectMedia: async () => ({}),
    state: { activeJob: { kind: 'text-voice' } },
    fs: {
      mkdir: async () => {}, unlink: async () => {},
      writeFile: async (file, text) => written.set(file, text),
      readFile: async file => JSON.stringify(metadataByPath(file)),
    },
  });
  return { voices, written };
}

const options = { name: 'routing', text: '이걸 "Ship it when it is ready" 라고 합니다.', modelId: 'qwen3-tts', candidateCount: 2, voiceParallelism: 1 };

function indexOf(written) {
  const entry = [...written].find(([file]) => path.basename(file) === 'index.json');
  assert.ok(entry, '후보 목록 파일이 없습니다.');
  return JSON.parse(entry[1]);
}

test('영어 구간을 나눈 후보는 목록 파일에 그 사실을 남긴다', async () => {
  const routing = {
    policy: 'english-speaker-only-v1', gapMs: 120,
    segments: [{ text: '이걸', language: 'Korean' }, { text: '"Ship it when it is ready"', language: 'English' }],
  };
  const { voices, written } = service(() => ({ durationMs: 4200, voiceRouting: routing }));
  await voices.runTextVoiceCandidates(options);
  const record = indexOf(written);
  assert.equal(record.candidates.length, 2);
  for (const candidate of record.candidates) assert.deepEqual(candidate.voiceRouting, routing);
});

test('영어가 없던 후보는 기록 없음이 아니라 null로 남는다', async () => {
  const { voices, written } = service(() => ({ durationMs: 4200, voiceRouting: null }));
  await voices.runTextVoiceCandidates(options);
  for (const candidate of indexOf(written).candidates) {
    assert.ok('voiceRouting' in candidate, '영어 분리 여부를 적지 않으면 파일만으로 확인할 수 없다');
    assert.equal(candidate.voiceRouting, null);
  }
});
