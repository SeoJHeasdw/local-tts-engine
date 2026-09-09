import { createSettingsService } from "./settings.mjs";
import { createRuntimeService } from "./runtime.mjs";
import { createCatalogService } from "./catalog.mjs";
import { createMediaService } from "./media.mjs";
import { createProductionService } from "./production.mjs";
import { createVoicesService } from "./voices.mjs";
import { createEditingComposeService } from "./editing/compose.mjs";
import { createEditingPagesService } from "./editing/pages.mjs";
import { createEditingRegionsService } from "./editing/regions.mjs";
import { createEditingService } from "./editing.mjs";
import { createOutputsService } from "./outputs.mjs";
import { createIpcService } from "./ipc.mjs";
import { createWindowService } from "./window.mjs";
import { ROOT } from "./paths.mjs";
import { resolveRuntimeTools } from "./runtime-config.mjs";
import { resumeJobProcesses, stopJobProcesses } from "./job-process.mjs";

// Electron objects enter here; services can also run in Node-based integration tests.
export function createStudio({ app, BrowserWindow, ipcMain, dialog, shell }) {
  const state = { activeJob: null, mainWindow: null, catalogCache: null, catalogCacheRoot: null, runtimeTools: {} };
  const { readAppSettings, saveAppSettings, applyVoiceSettings } = createSettingsService({
    state,
  });
  const { emit, jobSnapshot, requireRuntimeTool, assertRuntime, runProcess, runUtility } = createRuntimeService({
    state,
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
    deleteOutput, dialog, emit, findVideoTimeline,
    finishedUnitNames, ipcMain, jobSnapshot, launchPipeline,
    listOutputs, loadCatalog, readActiveJob, readAppSettings,
    registerSelected, renameOutput, requireRuntimeTool, resolveOutputFile,
    runFineTune, runTextVoiceCandidates, runVideoEdit, saveAppSettings,
    selectTextVoice, setClearedFindings, setOutputReview, shell,
    state, writeActiveJob,
  });
  const { createWindow } = createWindowService({
    BrowserWindow, app, state,
  });

  async function start() {
    state.runtimeTools = await resolveRuntimeTools(ROOT);
    registerIpc();
    createWindow();
  }

  function stop() {
    if (state.activeJob?.paused) resumeJobProcesses(state.activeJob);
    stopJobProcesses(state.activeJob);
  }

  return { start, stop, createWindow, cleanupReviewPreviews, state };
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
