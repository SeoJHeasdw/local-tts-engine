import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createCaptureResourceSampler, parseMemoryPressure, parseProcessRss, parseVmStat, processTreeRss,
} from '../../electron-app/main/capture/resource-metrics.mjs';

test('프로세스별 RSS는 자손을 포함하되 worker와 다른 나무를 중복하지 않는다', () => {
  const rows = parseProcessRss(' 10 1 100\n 20 10 200\n 21 20 30\n 22 20 40\n 30 10 50\n');
  assert.deepEqual(processTreeRss(rows, 20), { rssBytes: 270 * 1024, processCount: 3 });
  assert.deepEqual(processTreeRss(rows, 30), { rssBytes: 50 * 1024, processCount: 1 });
  assert.equal(processTreeRss(rows, 99), null);
  assert.equal(rows.find(row => row.pid === 10).rssBytes, 100 * 1024);
});

test('시스템 여유율과 재부팅 이후 누적 스왑 기록을 구별해 읽는다', () => {
  assert.equal(parseMemoryPressure('System-wide memory free percentage: 73%'), 73);
  assert.deepEqual(parseVmStat('Mach Virtual Memory Statistics: (page size of 16384 bytes)\nSwapouts: 12345.\n'), {
    pageSizeBytes: 16384, swapoutsPagesSinceBoot: 12345,
  });
});

test('동일 시점의 worker·Chromium·ffmpeg 합계 피크와 스왑 증가를 기록한다', async () => {
  let browserKb = 200, encoderKb = 50, heap = 100, swapouts = 5;
  const sampler = createCaptureResourceSampler({
    workerPid: 10, intervalMs: 60000, systemIntervalMs: 60000,
    workerRss: () => 999,
    readProcessRows: async () => parseProcessRss(
      `10 1 100\n20 10 ${browserKb}\n21 20 30\n30 10 ${encoderKb}\n`,
    ),
    readSystemMemory: async () => ({
      freePercent: 75 - swapouts, pageSizeBytes: 16384, swapoutsPagesSinceBoot: swapouts,
    }),
  });
  sampler.setBrowserPid(20);
  sampler.setEncoderPid(30);
  sampler.setPageJsHeapReader(async () => heap);
  sampler.start();
  await sampler.sample();
  browserKb = 300; encoderKb = 70; heap = 120; swapouts = 7;
  sampler.setPhase('recording');
  await sampler.sample();
  const report = await sampler.stop();
  assert.equal(report.peakCaptureFamilyRssBytes, (100 + 300 + 30 + 70) * 1024);
  assert.equal(report.peakTotalRssBytes, (100 + 300 + 30 + 70) * 1024);
  assert.equal(report.peakBrowserRssBytes, 330 * 1024);
  assert.equal(report.peakEncoderRssBytes, 70 * 1024);
  assert.equal(report.peakWorkerRssBytes, 100 * 1024);
  assert.equal(report.peakPageJsHeapUsedBytes, 120);
  assert.equal(report.minimumSystemFreePercent, 68);
  assert.equal(report.swapoutsDeltaBytes, 2 * 16384);
  assert.equal(report.gpuMemoryBytes, null);
  assert.equal(report.samples.some(sample => sample.phase === 'recording'), true);
});

test('프로세스 조회가 막히면 합계 RSS를 꾸며내지 않고 worker만 남긴다', async () => {
  const denied = Object.assign(new Error('operation not permitted'), { code: 'EPERM' });
  const sampler = createCaptureResourceSampler({
    intervalMs: 60000, systemIntervalMs: 60000,
    readProcessRows: async () => { throw denied; },
    readSystemMemory: async () => ({ freePercent: 73, pageSizeBytes: 16384, swapoutsPagesSinceBoot: 11 }),
    workerRss: () => 123456,
  });
  sampler.setBrowserPid(20);
  sampler.setEncoderPid(30);
  sampler.start();
  const report = await sampler.stop();
  assert.equal(report.processError, 'EPERM');
  assert.equal(report.peakWorkerRssBytes, 123456);
  assert.equal(report.peakBrowserRssBytes, null);
  assert.equal(report.peakEncoderRssBytes, null);
  assert.equal(report.peakTotalRssBytes, null);
  assert.equal(report.peakCaptureFamilyRssBytes, null);
  assert.equal(report.minimumSystemFreePercent, 73);
});

test('Playwright Browser PID를 모를 때도 촬영 작업자 자손 전체의 RSS를 잰다', async () => {
  const sampler = createCaptureResourceSampler({
    workerPid: 10, intervalMs: 60000, systemIntervalMs: 60000,
    readProcessRows: async () => parseProcessRss('10 1 100\n20 10 200\n21 20 30\n30 10 50\n'),
    readSystemMemory: async () => ({ freePercent: 72, pageSizeBytes: 16384, swapoutsPagesSinceBoot: 2 }),
    workerRss: () => 999,
  });
  sampler.setEncoderPid(30);
  sampler.start();
  const report = await sampler.stop();
  assert.equal(report.processRssStatus, 'measured');
  assert.equal(report.peakCaptureFamilyRssBytes, 380 * 1024);
  assert.equal(report.peakBrowserRssBytes, null);
  assert.equal(report.peakEncoderRssBytes, 50 * 1024);
  assert.equal(report.peakTotalRssBytes, null);
});

test('페이지 JS heap 조회는 진행 중 연속 호출하지 않고 종료 때 다시 측정한다', async () => {
  let heapReads = 0;
  const sampler = createCaptureResourceSampler({
    intervalMs: 60000, systemIntervalMs: 60000, pageHeapIntervalMs: 10000,
    readProcessRows: async () => parseProcessRss('10 1 100\n20 10 200\n'),
    readSystemMemory: async () => ({ freePercent: 70, pageSizeBytes: 16384, swapoutsPagesSinceBoot: 0 }),
    workerPid: 10,
  });
  sampler.setBrowserPid(20);
  sampler.setPageJsHeapReader(async () => ++heapReads);
  sampler.start();
  await sampler.sample();
  await sampler.sample();
  assert.equal(heapReads, 1);
  const report = await sampler.stop();
  assert.equal(heapReads, 2);
  assert.equal(report.peakPageJsHeapUsedBytes, 2);
});
