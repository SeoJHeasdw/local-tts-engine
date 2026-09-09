import fs from "node:fs/promises";
import path from "node:path";
import { nextDisplayVideoFileName, renamedFileName, videoTimelineFileName } from "../shared/index.mjs";

export async function findVideo(renderDir, name) {
  const names = await fs.readdir(renderDir).catch(() => []);
  const preferred = `${name}-captioned.mp4`;
  if (names.includes(preferred)) return path.join(renderDir, preferred);
  const mp4s = names.filter((item) => item.toLowerCase().endsWith(".mp4"));
  if (!mp4s.length) return null;
  const dated = await Promise.all(mp4s.map(async (item) => ({
    item,
    at: (await safeStat(path.join(renderDir, item)))?.mtimeMs || 0,
  })));
  dated.sort((left, right) => left.at - right.at || left.item.localeCompare(right.item));
  return path.join(renderDir, dated.at(-1).item);
}

// 결과 폴더의 영상 이름을 Finder에서 바꾸는 일은 흔하다. 기록해 둔 경로와
// 글자가 다르다고 남이 되면, 그 영상의 확인 항목과 승인 표시가 통째로
// 사라진다. 적어 둔 파일이 더는 없고 같은 폴더의 영상을 연 것이라면,
// 이름만 바뀐 바로 그 영상이다.
export async function reportDescribesVideo(reportVideoPath, videoPath) {
  const recorded = path.resolve(String(reportVideoPath || ""));
  if (recorded === videoPath) return true;
  if (path.dirname(recorded) !== path.dirname(videoPath)) return false;
  return !await safeStat(recorded);
}

export async function publishedVideoNames(root) {
  const names = [];
  const entries = await fs.readdir(root, { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    if (entry.isFile() && entry.name.toLowerCase().endsWith(".mp4")) names.push(entry.name);
    if (!entry.isDirectory()) continue;
    const children = await fs.readdir(path.join(root, entry.name), { withFileTypes: true }).catch(() => []);
    names.push(...children
      .filter((child) => child.isFile() && child.name.toLowerCase().endsWith(".mp4"))
      .map((child) => child.name));
  }
  return names;
}

export async function publishVideo(source, studio, name, title, renderDir = null) {
  const outputDir = path.join(studio.videoOutputRoot, name);
  await fs.mkdir(outputDir, { recursive: true });
  const target = path.join(
    outputDir,
    nextDisplayVideoFileName(title, await publishedVideoNames(studio.videoOutputRoot)),
  );
  // The published video carries its own timeline, named after itself, so it
  // stays page-editable wherever the folder is moved and never borrows the
  // boundaries of another run that landed in the same folder.
  if (renderDir) {
    await fs.copyFile(
      path.join(renderDir, "timeline.json"),
      path.join(outputDir, videoTimelineFileName(target)),
    ).catch(() => {});
  }
  if (path.resolve(source) === path.resolve(target)) return target;
  try {
    await fs.rename(source, target);
  } catch (error) {
    if (error?.code !== "EXDEV") throw error;
    await fs.copyFile(source, target);
    await fs.unlink(source);
  }
  return target;
}

export async function safeStat(file) {
  try { return await fs.stat(file); } catch { return null; }
}

export async function existingFile(file) {
  return file && await safeStat(file) ? file : null;
}

export async function listDirectories(root) {
  const entries = await fs.readdir(root, { withFileTypes: true }).catch(() => []);
  return entries.filter((item) => item.isDirectory() && /^[a-z0-9][a-z0-9-]*$/.test(item.name));
}

// 검증 기록은 다음에 열 때의 유일한 근거다. 쓰다 만 파일이 남으면 그 결과는
// 통째로 읽히지 않으므로, 옆에 다 쓰고 나서 자리를 바꾼다.
export async function writeReport(reportPath, report, tag) {
  const temporary = `${reportPath}.${tag}-${process.pid}.tmp`;
  await fs.writeFile(temporary, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  await fs.rename(temporary, reportPath);
  return report;
}

// 영상 하나만 바꿔 부르면 이름을 나눠 갖던 타임라인이 뒤에 남는다. 그러면
// 다음 검수에서 페이지를 잃으므로, 이름을 함께 쓰던 곁 파일도 같이 옮긴다.
export async function renameMediaFile(file, rawName) {
  const directory = path.dirname(file);
  const previous = path.basename(file);
  const next = renamedFileName(previous, rawName);
  if (next === previous) return file;
  const target = path.join(directory, next);
  if (await safeStat(target)) throw new Error("같은 이름의 파일이 이미 있습니다.");
  const previousStem = path.basename(previous, path.extname(previous));
  const nextStem = path.basename(next, path.extname(next));
  await fs.rename(file, target);
  for (const entry of await fs.readdir(directory).catch(() => [])) {
    if (entry === next || !entry.startsWith(`${previousStem}.`)) continue;
    await fs.rename(path.join(directory, entry), path.join(directory, `${nextStem}${entry.slice(previousStem.length)}`))
      .catch(() => {});
  }
  return target;
}

// 기록이 파일을 가리키고 있었다면 옮긴 자리를 함께 적어 둔다. 화면에 뜨는
// 이름도 파일 이름을 따라간다 — 둘이 다르면 어느 쪽이 이 영상인지 알 수 없다.
export async function repointReport(directory, previous, next) {
  return repointReportFile(path.join(directory, "validation-report.json"), previous, next);
}

export async function repointReportFile(reportPath, previous, next) {
  const report = await fs.readFile(reportPath, "utf8").then(JSON.parse).catch(() => null);
  if (!report) return null;
  const updated = { ...report, displayName: path.basename(next, path.extname(next)) };
  for (const key of ["videoPath", "audioPath"]) {
    if (report[key] && path.resolve(report[key]) === previous) updated[key] = next;
  }
  return writeReport(reportPath, updated, "rename");
}
