import { createSettingsService } from "./settings.mjs";
import { createRuntimeService } from "./runtime.mjs";
import { createCatalogService } from "./catalog.mjs";
import { createMediaService } from "./media.mjs";
import { createProductionService } from "./production.mjs";
import { createRecordingService } from "./recording.mjs";
import { createAppDemoService } from "./app-demo.mjs";
import { createVoicesService } from "./voices.mjs";
import { createEditingComposeService } from "./editing/compose.mjs";
import { createEditingPagesService } from "./editing/pages.mjs";
import { createEditingRegionsService } from "./editing/regions.mjs";
import { createEditingService } from "./editing.mjs";
import { createOutputsService } from "./outputs.mjs";
import { createIpcService } from "./ipc.mjs";
import { createAttentionService } from "./attention.mjs";
import { createWindowService } from "./window.mjs";
import { ROOT } from "./paths.mjs";
import { resolveRuntimeTools } from "./runtime-config.mjs";
import { resumeJobProcesses, stopJobProcesses } from "./job-process.mjs";

// Electron objects enter here; services can also run in Node-based integration tests.
export function createStudio({
  app, BrowserWindow, ipcMain, dialog, shell,
  powerMonitor = null, powerSaveBlocker = null, Notification = null,
}) {
  const state = { activeJob: null, mainWindow: null, catalogCache: null, catalogCacheRoot: null, runtimeTools: {} };
  const { readAppSettings, saveAppSettings, applyVoiceSettings } = createSettingsService({
    state,
  });
  // 작업 사건은 모두 emit 하나를 지난다. 잠 막기와 완료 알림은 그 길목에서
  // 함께 판단한다 — 시작·끝을 따로 세어 두면 어느 한쪽에서 새기 쉽다.
  let attention = null;
  const { emit, jobSnapshot, requireRuntimeTool, assertRuntime, runProcess, runUtility } = createRuntimeService({
    state,
    onEvent: (payload) => { attention?.watch(payload); },
  });
  attention = createAttentionService({
    powerSaveBlocker, Notification, readAppSettings, state,
  });
  const { loadCatalog } = createCatalogService({
    requireRuntimeTool, runProcess, runUtility, state,
  });
  const { ffprobe, inspectMedia, chosenRecord, findVideoTimeline, registerSelected } = createMediaService({
    readAppSettings, requireRuntimeTool, runProcess, runUtility,
  });
  const { writeActiveJob, clearActiveJob, readActiveJob, finishedUnitNames, launchPipeline } = createProductionService({
    emit, ffprobe, jobSnapshot, loadCatalog, requireRuntimeTool, runProcess, state,
  });
  const { listRecordingSources, startRecording, finishRecording } = createRecordingService({
    emit, jobSnapshot, readAppSettings, requireRuntimeTool, runProcess, state,
  });
  const {
    pickDemoScenario, pickDemoProject, readDemoScenario, readDemoProject, saveDemoScript,
    startDemoRecord, startDemoVoice, startDemoRender,
  } = createAppDemoService({
    dialog, emit, jobSnapshot, readAppSettings, requireRuntimeTool, runProcess, state,
  });
  const {
    generateReplacementVoice, runVoiceCandidates, runTextVoiceCandidates, selectTextVoice,
    runFineTune,
  } = createVoicesService({
    chosenRecord, emit, inspectMedia, readAppSettings,
    registerSelected, requireRuntimeTool, runProcess, saveAppSettings,
    state,
  });
  const { validateEditVideo, runComposeEdit } = createEditingComposeService({
    chosenRecord, emit, ffprobe, inspectMedia, requireRuntimeTool, runProcess,
  });
  const { runPageVoicePatchBatch, runVoiceBatchEdit } = createEditingPagesService({
    chosenRecord, emit, generateReplacementVoice, inspectMedia, requireRuntimeTool, runProcess, validateEditVideo,
  });
  const { runMuteEdit, runRegionReplaceEdit } = createEditingRegionsService({
    chosenRecord, inspectMedia, requireRuntimeTool, runProcess, validateEditVideo,
  });
  const { runVideoEdit } = createEditingService({
    emit, runComposeEdit, runMuteEdit, runPageVoicePatchBatch,
    runRegionReplaceEdit, runVoiceBatchEdit, runVoiceCandidates, state,
  });
  const {
    resolveOutputFile, listOutputs, setOutputReview, setClearedFindings,
    renameOutput, deleteOutput,
  } = createOutputsService({
    dialog, readAppSettings, shell, state,
  });
  const { registerIpc, cleanupReviewPreviews } = createIpcService({
    applyVoiceSettings, assertRuntime, chosenRecord, clearActiveJob,
    deleteOutput, dialog, emit, findVideoTimeline, finishRecording,
    finishedUnitNames, ipcMain, jobSnapshot, launchPipeline,
    listOutputs, listRecordingSources, loadCatalog, pickDemoProject, pickDemoScenario,
    readActiveJob, readAppSettings, readDemoProject, readDemoScenario,
    registerSelected, renameOutput, requireRuntimeTool, resolveOutputFile,
    runFineTune, runTextVoiceCandidates, runVideoEdit, saveAppSettings, saveDemoScript,
    selectTextVoice, setClearedFindings, setOutputReview, shell,
    startDemoRecord, startDemoRender, startDemoVoice, startRecording, state, writeActiveJob,
  });
  const { createWindow } = createWindowService({
    BrowserWindow, app, state,
  });

  // 맥이 잠든 동안에는 제작도 함께 멈춰 있다. 그 시간을 경과로 세면 남은 시간이
  // 자고 일어난 만큼 부풀고, 그 속도로 남은 편들의 몫까지 함께 늘어난다.
  // 화면 보호기·화면 꺼짐은 제작을 멈추지 않으므로 여기서 다루지 않는다.
  function watchSystemSleep() {
    if (!powerMonitor?.on) return;
    let sleptAt = null;
    powerMonitor.on("suspend", () => { sleptAt = Date.now(); });
    powerMonitor.on("resume", () => {
      const away = sleptAt ? Date.now() - sleptAt : 0;
      sleptAt = null;
      if (away > 1000 && state.activeJob?.state === "running") emit({ type: "slept", ms: away });
    });
  }

  async function start() {
    state.runtimeTools = await resolveRuntimeTools(ROOT);
    registerIpc();
    watchSystemSleep();
    createWindow();
  }

  function stop() {
    attention.release();
    if (state.activeJob?.paused) resumeJobProcesses(state.activeJob);
    stopJobProcesses(state.activeJob);
  }

  return { start, stop, createWindow, cleanupReviewPreviews, attention, state };
}

export function startStudio(electron) {
  const studio = createStudio(electron);
  const { app, BrowserWindow } = electron;
  app.whenReady().then(async () => {
    await studio.start();
    app.on("activate", () => {
      if (BrowserWindow.getAllWindows().length === 0) studio.createWindow();
    });
  });
  app.on("before-quit", studio.stop);
  app.on("will-quit", studio.cleanupReviewPreviews);
  app.on("window-all-closed", () => {
    if (process.platform !== "darwin") app.quit();
  });
  return studio;
}
