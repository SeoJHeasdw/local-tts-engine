import crypto from "node:crypto";
import nativeFs from "node:fs/promises";
import path from "node:path";
import { captureVideoFileName, videoFrameRate, videoQuality } from "../shared/video-quality.mjs";
import { ACTIVE_JOB_PATH, ADAPTER, ROOT, dateFolder, runtimePaths } from "./paths.mjs";
import { combineChapterReports, pendingUnits, mapWithConcurrency, presetFromManifest, providerForOptions, summarizeChecks, voiceQualityFindings } from "../shared/index.mjs";
import { fileSha256, findVideo, publishVideo, safeStat, writeReport } from "./files.mjs";

export function createProductionService({
  emit,
  ffprobe,
  fs = nativeFs,
  jobSnapshot,
  loadCatalog,
  requireRuntimeTool,
  runProcess,
  state,
}) {
  async function writeActiveJob(record) {
    await fs.mkdir(path.dirname(ACTIVE_JOB_PATH), { recursive: true });
    await fs.writeFile(ACTIVE_JOB_PATH, `${JSON.stringify(record, null, 2)}\n`, "utf8");
  }

  async function clearActiveJob() {
    const record = await readActiveJob();
    if (record?.options?.name && /^[a-z0-9][a-z0-9-]{0,63}$/.test(record.options.name)
      && !['running', 'paused', 'cancelling'].includes(state?.activeJob?.state)) {
      const studio = runtimePaths(record.options.paths);
      await fs.rm(path.join(studio.captionOutputRoot, record.options.name, '.production-input'), { recursive: true, force: true }).catch(() => {});
    }
    await fs.rm(ACTIVE_JOB_PATH, { force: true }).catch(() => {});
  }

  async function readActiveJob() {
    return fs.readFile(ACTIVE_JOB_PATH, "utf8").then(JSON.parse).catch(() => null);
  }

  // 끝난 편의 표식은 그 편이 스스로 남긴 검증 결과다. 별도 장부를 두면 장부와
  // 실제 결과가 어긋날 수 있어, 결과 자체를 근거로 삼는다.
  async function finishedUnitNames(units, studio, expectedFingerprint = null) {
    const checked = await mapWithConcurrency(units, 4, async (unit) => {
      const report = await fs
        .readFile(path.join(studio.captionOutputRoot, unit.name, "validation-report.json"), "utf8")
        .then(JSON.parse)
        .catch(() => null);
      if (!report?.summary?.ok || !report?.videoPath || !(await safeStat(report.videoPath))?.isFile()) return null;
      if ((report.videoQuality?.id ?? 'standard') !== (unit.videoQuality ?? 'standard')) return null;
      if (expectedFingerprint && report.sourceContract?.fingerprint !== expectedFingerprint) return null;
      if (report.capture?.fileSha256 && await fileSha256(report.videoPath) !== report.capture.fileSha256) return null;
      return unit.name;
    });
    return checked.filter(Boolean);
  }

  async function writeDeckContract(manifest, options, providerName, studio) {
    const raw = await fs.readFile(studio.configPath, "utf8");
    const config = JSON.parse(raw);
    const provider = providerForOptions(options, {
      repository: manifest.model,
      revision: manifest.modelRevision,
    });
    config.presets ||= {};
    config.providers ||= {};
    const previous = {
      preset: Object.hasOwn(config.presets, options.name) ? config.presets[options.name] : null,
      provider: Object.hasOwn(config.providers, providerName) ? config.providers[providerName] : null,
      outputRoot: config.outputRoot,
    };
    config.presets[options.name] = presetFromManifest(manifest, options);
    config.providers[providerName] = provider;
    config.outputRoot = path.relative(studio.deckRoot, studio.captionOutputRoot) || ".";

    const temporary = `${studio.configPath}.studio-${process.pid}.tmp`;
    await fs.writeFile(temporary, `${JSON.stringify(config, null, 2)}\n`, "utf8");
    await fs.rename(temporary, studio.configPath);
    emit({ type: "log", stream: "stdout", text: "영상 범위를 실제 음성 길이에 맞췄습니다.\n" });
    return previous;
  }

  async function restoreDeckContract(options, providerName, previous, studio) {
    const config = JSON.parse(await fs.readFile(studio.configPath, "utf8"));
    if (previous.preset === null) delete config.presets[options.name];
    else config.presets[options.name] = previous.preset;
    if (previous.provider === null) delete config.providers[providerName];
    else config.providers[providerName] = previous.provider;
    config.outputRoot = previous.outputRoot;
    const temporary = `${studio.configPath}.studio-${process.pid}.tmp`;
    await fs.writeFile(temporary, `${JSON.stringify(config, null, 2)}\n`, "utf8");
    await fs.rename(temporary, studio.configPath);
  }

  async function validateResult({ sourceDir, renderDir, options, studio }) {
    const manifest = JSON.parse(await fs.readFile(path.join(sourceDir, "manifest.json"), "utf8"));
    const voiceQuality = manifest.quality?.enabled ? manifest.quality.summary : null;
    const voiceFindings = voiceQualityFindings(manifest);
    const audioProbe = await ffprobe(manifest.audioPath);
    const audioDurationMs = Math.round(Number(audioProbe.format?.duration || 0) * 1000);
    const checks = [
      { label: "음성 파일", ok: audioProbe.streams?.some((stream) => stream.codec_type === "audio") },
      { label: "음성 길이", ok: Math.abs(audioDurationMs - Number(manifest.durationMs)) <= 150 },
      { label: "타임라인", ok: Array.isArray(manifest.entries) && manifest.entries.length > 0 },
    ];
    let videoPath = null;
    let capture = null;
    let lessonReview = null;

    if (options.deliverable !== "audio") {
      const timeline = JSON.parse(await fs.readFile(path.join(renderDir, "timeline.json"), "utf8"));
      const captions = JSON.parse(await fs.readFile(path.join(renderDir, "captions.json"), "utf8"));
      checks.push(
        { label: "자막 생성", ok: Array.isArray(captions) && captions.length > 0 },
        { label: "자막 범위", ok: Number(captions.at(-1)?.endMs || 0) <= Number(timeline.totalMs) + 50 },
        { label: "화면 타임라인", ok: Math.abs(Number(timeline.totalMs) - Number(manifest.durationMs)) <= 1 },
      );
    }

    if (options.deliverable === "video") {
      const quality = videoQuality(options.videoQuality ?? "standard");
      videoPath = await findVideo(renderDir, options.name, captureVideoFileName(options.name, options));
      if (!videoPath) throw new Error("촬영은 끝났지만 MP4 파일을 찾지 못했습니다.");
      // Load required metadata before moving a validated result to the published folder.
      lessonReview = await fs.readFile(path.join(renderDir, 'lesson-review.json'), 'utf8').then(JSON.parse);
      const captureFile = (await safeStat(`${videoPath}.capture.json`))
        ? `${videoPath}.capture.json` : path.join(renderDir, 'capture-report.json');
      capture = await fs.readFile(captureFile, 'utf8').then(JSON.parse).catch(error => {
        if (error.code === 'ENOENT') return null;
        throw error;
      });
      const videoProbe = await ffprobe(videoPath);
      const videoDurationMs = Math.round(Number(videoProbe.format?.duration || 0) * 1000);
      const videoStream = videoProbe.streams?.find((stream) => stream.codec_type === "video");
      checks.push(
        { label: "영상 파일", ok: Boolean(videoStream) },
        { label: `영상 크기 · ${quality.width}×${quality.height}`, ok: Number(videoStream?.width) === quality.width && Number(videoStream?.height) === quality.height },
        { label: "영상 코덱", ok: videoStream?.codec_name === "h264" && videoStream?.pix_fmt === "yuv420p" },
        { label: "영상 프레임률", ok: Math.abs(videoFrameRate(videoStream) - quality.fps) < 0.01 },
        { label: "영상 음성", ok: videoProbe.streams?.some((stream) => stream.codec_type === "audio") },
        { label: "영상 길이", ok: Math.abs(videoDurationMs - Number(manifest.durationMs)) <= 200 },
      );
      if (options.videoQuality !== undefined) {
        checks.push(
          { label: '촬영 설정 일치', ok: capture?.profile?.id === quality.id
            && path.basename(capture?.file || '') === path.basename(videoPath) },
          { label: '촬영 파일 무결성', ok: Boolean(capture?.fileSha256) && capture.fileSha256 === await fileSha256(videoPath) },
          { label: '촬영 판본 일치', ok: !manifest.sourceContract
            || capture?.sourceContract?.fingerprint === manifest.sourceContract.fingerprint },
        );
      }
    }

    const summary = summarizeChecks(checks);
    if (summary.ok && videoPath) {
      videoPath = await publishVideo(videoPath, studio, options.name, options.title, renderDir);
    }
    const report = {
      schemaVersion: 1,
      generatedAt: new Date().toISOString(),
      name: options.name,
      displayName: options.title,
      sourceContract: manifest.sourceContract || null,
      lessonReview,
      sourceDir,
      renderDir: options.deliverable === "audio" ? null : renderDir,
      audioPath: manifest.audioPath,
      videoPath,
      durationMs: Number(manifest.durationMs),
      naturalness: manifest.naturalness || null,
      voiceRouting: manifest.voiceRouting || null,
      videoQuality: options.deliverable === "video" ? videoQuality(options.videoQuality ?? "standard") : null,
      capture,
      voiceQuality,
      voiceFindings,
      needsReview: voiceQuality?.needsReview || [],
      listenSuggested: voiceQuality?.listenSuggested || [],
      target: options.deliverable === "audio"
        ? { root: "pilot", day: path.basename(path.dirname(sourceDir)), name: options.name }
        : { root: "render", name: options.name },
      checks,
      summary,
    };
    const reportDir = options.deliverable === "audio" ? sourceDir : renderDir;
    await writeReport(path.join(reportDir, "validation-report.json"), report, 'validate');
    if (!summary.ok) throw new Error(`자동 검증 실패: ${summary.failed.join(", ")}`);
    return report;
  }

  async function runPipelineUnit(options, studio, captureSiteDir) {
    const job = state.activeJob;
    const sourceDir = path.join(studio.ttsOutputRoot, dateFolder(), options.name);
    const renderDir = path.join(studio.captionOutputRoot, options.name);
    const providerName = `${options.name}-provider`;
    const ttsArgs = [
      "-m", "local_tts_engine.course_pilot",
      "--source-project", studio.sourceProjectRoot,
      "--reference", studio.referenceAudioPath,
      "--reference-text", studio.referenceTextPath,
      "--output-dir", sourceDir,
      "--target-seconds", String(options.targetSeconds),
      "--start-page", String(options.startPage),
      "--model", options.modelId || "qwen3-tts",
      "--no-cache",
    ];
    if (options.endPage !== null) ttsArgs.push("--end-page", String(options.endPage));
    if (options.voiceMode === "finetuned") {
      ttsArgs.push("--adapter", options.adapterPath || ADAPTER, "--adapter-scale", String(options.adapterScale));
    }

    await runProcess("voice", requireRuntimeTool("trainPython", "음성 생성 Python"), ttsArgs);
    const manifest = JSON.parse(await fs.readFile(path.join(sourceDir, "manifest.json"), "utf8"));

    let previousContract = null;
    try {
      if (options.deliverable !== "audio") {
        previousContract = await writeDeckContract(manifest, options, providerName, studio);
        await runProcess("export", requireRuntimeTool("basePython", "강의 도구 Python"), [
          "-m", "local_tts_engine.export_udemy",
          "--source-dir", sourceDir,
          "--deck-root", studio.deckRoot,
          "--preset", options.name,
          "--provider", providerName,
        ]);
        await runProcess("captions", requireRuntimeTool("node", "Node.js"), [
          "tools/captions.mjs",
          "--preset", options.name,
          "--provider", providerName,
        ], { cwd: studio.deckRoot });
      }

      if (options.deliverable === "video") {
        const captureArgs = [
          "tools/capture.mjs",
          "--preset", options.name,
          "--provider", providerName,
          "--no-cache",
          "--quality", options.videoQuality ?? "standard",
        ];
        if (captureSiteDir) captureArgs.push("--site-dir", captureSiteDir);
        if (options.burnCaptions) captureArgs.push("--burn-captions");
        try {
          await runProcess("capture", requireRuntimeTool("node", "Node.js"), captureArgs, { cwd: studio.deckRoot });
        } catch (error) {
          if (job.cancelled) throw error;
          emit({
            type: "log",
            stream: "stderr",
            text: "화면 촬영이 중간에 멈춰 같은 음성과 타임라인으로 한 번 다시 시도합니다.\n",
          });
          await runProcess("capture", requireRuntimeTool("node", "Node.js"), captureArgs, { cwd: studio.deckRoot });
        }
      }
    } finally {
      if (previousContract) await restoreDeckContract(options, providerName, previousContract, studio);
    }

    const report = await validateResult({ sourceDir, renderDir, options, studio });
    if (state.activeJob !== job) return;
    if (job.cancelled) throw new Error("사용자가 작업을 중지했습니다.");
    return report;
  }

  function chapterUnitName(base, suffix) {
    const tail = `-${suffix}`;
    const maxBaseLength = Math.max(1, 64 - tail.length);
    return `${base.slice(0, maxBaseLength)}${tail}`;
  }

  function chapterUnits(options, catalog) {
    if (options.mode !== "chapter" || options.chapterMode !== "lesson") return [options];
    const lessons = (catalog.lessons || [])
      .filter((lesson) => lesson.chapter === options.startChapter || lesson.chapter === options.chapter)
      .sort((left, right) => Number(left.startPage) - Number(right.startPage));
    if (!lessons.length) return [options];
    return lessons.map((lesson) => ({
      ...options,
      name: chapterUnitName(options.name, lesson.id),
      title: lesson.title,
      mode: "lesson",
      chapterMode: "single",
      startPage: Number(lesson.startPage),
      endPage: Number(lesson.endPage),
    }));
  }

  async function runPipeline(options) {
    const job = state.activeJob;
    const originalStudio = runtimePaths(options.paths);
    // 한 챕터를 여러 편으로 만들 때도 모든 편이 같은 입력을 사용한다.
    // 작업 트리의 대본·장표와 narration.config를 제작 중 다시 읽거나 고치지 않는다.
    const project = path.join(originalStudio.captionOutputRoot, options.name, ".production-input");
    // Own the directory before starting, including cancellation during the copy.
    // A pre-existing directory belongs to a previous run and must not be removed.
    const resuming = Boolean(options.resumeFrom);
    const snapshotExists = Boolean(await safeStat(project));
    // 이어하는 중이라면 이 폴더는 지난 실행이 얼려 둔 바로 그 입력이다. 다시
    // 만들면 '모든 편이 같은 입력을 쓴다'는 보장이 깨지므로 그대로 쓴다.
    if (snapshotExists && !resuming) throw new Error(`제작 입력 폴더가 이미 있습니다: ${project}`);
    job.productionInputDir = project;
    if (snapshotExists && resuming) {
      emit({ type: "log", stream: "stdout",
        text: "지난 실행이 얼려 둔 제작 입력을 그대로 이어서 사용합니다.\n" });
    } else await runProcess("snapshot", requireRuntimeTool("node", "Node.js"), [
      path.join(ROOT, "electron-app/main/workers/prepare-input.mjs"),
      JSON.stringify({ root: originalStudio.deckRoot, destination: project,
        from: options.startPage, to: options.endPage ?? undefined,
        expectedStartId: options.inputStartId, expectedEndId: options.inputEndId,
        build: options.deliverable === "video", node: requireRuntimeTool("node", "Node.js") }),
    ]);
    const input = { project, deck: path.join(project, "deck"),
      site: options.deliverable === "video" ? path.join(project, "site") : null };
    const inputMetadata = await fs.readFile(path.join(project, 'production-input.json'), 'utf8').then(JSON.parse);
    const fingerprint = inputMetadata.sourceContract?.fingerprint;
    if (resuming && options.inputFingerprint && fingerprint !== options.inputFingerprint) {
      throw new Error('지난 제작과 강의 입력 판본이 달라 이어할 수 없습니다. 새 작업 이름으로 제작해 주세요.');
    }
    if (resuming && !options.inputFingerprint && options.resumeFrom?.length) {
      const previousName = String(options.resumeFrom[0]);
      if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(previousName)) throw new Error('이전 제작 기록의 이름이 올바르지 않습니다.');
      const previous = await fs.readFile(path.join(originalStudio.captionOutputRoot, previousName, 'validation-report.json'), 'utf8').then(JSON.parse).catch(() => null);
      if (!fingerprint || previous?.sourceContract?.fingerprint !== fingerprint) {
        throw new Error('이전 제작의 입력 판본을 확인할 수 없습니다. 기존 결과를 보존하고 새 작업 이름으로 제작해 주세요.');
      }
    }
    options = { ...options, inputFingerprint: fingerprint };
    const studio = { ...originalStudio, sourceProjectRoot: input.project, deckRoot: input.deck,
      configPath: path.join(input.deck, "narration.config.json") };
    emit({ type: "log", stream: "stdout",
      text: "화면·대본·장표 순서를 함께 고정하고 제작 전 검사를 마쳤습니다. 이번 제작은 이 입력을 사용합니다.\n" });
    const catalog = options.mode === "chapter" && options.chapterMode === "lesson"
      ? await loadCatalog(studio, { tracked: true })
      : null;
    const units = chapterUnits(options, catalog);
    const finished = resuming && units.length > 1 ? await finishedUnitNames(units, studio, fingerprint) : [];
    // 챕터 전체 남은 시간은 페이지 수로만 낼 수 있다. 편마다 분량이 크게 달라
    // 편 개수로 세면 남은 편이 가벼운지 무거운지를 놓친다. 여러 편으로 나눌
    // 때에만 보내고, 한 편짜리에는 두 번째 시계가 필요 없다.
    if (units.length > 1) {
      emit({
        type: "plan",
        units: units.map((unit) => ({
          title: unit.title,
          pages: Math.max(1, Number(unit.endPage) - Number(unit.startPage) + 1),
          completed: finished.includes(unit.name),
        })),
      });
    }
    const remaining = pendingUnits(units, finished);
    if (finished.length) {
      emit({ type: "log", stream: "stdout",
        text: `이미 완성된 ${finished.length}편은 건너뜁니다. ${remaining.length}편을 이어서 만듭니다.\n` });
    }
    const reports = [];
    const failedUnits = [];
    const saveProgress = () => writeActiveJob({
      schemaVersion: 1, id: job.id, startedAt: job.startedAt, options,
      unitNames: units.map((unit) => unit.name), completed: [...finished],
      failedUnits: [...failedUnits],
    });
    await saveProgress();
    // Keep this input until every lesson succeeds, so a retry uses the same source.
    job.retainProductionInput = true;
    for (const [index, unit] of units.entries()) {
      if (job.cancelled) throw new Error("사용자가 작업을 중지했습니다.");
      if (finished.includes(unit.name)) {
        reports.push(await fs.readFile(path.join(studio.captionOutputRoot, unit.name, 'validation-report.json'), 'utf8').then(JSON.parse));
        continue;
      }
      // 일시정지는 편 사이에서 확정된다. 앱이 꺼져도 이어할 수 있는 지점이 곧
      // 여기이므로, 멈추는 자리와 이어붙이는 자리를 같게 둔다.
      while (job.pauseRequested && !job.cancelled) {
        if (job.state !== "paused") { job.state = "paused"; emit({ type: "paused" }); }
        await new Promise((resolve) => setTimeout(resolve, 400));
      }
      if (job.cancelled) throw new Error("사용자가 작업을 중지했습니다.");
      if (job.state === "paused") { job.state = "running"; emit({ type: "resumed" }); }
      if (units.length > 1) {
        emit({ type: "unit", index: index + 1, total: units.length, title: unit.title });
        emit({
          type: "log",
          stream: "stdout",
          text: `챕터 레슨 단위 ${index + 1}/${units.length}: ${unit.title}를 제작합니다.\n`,
        });
      }
      try {
        const report = await runPipelineUnit(unit, studio, input.site);
        if (!report) return;
        reports.push(report);
        finished.push(unit.name);
      } catch (error) {
        if (job.cancelled || units.length === 1) throw error;
        if (state.activeJob !== job) return;
        const failure = { name: unit.name, title: unit.title, index: index + 1,
          startPage: unit.startPage, endPage: unit.endPage, stage: job.stage,
          message: error.message || String(error) };
        failedUnits.push(failure);
        emit({ type: 'unit-failed', ...failure, total: units.length, failedCount: failedUnits.length });
        emit({ type: 'log', stream: 'stderr', text: `${unit.title} 제작 실패: ${failure.message}\n나머지 레슨 제작을 계속합니다.\n` });
      }
      await saveProgress();
    }
    if (state.activeJob !== job) return;
    if (job.cancelled) throw new Error("사용자가 작업을 중지했습니다.");
    const report = units.length > 1 ? combineChapterReports(options, reports, failedUnits) : reports[0];
    if (units.length > 1) {
      await writeReport(path.join(originalStudio.captionOutputRoot, options.name, 'chapter-report.json'), report, 'chapter');
    }
    job.retainProductionInput = failedUnits.length > 0;
    await cleanupCaptureSite(job);
    if (job.cancelled) throw new Error("사용자가 작업을 중지했습니다.");
    job.state = failedUnits.length ? (reports.length ? 'partial' : 'failed') : "done";
    job.stage = "done";
    if (!failedUnits.length) await clearActiveJob();
    emit({ type: failedUnits.length ? 'partial-complete' : "complete", report });
  }

  function launchPipeline(options) {
    state.activeJob = {
      id: crypto.randomUUID(),
      kind: "create",
      options,
      state: "running",
      stage: "starting",
      child: null,
      children: new Set(),
      cancelled: false,
      startedAt: new Date().toISOString(),
    };
    const snapshot = jobSnapshot();
    emit({ type: "started", job: snapshot, options });
    const job = state.activeJob;
    runPipeline(options).catch(async (error) => {
      await cleanupCaptureSite(job);
      if (state.activeJob !== job) return;
      job.state = job.cancelled ? "cancelled" : "failed";
      job.error = error.message;
      // 중지는 그만두겠다는 뜻이므로 이어할 기록을 지운다. 실패는 다르다. 원인을
      // 고치고 이어서 만들 수 있어야 두 시간이 날아가지 않는다.
      if (job.cancelled) await clearActiveJob();
      emit({ type: "failed", cancelled: job.cancelled, message: error.message });
    }).finally(() => cleanupCaptureSite(job));
    return snapshot;
  }

  async function cleanupCaptureSite(job) {
    for (const key of ["captureSiteDir", "productionInputDir"]) {
      const directory = job?.[key];
      if (!directory) continue;
      if (key === 'productionInputDir' && job.retainProductionInput && !job.cancelled) continue;
      job[key] = null;
      await fs.rm(directory, { recursive: true, force: true }).catch(() => {});
    }
  }

  return { writeActiveJob, clearActiveJob, readActiveJob, finishedUnitNames, writeDeckContract, restoreDeckContract, validateResult, runPipelineUnit, chapterUnitName, chapterUnits, runPipeline, launchPipeline, cleanupCaptureSite };
}
