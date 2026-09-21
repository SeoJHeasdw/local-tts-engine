import crypto from "node:crypto";
import nativeFs from "node:fs/promises";
import path from "node:path";
import { ADAPTER, DEFAULT_QUALITY_ATTEMPTS, FINETUNE_RUN_ROOT, FINETUNE_TRAIN_JSONL, dateFolder, runtimePaths } from "./paths.mjs";
import { assertPageReplaceable, mapWithConcurrency, voiceQualityFindings } from "../shared/index.mjs";
import { pathToFileURL } from "node:url";

export function createVoicesService({
  chosenRecord,
  emit,
  fs = nativeFs,
  inspectMedia,
  readAppSettings,
  registerSelected,
  requireRuntimeTool,
  runProcess,
  saveAppSettings,
  state,
}) {
  async function generateReplacementVoice(options, outputDir) {
    const studio = runtimePaths(options.paths);
    const voiceDir = path.join(outputDir, "generated-voice");
    const args = [
      "-m", "local_tts_engine.course_pilot",
      "--source-project", studio.sourceProjectRoot,
      "--reference", studio.referenceAudioPath,
      "--reference-text", studio.referenceTextPath,
      "--output-dir", voiceDir,
      "--target-seconds", "30",
      "--start-page", String(options.startPage),
      "--end-page", String(options.endPage),
      "--model", options.modelId || "qwen3-tts",
      "--no-cache",
      "--quality-attempts", String(options.qualityAttempts || DEFAULT_QUALITY_ATTEMPTS),
    ];
    if (options.seed) args.push("--seed", String(options.seed));
    if (options.recoveryFindings?.length) {
      const recoveryPath = path.join(outputDir, "recovery-findings.json");
      await fs.writeFile(recoveryPath, `${JSON.stringify(options.recoveryFindings, null, 2)}\n`, "utf8");
      args.push("--recovery-findings", recoveryPath);
    }
    if (options.voiceMode !== "zero") {
      args.push("--adapter", options.adapterPath || ADAPTER, "--adapter-scale", String(options.adapterScale));
    }
    await runProcess("voice", requireRuntimeTool("trainPython", "음성 생성 Python"), args);
    const manifest = JSON.parse(await fs.readFile(path.join(voiceDir, "manifest.json"), "utf8"));
    const firstChunk = manifest.chunks?.[0];
    const lastChunk = manifest.chunks?.at(-1);
    if (!firstChunk || !lastChunk) throw new Error("생성된 목소리의 음성 구간을 찾지 못했습니다.");
    return {
      audioPath: manifest.audioPath,
      voiceFindings: voiceQualityFindings(manifest),
      generatedVoice: {
        manifestPath: path.join(voiceDir, "manifest.json"),
        sourceStartMs: Number(firstChunk.startMs),
        sourceEndMs: Number(lastChunk.endMs),
        startPage: Number(options.startPage),
        endPage: Number(options.endPage),
      },
    };
  }

  // 다시 읽히기만으로 풀리지 않는 자리가 있다. 사전에 없는 식별자나 낯선 약어는
  // 몇 번을 다시 만들어도 같은 자리에서 같게 읽힌다. 그때는 읽을 말을 사람이
  // 직접 적어 준다. 자막·대본은 그대로 두고 발음문만 이 문장으로 바꾸는 셈이라,
  // 기존 발음문·자막 원문 분리와 같은 규칙 위에 선다.
  async function generateSpokenText(options, outputDir) {
    const studio = runtimePaths(options.paths);
    const textPath = path.join(outputDir, "spoken-text.txt");
    const audioPath = path.join(outputDir, "spoken.wav");
    const metadataPath = path.join(outputDir, "spoken.json");
    await fs.mkdir(outputDir, { recursive: true });
    await fs.writeFile(textPath, `${options.overrideText}\n`, "utf8");
    const args = [
      "-m", "local_tts_engine.text_candidate",
      "--model", options.modelId || "qwen3-tts",
      "--text-file", textPath,
      "--reference", studio.referenceAudioPath,
      "--reference-text", studio.referenceTextPath,
      "--output", audioPath,
      "--metadata", metadataPath,
      "--seed", String(options.seed),
    ];
    if (options.voiceMode !== "zero") {
      args.push("--adapter", options.adapterPath || ADAPTER, "--adapter-scale", String(options.adapterScale));
    }
    await runProcess("voice", requireRuntimeTool("trainPython", "음성 생성 Python"), args);
    const metadata = JSON.parse(await fs.readFile(metadataPath, "utf8"));
    const durationMs = Number(metadata.durationMs);
    if (!(durationMs > 0)) throw new Error("입력한 말로 만든 음성의 길이를 읽지 못했습니다.");
    return {
      audioPath,
      // 입력한 말은 자동 판독의 대조 원문이 없다. 판정을 지어내지 않고 사람이
      // 직접 듣고 고르는 후보로만 둔다.
      voiceFindings: [],
      generatedVoice: {
        metadataPath,
        // 만든 음성 전체가 이 페이지의 음성이 된다. 잘라 낼 구간이 없다.
        sourceStartMs: 0,
        sourceEndMs: durationMs,
        startPage: Number(options.startPage),
        endPage: Number(options.endPage),
        spokenText: options.overrideText,
      },
    };
  }

  async function runVoiceCandidates(options, outputDir) {
    const video = chosenRecord(options.videoToken, "video");
    assertPageReplaceable(video, options);
    const count = Math.min(8, Math.max(2, Math.round(Number(options.candidateCount ?? 3))));
    const digest = crypto.createHash("sha256").update(options.name).digest();
    const baseSeed = digest.readUInt32BE(0);
    const candidates = [];
    for (let index = 0; index < count; index += 1) {
      const candidateName = `candidate-${String(index + 1).padStart(2, "0")}`;
      const candidateDir = path.join(outputDir, "candidates", candidateName);
      await fs.mkdir(candidateDir, { recursive: true });
      const seed = (baseSeed ^ Math.imul(index + 1, 0x9e3779b1)) >>> 0;
      // One take per candidate: the point of candidates is a spread of readings
      // to choose between, not one reading retried until it scores well. They run
      // one at a time because each run holds the generator and the reader at once.
      // Retain one take per visible candidate. A recorded repeated omission can
      // start with a split input instead of spending two new takes rediscovering
      // it. Python requires an exact full-text match before using these hints.
      const generated = options.overrideText
        ? await generateSpokenText({ ...options, seed }, candidateDir)
        : await generateReplacementVoice({ ...options, seed, qualityAttempts: 1,
          recoveryFindings: video.voiceFindings || [] }, candidateDir);
      candidates.push({ index: index + 1, seed, ...generated });
      emit({ type: "voice-item-complete", completed: candidates.length, total: count, name: `후보 ${index + 1}` });
    }
    const registered = await registerSelected(
      candidates.map((item) => item.audioPath),
      "audio",
      candidates.map((item) => ({ generatedVoice: item.generatedVoice })),
    );
    return candidates.map((item, index) => ({
      ...item,
      token: registered[index].token,
      name: `${options.overrideText ? "입력한 말" : "목소리 후보"} ${item.index}`,
      audioUrl: pathToFileURL(item.audioPath).href,
    }));
  }

  async function runTextVoiceCandidates(options) {
    const job = state.activeJob;
    const studio = runtimePaths(options.paths);
    const outputDir = path.join(studio.voiceOutputRoot, dateFolder(), options.name);
    const candidatesDir = path.join(outputDir, "candidates");
    const inputPath = path.join(outputDir, "input.txt");
    await fs.mkdir(candidatesDir, { recursive: true });
    await fs.writeFile(inputPath, `${options.text}\n`, "utf8");
    await fs.unlink(path.join(outputDir, "selected.wav")).catch(() => {});
    await fs.unlink(path.join(outputDir, "validation-report.json")).catch(() => {});

    const digest = crypto.createHash("sha256").update(`${options.name}\n${options.text}`).digest();
    const baseSeed = digest.readUInt32BE(0);
    let completed = 0;
    const candidates = await mapWithConcurrency(
      Array.from({ length: options.candidateCount }, (_, index) => index),
      options.voiceParallelism || 2,
      async (index) => {
        const number = String(index + 1).padStart(2, "0");
        const audioPath = path.join(candidatesDir, `candidate-${number}.wav`);
        const metadataPath = path.join(candidatesDir, `candidate-${number}.json`);
        const seed = (baseSeed ^ Math.imul(index + 1, 0x9e3779b1)) >>> 0;
        const args = [
          "-m", "local_tts_engine.text_candidate",
          "--model", options.modelId,
          "--text-file", inputPath,
          "--reference", studio.referenceAudioPath,
          "--reference-text", studio.referenceTextPath,
          "--output", audioPath,
          "--metadata", metadataPath,
          "--seed", String(seed),
        ];
        if (options.voiceMode === "finetuned") {
          args.push("--adapter", options.adapterPath || ADAPTER, "--adapter-scale", String(options.adapterScale));
        }
        await runProcess("voice", requireRuntimeTool("trainPython", "음성 생성 Python"), args);
        const metadata = JSON.parse(await fs.readFile(metadataPath, "utf8"));
        completed += 1;
        emit({ type: "voice-item-complete", completed, total: options.candidateCount, name: `후보 ${index + 1}` });
        return { index: index + 1, seed, audioPath, metadata };
      },
    );
    if (state.activeJob !== job) return;

    const registered = await registerSelected(candidates.map((item) => item.audioPath), "audio");
    const values = candidates.map((item, index) => ({
      index: item.index,
      seed: item.seed,
      token: registered[index].token,
      name: `목소리 후보 ${item.index}`,
      durationMs: item.metadata.durationMs,
      // 영어 구간을 따로 읽었는지는 후보를 고른 뒤에도 물어보게 된다. 목록만
      // 보고 답할 수 있어야 하므로 없을 때도 null로 남긴다.
      voiceRouting: item.metadata.voiceRouting ?? null,
      audioUrl: pathToFileURL(item.audioPath).href,
    }));
    await fs.writeFile(path.join(outputDir, "index.json"), `${JSON.stringify({
      schemaVersion: 1,
      cachePolicy: "disabled",
      text: options.text,
      modelId: options.modelId,
      candidateCount: options.candidateCount,
      parallelism: options.voiceParallelism,
      candidates: values.map(({ audioUrl: _audioUrl, token: _token, ...item }) => item),
    }, null, 2)}\n`, "utf8");
    job.state = "done";
    job.stage = "awaiting-selection";
    job.outputDir = outputDir;
    job.candidateTokens = new Set(values.map((item) => item.token));
    emit({ type: "text-voices-ready", candidates: values, options });
  }

  async function selectTextVoice(token) {
    if (!state.activeJob || state.activeJob.kind !== "text-voice" || state.activeJob.stage !== "awaiting-selection") {
      throw new Error("선택할 목소리 후보 작업이 없습니다.");
    }
    if (!state.activeJob.candidateTokens?.has(token)) throw new Error("이 작업의 목소리 후보가 아닙니다.");
    const selected = chosenRecord(token, "audio");
    const outputPath = path.join(state.activeJob.outputDir, "selected.wav");
    await fs.copyFile(selected.path, outputPath);
    const probe = await inspectMedia(outputPath);
    const durationMs = Math.round(Number(probe.format?.duration || 0) * 1000);
    const report = {
      schemaVersion: 1,
      generatedAt: new Date().toISOString(),
      name: state.activeJob.options.name,
      operation: "text-voice",
      cachePolicy: "disabled",
      audioPath: outputPath,
      selectedSource: selected.path,
      durationMs,
      summary: { ok: durationMs > 0, passed: durationMs > 0 ? 1 : 0, total: 1, failed: durationMs > 0 ? [] : ["음성 길이"] },
      target: {
        root: "voice",
        day: path.basename(path.dirname(state.activeJob.outputDir)),
        name: state.activeJob.options.name,
      },
    };
    await fs.writeFile(path.join(state.activeJob.outputDir, "validation-report.json"), `${JSON.stringify(report, null, 2)}\n`, "utf8");
    state.activeJob.state = "done";
    state.activeJob.stage = "done";
    emit({ type: "text-voice-selected", report });
    return report;
  }

  async function runFineTune(options) {
    const studio = runtimePaths(options.paths);
    const outputDir = path.join(FINETUNE_RUN_ROOT, dateFolder(), options.name);
    await fs.mkdir(outputDir, { recursive: true });
    await runProcess("training", requireRuntimeTool("trainPython", "음성 생성 Python"), [
      "-m", "local_tts_engine.finetune_mlx",
      "--train-jsonl", FINETUNE_TRAIN_JSONL,
      "--output-dir", outputDir,
      "--max-steps", String(options.maxSteps),
      "--rank", "16",
      "--alpha", "16",
      "--gradient-accumulation", "4",
      "--learning-rate", "0.00002",
      "--eval-output", path.join(outputDir, "eval-after.wav"),
      "--reference", studio.referenceAudioPath,
      "--reference-text", studio.referenceTextPath,
    ]);
    const result = JSON.parse(await fs.readFile(path.join(outputDir, "training-result.json"), "utf8"));
    const settings = await readAppSettings();
    const adapter = settings.adapters.find((item) => item.path === result.adapterDir)
      || settings.adapters.find((item) => item.label === options.name)
      || null;
    const updatedSettings = adapter
      ? await saveAppSettings({ ...settings, modelId: "qwen3-tts", adapterId: adapter.id })
      : settings;
    state.activeJob.state = "done";
    state.activeJob.stage = "done";
    emit({ type: "training-complete", result, adapter, settings: updatedSettings });
  }

  return { generateReplacementVoice, runVoiceCandidates, runTextVoiceCandidates, selectTextVoice, runFineTune };
}
