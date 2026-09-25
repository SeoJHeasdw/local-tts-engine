import { execFile } from 'node:child_process';
import { performance } from 'node:perf_hooks';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

async function command(file, args) {
  const { stdout } = await execFileAsync(file, args, { timeout: 3000, maxBuffer: 4 * 1024 * 1024 });
  return stdout;
}

export function parseProcessRss(output) {
  return String(output).split('\n').flatMap(line => {
    const match = /^\s*(\d+)\s+(\d+)\s+(\d+)\s*$/.exec(line);
    return match ? [{ pid: Number(match[1]), ppid: Number(match[2]), rssBytes: Number(match[3]) * 1024 }] : [];
  });
}

export function processTreeRss(rows, rootPid) {
  if (!Number.isSafeInteger(rootPid) || rootPid <= 0) return null;
  const byPid = new Map(rows.map(row => [row.pid, row]));
  if (!byPid.has(rootPid)) return null;
  const children = new Map();
  for (const row of rows) {
    if (!children.has(row.ppid)) children.set(row.ppid, []);
    children.get(row.ppid).push(row.pid);
  }
  const seen = new Set(), pending = [rootPid];
  let rssBytes = 0;
  while (pending.length) {
    const pid = pending.pop();
    if (seen.has(pid)) continue;
    seen.add(pid);
    rssBytes += byPid.get(pid)?.rssBytes || 0;
    pending.push(...(children.get(pid) || []));
  }
  return { rssBytes, processCount: seen.size };
}

export function parseMemoryPressure(output) {
  const match = /System-wide memory free percentage:\s*(\d+)%/i.exec(String(output));
  return match ? Number(match[1]) : null;
}

export function parseVmStat(output) {
  const text = String(output);
  const pageSize = /page size of (\d+) bytes/i.exec(text);
  const swapouts = /^Swapouts:\s*(\d+)\.?/im.exec(text);
  return {
    pageSizeBytes: pageSize ? Number(pageSize[1]) : null,
    swapoutsPagesSinceBoot: swapouts ? Number(swapouts[1]) : null,
  };
}

function reason(error) {
  return String(error?.code || error?.stderr?.toString().trim() || error?.message || error).slice(0, 240);
}

const defaultProcessRows = async () => parseProcessRss(await command('ps', ['-A', '-o', 'pid=', '-o', 'ppid=', '-o', 'rss=']));
const defaultSystemMemory = async () => {
  const [pressure, vm] = await Promise.allSettled([
    command('memory_pressure', ['-Q']), command('vm_stat', []),
  ]);
  return {
    freePercent: pressure.status === 'fulfilled' ? parseMemoryPressure(pressure.value) : null,
    ...parseVmStat(vm.status === 'fulfilled' ? vm.value : ''),
    errors: [pressure, vm].filter(result => result.status === 'rejected').map(result => reason(result.reason)),
  };
};

// RSS is a diagnostic sum of process resident sets, not physical memory usage:
// Chromium processes can map the same pages. GPU allocations are not included.
export function createCaptureResourceSampler({
  workerPid = process.pid,
  intervalMs = 2000,
  systemIntervalMs = 10000,
  pageHeapIntervalMs = 10000,
  readProcessRows = defaultProcessRows,
  readSystemMemory = defaultSystemMemory,
  workerRss = () => process.memoryUsage.rss(),
} = {}) {
  let browserPid = null, encoderPid = null, readPageJsHeap = null;
  let phase = 'startup', processError = null, systemError = null, pageHeapError = null;
  let systemProbeDisabled = false;
  let processTimer = null, systemTimer = null, processPending = null, systemPending = null;
  let startedAt = 0, startedMono = 0;
  let lastPageHeapAt = -Infinity;
  const samples = [], systemSamples = [];

  async function sampleProcess() {
    if (processPending) return processPending;
    processPending = (async () => {
      const sample = {
        at: new Date().toISOString(), elapsedMs: Math.round(performance.now() - startedMono), phase,
        workerRssBytes: workerRss(), browserRssBytes: null, encoderRssBytes: null,
        totalRssBytes: null, captureFamilyRssBytes: null,
        captureFamilyProcessCount: null, browserProcessCount: null, encoderProcessCount: null,
        pageJsHeapUsedBytes: null,
      };
      if (!processError) {
        try {
          const rows = await readProcessRows();
          const family = processTreeRss(rows, workerPid);
          const browser = processTreeRss(rows, browserPid);
          const encoder = encoderPid === null ? { rssBytes: 0, processCount: 0 } : processTreeRss(rows, encoderPid);
          const worker = rows.find(row => row.pid === workerPid);
          if (family) {
            sample.captureFamilyRssBytes = family.rssBytes;
            sample.captureFamilyProcessCount = family.processCount;
          }
          if (browser) {
            sample.browserRssBytes = browser.rssBytes;
            sample.browserProcessCount = browser.processCount;
          }
          if (encoder) {
            sample.encoderRssBytes = encoder.rssBytes;
            sample.encoderProcessCount = encoder.processCount;
          }
          if (worker) sample.workerRssBytes = worker.rssBytes;
          if (browser && encoder) {
            sample.totalRssBytes = sample.workerRssBytes + browser.rssBytes + encoder.rssBytes;
          }
        } catch (error) {
          // Restricted shells may deny process enumeration. Keep worker and
          // system measurements, and state why the combined RSS is absent.
          processError = reason(error);
        }
      }
      if (readPageJsHeap && !pageHeapError && performance.now() - lastPageHeapAt >= pageHeapIntervalMs) {
        lastPageHeapAt = performance.now();
        let timeout;
        try {
          const used = await Promise.race([
            readPageJsHeap(),
            new Promise((_, reject) => {
              timeout = setTimeout(() => reject(new Error('CDP page heap probe timed out')), 1000);
            }),
          ]);
          if (Number.isFinite(used) && used >= 0) sample.pageJsHeapUsedBytes = used;
        } catch (error) { pageHeapError = reason(error); }
        finally { clearTimeout(timeout); }
      }
      samples.push(sample);
      return sample;
    })().finally(() => { processPending = null; });
    return processPending;
  }

  async function sampleSystem() {
    if (systemPending) return systemPending;
    systemPending = (async () => {
      if (systemProbeDisabled) return;
      try {
        const result = await readSystemMemory();
        if (result.errors?.length && !systemError) systemError = result.errors.join('; ');
        if (result.freePercent === null && result.swapoutsPagesSinceBoot === null) systemProbeDisabled = true;
        systemSamples.push({
          at: new Date().toISOString(), elapsedMs: Math.round(performance.now() - startedMono),
          freePercent: result.freePercent ?? null,
          pageSizeBytes: result.pageSizeBytes ?? null,
          swapoutsPagesSinceBoot: result.swapoutsPagesSinceBoot ?? null,
        });
      } catch (error) { systemError = reason(error); }
    })().finally(() => { systemPending = null; });
    return systemPending;
  }

  const peak = field => samples.reduce((value, sample) =>
    sample[field] === null ? value : Math.max(value ?? 0, sample[field]), null);
  return {
    setBrowserPid(pid) { browserPid = pid ?? null; },
    setEncoderPid(pid) { encoderPid = pid ?? null; },
    setPageJsHeapReader(reader) { readPageJsHeap = reader; },
    setPageHeapError(error) { pageHeapError = reason(error); },
    setPhase(value) { phase = value; },
    async sample() { await Promise.all([sampleProcess(), sampleSystem()]); },
    start() {
      startedAt = Date.now(); startedMono = performance.now();
      processTimer = setInterval(() => { void sampleProcess().catch(() => {}); }, intervalMs);
      systemTimer = setInterval(() => { void sampleSystem().catch(() => {}); }, systemIntervalMs);
      void this.sample().catch(() => {});
    },
    async stop() {
      clearInterval(processTimer); clearInterval(systemTimer);
      if (processPending) await processPending;
      if (systemPending) await systemPending;
      lastPageHeapAt = -Infinity;
      await this.sample();
      const firstSwap = systemSamples.find(sample => sample.swapoutsPagesSinceBoot !== null);
      const lastSwap = systemSamples.findLast(sample => sample.swapoutsPagesSinceBoot !== null);
      const swapoutsDeltaBytes = firstSwap && lastSwap && lastSwap.swapoutsPagesSinceBoot >= firstSwap.swapoutsPagesSinceBoot
        && firstSwap.pageSizeBytes === lastSwap.pageSizeBytes
        ? (lastSwap.swapoutsPagesSinceBoot - firstSwap.swapoutsPagesSinceBoot) * lastSwap.pageSizeBytes : null;
      return {
        startedAt: new Date(startedAt).toISOString(), endedAt: new Date().toISOString(),
        intervalMs, systemIntervalMs, pageHeapIntervalMs,
        rssMethod: 'Explicit worker, Chromium and ffmpeg RSS is available only when each process root PID is known; see captureFamilyRss otherwise',
        rssLimit: 'Shared resident pages may be counted in more than one process; this is not physical memory used.',
        processError, systemError, pageHeapError,
        processRssStatus: peak('captureFamilyRssBytes') === null ? 'unavailable' : 'measured',
        processRssUnavailableReason: peak('captureFamilyRssBytes') === null
          ? processError || 'Capture worker was not present in a process-table sample' : null,
        captureFamilyRssMethod: 'ps process tree rooted at capture worker; includes Chromium, ffmpeg and transient helper processes',
        peakCaptureFamilyRssBytes: peak('captureFamilyRssBytes'),
        peakTotalRssBytes: peak('totalRssBytes'),
        peakWorkerRssBytes: peak('workerRssBytes'),
        peakBrowserRssBytes: peak('browserRssBytes'),
        peakEncoderRssBytes: peak('encoderRssBytes'),
        peakPageJsHeapUsedBytes: peak('pageJsHeapUsedBytes'),
        pageJsHeapStatus: peak('pageJsHeapUsedBytes') === null ? 'unavailable' : 'measured',
        pageJsHeapUnavailableReason: peak('pageJsHeapUsedBytes') === null
          ? pageHeapError || 'CDP did not return JSHeapUsedSize for this page target' : null,
        pageJsHeapScope: 'CDP page target only; excludes other Chromium processes and GPU memory',
        gpuMemoryBytes: null,
        gpuMemoryLimit: 'No reliable GPU allocation measurement is available from this capture path.',
        minimumSystemFreePercent: systemSamples.reduce((value, sample) =>
          sample.freePercent === null ? value : Math.min(value ?? 100, sample.freePercent), null),
        swapoutsDeltaBytes,
        systemMemoryLimit: 'System-wide free percentage and swapouts change can include unrelated applications.',
        samples, systemSamples,
      };
    },
  };
}
