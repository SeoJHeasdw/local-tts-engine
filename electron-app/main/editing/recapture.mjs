import fs from 'node:fs/promises';
import path from 'node:path';
import { ROOT, runtimePaths } from '../paths.mjs';
import { fileSha256, renameMediaFile, repointReportFile, writeReport } from '../files.mjs';
import { buildCaptionCues } from '../../shared/captions.mjs';
import { captureVideoFileName, videoQuality } from '../../shared/video-quality.mjs';
import { summarizeChecks, videoTimelineFileName } from '../../shared/index.mjs';
import { captionText } from './review-media.mjs';
import { assertRecaptureScriptContract } from '../capture/deck-source.mjs';
import { alignmentWarnings } from '../../shared/quality.mjs';

// renderer는 경로를 넘기지 않는다. 파일 선택창에서 발급한 token의 이 기록만 사용한다.
export async function readRecaptureTimelineSelection(file) {
  const stat = await fs.stat(file);
  if (!stat.isFile() || stat.size > 32 * 1024 * 1024) throw new Error('교정 타임라인 JSON 파일을 선택해 주세요.');
  const contents = await fs.readFile(file, 'utf8');
  const timeline = JSON.parse(contents);
  const origin = timeline.realignment;
  if (!origin || !path.isAbsolute(origin.sourceTimeline || '') || !path.isAbsolute(origin.sourceAudio || '')
    || !/^[a-f0-9]{64}$/.test(origin.sourceAudioSha256 || '')
    || !/^[a-f0-9]{64}$/.test(origin.originalTimelineSha256 || '')
    || !Number.isFinite(origin.originalTotalMs) || !origin.algorithmVersion) {
    throw new Error('원본 음성·타임라인 확인 기록이 있는 교정 타임라인을 선택해 주세요.');
  }
  return { path: path.resolve(file), sha256: await fileSha256(file) };
}

export function createRecaptureService({
  chosenRecord, emit, inspectMedia, requireRuntimeTool, runProcess, state, validateEditVideo,
}) {
  const worker = name => path.join(ROOT, 'electron-app/main/workers', `${name}.mjs`);

  async function audioHash(file) {
    // 디코딩한 샘플까지 같아야 AAC의 지연·끝 패딩도 그대로 보존한 것이다.
    const output = await runProcess('verify', requireRuntimeTool('ffmpeg', 'FFmpeg'), [
      '-v', 'error', '-i', file, '-map', '0:a:0', '-c:a', 'pcm_s32le',
      '-f', 'hash', '-hash', 'sha256', '-',
    ], { capture: true });
    const hash = String(output).trim().match(/^SHA256=([a-f0-9]{64})$/i)?.[1];
    if (!hash) throw new Error('음성 보존 검사 결과를 읽지 못했습니다.');
    return hash;
  }

  async function runScreenRecapture(options, outputDir) {
    const job = state.activeJob;
    const checkCancelled = () => {
      if (job.cancelled || state.activeJob !== job) throw new Error('사용자가 작업을 중지했습니다.');
    };
    const record = chosenRecord(options.videoToken, 'video');
    if (!record.timelinePath) throw new Error('화면 재촬영에는 페이지 타임라인이 있는 강의 영상이 필요합니다.');
    const originalTimeline = JSON.parse(await fs.readFile(record.timelinePath, 'utf8'));
    const entries = originalTimeline.entries;
    if (!entries?.length || !Number.isFinite(originalTimeline.totalMs) || originalTimeline.totalMs <= 0
      || entries.some(entry => !Number.isInteger(entry.slideNumber) || entry.slideNumber < 1
        || !entry.slideId || !Number.isInteger(entry.step))) {
      throw new Error('강의 화면을 재촬영할 페이지·시간 정보가 없습니다.');
    }
    const original = record.reportPath
      ? JSON.parse(await fs.readFile(record.reportPath, 'utf8')) : null;
    if (original?.operation === 'app-demo') throw new Error('앱 데모는 앱 데모 다듬기에서 다시 구워 주세요.');
    const probe = await inspectMedia(record.path);
    const audio = probe.streams?.find(stream => stream.codec_type === 'audio');
    if (audio?.codec_name !== 'aac') {
      throw new Error('음성을 그대로 보존하려면 AAC 음성 트랙이 있는 강의 영상을 선택해 주세요.');
    }
    if (Math.abs(Number(audio.start_time || 0)) > .001) {
      throw new Error('음성 시작 시각이 0초가 아닌 영상입니다. 음성과 화면의 동기화를 보존할 수 없습니다.');
    }
    if (Math.abs(Number(probe.format?.duration) * 1000 - originalTimeline.totalMs) > 200
      || !Number.isFinite(Number(probe.format?.duration))) {
      throw new Error('선택한 영상과 페이지 타임라인의 길이가 다릅니다. 같은 수정본의 타임라인을 확인해 주세요.');
    }
    const quality = videoQuality(options.videoQuality);
    const studio = runtimePaths(options.paths);
    const node = requireRuntimeTool('node', 'Node.js');
    const project = path.join(outputDir, '.production-input');
    const timelinePath = path.join(outputDir, 'timeline.json');
    const captionsPath = path.join(outputDir, 'captions.json');
    const audioPath = path.join(outputDir, 'audio/track.m4a');
    const reportPath = path.join(outputDir, 'validation-report.json');
    const sourceHash = await fileSha256(record.path);
    const sourceAudioHash = await audioHash(record.path);
    checkCancelled();

    let timingTimeline = originalTimeline;
    let captionDir = path.dirname(record.reportPath || record.timelinePath);
    const corrected = options.correctedTimeline;
    if (corrected) {
      if (await fileSha256(corrected.path) !== corrected.sha256) {
        throw new Error('선택한 교정 타임라인이 바뀌었습니다. 파일을 다시 선택해 주세요.');
      }
      const selection = await readRecaptureTimelineSelection(corrected.path);
      if (selection.sha256 !== corrected.sha256) throw new Error('교정 타임라인이 선택 이후 바뀌었습니다.');
      timingTimeline = JSON.parse(await fs.readFile(corrected.path, 'utf8'));
      const origin = timingTimeline.realignment;
      if (await fileSha256(origin.sourceTimeline) !== origin.originalTimelineSha256) {
        throw new Error('교정에 사용한 원본 타임라인이 바뀌었습니다.');
      }
      const sourceTimeline = JSON.parse(await fs.readFile(origin.sourceTimeline, 'utf8'));
      assertRecaptureScriptContract(timingTimeline.entries, originalTimeline.entries);
      assertRecaptureScriptContract(timingTimeline.entries, sourceTimeline.entries);
      if (timingTimeline.totalMs !== originalTimeline.totalMs || timingTimeline.totalMs !== origin.originalTotalMs
        || sourceTimeline.totalMs !== origin.originalTotalMs
        || JSON.stringify(originalTimeline.entries) !== JSON.stringify(sourceTimeline.entries)) {
        throw new Error('이 교정 타임라인은 선택한 영상의 음성·시간 배치에 대응하지 않습니다.');
      }
      captionDir = path.dirname(corrected.path);
      const sourceDir = path.dirname(origin.sourceTimeline);
      // WAV와 AAC를 함께 원래 제작 폴더에 결합한다. 이름이나 길이가 같은 다른
      // 수정본을 고른 경우에는 선택 영상 AAC의 실제 디코딩 샘플 비교에서 막힌다.
      for (const file of new Set([origin.sourceAudio, path.join(sourceDir, 'audio/track.wav'),
        path.join(captionDir, 'audio/track.wav')])) {
        if (await fileSha256(file) !== origin.sourceAudioSha256) throw new Error('교정 타임라인의 원본 음성 해시가 다릅니다.');
      }
      for (const file of new Set([path.join(sourceDir, 'audio/track.m4a'), path.join(captionDir, 'audio/track.m4a')])) {
        if (await audioHash(file) !== sourceAudioHash) {
          throw new Error('교정한 음성과 선택한 영상의 음성이 다릅니다. 같은 제작본의 영상을 선택해 주세요.');
        }
      }
      checkCancelled();
    }

    // 원래 제작 manifest의 음성은 사용하지 않는다. 선택한 수정본에 실제로 담긴
    // 트랙을 복사해야 페이지 교체·무음 처리까지 모두 보존된다.
    await fs.mkdir(path.dirname(audioPath), { recursive: true });
    await runProcess('export', requireRuntimeTool('ffmpeg', 'FFmpeg'), [
      '-n', '-hide_banner', '-nostats', '-i', record.path, '-map', '0:a:0',
      '-c:a', 'copy', '-movflags', '+faststart', audioPath,
    ]);
    if (await audioHash(audioPath) !== sourceAudioHash) throw new Error('음성을 복사하는 동안 샘플이 달라졌습니다. 재촬영을 중단했습니다.');
    const timeline = { ...timingTimeline, preset: { ...timingTimeline.preset, name: options.name } };
    await fs.writeFile(timelinePath, `${JSON.stringify(timeline, null, 2)}\n`);
    let captions;
    try { captions = JSON.parse(await fs.readFile(path.join(captionDir, 'captions.json'), 'utf8')); }
    catch (error) { if (error.code !== 'ENOENT' || corrected) throw error; captions = buildCaptionCues(timeline); }
    if (!Array.isArray(captions) || !captions.length || captions.some(cue =>
      !Number.isFinite(cue.startMs) || !Number.isFinite(cue.endMs) || cue.startMs < 0
      || cue.endMs <= cue.startMs || cue.endMs > timeline.totalMs + 50 || typeof cue.text !== 'string')) {
      throw new Error('현재 수정본의 자막을 확인해 주세요. 자막 시간 범위가 올바르지 않습니다.');
    }
    await fs.writeFile(captionsPath, `${JSON.stringify(captions, null, 2)}\n`);
    await fs.writeFile(path.join(outputDir, 'captions.srt'), captionText(captions));
    await fs.writeFile(path.join(outputDir, 'captions.vtt'), captionText(captions, true));
    let alignmentQuality = original?.alignmentQuality ?? null;
    if (corrected) {
      try {
        alignmentQuality = JSON.parse(await fs.readFile(path.join(captionDir, 'alignment-quality.json'), 'utf8'));
      } catch (error) {
        alignmentQuality = { status: 'not-checked', blocksAudioGeneration: false,
          error: `교정 정렬 검사 결과를 읽지 못했습니다: ${error.message}` };
      }
      await fs.writeFile(path.join(outputDir, 'alignment-quality.json'), `${JSON.stringify(alignmentQuality, null, 2)}\n`);
    }
    const warnings = alignmentWarnings(alignmentQuality);
    for (const warning of warnings) emit({ type: 'log', stream: 'stderr', text: `${warning}\n` });
    emit({ type: 'log', stream: 'stdout', text: corrected
      ? '현재 영상의 목소리를 보존하고 교정된 자막·화면 전환 시각으로 최신 강의 화면을 준비합니다.\n'
      : '현재 영상의 목소리·자막·페이지 전환 시각을 보존하고 최신 강의 화면을 준비합니다.\n' });

    // 이전 스냅샷을 재사용하지 않는다. 새 화면을 고정한 뒤 대본·페이지·편집점의
    // 호환성을 덱이 판정하고, 통과한 타임라인만 새 화면 판본에 연결한다.
    try {
      await runProcess('snapshot', node, [worker('prepare-input'), JSON.stringify({
        root: studio.deckRoot, destination: project,
        from: entries[0].slideNumber, to: entries.at(-1).slideNumber,
        expectedStartId: entries[0].slideId, expectedEndId: entries.at(-1).slideId,
        build: true, node,
      })]);
      checkCancelled();
      await runProcess('export', node, [worker('recapture-timeline'), JSON.stringify({
        deckRoot: path.join(project, 'deck'), siteDir: path.join(project, 'site'),
        timeline: timelinePath, review: path.join(outputDir, 'lesson-review.json'),
      })]);
      const nextTimeline = JSON.parse(await fs.readFile(timelinePath, 'utf8'));
      const captureArgs = [worker('capture'), '--timeline', timelinePath, '--out-dir', outputDir,
        '--deck-root', path.join(project, 'deck'), '--site-dir', path.join(project, 'site'),
        '--audio-file', audioPath, '--captions', captionsPath, '--quality', quality.id, '--no-cache'];
      if (options.burnCaptions) captureArgs.push('--burn-captions');
      try { await runProcess('capture', node, captureArgs); }
      catch (error) {
        checkCancelled();
        emit({ type: 'log', stream: 'stderr', text: '촬영이 중단되어 같은 음성과 화면으로 한 번 다시 시도합니다.\n' });
        await runProcess('capture', node, captureArgs);
      }
      checkCancelled();
      const output = path.join(outputDir, captureVideoFileName(options.name, options));
      const capture = JSON.parse(await fs.readFile(`${output}.capture.json`, 'utf8'));
      const lessonReview = JSON.parse(await fs.readFile(path.join(outputDir, 'lesson-review.json'), 'utf8'));
      // 이 검사들을 먼저 마친다. 검증 도중 중지된 결과를 성공 보고서로 남기지 않는다.
      const outputAudioHash = await audioHash(output);
      const unchangedSource = await fileSha256(record.path) === sourceHash;
      const outputHash = await fileSha256(output);
      checkCancelled();
      const report = await validateEditVideo(output, 'screen-recapture', [record.path], outputDir,
        { ...quality, durationMs: timeline.totalMs });
      Object.assign(report, {
        displayName: `${path.parse(record.name).name.replace(/ · 화면 재촬영$/, '')} · 화면 재촬영`,
        timelinePath, audioPath, renderDir: outputDir, videoQuality: quality, capture, lessonReview,
        sourceContract: nextTimeline.sourceContract,
        voiceSourceContract: nextTimeline.voiceSourceContract,
        alignmentQuality, warnings,
        voiceFindings: original?.voiceFindings || [],
        voiceQuality: original?.voiceQuality ?? null,
        voiceFinalTrack: original?.voiceFinalTrack ?? null,
        voiceReview: original?.review?.status === 'approved' ? original.review : original?.voiceReview ?? original?.review ?? null,
        needsReview: original?.needsReview || [], listenSuggested: original?.listenSuggested || [],
        naturalness: original?.naturalness ?? null, voiceRouting: original?.voiceRouting ?? null,
        review: { status: 'pending', clearedFindings: original?.review?.clearedFindings || [] },
        recapture: { sourceVideo: record.path, sourceVideoSha256: sourceHash,
          sourceTimeline: record.timelinePath, sourceAudioHash, outputAudioHash,
          audioCopied: true, timingPreserved: !corrected, correctedTimeline: corrected?.path ?? null,
          correctedTimelineSha256: corrected?.sha256 ?? null,
          realignment: timingTimeline.realignment ?? null, burnCaptions: Boolean(options.burnCaptions) },
      });
      report.checks.push(
        { label: '기존 음성 샘플 보존', ok: sourceAudioHash === outputAudioHash },
        { label: '원본 영상 보존', ok: unchangedSource },
        { label: '촬영 파일 무결성', ok: capture.fileSha256 === outputHash },
        { label: '촬영 설정·판본 일치', ok: capture.profile?.id === quality.id
          && capture.sourceContract?.fingerprint === nextTimeline.sourceContract?.fingerprint },
      );
      report.summary = summarizeChecks(report.checks);
      await writeReport(reportPath, report, 'recapture');
      if (!report.summary.ok) throw new Error(`재촬영 검증 실패: ${report.summary.failed.join(', ')}`);
      await fs.copyFile(timelinePath, path.join(outputDir, videoTimelineFileName(output)));
      // 결과 목록·Finder에서 무슨 영상인지 보이게 `recapture-<시각>-high.mp4`를 강의 제목으로
      // 바꾼다. 같은 이름의 짝 파일(.capture.json·.timeline.json)도 함께 옮기고 기록을 따라 고친다.
      const titled = await renameMediaFile(output, report.displayName).catch(() => output);
      // 자막 파일이 정본이다. 올릴 때 짝을 찾기 쉽게 영상과 같은 이름의 SRT·VTT를 둔다.
      const stem = path.join(outputDir, path.basename(titled, path.extname(titled)));
      await fs.copyFile(path.join(outputDir, 'captions.srt'), `${stem}.srt`).catch(() => {});
      await fs.copyFile(path.join(outputDir, 'captions.vtt'), `${stem}.vtt`).catch(() => {});
      if (titled === output) return report;
      return await repointReportFile(reportPath, output, titled) ?? report;
    } catch (error) {
      // 실패한 MP4가 최근 결과에서 성공으로 보이지 않게 별도 상태를 남긴다.
      const failed = await fs.readFile(reportPath, 'utf8').then(JSON.parse).catch(() => ({}));
      await writeReport(reportPath, { ...failed, name: options.name, operation: 'screen-recapture',
        generatedAt: new Date().toISOString(), inputs: [record.path],
        summary: { ok: false, passed: 0, total: 1, failed: [error.message] },
        review: { status: 'pending' }, error: error.message,
      }, 'failed');
      throw error;
    } finally {
      await fs.rm(project, { recursive: true, force: true }).catch(error => {
        emit({ type: 'log', stream: 'stderr', text: `촬영 입력 정리를 마치지 못했습니다: ${error.message}\n` });
      });
    }
  }

  return { runScreenRecapture };
}
