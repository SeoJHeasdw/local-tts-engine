import crypto from "node:crypto";
import nativeFs from "node:fs/promises";
import path from "node:path";
import { ADAPTER, RENDERER_DIR, dateFolder, runtimePaths } from "./paths.mjs";
import { audioEnvelope, makeRegionPreview, newPreviewDirectory } from "./editing/review-media.mjs";
import { cancelJobProcesses, jobIsActive, pauseJobProcesses, resumeJobProcesses, withJobStartReservation } from "./job-process.mjs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { isInside, normalizeEditName, normalizeOptions, normalizeVoiceText, pendingUnits } from "../shared/index.mjs";
import { renameMediaFile, repointReportFile, safeStat } from "./files.mjs";
import { inspectVoiceReadiness } from "./voice-readiness.mjs";
import { captionStyleId } from '../shared/caption-styles.mjs';
import { videoQuality } from '../shared/video-quality.mjs';
import { readRecaptureTimelineSelection } from './editing/recapture.mjs';
import { TRAINING_IMPORT_EXTENSIONS } from './training-import.mjs';

// ffmpeg 가 읽는 흔한 컨테이너는 모두 받는다. 코덱·색 형식이 편집에 맞지 않으면
// 렌더 직전의 검사가 그 이유를 따로 말해 주므로, 담는 문턱에서 미리 막지 않는다.
const DROPPABLE = {
  video: {
    label: "영상",
    extensions: new Set([".mp4", ".mov", ".m4v", ".mkv", ".webm", ".avi", ".wmv",
      ".flv", ".mpg", ".mpeg", ".ts", ".m2ts", ".mts", ".ogv", ".3gp"]),
  },
  audio: {
    label: "음성",
    extensions: new Set([".wav", ".m4a", ".mp3", ".flac", ".aac", ".ogg", ".opus", ".aiff", ".aif"]),
  },
};

export function createIpcService({
  applyVoiceSettings,
  assertRuntime,
  chosenRecord,
  clearActiveJob,
  deleteOutput,
  dialog,
  emit,
  findVideoTimeline,
  finishRecording,
  finishedUnitNames,
  fs = nativeFs,
  ipcMain,
  jobSnapshot,
  launchPipeline,
  listOutputs,
  listTextVoiceCandidates,
  listRecordingSources,
  listDemoScenarios,
  loadCatalog,
  pickDemoProject,
  pickDemoScenario,
  readActiveJob,
  readAppSettings,
  readDemoProject,
  readDemoCameraPreview,
  readDemoScenario,
  registerSelected,
  renameOutput,
  requireRuntimeTool,
  resolveOutputFile,
  runFineTune,
  listTrainingDatasets,
  readTrainingDataset,
  importTrainingDataset,
  runVoicePreview,
  runTextVoiceCandidates,
  runVideoEdit,
  saveAppSettings,
  saveDemoScript,
  selectTextVoice,
  selectTextVoiceFromHistory,
  setClearedFindings,
  setClearedReviewWarnings,
  setOutputReview,
  shell,
  startDemoRecord,
  startDemoRender,
  startDemoVoice,
  startRecording,
  state,
  writeActiveJob,
}) {
  const reviewPreviewDirectories = [];
  const recaptureTimelines = new Map();

  let reviewPreviewBusy = false;

  let reviewWaveTask=Promise.resolve(), reviewWaveTicket=0;

  function senderIsLocal(event) {
    try {
      const source = fileURLToPath(event.senderFrame.url);
      return isInside(RENDERER_DIR, source);
    } catch {
      return false;
    }
  }

  function guard(event) {
    if (!senderIsLocal(event)) throw new Error("허용되지 않은 화면 요청입니다.");
  }

  function startHandler(handler) {
    return async (event, ...args) => {
      guard(event);
      return withJobStartReservation(state, () => handler(event, ...args));
    };
  }

  function launchSettingsJob(options, run) {
    if (jobIsActive(state.activeJob)) {
      throw new Error('다른 작업이 진행 중입니다. 끝난 뒤 다시 시도해 주세요.');
    }
    state.activeJob = { id: crypto.randomUUID(), kind: 'training', options, state: 'running',
      stage: 'training', child: null, children: new Set(), cancelled: false, startedAt: new Date().toISOString() };
    const job = state.activeJob;
    emit({ type: 'training-started', options });
    run().catch(error => {
      if (state.activeJob !== job) return;
      job.state = job.cancelled ? 'cancelled' : 'failed';
      emit({ type: 'training-failed', mode: options.mode, cancelled: job.cancelled, message: error.message });
    });
    return jobSnapshot();
  }

  function registerIpc() {
    ipcMain.handle('studio:review-waveform',async(event,options={})=>{
      guard(event);
      const video=chosenRecord(options.videoToken,'video');
      const start=Number(options.start),end=Number(options.end);
      if(end>video.durationMs/1000+.001)throw new Error('파형 범위가 영상 밖입니다.');
      const ticket=++reviewWaveTicket;
      const task=reviewWaveTask.then(()=>{
        if(ticket!==reviewWaveTicket)throw new Error('파형 선택이 변경되었습니다.');
        return audioEnvelope(requireRuntimeTool('ffmpeg','FFmpeg'),video.path,start,end);
      });
      reviewWaveTask=task.catch(()=>{});
      return task;
    });
    ipcMain.handle('studio:review-preview',async(event,options={})=>{
      guard(event);
      if(reviewPreviewBusy)throw new Error('미리듣기를 준비하고 있습니다.');
      const video=chosenRecord(options.videoToken,'video');
      if(!['original','mute','replace'].includes(options.mode))throw new Error('미리듣기 종류를 확인하세요.');
      const audio=options.mode==='replace'?chosenRecord(options.audioToken,'audio'):null;
      const context=Number(options.context??.6);
      if(!Number.isFinite(context)||context<0||context>2)throw new Error('앞뒤 듣기 범위가 올바르지 않습니다.');
      reviewPreviewBusy=true;
      let directory;
      try{
        directory=await newPreviewDirectory();
        const preview=await makeRegionPreview(requireRuntimeTool('ffmpeg','FFmpeg'),video.path,audio?.path,
          {start:Number(options.start),end:Number(options.end),duration:video.durationMs/1000,
            audioDuration:audio?.durationMs/1000,mode:options.mode,fit:options.durationPolicy==='match-audio'?'match-audio':'keep-video',context},directory);
        reviewPreviewDirectories.push(directory);
        if(reviewPreviewDirectories.length>8)await fs.rm(reviewPreviewDirectories.shift(),{recursive:true,force:true});
        return {audioUrl:pathToFileURL(preview.file).href};
      }catch(error){if(directory)await fs.rm(directory,{recursive:true,force:true});throw error;}
      finally{reviewPreviewBusy=false;}
    });
    ipcMain.handle("studio:get-status", async (event) => {
      guard(event);
      const settings = await readAppSettings();
      const studio = runtimePaths(settings.paths);
      const readiness = await inspectVoiceReadiness(settings, studio, { fs });
      const ready = (item) => item?.state === "ready";
      const runtime = {
        basePython: Boolean(state.runtimeTools.basePython),
        trainPython: Boolean(state.runtimeTools.trainPython),
        node: Boolean(state.runtimeTools.node),
        ffmpeg: Boolean(state.runtimeTools.ffmpeg),
        ffprobe: Boolean(state.runtimeTools.ffprobe),
        voice: ready(readiness.referenceAudio),
        referenceText: ready(readiness.referenceText),
        voiceLibrary: Boolean(await safeStat(studio.voiceLibraryRoot)),
        adapter: settings.adapterId === "none" || ready(readiness.adapter),
        model: ready(readiness.models[settings.modelId]),
        qualityModel: ready(readiness.quality),
        aligner: ready(readiness.aligner),
        deck: Boolean(await safeStat(studio.configPath))
          && Boolean(await safeStat(path.join(studio.deckRoot, "script/course"))),
      };
      const capabilities = {
        textVoice: runtime.trainPython && runtime.ffprobe && runtime.voice && runtime.referenceText
          && runtime.adapter && runtime.model && runtime.qualityModel,
        editing: runtime.ffmpeg && runtime.ffprobe,
        course: runtime.trainPython && runtime.basePython && runtime.node && runtime.ffmpeg
          && runtime.ffprobe && runtime.voice && runtime.referenceText && runtime.adapter
          && runtime.model && runtime.qualityModel && runtime.aligner && runtime.deck,
      };
      const setupIssues = [];
      let catalog = { pages: [], lessons: [], totalPages: 0 };
      if (runtime.basePython && runtime.deck) {
        try {
          catalog = await loadCatalog(studio);
        } catch (error) {
          setupIssues.push(`강의 목록: ${error.message}`);
        }
      } else {
        setupIssues.push("강의 소스가 없어 강의 영상 제작 기능은 아직 준비되지 않았습니다.");
      }
      return {
        activeJob: jobSnapshot(),
        runtime,
        readiness,
        capabilities,
        setupIssues,
        catalog,
        defaults: { adapterScale: 0.6, mode: "lesson", targetSeconds: 0 },
      };
    });

    ipcMain.handle("studio:get-settings", async (event) => {
      guard(event);
      return readAppSettings();
    });

    ipcMain.handle("studio:save-settings", async (event, settings) => {
      guard(event);
      return saveAppSettings(settings);
    });

    ipcMain.handle("studio:list-outputs", async (event) => {
      guard(event);
      const settings = await readAppSettings();
      return listOutputs(runtimePaths(settings.paths));
    });

    ipcMain.handle("studio:set-cleared-findings", async (event, target, keys) => {
      guard(event);
      const settings = await readAppSettings();
      return setClearedFindings(target, Array.isArray(keys) ? keys : [], runtimePaths(settings.paths));
    });

    ipcMain.handle("studio:set-cleared-review-warnings", async (event, target, keys) => {
      guard(event);
      const settings = await readAppSettings();
      return setClearedReviewWarnings(target, Array.isArray(keys) ? keys : [], runtimePaths(settings.paths));
    });

    ipcMain.handle("studio:set-output-review", async (event, target, status) => {
      guard(event);
      const settings = await readAppSettings();
      return setOutputReview(target, status, runtimePaths(settings.paths));
    });

    ipcMain.handle("studio:rename-output", async (event, target, name) => {
      guard(event);
      const settings = await readAppSettings();
      return renameOutput(target, name, runtimePaths(settings.paths));
    });

    ipcMain.handle("studio:delete-output", async (event, target) => {
      guard(event);
      const settings = await readAppSettings();
      return deleteOutput(target, runtimePaths(settings.paths));
    });

    // 다듬기에서 여는 영상은 결과 목록을 거치지 않고 고른 파일일 수도 있다.
    // 이름은 그 파일에 붙은 것이므로, 결과인지 아닌지와 무관하게 바꿀 수 있다.
    ipcMain.handle("studio:rename-video", async (event, token, name) => {
      guard(event);
      const record = chosenRecord(token, "video");
      const previous = record.path;
      const renamed = await renameMediaFile(previous, name);
      // 완성 강의 영상은 작업 폴더의 기록이 가리킨다. 영상 옆에 기록이 없을 수도
      // 있으므로, 이 영상을 자기 것이라고 말한 기록까지 함께 맞춘다.
      for (const reportPath of new Set([path.join(path.dirname(renamed), "validation-report.json"), record.reportPath].filter(Boolean))) {
        await repointReportFile(reportPath, previous, renamed);
      }
      record.path = renamed;
      record.name = path.basename(renamed);
      if (record.timelinePath) record.timelinePath = await findVideoTimeline(renamed);
      return { name: record.name, videoUrl: pathToFileURL(renamed).href };
    });

    ipcMain.handle("studio:pick-location", async (event, key) => {
      guard(event);
      const directoryKeys = new Set([
        "sourceProjectRoot",
        "voiceLibraryRoot",
        "outputRoot",
      ]);
      const fileOptions = {
        referenceAudioPath: { title: "참조 음성 선택", extensions: ["wav", "m4a", "flac"] },
        referenceTextPath: { title: "참조 전사문 선택", extensions: ["txt", "md"] },
      };
      const directoryTitles = {
        sourceProjectRoot: "강의 소스 선택",
        voiceLibraryRoot: "내 목소리 원본 선택",
        outputRoot: "결과물 폴더 선택",
      };
      if (!directoryKeys.has(key) && !fileOptions[key]) throw new Error("지원하지 않는 경로 설정입니다.");
      const result = await dialog.showOpenDialog(state.mainWindow, directoryKeys.has(key)
        ? { title: directoryTitles[key] || "폴더 선택", properties: ["openDirectory", "createDirectory"] }
        : {
            title: fileOptions[key].title,
            properties: ["openFile"],
            filters: [{ name: "지원 파일", extensions: fileOptions[key].extensions }],
          });
      return result.canceled ? null : result.filePaths[0];
    });

    ipcMain.handle("studio:pick-videos", async (event, multiple = false) => {
      guard(event);
      const result = await dialog.showOpenDialog(state.mainWindow, {
        title: multiple ? "편집할 영상 선택" : "원본 영상 선택",
        properties: multiple ? ["openFile", "multiSelections"] : ["openFile"],
        filters: [{ name: "영상", extensions: [...DROPPABLE.video.extensions].map((extension) => extension.slice(1)) }],
      });
      return result.canceled ? [] : registerSelected(result.filePaths, "video");
    });

    // 놓은 것을 되돌려보낼 때 '지원하는 영상 파일을 놓아 주세요'만 말하면, 무엇이
    // 걸렸는지 알 길이 없다. 폴더인지, 확장자가 다른지, 경로 자체를 못 읽었는지는
    // 서로 다른 문제이고 사용자가 할 일도 다르다. 무엇이 걸렸는지 이름으로 말한다.
    ipcMain.handle("studio:register-dropped-files", async (event, paths = [], kind) => {
      guard(event);
      const spec = DROPPABLE[kind];
      if (!spec) throw new Error("지원하지 않는 파일 종류입니다.");
      const accepted = [];
      const rejected = [];
      for (const candidate of paths.slice(0, 100)) {
        const resolved = path.resolve(String(candidate));
        const name = path.basename(resolved);
        const stat = await safeStat(resolved);
        if (stat?.isDirectory()) { rejected.push(`${name}(폴더)`); continue; }
        if (!stat?.isFile()) { rejected.push(`${name}(파일 아님)`); continue; }
        if (!spec.extensions.has(path.extname(resolved).toLowerCase())) { rejected.push(name); continue; }
        accepted.push(resolved);
      }
      if (accepted.length) return registerSelected(accepted, kind);
      if (!rejected.length) {
        throw new Error(`놓은 것에서 파일 경로를 읽지 못했습니다. Finder에서 ${spec.label} 파일을 끌어다 놓아 주세요.`);
      }
      const shown = rejected.slice(0, 3).join(", ") + (rejected.length > 3 ? ` 외 ${rejected.length - 3}개` : "");
      const kinds = [...spec.extensions].map((extension) => extension.slice(1)).join(" · ");
      throw new Error(`${spec.label} 파일이 아닙니다: ${shown}. 받는 형식은 ${kinds} 입니다.`);
    });

    ipcMain.handle("studio:pick-audio", async (event) => {
      guard(event);
      const result = await dialog.showOpenDialog(state.mainWindow, {
        title: "교체할 음성 선택",
        properties: ["openFile"],
        filters: [{ name: "음성", extensions: [...DROPPABLE.audio.extensions].map((extension) => extension.slice(1)) }],
      });
      return result.canceled ? [] : registerSelected(result.filePaths, "audio");
    });

    ipcMain.handle('studio:pick-recapture-timeline', async (event, videoToken) => {
      guard(event);
      const video = chosenRecord(videoToken, 'video');
      if (!video.timelinePath) throw new Error('페이지 타임라인이 있는 강의 영상을 먼저 선택하세요.');
      const result = await dialog.showOpenDialog(state.mainWindow, {
        title: '교정된 자막·화면 전환 타임라인 선택', properties: ['openFile'],
        filters: [{ name: '교정 타임라인', extensions: ['json'] }],
      });
      if (result.canceled) return null;
      const selection = await readRecaptureTimelineSelection(result.filePaths[0]);
      const token = crypto.randomUUID();
      recaptureTimelines.set(token, { ...selection, videoToken });
      // 오래된 선택은 다시 고르면 된다. renderer에는 파일 경로를 받는 API가 없다.
      if (recaptureTimelines.size > 32) recaptureTimelines.delete(recaptureTimelines.keys().next().value);
      return { token, name: path.basename(path.dirname(selection.path)) + ' / ' + path.basename(selection.path) };
    });

    ipcMain.handle("studio:start-edit", startHandler(async (event, rawOptions = {}) => {
      guard(event);
      if (state.activeJob && ["running", "paused", "cancelling"].includes(state.activeJob.state)) {
        throw new Error("이미 실행 중인 작업이 있습니다.");
      }
      requireRuntimeTool("ffmpeg", "FFmpeg");
      const operation = ["compose", "voice", "voice-pages", "voice-candidates", "mute-region", "replace-region", "screen-recapture"].includes(rawOptions.operation)
        ? rawOptions.operation
        : null;
      if (!operation) throw new Error("편집 종류를 선택해 주세요.");
      const settings = await readAppSettings();
      const studio = runtimePaths(settings.paths);
      let options = {
        ...rawOptions,
        operation,
        name: normalizeEditName(rawOptions.name),
        durationPolicy: rawOptions.durationPolicy === "match-audio" ? "match-audio" : "keep-video",
        audioSource: rawOptions.audioSource === "generate" ? "generate" : "file",
        voiceMode: rawOptions.voiceMode === "zero" ? "zero" : "finetuned",
        adapterScale: Number(rawOptions.adapterScale ?? 0.6),
        startPage: Number(rawOptions.startPage ?? 1),
        endPage: Number(rawOptions.endPage ?? rawOptions.startPage ?? 1),
        // 사람이 적어 준 읽을 말. 비어 있으면 대본을 그대로 다시 읽는다.
        overrideText: typeof rawOptions.overrideText === "string"
          ? rawOptions.overrideText.replace(/\s+/g, " ").trim().slice(0, 2000) : "",
      };
      // 내부 경로 기록은 renderer가 주입할 수 없고, 선택창의 token으로만 해석한다.
      delete options.correctedTimeline;
      options = applyVoiceSettings(options, settings);
      if (operation === 'screen-recapture') {
        if (!chosenRecord(options.videoToken, 'video').timelinePath) {
          throw new Error('화면 재촬영에는 페이지 타임라인이 있는 강의 영상이 필요합니다.');
        }
        requireRuntimeTool('node', 'Node.js');
        requireRuntimeTool('ffprobe', 'FFprobe');
        options.videoQuality = videoQuality(rawOptions.videoQuality).id;
        options.burnCaptions = rawOptions.burnCaptions === true;
        options.captionStyle = captionStyleId(rawOptions.captionStyle);
        if (rawOptions.correctedTimelineToken) {
          const selected = recaptureTimelines.get(String(rawOptions.correctedTimelineToken));
          if (!selected || selected.videoToken !== options.videoToken) {
            throw new Error('이 영상에 사용할 교정 타임라인을 다시 선택해 주세요.');
          }
          options.correctedTimeline = { path: selected.path, sha256: selected.sha256 };
        }
      }
      if (options.overrideText && !(operation === "voice-candidates" && options.audioSource === "generate")) {
        throw new Error("읽을 말을 직접 적는 것은 페이지 재생성에서만 사용할 수 있습니다.");
      }
      if (["voice", "voice-candidates"].includes(operation) && options.audioSource === "generate") {
        const catalog = await loadCatalog(studio);
        const ranges = Array.isArray(options.videoItems) && options.videoItems.length
          ? options.videoItems.map((item) => [Number(item.startPage), Number(item.endPage)])
          : [[options.startPage, options.endPage]];
        if (ranges.some(([start, end]) => !Number.isInteger(start) || !Number.isInteger(end)
            || start < 1 || end < start || end > catalog.totalPages)) {
          throw new Error(`음성 생성 페이지는 1~${catalog.totalPages} 범위로 입력해 주세요.`);
        }
        if (options.voiceMode === "finetuned" && (!(options.adapterScale > 0) || options.adapterScale > 1)) {
          throw new Error("파인튜닝 강도는 0보다 크고 1 이하여야 합니다.");
        }
        await assertRuntime(options, studio);
      }
      state.activeJob = {
        id: crypto.randomUUID(),
        kind: "edit",
        options,
        state: "running",
        stage: "starting",
        child: null,
        children: new Set(),
        cancelled: false,
        startedAt: new Date().toISOString(),
      };
      const job = state.activeJob;
      const snapshot = jobSnapshot();
      emit({ type: "edit-started", job: snapshot, options });
      runVideoEdit(options).catch((error) => {
        if (state.activeJob !== job) return;
        job.state = job.cancelled ? "cancelled" : "failed";
        emit({ type: "edit-failed", cancelled: job.cancelled, message: error.message });
      });
      return snapshot;
    }));

    ipcMain.handle("studio:start-text-voices", startHandler(async (event, rawOptions = {}) => {
      guard(event);
      if (jobIsActive(state.activeJob)) {
        throw new Error("이미 실행 중인 작업이 있습니다.");
      }
      const text = normalizeVoiceText(rawOptions.text);
      if (!text) throw new Error("목소리로 만들 텍스트를 입력해 주세요.");
      if (text.length > 2_000) throw new Error("텍스트는 한 번에 2,000자까지 입력할 수 있습니다.");
      const settings = await readAppSettings();
      const candidateCount = Math.min(8, Math.max(2, Math.round(Number(rawOptions.candidateCount ?? 3))));
      const options = applyVoiceSettings({
        name: normalizeEditName(rawOptions.name),
        text,
        candidateCount,
      }, settings);
      await assertRuntime(options, runtimePaths(settings.paths), { course: false });
      state.activeJob = {
        id: crypto.randomUUID(),
        kind: "text-voice",
        options,
        state: "running",
        stage: "voice",
        children: new Set(),
        cancelled: false,
        startedAt: new Date().toISOString(),
      };
      const job = state.activeJob;
      const snapshot = jobSnapshot();
      emit({ type: "text-voice-started", job: snapshot, options });
      runTextVoiceCandidates(options).catch((error) => {
        if (state.activeJob !== job) return;
        job.state = job.cancelled ? "cancelled" : "failed";
        emit({ type: "text-voice-failed", cancelled: job.cancelled, message: error.message });
      });
      return snapshot;
    }));

    ipcMain.handle("studio:select-text-voice", async (event, token) => {
      guard(event);
      return selectTextVoice(String(token || ""));
    });

    ipcMain.handle("studio:list-text-voice-candidates", async (event, target) => {
      guard(event);
      return listTextVoiceCandidates(target);
    });

    ipcMain.handle("studio:select-text-voice-from-history", async (event, target, candidateIndex) => {
      guard(event);
      return selectTextVoiceFromHistory(target, candidateIndex);
    });

    ipcMain.handle("studio:list-training-datasets", async (event) => {
      guard(event);
      return listTrainingDatasets();
    });
    ipcMain.handle('studio:import-training-dataset', startHandler(async (event, raw = {}) => {
      guard(event);
      const displayName = String(raw.displayName || '').trim();
      if (!displayName || displayName.length > 80) throw new Error('먼저 새 목소리 이름을 1~80자로 입력해 주세요.');
      if (jobIsActive(state.activeJob)) {
        throw new Error('다른 작업이 진행 중입니다. 끝난 뒤 녹음을 불러와 주세요.');
      }
      const result = await dialog.showOpenDialog({ title: '같은 사람의 녹음 불러오기',
        properties: ['openFile', 'multiSelections'], filters: [{ name: '녹음 파일', extensions: [...TRAINING_IMPORT_EXTENSIONS] }] });
      if (result.canceled || !result.filePaths.length) return null;
      return launchSettingsJob({ name: displayName, displayName, mode: 'import' }, async () => {
        const imported = await importTrainingDataset({ displayName, files: result.filePaths });
        const dataset = await readTrainingDataset(imported.id);
        state.activeJob.state = 'done';
        state.activeJob.stage = 'done';
        emit({ type: 'training-prepared', mode: 'import', dataset });
      });
    }));
    ipcMain.handle('studio:start-voice-preview', startHandler(async (event, raw = {}) => {
      guard(event);
      const settings = await readAppSettings();
      const adapter = settings.adapters.find(item => item.id === raw.adapterId);
      const scale = Number(raw.adapterScale);
      if (!adapter || adapter.profileError || !Number.isFinite(scale) || scale < 0.1 || scale > 1) {
        throw new Error('시험 음성을 만들 목소리와 반영 강도를 확인해 주세요.');
      }
      return launchSettingsJob({ name: adapter.displayName, mode: 'preview', adapterId: adapter.id, adapterScale: scale },
        () => runVoicePreview({ adapterId: adapter.id, adapterScale: scale }));
    }));
    ipcMain.handle("studio:read-training-dataset", async (event, id) => {
      guard(event);
      return readTrainingDataset(id);
    });
    ipcMain.handle("studio:start-finetune", startHandler(async (event, rawOptions = {}) => {
      guard(event);
      if (jobIsActive(state.activeJob)) {
        throw new Error("이미 실행 중인 작업이 있습니다.");
      }
      const dataset = await readTrainingDataset(rawOptions.datasetId);
      const settings = await readAppSettings();
      const maxSteps = Math.round(Number(rawOptions.maxSteps ?? 60));
      if (!Number.isFinite(maxSteps) || maxSteps < 10 || maxSteps > 500) throw new Error("학습 스텝은 10~500 사이여야 합니다.");
      const options = {
        name: normalizeEditName(rawOptions.name),
        mode: rawOptions.mode === "prepare" ? "prepare" : "train",
        datasetId: dataset.id,
        displayName: String(rawOptions.displayName || dataset.displayName).trim().slice(0, 80),
        referenceId: rawOptions.referenceId,
        reviews: rawOptions.reviews,
        maxSteps,
        paths: settings.paths,
      };
      state.activeJob = {
        id: crypto.randomUUID(),
        kind: "training",
        options,
        state: "running",
        stage: "training",
        child: null,
        children: new Set(),
        cancelled: false,
        startedAt: new Date().toISOString(),
      };
      const job = state.activeJob;
      emit({ type: "training-started", options });
      runFineTune(options).catch((error) => {
        if (state.activeJob !== job) return;
        job.state = job.cancelled ? "cancelled" : "failed";
        emit({ type: "training-failed", cancelled: job.cancelled, message: error.message });
      });
      return jobSnapshot();
    }));

    ipcMain.handle("studio:start", startHandler(async (event, rawOptions) => {
      guard(event);
      if (jobIsActive(state.activeJob)) {
        throw new Error("이미 실행 중인 작업이 있습니다.");
      }
      const settings = await readAppSettings();
      const options = applyVoiceSettings(normalizeOptions(rawOptions), settings);
      const studio = runtimePaths(settings.paths);
      await assertRuntime(options, studio, {
        node: true,
        productionInput: true,
        ffmpeg: options.deliverable === "video",
      });
      const catalog = await loadCatalog(studio);
      if (options.startPage > catalog.totalPages || (options.endPage && options.endPage > catalog.totalPages)) {
        throw new Error(`페이지는 1~${catalog.totalPages} 사이에서 선택해 주세요.`);
      }
      // UI가 본 카탈로그의 ID를 보존한다. 스냅샷 때 번호가 다른 ID를 가리키면
      // 엉뚱한 레슨을 만드는 대신 목록 새로고침을 요청한다.
      options.inputStartId = catalog.pages.find((p) => p.page === options.startPage)?.slideId;
      options.inputEndId = catalog.pages.find((p) => p.page === options.endPage)?.slideId;
      return launchPipeline(options);
    }));

    ipcMain.handle("studio:resume-job", startHandler(async (event) => {
      guard(event);
      if (jobIsActive(state.activeJob)) {
        throw new Error("이미 실행 중인 작업이 있습니다.");
      }
      const record = await readActiveJob();
      if (!record?.options?.name) throw new Error("이어서 만들 작업이 없습니다.");
      const settings = await readAppSettings();
      const studio = runtimePaths(settings.paths);
      // 지난 실행에서 이미 정규화하고 카탈로그로 확인한 옵션이다. 그때 얼려 둔
      // 입력을 그대로 쓰므로 페이지를 다시 풀지 않는다. 도구만 다시 확인한다.
      let options = { ...record.options, resumeFrom: record.completed || [] };
      if (options.voiceMode === 'finetuned') {
        const adapterPath = path.resolve(options.adapterPath || ADAPTER);
        const adapter = settings.adapters?.find(item => path.resolve(item.path) === adapterPath);
        if (!adapter) throw new Error('이전 제작 목소리의 청취 확인 기록이 없습니다. 설정에서 다시 확인해 주세요.');
        const approved = applyVoiceSettings(options, { ...settings,
          modelId: options.modelId || 'qwen3-tts', adapterId: adapter.id,
          adapterScale: options.adapterScale ?? .6, paths: options.paths || settings.paths });
        options = { ...options, voiceInputIdentity: options.voiceInputIdentity || approved.voiceInputIdentity };
      }
      await assertRuntime(options, studio, {
        node: true,
        productionInput: true,
        ffmpeg: options.deliverable === "video",
      });
      return launchPipeline(options);
    }));

    ipcMain.handle("studio:list-displays", async (event) => {
      guard(event);
      return listRecordingSources();
    });

    ipcMain.handle("studio:start-recording", startHandler(async (event, rawOptions = {}) => {
      guard(event);
      return startRecording(rawOptions);
    }));

    // 앱 데모는 촬영 → 목소리 → 렌더 세 단계다. 화면과 CLI가 같은 작업자·같은 결과
    // 폴더를 쓰므로, 어느 쪽에서 시작했든 다른 쪽에서 이어갈 수 있다.
    ipcMain.handle("studio:list-demo-scenarios", async (event) => {
      guard(event);
      return listDemoScenarios();
    });

    ipcMain.handle("studio:pick-demo-scenario", async (event) => {
      guard(event);
      return pickDemoScenario();
    });

    ipcMain.handle("studio:pick-demo-project", async (event) => {
      guard(event);
      return pickDemoProject();
    });

    ipcMain.handle("studio:read-demo-scenario", async (event, file) => {
      guard(event);
      return readDemoScenario(String(file || ""));
    });

    ipcMain.handle("studio:read-demo-project", async (event, outDir) => {
      guard(event);
      return readDemoProject(String(outDir || ""));
    });

    ipcMain.handle("studio:save-demo-script", async (event, outDir, scenes) => {
      guard(event);
      return saveDemoScript(String(outDir || ""), Array.isArray(scenes) ? scenes : []);
    });

    ipcMain.handle("studio:demo-camera-preview", async (event, options = {}) => {
      guard(event);
      return readDemoCameraPreview({ outDir: String(options.outDir || ""), sceneId: String(options.sceneId || ""), atMs: options.atMs });
    });

    ipcMain.handle("studio:start-demo-record", startHandler(async (event, options = {}) => {
      guard(event);
      return startDemoRecord(options);
    }));

    ipcMain.handle("studio:start-demo-voice", startHandler(async (event, options = {}) => {
      guard(event);
      return startDemoVoice(options);
    }));

    ipcMain.handle("studio:start-demo-render", startHandler(async (event, options = {}) => {
      guard(event);
      return startDemoRender(options);
    }));

    // 녹화의 정지는 결과를 남기는 정상 완료다. 결과를 버리는 중지(studio:cancel)와 다르다.
    ipcMain.handle("studio:finish-recording", async (event) => {
      guard(event);
      return finishRecording();
    });

    ipcMain.handle("studio:pause", async (event) => {
      guard(event);
      if (!state.activeJob || state.activeJob.kind !== "create" || state.activeJob.state !== "running") return false;
      state.activeJob.pauseRequested = true;
      // 촬영은 시간축을 지키기 위해 현재 편이 끝난 뒤 멈춘다.
      // 그 밖의 작업은 프로세스를 즉시 멈추고 편 경계는 루프가 처리한다.
      const stopped = pauseJobProcesses(state.activeJob);
      emit({ type: "paused", immediate: stopped });
      const record = await readActiveJob();
      if (record) await writeActiveJob({ ...record, paused: true }).catch(() => {});
      return true;
    });

    ipcMain.handle("studio:resume", async (event) => {
      guard(event);
      if (!state.activeJob || state.activeJob.kind !== "create" || !state.activeJob.pauseRequested) return false;
      state.activeJob.pauseRequested = false;
      resumeJobProcesses(state.activeJob);
      if (state.activeJob.state === "paused") state.activeJob.state = "running";
      emit({ type: "resumed" });
      const record = await readActiveJob();
      if (record) await writeActiveJob({ ...record, paused: false }).catch(() => {});
      return true;
    });

    // 앱이 꺼졌다 켜지면 여기서 남은 일을 알려 준다. 실행 중인 작업이 있으면
    // 이어할 것이 없다.
    ipcMain.handle("studio:get-resumable", async (event) => {
      guard(event);
      if (state.startReservation || jobIsActive(state.activeJob)) return null;
      const record = await readActiveJob();
      if (!record?.options?.name) return null;
      const settings = await readAppSettings();
      const studio = runtimePaths(record.options.paths || settings.paths);
      const units = (record.unitNames || []).map((name) => ({ name, videoQuality: record.options.videoQuality,
        deliverable: record.options.deliverable,
        productionDay: record.options.productionDay || (record.startedAt ? dateFolder(new Date(record.startedAt)) : undefined),
      }));
      const finished = units.length ? await finishedUnitNames(units, studio, record.options.inputFingerprint) : [];
      const remaining = units.length ? pendingUnits(units, finished).length : 1;
      if (units.length && remaining === 0) { await clearActiveJob(); return null; }
      return {
        name: record.options.name,
        title: record.options.title || record.options.name,
        startedAt: record.startedAt,
        total: units.length,
        done: finished.length,
        remaining,
        paused: Boolean(record.paused),
        failed: (record.failedUnits || []).filter(unit => !finished.includes(unit.name)).length,
      };
    });

    ipcMain.handle("studio:discard-resumable", async (event) => {
      guard(event);
      if (['running', 'paused', 'cancelling'].includes(state.activeJob?.state)) {
        throw new Error('실행 중인 작업의 이어하기 기록은 지울 수 없습니다.');
      }
      await clearActiveJob();
      return true;
    });

    ipcMain.handle("studio:cancel", async (event) => {
      guard(event);
      if (!jobIsActive(state.activeJob)) return false;
      if (state.activeJob.state === "cancelling") return true;
      const job = state.activeJob;
      const accepted = cancelJobProcesses(job, {
        onForce: () => emit({ type: "log", stream: "stderr", text: "중지되지 않은 작업을 강제로 종료했습니다.\n" }),
      });
      if (accepted) emit({ type: "cancelling" });
      return accepted;
    });

    ipcMain.handle("studio:reveal", async (event, target) => {
      guard(event);
      const { file, directory } = await resolveOutputFile(target);
      shell.showItemInFolder(file || directory);
      return true;
    });

    // 목록에서 고른 앱 데모 결과를 다듬기가 이어받을 수 있게 폴더를 알려 준다.
    ipcMain.handle("studio:demo-project-dir", async (event, target) => {
      guard(event);
      const { directory } = await resolveOutputFile(target);
      return directory;
    });

    ipcMain.handle("studio:open", async (event, target) => {
      guard(event);
      const { file, directory } = await resolveOutputFile(target);
      const error = await shell.openPath(file || directory);
      if (error) throw new Error(error);
      return true;
    });

    ipcMain.handle("studio:preview-output-audio", async (event, target) => {
      guard(event);
      const { file } = await resolveOutputFile(target);
      if (!file || !DROPPABLE.audio.extensions.has(path.extname(file).toLowerCase())) {
        throw new Error("이 결과에는 들을 수 있는 음성 파일이 없습니다.");
      }
      return pathToFileURL(file).href;
    });

    // Opening the editor from a flagged segment must not ask the user to find the
    // video they were just looking at, so the result adopts itself as the input.
    ipcMain.handle("studio:adopt-result-video", async (event, target) => {
      guard(event);
      const { file, directory } = await resolveOutputFile(target);
      if (!file || !/\.mp4$/i.test(file)) throw new Error("이 결과에는 편집할 영상이 없습니다.");
      const [registered] = await registerSelected([file], "video");
      return registered;
    });

  }

  function cleanupReviewPreviews() {
    for (const directory of reviewPreviewDirectories) {
      void fs.rm(directory, { recursive: true, force: true }).catch(() => {});
    }
  }

  return { registerIpc, cleanupReviewPreviews };
}
