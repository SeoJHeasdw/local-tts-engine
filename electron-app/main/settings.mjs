import nativeFs from "node:fs/promises";
import path from "node:path";
import { APP_SETTINGS_PATH, FINETUNE_RUN_ROOT, normalizeStudioPaths, runtimePaths } from "./paths.mjs";
import { safeStat } from "./files.mjs";
import { settingsAdapterScale } from "../shared/index.mjs";

export function createSettingsService({
  fs = nativeFs,
  state,
}) {
  async function discoverAdapters() {
    const adapters = [];
    const days = await fs.readdir(FINETUNE_RUN_ROOT, { withFileTypes: true }).catch(() => []);
    for (const day of days.filter((item) => item.isDirectory())) {
      const dayRoot = path.join(FINETUNE_RUN_ROOT, day.name);
      const runs = await fs.readdir(dayRoot, { withFileTypes: true }).catch(() => []);
      for (const run of runs.filter((item) => item.isDirectory())) {
        const adapterPath = path.join(dayRoot, run.name, "adapters");
        if (await safeStat(path.join(adapterPath, "adapters.safetensors"))
            && await safeStat(path.join(adapterPath, "adapter_config.json"))) {
          adapters.push({
            id: `${day.name}/${run.name}`,
            label: run.name,
            path: adapterPath,
            date: day.name,
          });
        }
      }
    }
    return adapters.sort((a, b) => b.id.localeCompare(a.id));
  }

  async function readAppSettings() {
    const adapters = await discoverAdapters();
    const fallbackAdapter = adapters.find((item) => item.label === "jaeho-ko-r16-v1") || adapters[0] || null;
    const stored = await fs.readFile(APP_SETTINGS_PATH, "utf8").then(JSON.parse).catch(() => ({}));
    const selected = adapters.find((item) => item.id === stored.adapterId) || fallbackAdapter;
    const modelId = stored.modelId === "chatterbox-v3" ? "chatterbox-v3" : "qwen3-tts";
    return {
      modelId,
      adapterId: modelId === "qwen3-tts" && stored.adapterId !== "none" ? selected?.id || "none" : "none",
      adapterScale: settingsAdapterScale(stored.adapterScale),
      voiceParallelism: Math.min(2, Math.max(1, Math.round(Number(stored.voiceParallelism ?? 2)))),
      // 자리를 비운 사이에도 제작이 이어지도록 하는 두 값이다. 기본은 켜 둔다 —
      // 일곱 시간짜리 작업에서 이것이 꺼져 있어 좋을 까닭이 없다.
      preventSleep: stored.preventSleep !== false,
      notifyOnFinish: stored.notifyOnFinish !== false,
      paths: normalizeStudioPaths(stored.paths),
      adapters,
    };
  }

  async function saveAppSettings(raw = {}) {
    const current = await readAppSettings();
    const modelId = raw.modelId === "chatterbox-v3" ? "chatterbox-v3" : "qwen3-tts";
    const adapterId = raw.adapterId === "none" || current.adapters.some((item) => item.id === raw.adapterId)
      ? raw.adapterId
      : current.adapterId;
    const settings = {
      modelId,
      adapterId: modelId === "qwen3-tts" ? adapterId : "none",
      adapterScale: settingsAdapterScale(raw.adapterScale ?? current.adapterScale),
      voiceParallelism: Math.min(2, Math.max(1, Math.round(Number(raw.voiceParallelism ?? current.voiceParallelism)))),
      preventSleep: Boolean(raw.preventSleep ?? current.preventSleep),
      notifyOnFinish: Boolean(raw.notifyOnFinish ?? current.notifyOnFinish),
      paths: normalizeStudioPaths(raw.paths || current.paths),
    };
    for (const key of ["voiceLibraryRoot", "outputRoot", "ttsOutputRoot", "voiceOutputRoot", "captionOutputRoot", "videoOutputRoot", "editOutputRoot"]) {
      await fs.mkdir(settings.paths[key], { recursive: true });
    }
    const studio = runtimePaths(settings.paths);
    for (const [label, requiredPath] of Object.entries({
      "참조 음성": studio.referenceAudioPath,
      "참조 전사문": studio.referenceTextPath,
    })) {
      if (!(await safeStat(requiredPath))) throw new Error(`${label} 경로를 찾지 못했습니다: ${requiredPath}`);
    }
    await fs.mkdir(path.dirname(APP_SETTINGS_PATH), { recursive: true });
    const storedSettings = {
      ...settings,
      paths: Object.fromEntries(["sourceProjectRoot", "voiceLibraryRoot", "outputRoot", "referenceAudioPath", "referenceTextPath", "savedRoot"]
        .map((key) => [key, settings.paths[key]])),
    };
    await fs.writeFile(APP_SETTINGS_PATH, `${JSON.stringify(storedSettings, null, 2)}\n`, "utf8");
    state.catalogCache = null;
    state.catalogCacheRoot = null;
    return { ...settings, adapters: current.adapters };
  }

  function applyVoiceSettings(options, settings) {
    const adapter = settings.modelId === "qwen3-tts"
      ? settings.adapters.find((item) => item.id === settings.adapterId) || null
      : null;
    return {
      ...options,
      modelId: settings.modelId,
      voiceMode: adapter ? "finetuned" : "zero",
      adapterId: adapter?.id || "none",
      adapterLabel: adapter?.label || null,
      adapterPath: adapter?.path || null,
      adapterScale: settings.adapterScale,
      voiceParallelism: settings.voiceParallelism,
      paths: settings.paths,
    };
  }

  return { discoverAdapters, readAppSettings, saveAppSettings, applyVoiceSettings };
}
