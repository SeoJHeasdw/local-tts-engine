import crypto from 'node:crypto';
import nativeFs from 'node:fs/promises';
import path from 'node:path';
import { timeRangeForPages } from '../shared/timeline.mjs';
import { assertCurrentCourseManifest } from './course-run-state.mjs';

const digest = value => crypto.createHash('sha256').update(value).digest('hex');

async function audioHash(file, fs) {
  const hash = crypto.createHash('sha256');
  const handle = await fs.open(file, 'r');
  const block = Buffer.allocUnsafe(1024 * 1024);
  try {
    for (;;) {
      const { bytesRead } = await handle.read(block, 0, block.length, null);
      if (!bytesRead) break;
      hash.update(block.subarray(0, bytesRead));
    }
  } finally { await handle.close(); }
  return hash.digest('hex');
}

function scriptHash(entries, startPage, endPage) {
  const normalized = (entries || []).map(entry => ({
    chapter: entry.chapter ?? null,
    slideId: entry.slideId ?? entry.slide_id ?? null,
    slideNumber: Number(entry.slideNumber ?? entry.slide_number),
    step: entry.step ?? null,
    sourceText: entry.sourceText ?? entry.source_text ?? '',
    startMs: entry.startMs, endMs: entry.endMs,
  }));
  timeRangeForPages(normalized, startPage, endPage);
  return digest(JSON.stringify(normalized.filter(entry => entry.slideNumber >= startPage
    && entry.slideNumber <= endPage).map(({ startMs, endMs, ...entry }) => entry)));
}

// A page candidate is used later, sometimes after several other candidates have
// been made. Its token must describe the exact take and the page it was made for.
export async function bindPageVoiceCandidate(audioPath, generated, timeline, { fs = nativeFs } = {}) {
  const recordPath = generated.manifestPath || generated.metadataPath;
  if (!recordPath) throw new Error('후보 음성의 생성 기록이 없습니다. 다시 만들어 주세요.');
  const bytes = await fs.readFile(recordPath);
  const record = JSON.parse(bytes.toString('utf8'));
  const targetScriptSha256 = scriptHash(timeline.entries, generated.startPage, generated.endPage);
  const kind = generated.manifestPath ? 'course' : 'spoken-text';
  if (kind === 'course') {
    await assertCurrentCourseManifest(path.dirname(recordPath), record, fs);
    if (scriptHash(record.entries, generated.startPage, generated.endPage) !== targetScriptSha256) {
      throw new Error('현재 강의 대본과 선택한 영상의 페이지 대본이 다릅니다. 같은 판본에서 후보를 만들어 주세요.');
    }
  } else if (typeof record.sourceText !== 'string'
    || record.sourceText.trim() !== String(generated.spokenText || '').trim()) {
    throw new Error('후보 음성이 입력한 읽는 말과 다른 기록입니다. 다시 만들어 주세요.');
  }
  return { ...generated, binding: {
    schemaVersion: 1, kind, audioPath: path.resolve(audioPath),
    audioSha256: await audioHash(audioPath, fs), recordPath: path.resolve(recordPath),
    recordSha256: digest(bytes), runId: record.runId ?? null, targetScriptSha256,
    startPage: generated.startPage, endPage: generated.endPage,
    sourceStartMs: generated.sourceStartMs, sourceEndMs: generated.sourceEndMs,
  } };
}

export async function verifyPageVoiceCandidate(audioRecord, timeline, probe, { fs = nativeFs } = {}) {
  const generated = audioRecord.generatedVoice, binding = generated?.binding;
  if (binding?.schemaVersion !== 1 || !['course', 'spoken-text'].includes(binding.kind)
    || path.resolve(audioRecord.path) !== binding.audioPath) {
    throw new Error('후보 음성의 파일·대본 확인 기록이 없습니다. 후보를 다시 만들어 주세요.');
  }
  for (const field of ['startPage', 'endPage', 'sourceStartMs', 'sourceEndMs']) {
    if (generated[field] !== binding[field]) throw new Error('후보 음성의 페이지·시간 기록이 달라졌습니다. 다시 만들어 주세요.');
  }
  if (await audioHash(audioRecord.path, fs) !== binding.audioSha256) {
    throw new Error('후보 음성이 생성 당시 파일과 달라졌습니다. 다시 만들어 주세요.');
  }
  const bytes = await fs.readFile(binding.recordPath);
  if (digest(bytes) !== binding.recordSha256) throw new Error('후보 음성의 생성 기록이 달라졌습니다. 다시 만들어 주세요.');
  const record = JSON.parse(bytes.toString('utf8'));
  if (binding.kind === 'course') {
    await assertCurrentCourseManifest(path.dirname(binding.recordPath), record, fs);
    if ((record.runId ?? null) !== binding.runId) throw new Error('후보 음성의 제작 판본이 달라졌습니다. 다시 만들어 주세요.');
  }
  if (scriptHash(timeline.entries, generated.startPage, generated.endPage) !== binding.targetScriptSha256) {
    throw new Error('후보를 만든 뒤 영상의 페이지 대본이 달라졌습니다. 후보를 다시 만들어 주세요.');
  }
  const from = Number(generated.sourceStartMs), to = Number(generated.sourceEndMs);
  const durationMs = Number(probe.format?.duration) * 1000;
  if (!probe.streams?.some(stream => stream.codec_type === 'audio')
    || ![from, to, durationMs].every(Number.isFinite) || from < 0 || to <= from || to > durationMs + 1) {
    throw new Error('후보 음성의 실제 길이가 생성 기록의 구간을 담지 못합니다. 다시 만들어 주세요.');
  }
}
