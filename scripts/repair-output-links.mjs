#!/usr/bin/env node
// Finder에서 결과 영상의 이름을 바꾸면, 검증 기록에 적힌 경로만 옛 이름으로
// 남는다. 앱은 그런 경우에도 같은 폴더의 영상을 찾아 이어 주지만, 기록 자체가
// 어긋난 채로 쌓이면 다음에 그 파일을 무엇이라 불렀는지 알 수 없다. 폴더 안의
// 영상이 하나뿐일 때에만 — 어느 것을 가리켰는지 의심의 여지가 없을 때에만 —
// 기록을 지금 이름으로 맞춘다.
//
//   node scripts/repair-output-links.mjs [output 폴더] [--dry-run]

import fs from "node:fs/promises";
import path from "node:path";

const args = process.argv.slice(2);
const dryRun = args.includes("--dry-run");
const outputRoot = path.resolve(args.find((item) => !item.startsWith("--")) || "output");

async function* reportDirectories(root) {
  for (const entry of await fs.readdir(root, { withFileTypes: true }).catch(() => [])) {
    if (!entry.isDirectory()) continue;
    const directory = path.join(root, entry.name);
    if (await fs.stat(path.join(directory, "validation-report.json")).catch(() => null)) yield directory;
    else yield* reportDirectories(directory);
  }
}

let repaired = 0;
let checked = 0;
for await (const directory of reportDirectories(outputRoot)) {
  const reportPath = path.join(directory, "validation-report.json");
  const report = await fs.readFile(reportPath, "utf8").then(JSON.parse).catch(() => null);
  if (!report?.videoPath) continue;
  checked += 1;
  const recorded = path.resolve(report.videoPath);
  if (await fs.stat(recorded).catch(() => null)) continue;
  if (path.dirname(recorded) !== path.resolve(directory)) continue;
  const videos = (await fs.readdir(directory).catch(() => []))
    .filter((name) => name.toLowerCase().endsWith(".mp4"));
  if (videos.length !== 1) {
    console.log(`건너뜀 ${path.relative(outputRoot, directory)} · 영상 ${videos.length}개라 어느 것인지 정할 수 없음`);
    continue;
  }
  const videoPath = path.join(directory, videos[0]);
  const updated = {
    ...report,
    videoPath,
    displayName: path.basename(videos[0], path.extname(videos[0])),
  };
  console.log(`${dryRun ? "바꿀 예정" : "맞춤"} ${path.relative(outputRoot, directory)}`);
  console.log(`  ${path.basename(recorded)} → ${videos[0]}`);
  repaired += 1;
  if (dryRun) continue;
  // 영상만 바꿔 부르면 이름을 나눠 갖던 타임라인이 옛 이름으로 남는다. 같이 옮긴다.
  const previousStem = path.basename(recorded, path.extname(recorded));
  const nextStem = updated.displayName;
  for (const entry of await fs.readdir(directory).catch(() => [])) {
    if (!entry.startsWith(`${previousStem}.`)) continue;
    const moved = path.join(directory, `${nextStem}${entry.slice(previousStem.length)}`);
    if (await fs.stat(moved).catch(() => null)) continue;
    await fs.rename(path.join(directory, entry), moved);
    console.log(`  ${entry} → ${path.basename(moved)}`);
  }
  const temporary = `${reportPath}.repair-${process.pid}.tmp`;
  await fs.writeFile(temporary, `${JSON.stringify(updated, null, 2)}\n`, "utf8");
  await fs.rename(temporary, reportPath);
}

console.log(`\n검증 기록 ${checked}개 확인 · ${repaired}개 ${dryRun ? "수정 필요" : "수정함"}`);
