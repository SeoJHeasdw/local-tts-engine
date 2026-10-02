import nativeFs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { FINETUNE_DATASET_ROOT } from './paths.mjs';

export const TRAINING_IMPORT_EXTENSIONS = Object.freeze([
  'wav', 'm4a', 'mp3', 'flac', 'aac', 'aif', 'aiff', 'ogg', 'opus', 'mp4',
]);

export function createTrainingImportService({ datasetRoot = FINETUNE_DATASET_ROOT,
  runProcess, requireRuntimeTool, fs = nativeFs }) {
  async function sha256File(file) {
    const handle = await fs.open(file, 'r');
    const hash = crypto.createHash('sha256');
    const buffer = Buffer.allocUnsafe(1024 * 1024);
    try {
      for (;;) {
        const { bytesRead } = await handle.read(buffer, 0, buffer.length, null);
        if (!bytesRead) break;
        hash.update(buffer.subarray(0, bytesRead));
      }
    } finally { await handle.close(); }
    return hash.digest('hex');
  }

  async function inspectSources(files) {
    if (!Array.isArray(files) || files.length === 0) throw new Error('같은 사람의 녹음 파일을 하나 이상 골라 주세요.');
    const sources = [];
    const seen = new Set();
    for (const file of files) {
      if (typeof file !== 'string' || !path.isAbsolute(file) || file.includes('\0')
          || !TRAINING_IMPORT_EXTENSIONS.includes(path.extname(file).slice(1).toLowerCase())) {
        throw new Error('지원하는 녹음 파일을 골라 주세요. WAV·M4A·MP3·FLAC 등을 사용할 수 있습니다.');
      }
      const original = await fs.realpath(file).catch(() => null);
      const stat = original ? await fs.stat(original).catch(() => null) : null;
      if (!stat?.isFile() || stat.size === 0) throw new Error(`녹음 파일이 없거나 비어 있습니다: ${path.basename(file)}`);
      if (seen.has(original)) throw new Error('같은 녹음 파일을 두 번 불러올 수 없습니다.');
      seen.add(original);
      sources.push({ path: original, sha256: await sha256File(original), sizeBytes: stat.size });
    }
    return sources;
  }

  async function importDataset({ displayName, files } = {}) {
    if (typeof displayName !== 'string' || !displayName.trim() || displayName.includes('\0') || displayName.trim().length > 80) {
      throw new Error('목소리 이름은 1~80자로 입력해 주세요.');
    }
    const name = displayName.trim();
    const originals = await inspectSources(files);
    const ffmpeg = requireRuntimeTool('ffmpeg', '녹음 변환 도구');
    const python = requireRuntimeTool('trainPython', '녹음 분할 Python');
    const id = `voice-${Date.now().toString(36)}-${crypto.randomUUID().slice(0, 8)}`;
    const directory = path.join(path.resolve(datasetRoot), id);
    await fs.mkdir(path.resolve(datasetRoot), { recursive: true });
    // This exclusive directory is the only path removed on an import failure.
    // Neither the original recordings nor another dataset are overwritten.
    await fs.mkdir(directory);
    try {
      const sourceDirectory = path.join(directory, 'source');
      await fs.mkdir(sourceDirectory);
      for (const [index, original] of originals.entries()) {
        const derivedPath = path.join(sourceDirectory, `source-${String(index + 1).padStart(4, '0')}.wav`);
        await runProcess('training', ffmpeg, ['-nostdin', '-hide_banner', '-loglevel', 'error', '-n',
          '-i', original.path, '-map', '0:a:0', '-vn', '-ac', '1', '-ar', '48000', '-c:a', 'pcm_s24le', derivedPath]);
        const derived = await fs.stat(derivedPath);
        if (!derived.isFile() || derived.size === 0) throw new Error(`녹음 복사본을 만들지 못했습니다: ${path.basename(original.path)}`);
        original.derivedAudio = derivedPath;
        original.derivedAudioSha256 = await sha256File(derivedPath);
      }
      await runProcess('training', python, ['-m', 'local_tts_engine.finetune_dataset', 'segment',
        '--source-dir', sourceDirectory, '--reference', originals[0].derivedAudio,
        '--output-dir', directory, '--display-name', name]);
      for (const original of originals) {
        if (await sha256File(original.path) !== original.sha256) {
          throw new Error('불러오는 동안 원본 녹음이 바뀌었습니다. 녹음을 저장한 뒤 다시 불러와 주세요.');
        }
      }
      const manifestPath = path.join(directory, 'manifest.json');
      const manifest = JSON.parse(await fs.readFile(manifestPath, 'utf8'));
      if (!Number.isInteger(manifest.stats?.clips) || manifest.stats.clips <= 0) {
        throw new Error('불러온 녹음에서 학습용 클립을 만들지 못했습니다.');
      }
      // Python owns the derivative sources/clip contract. Original-source
      // provenance is additional evidence and never changes those bindings.
      manifest.originalSources = originals;
      manifest.importPolicy = 'read-only originals; 48 kHz mono PCM24 derivative copies; no transcription or training';
      await fs.writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
      return { id, displayName: name, directory, sourceCount: originals.length,
        clips: manifest.stats.clips, transcribed: manifest.stats.transcribed || 0 };
    } catch (error) {
      await fs.rm(directory, { recursive: true, force: true });
      throw error;
    }
  }

  return { importDataset };
}
