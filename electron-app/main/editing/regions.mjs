import nativeFs from "node:fs/promises";
import path from "node:path";
import { captionText, editedReviewContext, regionReplacementPlan, retimeCaptions } from "./review-media.mjs";
import { muteRegionFilter, patchedTimeline, summarizeChecks, videoTimelineFileName } from "../../shared/index.mjs";
import { safeStat } from "../files.mjs";

export function createEditingRegionsService({
  chosenRecord,
  fs = nativeFs,
  inspectMedia,
  requireRuntimeTool,
  runProcess,
  validateEditVideo,
}) {
  async function runMuteEdit(options, outputDir) {
    const record = chosenRecord(options.videoToken, "video");
    const probe = await inspectMedia(record.path);
    if (!probe.streams?.some(stream => stream.codec_type === "audio")) throw new Error("음성 트랙이 없는 영상입니다.");
    const start = Number(options.muteStart), end = Number(options.muteEnd);
    const filter = muteRegionFilter(start, end, Number(probe.format?.duration));
    const output = path.join(outputDir, `${options.name}.mp4`);
    await runProcess("edit", requireRuntimeTool("ffmpeg", "FFmpeg"), [
      "-n", "-hide_banner", "-nostats", "-i", record.path, "-map", "0:v:0", "-map", "0:a:0",
      "-c:v", "copy", "-af", filter, "-c:a", "aac", "-b:a", "192k", "-movflags", "+faststart", output,
    ]);
    if (record.timelinePath) {
      await fs.copyFile(record.timelinePath, path.join(outputDir, "timeline.json"));
      await fs.copyFile(record.timelinePath, path.join(outputDir, videoTimelineFileName(output)));
    }
    const report = await validateEditVideo(output, "mute-region", [record.path], outputDir);
    report.repair = { startMs: Math.round(start * 1000), endMs: Math.round(end * 1000), fadeMs: 5 };
    const original=record.reportPath?await fs.readFile(record.reportPath,'utf8').then(JSON.parse):null;
    Object.assign(report,editedReviewContext(original,start*1000,end*1000,(end-start)*1000,'mute-region'));
    report.displayName=`${path.parse(record.name).name} — 짧은 소리 제거`;
    if(record.timelinePath)report.timelinePath=path.join(outputDir,'timeline.json');
    if(record.reportPath)for(const name of ['captions.json','captions.srt','captions.vtt']){
      const file=path.join(path.dirname(record.reportPath),name);
      if(await safeStat(file))await fs.copyFile(file,path.join(outputDir,name));
    }
    await fs.writeFile(path.join(outputDir, "validation-report.json"), `${JSON.stringify(report, null, 2)}\n`);
    return report;
  }

  async function runRegionReplaceEdit(options, outputDir) {
    const video = chosenRecord(options.videoToken, "video");
    const audio = chosenRecord(options.audioToken, "audio");
    const [videoProbe, audioProbe] = await Promise.all([inspectMedia(video.path), inspectMedia(audio.path)]);
    if (!videoProbe.streams?.some(s => s.codec_type === "audio") || !audioProbe.streams?.some(s => s.codec_type === "audio")) throw new Error("영상과 교체 파일에 음성 트랙이 필요합니다.");
    const start = Number(options.muteStart), end = Number(options.muteEnd);
    const plan = regionReplacementPlan(start, end, Number(videoProbe.format?.duration), Number(audioProbe.format?.duration), options.durationPolicy);
    const output = path.join(outputDir, `${options.name}.mp4`);
    await runProcess("edit", requireRuntimeTool("ffmpeg", "FFmpeg"), [
      "-n", "-hide_banner", "-nostats", "-i", video.path, "-i", audio.path,
      "-filter_complex", plan.filter, "-map", plan.videoOutput, "-map", plan.audioOutput,
      ...(plan.videoUnchanged ? ["-c:v", "copy"] : ["-c:v", "libx264", "-preset", "medium", "-crf", "18", "-pix_fmt", "yuv420p"]),
      "-c:a", "aac", "-b:a", "192k", "-ar", "48000", "-movflags", "+faststart", output,
    ]);
    if (video.timelinePath) {
      const oldTimeline = JSON.parse(await fs.readFile(video.timelinePath, 'utf8'));
      const timeline = plan.deltaMs ? patchedTimeline(oldTimeline, Math.round(start*1000), Math.round(end*1000), Math.round(plan.replacementDuration*1000)) : oldTimeline;
      if(plan.deltaMs) timeline.editTiming = {method:'proportional-region-retime', startMs:Math.round(start*1000), endMs:Math.round(end*1000)};
      for (const name of ['timeline.json', videoTimelineFileName(output)]) await fs.writeFile(path.join(outputDir,name),`${JSON.stringify(timeline,null,2)}\n`);
    }
    const report = await validateEditVideo(output, "replace-region", [video.path, audio.path], outputDir);
    report.plannedDurationMs=Math.round(Number(videoProbe.format.duration)*1000)+plan.deltaMs;
    report.checks.push({label:'교체 후 예상 길이',ok:Math.abs(report.durationMs-report.plannedDurationMs)<=100});
    report.summary=summarizeChecks(report.checks);
    report.repair = { startMs:Math.round(start*1000), endMs:Math.round(end*1000), audioDurationMs:Math.round(Number(audioProbe.format.duration)*1000), fadeMs:5, durationPolicy:options.durationPolicy, deltaMs:plan.deltaMs };
    if(video.timelinePath) report.timelinePath=path.join(outputDir,'timeline.json');
    // Preserve the other review findings and their cleared status through an edit.
    const original = video.reportPath ? await fs.readFile(video.reportPath,'utf8').then(JSON.parse) : null;
    Object.assign(report,editedReviewContext(original,start*1000,end*1000,plan.replacementDuration*1000,'replace-region'));
    report.displayName=`${path.parse(video.name).name} — 구간 음성 교체`;
    const captionDir=video.reportPath ? path.dirname(video.reportPath) : path.dirname(video.timelinePath || video.path);
    const oldCaptions=await fs.readFile(path.join(captionDir,'captions.json'),'utf8').then(JSON.parse).catch(()=>null);
    if(oldCaptions){
      const captions=retimeCaptions(oldCaptions,start*1000,end*1000,plan.replacementDuration*1000);
      await fs.writeFile(path.join(outputDir,'captions.json'),`${JSON.stringify(captions,null,2)}\n`);
      await fs.writeFile(path.join(outputDir,'captions.srt'),captionText(captions));
      await fs.writeFile(path.join(outputDir,'captions.vtt'),captionText(captions,true));
    }
    await fs.writeFile(path.join(outputDir, "validation-report.json"), `${JSON.stringify(report, null, 2)}\n`);
    if(!report.summary.ok)throw new Error('교체 후 영상 길이 검증에 실패했습니다.');
    return report;
  }

  return { runMuteEdit, runRegionReplaceEdit };
}
