import nativeFs from "node:fs/promises";
import path from "node:path";
import { LEGACY_OUTPUT_PATHS, runtimePaths } from "./paths.mjs";
import { clearedFindingKeys, isInside, withClearedFindings, withOutputReview } from "../shared/index.mjs";
import { existingFile, findVideo, listDirectories, renameMediaFile, repointReport, safeStat, writeReport } from "./files.mjs";

export function createOutputsService({
  dialog,
  fs = nativeFs,
  readAppSettings,
  shell,
  state,
}) {
  async function resolveOutputFile(target) {
    const settings = await readAppSettings();
    const studio = runtimePaths(settings.paths);
    const store = outputStoreForTarget(target, studio);
    const directory = resolveOutputTarget(target, studio);
    let file = target.root === "render"
      ? await findVideo(path.join(store.videoOutputRoot, target.name), target.name) || await findVideo(directory, target.name)
      : target.root === "edit"
        ? path.join(directory, `${target.name}.mp4`)
        : target.root === "voice"
          ? path.join(directory, "selected.wav")
          : path.join(directory, `${target.name}.m4a`);
    if (["render", "edit", "voice"].includes(target.root)) {
      const report = await fs.readFile(path.join(directory, "validation-report.json"), "utf8").then(JSON.parse).catch(() => null);
      file = await safeStat(file) ? file : report?.videoPath || report?.audioPath || file;
    }
    // 이름이 바뀐 영상은 적어 둔 경로에 없다. 폴더에 그 영상이 그대로 있는데도
    // 열 수 없다고 말하지 않는다.
    if (!await safeStat(file) && ["render", "edit"].includes(target.root)) {
      file = await findVideo(directory, target.name) || file;
    }
    return { directory, file: await safeStat(file) ? file : null };
  }

  async function listOutputs(studio, { includeLegacy = true, storeId = "current" } = {}) {
    const result = [];
    for (const entry of await listDirectories(studio.captionOutputRoot)) {
      const dir = path.join(studio.captionOutputRoot, entry.name);
      const stat = await safeStat(dir);
      const reportPath = path.join(dir, "validation-report.json");
      const report = await fs.readFile(reportPath, "utf8").then(JSON.parse).catch(() => null);
      const videoPath = await findVideo(path.join(studio.videoOutputRoot, entry.name), entry.name)
        || await existingFile(report?.videoPath)
        || await findVideo(dir, entry.name);
      if (!videoPath && !report) continue;
      result.push({
        key: `${storeId}:render:${entry.name}`,
        store: storeId,
        root: "render",
        name: entry.name,
        displayName: report?.displayName || entry.name,
        updatedAt: stat?.mtime.toISOString(),
        durationMs: report?.durationMs || null,
        video: Boolean(videoPath),
        ok: report?.summary?.ok ?? null,
        passed: report?.summary?.passed ?? null,
        total: report?.summary?.total ?? null,
        needsReview: report?.needsReview || [],
        listenSuggested: report?.listenSuggested || [],
        voiceFindings: report?.voiceFindings || [],
        review: report?.review || null,
        path: videoPath || dir,
        fileName: videoPath ? path.basename(videoPath) : null,
      });
    }
    const dayEntries = await fs.readdir(studio.ttsOutputRoot, { withFileTypes: true }).catch(() => []);
    for (const dayEntry of dayEntries.filter((item) => item.isDirectory() && /^\d{4}-\d{2}-\d{2}$/.test(item.name))) {
      const dayRoot = path.join(studio.ttsOutputRoot, dayEntry.name);
      for (const entry of await listDirectories(dayRoot)) {
        const dir = path.join(dayRoot, entry.name);
        const report = await fs.readFile(path.join(dir, "validation-report.json"), "utf8").then(JSON.parse).catch(() => null);
        if (!report || report.renderDir) continue;
        const stat = await safeStat(dir);
        result.push({
          key: `${storeId}:pilot:${dayEntry.name}:${entry.name}`,
          store: storeId,
          root: "pilot",
          day: dayEntry.name,
          name: entry.name,
          updatedAt: stat?.mtime.toISOString(),
          durationMs: report.durationMs || null,
          video: false,
          ok: report.summary?.ok ?? null,
          passed: report.summary?.passed ?? null,
          total: report.summary?.total ?? null,
          needsReview: report.needsReview || [],
          listenSuggested: report.listenSuggested || [],
          voiceFindings: report.voiceFindings || [],
          review: report.review || null,
          path: report.audioPath || dir,
          fileName: report.audioPath ? path.basename(report.audioPath) : null,
        });
      }
    }
    const voiceDays = await fs.readdir(studio.voiceOutputRoot, { withFileTypes: true }).catch(() => []);
    for (const dayEntry of voiceDays.filter((item) => item.isDirectory() && /^\d{4}-\d{2}-\d{2}$/.test(item.name))) {
      const dayRoot = path.join(studio.voiceOutputRoot, dayEntry.name);
      for (const entry of await listDirectories(dayRoot)) {
        const dir = path.join(dayRoot, entry.name);
        const report = await fs.readFile(path.join(dir, "validation-report.json"), "utf8").then(JSON.parse).catch(() => null);
        if (!report?.audioPath) continue;
        const stat = await safeStat(dir);
        result.push({
          key: `${storeId}:voice:${dayEntry.name}:${entry.name}`,
          store: storeId,
          root: "voice",
          day: dayEntry.name,
          name: entry.name,
          operation: "text-voice",
          updatedAt: stat?.mtime.toISOString(),
          durationMs: report.durationMs || null,
          video: false,
          ok: report.summary?.ok ?? null,
          passed: report.summary?.passed ?? null,
          total: report.summary?.total ?? null,
          review: report.review || null,
          path: report.audioPath,
          fileName: path.basename(report.audioPath),
        });
      }
    }
    const editDays = await fs.readdir(studio.editOutputRoot, { withFileTypes: true }).catch(() => []);
    for (const dayEntry of editDays.filter((item) => item.isDirectory() && /^\d{4}-\d{2}-\d{2}$/.test(item.name))) {
      const dayRoot = path.join(studio.editOutputRoot, dayEntry.name);
      for (const entry of await listDirectories(dayRoot)) {
        const dir = path.join(dayRoot, entry.name);
        const report = await fs.readFile(path.join(dir, "validation-report.json"), "utf8").then(JSON.parse).catch(() => null);
        if (!report) continue;
        const stat = await safeStat(dir);
        const videoPath = await existingFile(report.videoPath) || await findVideo(dir, entry.name);
        result.push({
          key: `${storeId}:edit:${dayEntry.name}:${entry.name}`,
          store: storeId,
          root: "edit",
          day: dayEntry.name,
          name: entry.name,
          operation: report.operation,
          displayName: report.displayName || entry.name,
          voiceFindings: report.voiceFindings || [],
          updatedAt: stat?.mtime.toISOString(),
          durationMs: report.durationMs || null,
          video: true,
          ok: report.summary?.ok ?? null,
          passed: report.summary?.passed ?? null,
          total: report.summary?.total ?? null,
          review: report.review || null,
          path: videoPath || dir,
          fileName: videoPath ? path.basename(videoPath) : null,
          // 어느 영상에서 나온 수정본인지는 결과가 스스로 적어 둔다.
          sources: (report.inputs || []).filter((file) => typeof file === "string" && /\.(mp4|mov|m4v)$/i.test(file)),
        });
      }
    }
    if (includeLegacy) {
      const currentKey = [studio.ttsOutputRoot, studio.voiceOutputRoot, studio.captionOutputRoot, studio.videoOutputRoot, studio.editOutputRoot].join("\n");
      const legacyKey = Object.values(LEGACY_OUTPUT_PATHS).join("\n");
      if (currentKey !== legacyKey) {
        result.push(...await listOutputs({ ...studio, ...LEGACY_OUTPUT_PATHS }, { includeLegacy: false, storeId: "legacy" }));
      }
    }
    // 챕터 하나가 열두 편이다. 서른 개는 한 번 만들면 바로 차서, 지난 챕터가
    // 목록에서도 검색에서도 사라진다.
    return result.sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt))).slice(0, 120);
  }

  function outputStoreForTarget(target, studio) {
    return target?.store === "legacy" ? { ...studio, ...LEGACY_OUTPUT_PATHS } : studio;
  }

  function resolveOutputTarget(target, studio) {
    if (!target || !["render", "pilot", "edit", "voice"].includes(target.root) || !/^[a-z0-9][a-z0-9-]*$/.test(target.name || "")) {
      throw new Error("열 수 없는 결과입니다.");
    }
    const store = outputStoreForTarget(target, studio);
    let root = store.captionOutputRoot;
    let directory = path.join(root, target.name);
    if (target.root === "pilot") {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(target.day || "")) throw new Error("결과 날짜가 올바르지 않습니다.");
      root = path.join(store.ttsOutputRoot, target.day);
      directory = path.join(root, target.name);
    } else if (target.root === "edit") {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(target.day || "")) throw new Error("결과 날짜가 올바르지 않습니다.");
      root = path.join(store.editOutputRoot, target.day);
      directory = path.join(root, target.name);
    } else if (target.root === "voice") {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(target.day || "")) throw new Error("결과 날짜가 올바르지 않습니다.");
      root = path.join(store.voiceOutputRoot, target.day);
      directory = path.join(root, target.name);
    }
    if (!isInside(root, directory)) throw new Error("결과 경로가 올바르지 않습니다.");
    return directory;
  }

  async function setOutputReview(target, status, studio) {
    const directory = resolveOutputTarget(target, studio);
    const reportPath = path.join(directory, "validation-report.json");
    const report = await fs.readFile(reportPath, "utf8").then(JSON.parse).catch(() => null);
    if (!report) throw new Error("자동 검증 기록이 있는 결과만 청취 승인할 수 있습니다.");
    const reviewed = await writeReport(reportPath, withOutputReview(report, status), "review");
    return reviewed.review;
  }

  async function setClearedFindings(target, keys, studio) {
    const directory = resolveOutputTarget(target, studio);
    const reportPath = path.join(directory, "validation-report.json");
    const report = await fs.readFile(reportPath, "utf8").then(JSON.parse).catch(() => null);
    if (!report) throw new Error("자동 검증 기록이 있는 결과만 확인 표시를 남길 수 있습니다.");
    return clearedFindingKeys(await writeReport(reportPath, withClearedFindings(report, keys), "cleared"));
  }

  async function renameOutput(target, rawName, studio) {
    resolveOutputTarget(target, studio);
    const { directory, file } = await resolveOutputFile(target);
    if (!file) throw new Error("이름을 바꿀 파일을 찾지 못했습니다.");
    const renamed = await renameMediaFile(file, rawName);
    await repointReport(directory, file, renamed);
    return { fileName: path.basename(renamed), path: renamed };
  }

  // 지우기는 되돌릴 수 있어야 한다. 두 시간을 들인 결과를 한 번의 오조작으로
  // 잃지 않도록, 먼저 물어보고 그다음에도 삭제가 아니라 휴지통으로 보낸다.
  async function deleteOutput(target, studio) {
    const directory = resolveOutputTarget(target, studio);
    if (!await safeStat(directory)) throw new Error("이미 없는 결과입니다.");
    // 강의 결과는 작업 폴더와 완성 영상 폴더로 나뉘어 있다. 한쪽만 버리면 목록
    // 에서는 사라졌는데 영상은 남아, 지웠는지 아닌지를 알 수 없는 상태가 된다.
    const store = outputStoreForTarget(target, studio);
    const directories = [directory];
    if (target.root === "render") {
      const published = path.join(store.videoOutputRoot, target.name);
      if (isInside(store.videoOutputRoot, published) && await safeStat(published)) directories.push(published);
    }
    const { response } = await dialog.showMessageBox(state.mainWindow, {
      type: "warning",
      buttons: ["휴지통으로 보내기", "취소"],
      defaultId: 1,
      cancelId: 1,
      message: "이 결과를 휴지통으로 보낼까요?",
      detail: `${path.basename(directory)} 폴더 ${directories.length}곳의 영상·음성·검수 기록이 함께 들어갑니다. Finder의 휴지통에서 되돌릴 수 있습니다.`,
    });
    if (response !== 0) return false;
    for (const item of directories) await shell.trashItem(item);
    return true;
  }

  return { resolveOutputFile, listOutputs, outputStoreForTarget, resolveOutputTarget, setOutputReview, setClearedFindings, renameOutput, deleteOutput };
}
