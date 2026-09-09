import crypto from "node:crypto";
import nativeFs from "node:fs/promises";
import path from "node:path";
import { FINETUNE_TRAIN_JSONL, RENDERER_DIR, ROOT, runtimePaths } from "./paths.mjs";
import { audioEnvelope, makeRegionPreview, newPreviewDirectory } from "./editing/review-media.mjs";
import { cancelJobProcesses, pauseJobProcesses, resumeJobProcesses } from "./job-process.mjs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { isInside, normalizeEditName, normalizeOptions, normalizeVoiceText, pendingUnits } from "../shared/index.mjs";
import { renameMediaFile, repointReportFile, safeStat } from "./files.mjs";

export function createIpcService({
  applyVoiceSettings,
  assertRuntime,
  chosenRecord,
  clearActiveJob,
  deleteOutput,
  dialog,
  emit,
  findVideoTimeline,
  finishedUnitNames,
  fs = nativeFs,
  ipcMain,
  jobSnapshot,
  launchPipeline,
  listOutputs,
  loadCatalog,
  readActiveJob,
  readAppSettings,
  registerSelected,
  renameOutput,
  requireRuntimeTool,
  resolveOutputFile,
  runFineTune,
  runTextVoiceCandidates,
  runVideoEdit,
  saveAppSettings,
  selectTextVoice,
  setClearedFindings,
  setOutputReview,
  shell,
  state,
  writeActiveJob,
}) {
  const reviewPreviewDirectories = [];

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
      const selectedAdapter = settings.adapters.find((item) => item.id === settings.adapterId) || null;
      const runtime = {
        basePython: Boolean(state.runtimeTools.basePython),
        trainPython: Boolean(state.runtimeTools.trainPython),
        node: Boolean(state.runtimeTools.node),
        ffmpeg: Boolean(state.runtimeTools.ffmpeg),
        ffprobe: Boolean(state.runtimeTools.ffprobe),
        voice: Boolean(await safeStat(studio.referenceAudioPath)),
        voiceLibrary: Boolean(await safeStat(studio.voiceLibraryRoot)),
        adapter: settings.adapterId === "none" || Boolean(await safeStat(selectedAdapter?.path)),
        qualityModel: Boolean(
          await safeStat(path.join(ROOT, "artifacts/models/whisper-large-v3-turbo-asr-fp16/config.json"))
          && await safeStat(path.join(ROOT, "artifacts/models/whisper-large-v3-turbo-asr-fp16/model.safetensors")),
        ),
        deck: Boolean(await safeStat(studio.configPath))
          && Boolean(await safeStat(path.join(studio.deckRoot, "script/course"))),
      };
      const capabilities = {
        textVoice: runtime.trainPython && runtime.ffprobe && runtime.voice && runtime.adapter,
        editing: runtime.ffmpeg && runtime.ffprobe,
        course: runtime.trainPython && runtime.basePython && runtime.node && runtime.ffmpeg
          && runtime.ffprobe && runtime.voice && runtime.adapter && runtime.qualityModel && runtime.deck,
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
        filters: [{ name: "영상", extensions: ["mp4", "mov", "mkv", "webm", "m4v"] }],
      });
      return result.canceled ? [] : registerSelected(result.filePaths, "video");
    });

    ipcMain.handle("studio:register-dropped-files", async (event, paths = [], kind) => {
      guard(event);
      const allowed = {
        video: new Set([".mp4", ".mov", ".mkv", ".webm", ".m4v"]),
        audio: new Set([".wav", ".m4a", ".mp3", ".flac", ".aac"]),
      };
      if (!allowed[kind]) throw new Error("지원하지 않는 파일 종류입니다.");
      const accepted = [];
      for (const candidate of paths.slice(0, 100)) {
        const resolved = path.resolve(String(candidate));
        if (!allowed[kind].has(path.extname(resolved).toLowerCase())) continue;
        if (!(await safeStat(resolved))?.isFile()) continue;
        accepted.push(resolved);
      }
      if (!accepted.length) throw new Error(kind === "video" ? "지원하는 영상 파일을 놓아 주세요." : "지원하는 음성 파일을 놓아 주세요.");
      return registerSelected(accepted, kind);
    });

    ipcMain.handle("studio:pick-audio", async (event) => {
      guard(event);
      const result = await dialog.showOpenDialog(state.mainWindow, {
        title: "교체할 음성 선택",
        properties: ["openFile"],
        filters: [{ name: "음성", extensions: ["wav", "m4a", "mp3", "flac", "aac"] }],
      });
      return result.canceled ? [] : registerSelected(result.filePaths, "audio");
    });

    ipcMain.handle("studio:start-edit", async (event, rawOptions = {}) => {
      guard(event);
      if (state.activeJob && ["running", "cancelling"].includes(state.activeJob.state)) {
        throw new Error("이미 실행 중인 작업이 있습니다.");
      }
      requireRuntimeTool("ffmpeg", "FFmpeg");
      const operation = ["compose", "voice", "voice-pages", "voice-candidates", "mute-region", "replace-region"].includes(rawOptions.operation)
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
      };
      options = applyVoiceSettings(options, settings);
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
      const snapshot = jobSnapshot();
      emit({ type: "edit-started", job: snapshot, options });
      runVideoEdit(options).catch((error) => {
        if (!state.activeJob) return;
        state.activeJob.state = state.activeJob.cancelled ? "cancelled" : "failed";
        emit({ type: "edit-failed", cancelled: state.activeJob.cancelled, message: error.message });
      });
      return snapshot;
    });

    ipcMain.handle("studio:start-text-voices", async (event, rawOptions = {}) => {
      guard(event);
      if (state.activeJob && ["running", "cancelling"].includes(state.activeJob.state)) {
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
      const snapshot = jobSnapshot();
      emit({ type: "text-voice-started", job: snapshot, options });
      runTextVoiceCandidates(options).catch((error) => {
        if (!state.activeJob) return;
        state.activeJob.state = state.activeJob.cancelled ? "cancelled" : "failed";
        emit({ type: "text-voice-failed", cancelled: state.activeJob.cancelled, message: error.message });
      });
      return snapshot;
    });

    ipcMain.handle("studio:select-text-voice", async (event, token) => {
      guard(event);
      return selectTextVoice(String(token || ""));
    });

    ipcMain.handle("studio:start-finetune", async (event, rawOptions = {}) => {
      guard(event);
      if (state.activeJob && ["running", "cancelling"].includes(state.activeJob.state)) {
        throw new Error("이미 실행 중인 작업이 있습니다.");
      }
      await fs.access(FINETUNE_TRAIN_JSONL);
      const settings = await readAppSettings();
      const options = {
        name: normalizeEditName(rawOptions.name),
        maxSteps: Math.min(500, Math.max(10, Math.round(Number(rawOptions.maxSteps ?? 60)))),
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
      emit({ type: "training-started", options });
      runFineTune(options).catch((error) => {
        if (!state.activeJob) return;
        state.activeJob.state = state.activeJob.cancelled ? "cancelled" : "failed";
        emit({ type: "training-failed", cancelled: state.activeJob.cancelled, message: error.message });
      });
      return jobSnapshot();
    });

    ipcMain.handle("studio:start", async (event, rawOptions) => {
      guard(event);
      if (state.activeJob && ["running", "cancelling"].includes(state.activeJob.state)) {
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
    });

    ipcMain.handle("studio:resume-job", async (event) => {
      guard(event);
      if (state.activeJob && ["running", "cancelling"].includes(state.activeJob.state)) {
        throw new Error("이미 실행 중인 작업이 있습니다.");
      }
      const record = await readActiveJob();
      if (!record?.options?.name) throw new Error("이어서 만들 작업이 없습니다.");
      const settings = await readAppSettings();
      const studio = runtimePaths(settings.paths);
      // 지난 실행에서 이미 정규화하고 카탈로그로 확인한 옵션이다. 그때 얼려 둔
      // 입력을 그대로 쓰므로 페이지를 다시 풀지 않는다. 도구만 다시 확인한다.
      const options = { ...record.options, resumeFrom: record.completed || [] };
      await assertRuntime(options, studio, {
        node: true,
        productionInput: true,
        ffmpeg: options.deliverable === "video",
      });
      return launchPipeline(options);
    });

    ipcMain.handle("studio:pause", async (event) => {
      guard(event);
      if (!state.activeJob || state.activeJob.kind !== "create" || state.activeJob.state !== "running") return false;
      state.activeJob.pauseRequested = true;
      // 지금 이 Mac 을 쓰려고 멈추는 것이므로, 다음 편을 기다리지 않고 돌고 있는
      // 프로세스를 바로 재운다. 편 경계에서의 확정은 루프가 따로 처리한다.
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
      if (state.activeJob && ["running", "cancelling"].includes(state.activeJob.state)) return null;
      const record = await readActiveJob();
      if (!record?.options?.name) return null;
      const settings = await readAppSettings();
      const studio = runtimePaths(settings.paths);
      const units = (record.unitNames || []).map((name) => ({ name }));
      const finished = units.length ? await finishedUnitNames(units, studio) : [];
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
      };
    });

    ipcMain.handle("studio:discard-resumable", async (event) => {
      guard(event);
      await clearActiveJob();
      return true;
    });

    ipcMain.handle("studio:cancel", async (event) => {
      guard(event);
      if (!state.activeJob || !["running", "cancelling"].includes(state.activeJob.state)) return false;
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

    ipcMain.handle("studio:open", async (event, target) => {
      guard(event);
      const { file, directory } = await resolveOutputFile(target);
      const error = await shell.openPath(file || directory);
      if (error) throw new Error(error);
      return true;
    });

    // Opening the editor from a flagged segment must not ask the user to find the
    // video they were just looking at, so the result adopts itself as the input.
    ipcMain.handle("studio:adopt-result-video", async (event, target) => {
      guard(event);
      const { file, directory } = await resolveOutputFile(target);
      if (!file || !/\.mp4$/i.test(file)) throw new Error("이 결과에는 편집할 영상이 없습니다.");
      const [registered] = await registerSelected([file], "video");
      const report = await fs.readFile(path.join(directory, "validation-report.json"), "utf8").then(JSON.parse).catch(() => null);
      return { ...registered, voiceFindings: report?.voiceFindings || [] };
    });
  }

  function cleanupReviewPreviews() {
    for (const directory of reviewPreviewDirectories) {
      void fs.rm(directory, { recursive: true, force: true }).catch(() => {});
    }
  }

  return { registerIpc, cleanupReviewPreviews };
}
