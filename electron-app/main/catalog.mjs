import nativeFs from "node:fs/promises";
import { combineLessonCatalogs, lessonCatalogFromPresets } from "../shared/index.mjs";

export function createCatalogService({
  fs = nativeFs,
  requireRuntimeTool,
  runProcess,
  runUtility,
  state,
}) {
  async function loadCatalog(studio, { tracked = false } = {}) {
    if (state.catalogCache && state.catalogCacheRoot === studio.sourceProjectRoot) return state.catalogCache;
    const execute = tracked
      ? (executable, args) => runProcess("snapshot", executable, args, { capture: true })
      : runUtility;
    const raw = await execute(requireRuntimeTool("basePython", "강의 도구 Python"), [
      "-m", "local_tts_engine.course_catalog",
      "--source-project", studio.sourceProjectRoot,
    ]);
    state.catalogCache = JSON.parse(raw);
    const deckConfig = await fs.readFile(studio.configPath, "utf8").then(JSON.parse).catch(() => ({}));
    state.catalogCache.lessons = combineLessonCatalogs(
      state.catalogCache.lessons,
      lessonCatalogFromPresets(state.catalogCache.pages, deckConfig.presets),
    );
    state.catalogCacheRoot = studio.sourceProjectRoot;
    return state.catalogCache;
  }

  return { loadCatalog };
}
