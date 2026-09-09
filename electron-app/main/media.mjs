import crypto from "node:crypto";
import nativeFs from "node:fs/promises";
import path from "node:path";
import { clearedFindingKeys, pageRangeFromTimeline, reviewPages, videoTimelineCandidates } from "../shared/index.mjs";
import { pathToFileURL } from "node:url";
import { reportDescribesVideo, safeStat } from "./files.mjs";
import { runtimePaths } from "./paths.mjs";

export function createMediaService({
  fs = nativeFs,
  readAppSettings,
  requireRuntimeTool,
  runProcess,
  runUtility,
}) {
  const selectedFiles = new Map();

  async function ffprobe(file) {
    const output = await runProcess("verify", requireRuntimeTool("ffprobe", "FFprobe"), [
      "-v", "error",
      "-show_entries", "format=duration:stream=codec_type,codec_name,width,height",
      "-of", "json",
      file,
    ], { capture: true });
    return JSON.parse(output);
  }

  async function inspectMedia(file) {
    const raw = await runUtility(requireRuntimeTool("ffprobe", "FFprobe"), [
      "-v", "error",
      "-show_entries", "format=duration:stream=codec_type,codec_name,width,height,pix_fmt,r_frame_rate,sample_rate,channels",
      "-of", "json",
      file,
    ]);
    return JSON.parse(raw);
  }

  function chosenRecord(token, kind) {
    const selected = selectedFiles.get(String(token || ""));
    if (!selected || selected.kind !== kind) throw new Error("선택한 로컬 파일을 다시 지정해 주세요.");
    return selected;
  }

  async function findVideoTimeline(videoPath) {
    const settings = await readAppSettings().catch(() => null);
    const captionRoot = settings ? runtimePaths(settings.paths).captionOutputRoot : null;
    for (const candidate of videoTimelineCandidates(videoPath, captionRoot)) {
      if (await safeStat(candidate)) return candidate;
    }
    return null;
  }

  async function registerSelected(paths, kind, extras = []) {
    return Promise.all(paths.map(async (file, index) => {
      const token = crypto.randomUUID();
      const value = {
        token,
        kind,
        path: path.resolve(file),
        name: path.basename(file),
        timelinePath: null,
        pageRange: null,
        ...(extras[index] || {}),
      };
      const mediaProbe = await inspectMedia(value.path);
      value.durationMs = Math.round(Number(mediaProbe.format?.duration || 0) * 1000);
      if (kind === "video" && !value.timelinePath) {
        const timelinePath = await findVideoTimeline(value.path);
        const timeline = timelinePath
          ? await fs.readFile(timelinePath, "utf8").then(JSON.parse).catch(() => null)
          : null;
        const pageRange = pageRangeFromTimeline(timeline);
        if (pageRange) {
          value.timelinePath = timelinePath;
          value.pageRange = pageRange;
          value.pages = reviewPages(timeline);
        }
      }
      if (kind === "video") {
        const settings = await readAppSettings();
        const captionRoot = runtimePaths(settings.paths).captionOutputRoot;
        const reports = [path.join(path.dirname(value.path), "validation-report.json"),
          path.join(captionRoot, path.basename(path.dirname(value.path)), "validation-report.json")];
        for (const reportPath of reports) {
          const report = await fs.readFile(reportPath, "utf8").then(JSON.parse).catch(() => null);
          if (report?.videoPath && await reportDescribesVideo(report.videoPath, value.path)) {
            value.voiceFindings = report.voiceFindings || [];
            // 확인 완료 표시는 결과에 적혀 있다. 다시 열어도 그대로 남아야 한다.
            value.clearedFindings = clearedFindingKeys(report);
            value.reviewTarget = report.target || null;
            value.reportPath = reportPath;
            break;
          }
        }
      }
      selectedFiles.set(token, value);
      return { token, kind, name: value.name, path: value.path, durationMs: value.durationMs, pageRange: value.pageRange, audioUrl: kind === "audio" ? pathToFileURL(value.path).href : null, pages: value.pages || [], voiceFindings: value.voiceFindings || [], clearedFindings: value.clearedFindings || [], reviewTarget: value.reviewTarget || null, videoUrl: kind === "video" ? pathToFileURL(value.path).href : null };
    }));
  }

  return { ffprobe, inspectMedia, chosenRecord, findVideoTimeline, registerSelected };
}
