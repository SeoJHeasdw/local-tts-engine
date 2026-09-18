import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createProductionService } from '../../../electron-app/main/production.mjs';
import { ACTIVE_JOB_PATH, dateFolder, runtimePaths } from '../../../electron-app/main/paths.mjs';
import { normalizeOptions } from '../../../electron-app/shared/options.mjs';
import { captureVideoFileName, videoQuality } from '../../../electron-app/shared/video-quality.mjs';
import { fileSha256 } from '../../../electron-app/main/files.mjs';

// Real orchestration, contracts, validation, publication and recovery; only the
// model/capture processes and probes are replaced. Outputs are isolated.
export async function productionFixture(t, { mode = 'chapter', chapterMode = 'lesson', quality = 'high' } = {}) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'tts-production-run-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const options = { ...normalizeOptions({ name: 'test', title: 'CH03', mode, chapterMode,
    chapter: 'ch03', startPage: 312, endPage: 414, videoQuality: quality }), paths: { outputRoot: dir } };
  const studio = runtimePaths(options.paths);
  assert.ok(studio.captionOutputRoot.startsWith(`${dir}/`));
  const project = path.join(studio.captionOutputRoot, options.name, '.production-input');
  const recordPath = path.join(dir, 'state', 'active-job.json');
  const redirected = file => file === ACTIVE_JOB_PATH ? recordPath
    : file === path.dirname(ACTIVE_JOB_PATH) ? path.dirname(recordPath) : file;
  const isolatedFs = { ...fs,
    readFile: (file, ...args) => fs.readFile(redirected(file), ...args),
    writeFile: (file, ...args) => fs.writeFile(redirected(file), ...args),
    mkdir: (file, ...args) => fs.mkdir(redirected(file), ...args),
    rm: (file, ...args) => fs.rm(redirected(file), ...args),
  };
  const events = [], calls = [], failures = new Map();
  const state = { activeJob: { id: 'test-job', state: 'running', startedAt: new Date().toISOString(), cancelled: false } };
  const json = async (file, value) => { await fs.mkdir(path.dirname(file), { recursive: true }); await fs.writeFile(file, JSON.stringify(value)); };
  const profile = videoQuality(quality);
  const audio = { codec_type: 'audio', codec_name: 'aac' };
  const service = createProductionService({ state, fs: isolatedFs, emit: event => events.push(event),
    requireRuntimeTool: key => key,
    loadCatalog: async () => ({ lessons: [312, 335, 389].map((page, index) => ({
      id: `ch03-l0${index + 1}`, chapter: 'ch03', title: `CH03 L0${index + 1}`, startPage: page, endPage: page,
    })) }),
    ffprobe: async file => ({ format: { duration: '1' }, streams: file.endsWith('.wav') ? [audio]
      : [{ codec_type: 'video', codec_name: 'h264', pix_fmt: 'yuv420p', width: profile.width, height: profile.height, avg_frame_rate: '25/1' }, audio] }),
    runProcess: async (stage, executable, args) => {
      state.activeJob.stage = stage;
      calls.push({ stage, executable, args });
      const value = flag => args[args.indexOf(flag) + 1];
      if (stage === 'snapshot') {
        assert.ok(args[0].endsWith('prepare-input.mjs'));
        const input = JSON.parse(args[1]);
        assert.equal(input.destination, project);
        assert.deepEqual([input.from, input.to], [312, 414]);
        if (failures.has('snapshot')) throw new Error('선택한 페이지 범위에 대본이 없습니다.');
        await json(path.join(project, 'production-input.json'), { sourceContract: { fingerprint: 'fixed-input' } });
        await json(path.join(project, 'deck/narration.config.json'), { presets: {}, providers: {}, outputRoot: 'original' });
        return;
      }
      // 내보내기·자막·촬영은 결과 폴더를 직접 받는다. 편 이름은 그 폴더 이름이다.
      const name = path.basename(value(stage === 'voice' ? '--output-dir' : '--out-dir'));
      if (failures.get(name) === 'cancel') {
        state.activeJob.cancelled = true;
        throw new Error('사용자가 작업을 중지했습니다.');
      }
      if (failures.get(name) === stage) throw new Error(`${name}: ${stage} 테스트 실패`);
      const sourceDir = path.join(studio.ttsOutputRoot, dateFolder(), name);
      const renderDir = path.join(studio.captionOutputRoot, name);
      if (stage === 'voice') {
        assert.ok(args.includes('--no-cache'));
        const page = Number(value('--start-page'));
        await json(path.join(sourceDir, 'manifest.json'), {
          audioPath: path.join(sourceDir, 'audio.wav'), durationMs: 1000, sourceContract: { fingerprint: 'fixed-input' },
          entries: [{ key: 'entry', chunkKey: 'chunk', chapter: 'ch03', slide_id: 'slide', slide_number: page, step: 0,
            source_text: 'UnknownWidget를 확인합니다.', tts_text: 'UnknownWidget를 확인합니다.',
            unresolved_tokens: ['UnknownWidget'], naturalness_warnings: [] }],
          chunks: [{ key: 'chunk', startMs: 0, endMs: 1000 }],
          quality: { enabled: true, summary: { clean: true }, chunks: [] },
        });
      } else if (stage === 'export') {
        // 타임라인은 내보내기가 만들고, 자막·촬영이 그것을 지목해 읽는다.
        assert.equal(JSON.parse(value('--preset-json')).name, name);
        await json(path.join(renderDir, 'timeline.json'), { totalMs: 1000, entries: [] });
      } else if (stage === 'captions') {
        assert.equal(value('--timeline'), path.join(renderDir, 'timeline.json'));
        await json(path.join(renderDir, 'captions.json'), [{ text: '원문', startMs: 0, endMs: 1000 }]);
      } else if (stage === 'capture') {
        assert.ok(args.includes('--no-cache'));
        assert.equal(value('--timeline'), path.join(renderDir, 'timeline.json'));
        const file = path.join(renderDir, captureVideoFileName(name, options));
        await fs.writeFile(file, `video-${name}`);
        await json(path.join(renderDir, 'lesson-review.json'), {});
        await json(`${file}.capture.json`, { profile, file, fileSha256: await fileSha256(file), sourceContract: { fingerprint: 'fixed-input' } });
      }
    },
  });
  return { service, state, options, events, calls, failures, studio, project, recordPath,
    record: () => fs.readFile(recordPath, 'utf8').then(JSON.parse) };
}
