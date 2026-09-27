import crypto from "node:crypto";
import nativeFs from "node:fs/promises";
import path from "node:path";
import { ADAPTER, DEFAULT_QUALITY_ATTEMPTS, FINETUNE_RUN_ROOT, FINETUNE_TRAIN_JSONL, LEGACY_OUTPUT_PATHS, dateFolder, runtimePaths } from "./paths.mjs";
import { assertPageReplaceable, isInside, mapWithConcurrency, voiceQualityFindings } from "../shared/index.mjs";
import { pathToFileURL } from "node:url";
import { assertCurrentCourseManifest } from "./course-run-state.mjs";

export function createVoicesService({
  chosenRecord,
  emit,
  fs = nativeFs,
  inspectMedia,
  readAppSettings,
  registerSelected,
  requireRuntimeTool,
  resolveOutputTarget,
  runProcess,
  saveAppSettings,
  state,
}) {
  async function sha256File(file) {
    const digest = crypto.createHash("sha256");
    const handle = await fs.open(file, "r");
    const block = Buffer.allocUnsafe(1024 * 1024);
    try {
      for (;;) {
        const { bytesRead } = await handle.read(block, 0, block.length, null);
        if (!bytesRead) break;
        digest.update(block.subarray(0, bytesRead));
      }
    } finally { await handle.close(); }
    return digest.digest("hex");
  }

  async function verifyCandidateBytes(audioPath, metadata) {
    if (Number(metadata?.schemaVersion) >= 2 && !metadata?.audioSha256) {
      throw new Error("후보 음성의 파일 일치 검사 기록이 없습니다. 다시 만들어 주세요.");
    }
    if (metadata?.audioSha256 && (!/^[a-f0-9]{64}$/i.test(metadata.audioSha256)
      || metadata.audioSha256.toLowerCase() !== await sha256File(audioPath))) {
      throw new Error("후보 음성이 생성 당시 파일과 달라졌습니다. 다시 만들어 주세요.");
    }
  }

  function candidateEvidence(metadata) {
    const bound = Boolean(metadata?.audioSha256);
    return {
      qualityReview: bound ? metadata.qualityReview || { enabled: false, status: "not-checked" }
        : { enabled: false, status: "not-checked", reason: "audio-hash-unavailable" },
      finalTrack: bound ? metadata.finalTrack || null : null,
    };
  }

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
    await assertCurrentCourseManifest(voiceDir, manifest, fs);
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
      qualityReview: { enabled: false, status: "not-checked" },
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
    const dayRoot = path.join(studio.voiceOutputRoot, dateFolder());
    await fs.mkdir(dayRoot, { recursive: true });
    let outputDir;
    let outputName;
    for (let attempt = 0; attempt < 100; attempt += 1) {
      outputName = attempt ? `${options.name.slice(0, 55)}-${attempt + 1}` : options.name;
      outputDir = path.join(dayRoot, outputName);
      try { await fs.mkdir(outputDir); break; }
      catch (error) { if (error.code !== "EEXIST" || attempt === 99) throw error; }
    }
    job.options.name = outputName;
    const candidatesDir = path.join(outputDir, "candidates");
    const inputPath = path.join(outputDir, "input.txt");
    await fs.mkdir(candidatesDir, { recursive: true });
    await fs.writeFile(inputPath, `${options.text}\n`, "utf8");
    const digest = crypto.createHash("sha256").update(`${outputName}\n${options.text}`).digest();
    const baseSeed = digest.readUInt32BE(0);
    let completed = 0;
    const completedCandidates = [];
    const failedCandidates = [];
    async function saveCandidateIndex(candidates, status) {
      if (!candidates.length) return;
      const record = {
        schemaVersion: 1,
        cachePolicy: "disabled",
        status,
        text: options.text,
        modelId: options.modelId,
        candidateCount: options.candidateCount,
        parallelism: options.voiceParallelism || 1,
        failedCandidates,
        candidates: candidates.map((item) => ({
          index: item.index,
          seed: item.seed,
          name: `목소리 후보 ${item.index}`,
          durationMs: item.metadata.durationMs,
          voiceRouting: item.metadata.voiceRouting ?? null,
          qualityReview: candidateEvidence(item.metadata).qualityReview,
        })),
      };
      const indexPath = path.join(outputDir, "index.json");
      const temporaryPath = `${indexPath}.tmp-${crypto.randomUUID()}`;
      await fs.writeFile(temporaryPath, `${JSON.stringify(record, null, 2)}\n`, "utf8");
      try { await fs.rename(temporaryPath, indexPath); }
      catch (error) { await fs.unlink(temporaryPath).catch(() => {}); throw error; }
    }
    let candidates;
    try {
      candidates = await mapWithConcurrency(
        Array.from({ length: options.candidateCount }, (_, index) => index),
        options.voiceParallelism || 1,
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
            "--quality-review",
            "--quality-attempts", String(DEFAULT_QUALITY_ATTEMPTS),
          ];
          if (options.voiceMode === "finetuned") {
            args.push("--adapter", options.adapterPath || ADAPTER, "--adapter-scale", String(options.adapterScale));
          }
          try {
            await runProcess("voice", requireRuntimeTool("trainPython", "음성 생성 Python"), args);
            const metadata = JSON.parse(await fs.readFile(metadataPath, "utf8"));
            await verifyCandidateBytes(audioPath, metadata);
            const candidate = { index: index + 1, seed, audioPath, metadata };
            completedCandidates[index] = candidate;
            completed += 1;
            emit({ type: "voice-item-complete", completed, total: options.candidateCount, name: `후보 ${index + 1}` });
            return candidate;
          } catch (error) {
            failedCandidates.push({ index: index + 1, message: String(error.message || error) });
            throw error;
          }
        },
      );
    } catch (error) {
      const available = completedCandidates.filter(Boolean);
      if (available.length) {
        try { await saveCandidateIndex(available, job.cancelled ? "cancelled" : "partial"); }
        catch (indexError) {
          throw new Error(`${error.message}\n완성된 후보의 목록도 저장하지 못했습니다: ${indexError.message}`, { cause: error });
        }
      }
      throw error;
    }
    if (state.activeJob !== job) return;

    let registered;
    try { registered = await registerSelected(candidates.map((item) => item.audioPath), "audio"); }
    catch (error) {
      await saveCandidateIndex(candidates, "registration-failed");
      throw error;
    }
    await saveCandidateIndex(candidates, "complete");
    const values = candidates.map((item, index) => ({
      index: item.index,
      seed: item.seed,
      token: registered[index].token,
      name: `목소리 후보 ${item.index}`,
      durationMs: item.metadata.durationMs,
      // 영어 구간을 따로 읽었는지는 후보를 고른 뒤에도 물어보게 된다. 목록만
      // 보고 답할 수 있어야 하므로 없을 때도 null로 남긴다.
      voiceRouting: item.metadata.voiceRouting ?? null,
      qualityReview: candidateEvidence(item.metadata).qualityReview,
      audioUrl: pathToFileURL(item.audioPath).href,
    }));
    job.state = "done";
    job.stage = "awaiting-selection";
    job.outputDir = outputDir;
    job.candidateTokens = new Set(values.map((item) => item.token));
    emit({ type: "text-voices-ready", candidates: values, options: { ...options, name: outputName } });
  }

  async function selectTextVoice(token) {
    if (!state.activeJob || state.activeJob.kind !== "text-voice" || state.activeJob.stage !== "awaiting-selection") {
      throw new Error("선택할 목소리 후보 작업이 없습니다.");
    }
    if (!state.activeJob.candidateTokens?.has(token)) throw new Error("이 작업의 목소리 후보가 아닙니다.");
    const selected = chosenRecord(token, "audio");
    const chosenName = path.basename(selected.path);
    const selectedIndex = /^candidate-(\d{2})\.wav$/.exec(chosenName)?.[1];
    const metadataPath = selectedIndex
      ? path.join(path.dirname(selected.path), `candidate-${selectedIndex}.json`)
      : null;
    const metadata = metadataPath
      ? await fs.readFile(metadataPath, "utf8").then(JSON.parse).catch(() => null)
      : null;
    const outputDir = state.activeJob.outputDir;
    const report = await saveTextVoiceSelection({
      sourcePath: selected.path,
      outputDir,
      name: state.activeJob.options.name,
      metadata,
      selectedCandidateIndex: selectedIndex ? Number(selectedIndex) : null,
    });
    state.activeJob.state = "done";
    state.activeJob.stage = "done";
    emit({ type: "text-voice-selected", report });
    return report;
  }

  async function saveTextVoiceSelection({ sourcePath, outputDir, name, metadata, selectedCandidateIndex, sourceCandidates = null }) {
    await verifyCandidateBytes(sourcePath, metadata);
    if (metadata?.finalTrack?.status === "failed") {
      throw new Error("완성 음성 무결성 검사를 통과하지 못한 후보입니다.");
    }
    const outputPath = path.join(outputDir, "selected.wav");
    await fs.copyFile(sourcePath, outputPath);
    const probe = await inspectMedia(outputPath);
    const durationMs = Math.round(Number(probe.format?.duration || 0) * 1000);
    if (!(durationMs > 0)) throw new Error("선택한 목소리의 길이를 확인하지 못했습니다.");
    const evidence = candidateEvidence(metadata);
    const report = {
      schemaVersion: 1,
      generatedAt: new Date().toISOString(),
      name,
      operation: "text-voice",
      cachePolicy: "disabled",
      audioPath: outputPath,
      selectedSource: sourcePath,
      selectedCandidateIndex,
      ...(sourceCandidates ? { sourceCandidates } : {}),
      qualityReview: evidence.qualityReview,
      finalTrack: evidence.finalTrack,
      durationMs,
      // File integrity is separate from content or listening approval.
      summary: { ok: true, passed: 1, total: 1, failed: [] },
      target: {
        root: "voice",
        day: path.basename(path.dirname(outputDir)),
        name,
      },
    };
    await fs.writeFile(path.join(outputDir, "validation-report.json"), `${JSON.stringify(report, null, 2)}\n`, "utf8");
    return report;
  }

  async function readTextVoiceCandidateSet(target) {
    if (!resolveOutputTarget || target?.root !== "voice") throw new Error("목소리 결과를 선택해 주세요.");
    const settings = await readAppSettings();
    const studio = runtimePaths(settings.paths);
    const directory = resolveOutputTarget(target, studio);
    const report = await fs.readFile(path.join(directory, "validation-report.json"), "utf8").then(JSON.parse).catch(() => null);
    const sourceTarget = report?.sourceCandidates || target;
    if (sourceTarget?.root !== "voice") throw new Error("원본 후보 기록이 올바르지 않습니다.");
    const sourceDir = resolveOutputTarget(sourceTarget, studio);
    const allowedRoot = sourceTarget.store === "legacy" ? LEGACY_OUTPUT_PATHS.voiceOutputRoot : studio.voiceOutputRoot;
    const realRoot = await fs.realpath(allowedRoot).catch(() => null);
    const realSourceDir = await fs.realpath(sourceDir).catch(() => null);
    if (!realRoot || !realSourceDir || !isInside(realRoot, realSourceDir)) throw new Error("목소리 후보 폴더가 결과물 밖에 있습니다.");
    async function readCandidateJson(file) {
      const stat = await fs.lstat(file).catch(() => null);
      if (!stat?.isFile() || stat.isSymbolicLink() || !isInside(realRoot, await fs.realpath(file))) return null;
      return fs.readFile(file, "utf8").then(JSON.parse).catch(() => null);
    }
    const index = await readCandidateJson(path.join(sourceDir, "index.json"));
    if (index?.schemaVersion !== 1 || !Array.isArray(index.candidates) || !index.candidates.length || index.candidates.length > 8) {
      throw new Error("이 결과의 목소리 후보 기록을 찾지 못했습니다.");
    }
    const seen = new Set();
    const candidates = [];
    for (const item of index.candidates) {
      const number = Number(item.index);
      if (!Number.isInteger(number) || number < 1 || number > 8 || seen.has(number)) throw new Error("목소리 후보 번호가 올바르지 않습니다.");
      seen.add(number);
      const base = `candidate-${String(number).padStart(2, "0")}`;
      const audioPath = path.join(sourceDir, "candidates", `${base}.wav`);
      const stat = await fs.lstat(audioPath).catch(() => null);
      if (!stat?.isFile() || stat.isSymbolicLink() || !isInside(realRoot, await fs.realpath(audioPath))) {
        throw new Error(`후보 ${number} 음성 파일을 확인하지 못했습니다.`);
      }
      const metadata = await readCandidateJson(path.join(sourceDir, "candidates", `${base}.json`));
      await verifyCandidateBytes(audioPath, metadata);
      candidates.push({
        index: number,
        name: `목소리 후보 ${number}`,
        seed: item.seed,
        durationMs: metadata?.audioSha256 ? metadata?.durationMs || item.durationMs || null : null,
        voiceRouting: metadata?.voiceRouting ?? item.voiceRouting ?? null,
        qualityReview: candidateEvidence(metadata).qualityReview,
        audioUrl: pathToFileURL(audioPath).href,
        audioPath,
        metadata,
      });
    }
    const selectedCandidateIndex = Number(report?.selectedCandidateIndex)
      || Number(/^candidate-(\d{2})\.wav$/.exec(path.basename(report?.selectedSource || ""))?.[1])
      || null;
    return { target: sourceTarget, text: String(index.text || ""), selectedCandidateIndex, candidates };
  }

  async function listTextVoiceCandidates(target) {
    const set = await readTextVoiceCandidateSet(target);
    return { ...set, candidates: set.candidates.map(({ audioPath: _audioPath, metadata: _metadata, ...item }) => item) };
  }

  async function selectTextVoiceFromHistory(target, candidateIndex) {
    if (state.activeJob && ["running", "cancelling"].includes(state.activeJob.state)) {
      throw new Error("실행 중인 작업이 끝난 뒤 후보를 선택해 주세요.");
    }
    const set = await readTextVoiceCandidateSet(target);
    const chosen = set.candidates.find((item) => item.index === Number(candidateIndex));
    if (!chosen) throw new Error("목소리 후보 번호를 확인해 주세요.");
    const settings = await readAppSettings();
    const studio = runtimePaths(settings.paths);
    const day = dateFolder();
    const dayRoot = path.join(studio.voiceOutputRoot, day);
    await fs.mkdir(dayRoot, { recursive: true });
    const prefix = `${String(target.name).slice(0, 42)}-take-${String(chosen.index).padStart(2, "0")}`;
    let outputDir;
    let name;
    for (let attempt = 0; attempt < 100; attempt += 1) {
      name = `${prefix}-${Date.now().toString(36)}${attempt ? `-${attempt}` : ""}`;
      outputDir = path.join(dayRoot, name);
      try { await fs.mkdir(outputDir); break; }
      catch (error) { if (error.code !== "EEXIST" || attempt === 99) throw error; }
    }
    const report = await saveTextVoiceSelection({
      sourcePath: chosen.audioPath, outputDir, name, metadata: chosen.metadata,
      selectedCandidateIndex: chosen.index, sourceCandidates: set.target,
    });
    // Reopening a saved take does not start an active text-voice job. State the
    // event's owner so runtime/renderer routing still reaches the voice UI.
    emit({ type: "text-voice-selected", jobKind: "text-voice", report });
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

  return { generateReplacementVoice, runVoiceCandidates, runTextVoiceCandidates, selectTextVoice,
    listTextVoiceCandidates, selectTextVoiceFromHistory, runFineTune };
}
