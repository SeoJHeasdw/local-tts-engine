import fs from "node:fs/promises";
import { createReadStream } from "node:fs";
import crypto from "node:crypto";
import path from "node:path";
import { nextDisplayVideoFileName, renamedFileName, videoTimelineFileName } from "../shared/index.mjs";

export async function fileSha256(file) {
  const hash = crypto.createHash('sha256');
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest('hex');
}

export async function findVideo(renderDir, name, expectedFileName = null) {
  if (expectedFileName) {
    const file = path.join(renderDir, expectedFileName);
    return (await safeStat(file))?.isFile() ? file : null;
  }
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

// A Finder rename can retain review evidence only when the video bytes match.
// Legacy exact-path pending reports remain readable. Approval requires a digest;
// its historical record remains on disk when the current bytes are unverifiable.
export async function reportDescribesVideo(reportVideoPath, videoPath, report = {}, currentSha256 = null) {
  if (!reportVideoPath || !videoPath) return false;
  const recorded = path.resolve(String(reportVideoPath || ""));
  const selected = path.resolve(videoPath);
  if (recorded !== selected && (path.dirname(recorded) !== path.dirname(selected)
      || await safeStat(recorded))) return false;
  const recordedDigests = [report.videoSha256, report.capture?.fileSha256, report.review?.fileSha256]
    .filter(value => value != null);
  if (recordedDigests.some(value => typeof value !== 'string' || !/^[a-f0-9]{64}$/i.test(value))) return false;
  const digests = recordedDigests;
  if (!digests.length) return recorded === selected && report.review?.status !== 'approved';
  try {
    const digest = currentSha256 || await fileSha256(selected);
    return digests.every(expected => expected.toLowerCase() === digest);
  } catch { return false; }
}

async function publishedVideoNames(root) {
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
    );
    // 강의의 정본은 자막 없는 영상 + 자막 파일이다. Udemy·유튜브에 올릴 때 짝을 찾기 쉽게
    // 영상과 같은 이름으로 둔다(이름을 바꾸면 renameMediaFile이 함께 옮긴다).
    const stem = path.join(outputDir, path.basename(target, path.extname(target)));
    for (const extension of ["srt", "vtt"]) {
      await fs.copyFile(path.join(renderDir, `captions.${extension}`), `${stem}.${extension}`).catch(() => {});
    }
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
  const temporary = `${reportPath}.${tag}-${process.pid}-${crypto.randomUUID()}.tmp`;
  await fs.writeFile(temporary, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  await fs.rename(temporary, reportPath);
  return report;
}

// 영상 하나만 바꿔 부르면 이름을 나눠 갖던 타임라인이 뒤에 남는다. 그러면
// 다음 검수에서 페이지를 잃으므로, 이름을 함께 쓰던 곁 파일도 같이 옮긴다.
export async function renameMediaFile(file, rawName, { fs: fileSystem = fs } = {}) {
  const directory = path.dirname(file);
  const previous = path.basename(file);
  const next = renamedFileName(previous, rawName);
  if (next === previous) return file;
  const target = path.join(directory, next);
  const previousStem = path.basename(previous, path.extname(previous));
  const nextStem = path.basename(next, path.extname(next));
  const companions = (await fileSystem.readdir(directory, { withFileTypes: true }))
    .filter(entry => entry.name !== previous && entry.name.startsWith(`${previousStem}.`)
      && (entry.isFile() || entry.isSymbolicLink()))
    .map(entry => ({ from: path.join(directory, entry.name),
      to: path.join(directory, `${nextStem}${entry.name.slice(previousStem.length)}`) }));
  const moves = [{ from: file, to: target }, ...companions];
  for (const { to } of moves) {
    try {
      await fileSystem.lstat(to);
      throw new Error("같은 이름의 영상 또는 연결 파일이 이미 있습니다.");
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  const reserve = async (from, to) => {
    try { await fileSystem.link(from, to); }
    catch (error) {
      if (!['ENOTSUP', 'EOPNOTSUPP', 'EXDEV', 'EPERM'].includes(error.code)) throw error;
      // External volumes may not support hard links. Exclusive copies retain
      // the same no-overwrite contract and preserve the original until commit.
      await fileSystem.copyFile(from, to, fs.constants.COPYFILE_EXCL);
    }
  };
  const linked = [], removed = [];
  try {
    // Hard links provide an atomic no-replace operation in this same directory.
    // Keep every original until all destinations have been reserved successfully.
    for (const move of moves) { await reserve(move.from, move.to); linked.push(move); }
    for (const move of moves) { await fileSystem.unlink(move.from); removed.push(move); }
  } catch (error) {
    const recoveryErrors = [];
    for (const move of removed.reverse()) {
      try { await reserve(move.to, move.from); }
      catch (recoveryError) { recoveryErrors.push(recoveryError); }
    }
    if (!recoveryErrors.length) {
      for (const move of linked.reverse()) {
        try { await fileSystem.unlink(move.to); }
        catch (recoveryError) { recoveryErrors.push(recoveryError); }
      }
    }
    if (recoveryErrors.length) throw new AggregateError([error, ...recoveryErrors],
      "이름 변경을 복구하지 못했습니다. 원본과 연결 파일을 확인해 주세요.");
    if (error.code === 'EEXIST') throw new Error("같은 이름의 영상 또는 연결 파일이 이미 있습니다.");
    throw error;
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
