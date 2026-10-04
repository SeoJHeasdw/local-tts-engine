import nativeFs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL, fileURLToPath } from 'node:url';
import { APP_SETTINGS_PATH, FINETUNE_RUN_ROOT, normalizeStudioPaths, runtimePaths } from "./paths.mjs";
import { settingsAdapterScale } from "../shared/index.mjs";
import { LEGACY_VOICE } from "./training-config.mjs";
import { readVoiceProfile, writeVoiceProfile, voiceInputIdentity, voiceInputMatches } from "./voice-profile.mjs";
import { fileSha256 } from './files.mjs';
import { sameVoiceScale } from '../shared/voice-profile-view.mjs';

export function createSettingsService({
  fs = nativeFs,
  state,
  adapterRoot = FINETUNE_RUN_ROOT,
  settingsPath = APP_SETTINGS_PATH,
  legacyVoice = LEGACY_VOICE,
}) {
  const safeStat = (file) => fs.stat(file).catch(() => null);
  async function discoverAdapters() {
    const adapters = [];
    const days = await fs.readdir(adapterRoot, { withFileTypes: true }).catch(() => []);
    for (const day of days.filter((item) => item.isDirectory())) {
      const dayRoot = path.join(adapterRoot, day.name);
      const runs = await fs.readdir(dayRoot, { withFileTypes: true }).catch(() => []);
      for (const run of runs.filter((item) => item.isDirectory())) {
        const runDirectory = path.join(dayRoot, run.name);
        const id = `${day.name}/${run.name}`;
        const legacy = id === legacyVoice.adapterId;
        const adapterPath = path.join(runDirectory, "adapters");
        if (await safeStat(path.join(adapterPath, "adapters.safetensors"))
            && await safeStat(path.join(adapterPath, "adapter_config.json"))) {
          let profile = null;
          let profileError = null;
          let referencePaths = null;
          try {
            ({ profile, referencePaths } = await readVoiceProfile(runDirectory, { fs }));
          } catch (error) {
            if (error.code === "ENOENT" && legacy) {
              referencePaths = {
                referenceAudioPath: legacyVoice.referenceAudioPath,
                referenceTextPath: legacyVoice.referenceTextPath,
              };
            } else {
              profileError = error.code === "ENOENT" ? "목소리 프로필이 없습니다. 참조 음성·전사를 연결해 주세요."
                : error.code === "INVALID_VOICE_PROFILE" ? error.message : "목소리 프로필을 읽지 못했습니다.";
            }
          }
          if (profile && profile.trainingStatus !== "complete") continue;
          const recordedScale = profile?.approvedScale ?? profile?.listeningApproval?.adapterScale
            ?? (profile?.listeningStatus === 'approved' ? profile?.comparisonScale : null)
            ?? (legacy ? legacyVoice.adapterScale : null);
          let previewUrl = null, previewAudioSha256 = null, previewScale = null;
          let previewAdapterWeightsSha256 = null, previewAdapterConfigSha256 = null;
          let previewReferenceAudioSha256 = null, previewReferenceTextSha256 = null, metadata = null;
          const previewPath = profile?.preview?.audioPath
            ? path.resolve(runDirectory, profile.preview.audioPath) : path.join(runDirectory, 'preview.wav');
          if ((await safeStat(previewPath))?.size > 0) {
            try {
              metadata = await fs.readFile(path.join(path.dirname(previewPath), 'preview.json'), 'utf8').then(JSON.parse).catch(() => null)
                || await fs.readFile(path.join(runDirectory, 'preview.json'), 'utf8').then(JSON.parse).catch(() => null);
              const digest = await fileSha256(previewPath);
              const recordedAudioHash = profile?.preview?.audioSha256 || metadata?.audioSha256;
              if (recordedAudioHash && recordedAudioHash === digest) {
                const sampleMetadata = metadata?.audioSha256 === digest ? metadata : null;
                previewUrl = pathToFileURL(previewPath).href;
                previewAudioSha256 = digest;
                previewScale = profile?.preview?.scale ?? sampleMetadata?.adapter?.scale
                  ?? profile?.trainingConfig?.preview?.scale ?? profile?.comparisonScale ?? null;
                previewAdapterWeightsSha256 = profile?.preview?.adapterWeightsSha256 ?? sampleMetadata?.adapter?.weightsSha256 ?? null;
                previewAdapterConfigSha256 = profile?.preview?.adapterConfigSha256 ?? sampleMetadata?.adapter?.configSha256 ?? null;
                previewReferenceAudioSha256 = profile?.preview?.referenceAudioSha256 ?? sampleMetadata?.referenceAudioSha256 ?? null;
                previewReferenceTextSha256 = profile?.preview?.referenceTextSha256 ?? sampleMetadata?.referenceTextSha256 ?? null;
              }
            } catch { /* An unavailable sample never counts as listening approval. */ }
          }
          let currentIdentity = null;
          try { if (referencePaths) currentIdentity = await voiceInputIdentity(adapterPath, referencePaths, { fs }); }
          catch { /* Missing inputs remain usable for general settings, never production. */ }
          const recordedStatus = profile?.listeningStatus || (legacy && !profileError ? legacyVoice.listeningStatus : 'pending');
          const previewIdentity = { adapterWeightsSha256: previewAdapterWeightsSha256, adapterConfigSha256: previewAdapterConfigSha256,
            referenceAudioSha256: previewReferenceAudioSha256, referenceTextSha256: previewReferenceTextSha256 };
          const plan = profile?.reviewPlan
            ? await fs.readFile(path.resolve(runDirectory, profile.reviewPlan), 'utf8').then(JSON.parse).catch(() => null) : null;
          const previewPlanBound = metadata?.audioSha256 === previewAudioSha256 && previewAudioSha256
            && metadata?.adapter?.weightsSha256 === previewAdapterWeightsSha256
            && metadata?.adapter?.configSha256 === previewAdapterConfigSha256
            && sameVoiceScale(metadata?.adapter?.scale, previewScale);
          const records = [...(profile?.listeningApprovals || (profile?.listeningApproval ? [profile.listeningApproval] : []))];
          if (!records.length && legacy && recordedStatus === 'approved' && Number.isFinite(recordedScale)) {
            records.push({ ...legacyVoice.listeningApproval, status: 'approved', adapterScale: recordedScale, source: 'legacy-approved-voice' });
          }
          const listeningApprovals = await Promise.all(records.map(async record => {
            const sampleBound = record.audioSha256 && record.audioSha256 === previewAudioSha256
              && sameVoiceScale(record.adapterScale, previewScale);
            const approvalMetadata = record.audioPath
              ? await fs.readFile(path.join(path.dirname(path.resolve(runDirectory, record.audioPath)), 'preview.json'), 'utf8').then(JSON.parse).catch(() => null)
                || await fs.readFile(path.join(runDirectory, 'preview.json'), 'utf8').then(JSON.parse).catch(() => null) : metadata;
            const comparisonBound = record.audioSha256 && approvalMetadata?.audioSha256 === record.audioSha256
              && sameVoiceScale(record.adapterScale, approvalMetadata?.adapter?.scale)
              && record.adapterWeightsSha256 === approvalMetadata?.adapter?.weightsSha256
              && record.adapterConfigSha256 === approvalMetadata?.adapter?.configSha256;
            const historical = legacy && sameVoiceScale(record.adapterScale, legacyVoice.adapterScale) ? legacyVoice.listeningApproval : null;
            return { ...record,
              adapterWeightsSha256: record.adapterWeightsSha256 || historical?.adapterWeightsSha256 || (sampleBound ? previewIdentity.adapterWeightsSha256 : null),
              adapterConfigSha256: record.adapterConfigSha256 || historical?.adapterConfigSha256 || (sampleBound ? previewIdentity.adapterConfigSha256 : null),
              referenceAudioSha256: record.referenceAudioSha256 || historical?.referenceAudioSha256 || (sampleBound ? previewIdentity.referenceAudioSha256 : null)
                || (comparisonBound ? approvalMetadata?.referenceAudioSha256 || plan?.referenceAudioSha256 : null),
              referenceTextSha256: record.referenceTextSha256 || historical?.referenceTextSha256 || (sampleBound ? previewIdentity.referenceTextSha256 : null)
                || (comparisonBound ? approvalMetadata?.referenceTextSha256 || plan?.referenceTextSha256 : null),
              referenceTextContentSha256: record.referenceTextContentSha256 || historical?.referenceTextContentSha256,
            };
          }));
          const approvedScales = recordedStatus === 'approved' ? [...new Set(listeningApprovals
            .filter(record => record.status === 'approved' && Number.isFinite(record.adapterScale) && voiceInputMatches(record, currentIdentity))
            .map(record => record.adapterScale))] : [];
          const listeningStatus = recordedStatus === 'approved' && !approvedScales.length ? 'pending' : recordedStatus;
          const approvalError = recordedStatus === 'approved' && !approvedScales.length
            ? '청취 확인 당시의 목소리 파일·대표 녹음·전사를 확인할 수 없습니다. 시험 음성을 다시 만들어 듣고 확인해 주세요.' : null;
          const approvedScale = approvedScales.find(value => sameVoiceScale(value, recordedScale)) ?? approvedScales[0] ?? null;
          adapters.push({
            id,
            label: run.name,
            path: adapterPath,
            date: day.name,
            displayName: profile?.displayName || (legacy ? legacyVoice.displayName : run.name),
            referencePaths,
            profileError,
            listeningStatus, approvalError, voiceInputIdentity: approvedScales.length ? currentIdentity : null, listeningApprovals,
            legacy, runDirectory, previewUrl, previewAudioSha256, previewScale,
            previewAdapterWeightsSha256, previewAdapterConfigSha256,
            previewReferenceAudioSha256: previewReferenceAudioSha256 || (previewPlanBound ? plan?.referenceAudioSha256 : null),
            previewReferenceTextSha256: previewReferenceTextSha256 || (previewPlanBound ? plan?.referenceTextSha256 : null),
            approvedScale, approvedScales,
          });
        }
      }
    }
    return adapters.sort((a, b) => b.id.localeCompare(a.id));
  }

  async function readAppSettings() {
    const adapters = await discoverAdapters();
    const stored = await fs.readFile(settingsPath, "utf8").then(JSON.parse).catch(() => ({}));
    const adapterId = stored.adapterId || legacyVoice.adapterId;
    const selected = adapters.find((item) => item.id === adapterId) || null;
    const modelId = stored.modelId === "chatterbox-v3" ? "chatterbox-v3" : "qwen3-tts";
    return {
      modelId,
      adapterId: modelId === "qwen3-tts" ? adapterId : "none",
      adapterScale: settingsAdapterScale(stored.adapterScale),
      voiceParallelism: Math.min(2, Math.max(1, Math.round(Number(stored.voiceParallelism ?? 1)))),
      // 자리를 비운 사이에도 제작이 이어지도록 하는 두 값이다. 기본은 켜 둔다 —
      // 일곱 시간짜리 작업에서 이것이 꺼져 있어 좋을 까닭이 없다.
      preventSleep: stored.preventSleep !== false,
      notifyOnFinish: stored.notifyOnFinish !== false,
      paths: normalizeStudioPaths({ ...stored.paths, ...(modelId === "qwen3-tts" && adapterId !== "none" ? selected?.referencePaths : {}) }),
      adapters,
    };
  }

  async function saveAppSettings(raw = {}) {
    const current = await readAppSettings();
    const modelId = (raw.modelId ?? current.modelId) === "chatterbox-v3" ? "chatterbox-v3" : "qwen3-tts";
    const adapterId = raw.adapterId ?? current.adapterId;
    const scale = settingsAdapterScale(raw.adapterScale ?? current.adapterScale);
    const requestedPaths = normalizeStudioPaths(raw.paths || current.paths);
    const voiceChanged = modelId !== current.modelId || adapterId !== current.adapterId
      || !sameVoiceScale(scale, current.adapterScale)
      || ['referenceAudioPath', 'referenceTextPath'].some(key => requestedPaths[key] !== current.paths[key]);
    if (voiceChanged && modelId === "qwen3-tts" && adapterId !== "none" && !current.adapters.some((item) => item.id === adapterId)) {
      throw new Error("선택한 목소리 어댑터가 없습니다. 설정에서 목소리를 다시 골라 주세요.");
    }
    const adapter = modelId === "qwen3-tts" ? current.adapters.find((item) => item.id === adapterId) : null;
    if (voiceChanged && adapter?.profileError) throw new Error(adapter.profileError);
    if (voiceChanged && adapter?.listeningStatus === 'rejected' && !raw.listeningApproval) {
      throw new Error('사용을 보류한 목소리입니다. 시험 음성을 다시 듣고 확인해 주세요.');
    }
    if (voiceChanged && adapter && !raw.listeningApproval
        && (adapter.listeningStatus !== 'approved' || !adapter.approvedScales.some(value => sameVoiceScale(value, scale)))) {
      throw new Error(adapter.approvalError || '선택한 강도의 시험 음성을 듣고 확인한 뒤 적용해 주세요.');
    }
    const settings = {
      modelId,
      adapterId: modelId === "qwen3-tts" ? adapterId : "none",
      adapterScale: scale,
      voiceParallelism: Math.min(2, Math.max(1, Math.round(Number(raw.voiceParallelism ?? current.voiceParallelism)))),
      preventSleep: Boolean(raw.preventSleep ?? current.preventSleep),
      notifyOnFinish: Boolean(raw.notifyOnFinish ?? current.notifyOnFinish),
      paths: normalizeStudioPaths({ ...(raw.paths || current.paths), ...adapter?.referencePaths }),
    };
    for (const key of ["voiceLibraryRoot", "outputRoot", "ttsOutputRoot", "voiceOutputRoot", "captionOutputRoot", "videoOutputRoot", "editOutputRoot"]) {
      await fs.mkdir(settings.paths[key], { recursive: true });
    }
    const studio = runtimePaths(settings.paths);
    for (const [label, requiredPath] of Object.entries(voiceChanged ? {
      "참조 음성": studio.referenceAudioPath,
      "참조 전사문": studio.referenceTextPath,
    } : {})) {
      const stat = await safeStat(requiredPath);
      if (!stat?.isFile() || stat.size <= 0) throw new Error(`${label} 파일을 찾지 못했습니다: ${requiredPath}`);
    }
    if (raw.listeningApproval) {
      if (!adapter?.previewUrl || !sameVoiceScale(adapter.previewScale, scale)
          || raw.listeningApproval.audioSha256 !== adapter.previewAudioSha256) {
        throw new Error('선택한 강도의 시험 음성을 다시 만들고 들어 주세요.');
      }
      const { profile } = await readVoiceProfile(adapter.runDirectory, { fs });
      const audioPath = new URL(adapter.previewUrl);
      if (await fileSha256(audioPath) !== adapter.previewAudioSha256) {
        throw new Error('시험 음성이 바뀌었습니다. 다시 들어 보고 확인해 주세요.');
      }
      const identity = await voiceInputIdentity(adapter.path, adapter.referencePaths, { fs });
      const expected = { adapterWeightsSha256: adapter.previewAdapterWeightsSha256, adapterConfigSha256: adapter.previewAdapterConfigSha256,
        referenceAudioSha256: adapter.previewReferenceAudioSha256, referenceTextSha256: adapter.previewReferenceTextSha256 };
      if (!expected.adapterWeightsSha256 || !expected.adapterConfigSha256 || !expected.referenceAudioSha256 || !expected.referenceTextSha256) {
        throw new Error('시험 음성의 목소리 파일·대표 녹음·전사 확인 기록이 없습니다. 시험 음성을 다시 만들어 주세요.');
      }
      if (expected.adapterWeightsSha256 !== identity.adapterWeightsSha256 || expected.adapterConfigSha256 !== identity.adapterConfigSha256) {
        throw new Error('시험 음성을 만든 뒤 목소리 학습 파일이 바뀌었습니다. 시험 음성을 다시 만들어 주세요.');
      }
      if (!voiceInputMatches(expected, identity)) throw new Error('시험 음성을 만든 뒤 대표 녹음이나 전사가 바뀌었습니다. 시험 음성을 다시 만들어 주세요.');
      const approval = { status: 'approved', date: new Date().toISOString(),
          source: 'settings-listening-confirmation', adapterScale: scale,
          audioPath: fileURLToPath(audioPath), audioSha256: adapter.previewAudioSha256,
          ...identity };
      const previous = adapter.listeningApprovals;
      await writeVoiceProfile(adapter.runDirectory, { ...profile, listeningStatus: 'approved', approvedScale: scale,
        referenceAudioSha256: identity.referenceAudioSha256, referenceTextSha256: identity.referenceTextSha256,
        listeningApproval: approval, listeningApprovals: [...previous, approval] }, { fs });
    }
    await fs.mkdir(path.dirname(settingsPath), { recursive: true });
    const storedSettings = {
      ...settings,
      paths: Object.fromEntries(["sourceProjectRoot", "voiceLibraryRoot", "outputRoot", "referenceAudioPath", "referenceTextPath", "savedRoot"]
        .map((key) => [key, settings.paths[key]])),
    };
    await fs.writeFile(settingsPath, `${JSON.stringify(storedSettings, null, 2)}\n`, "utf8");
    state.catalogCache = null;
    state.catalogCacheRoot = null;
    return { ...settings, adapters: raw.listeningApproval ? await discoverAdapters() : current.adapters };
  }

  function applyVoiceSettings(options, settings) {
    const adapter = settings.modelId === "qwen3-tts"
      ? settings.adapters.find((item) => item.id === settings.adapterId) || null
      : null;
    if (settings.modelId === "qwen3-tts" && settings.adapterId !== "none" && !adapter) {
      throw new Error("선택한 목소리 어댑터가 없습니다. 설정에서 목소리를 다시 골라 주세요.");
    }
    if (adapter?.profileError) throw new Error(adapter.profileError);
    if (adapter?.listeningStatus === 'rejected') throw new Error('사용을 보류한 목소리입니다. 설정에서 다시 들어 보고 확인해 주세요.');
    if (adapter && (adapter.listeningStatus !== 'approved' || !adapter.approvedScales?.some(value => sameVoiceScale(value, settings.adapterScale)))) {
      throw new Error(adapter.approvalError || '선택한 강도의 시험 음성을 듣고 확인한 뒤 적용해 주세요.');
    }
    return {
      ...options,
      modelId: settings.modelId,
      voiceMode: adapter ? "finetuned" : "zero",
      adapterId: adapter?.id || "none",
      adapterLabel: adapter?.label || null,
      adapterPath: adapter?.path || null,
      adapterScale: settings.adapterScale,
      voiceInputIdentity: adapter?.voiceInputIdentity || null,
      voiceParallelism: settings.voiceParallelism,
      paths: normalizeStudioPaths({ ...settings.paths, ...adapter?.referencePaths }),
    };
  }

  return { discoverAdapters, readAppSettings, saveAppSettings, applyVoiceSettings };
}
