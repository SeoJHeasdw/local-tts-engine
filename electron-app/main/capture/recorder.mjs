import { spawn } from 'node:child_process';
import { performance } from 'node:perf_hooks';
import { captureFrameCount } from '../../shared/video-quality.mjs';

const LAG_MS = 150;
// Lossless PNG frames are sampled onto the lecture clock and encoded once.
// A still page need not send new frames; transport/process failure is separate.
//
// `session`은 CDP 세션의 모양(`on`/`off`/`send`)만 요구한다. 프레임을 덱 페이지가
// 보내는지 다른 화면이 보내는지는 여기서 구분하지 않는다.
export function startScreencastEncoder({ session, ffmpegArgs, width = 1920, height = 1080, fps = 25,
  maxBacklogBytes = 512 * 1024 * 1024, maxBufferedBytes = 256 * 1024 * 1024,
  maxBufferedFrames = 64, readyTimeoutMs = 15000, stopTimeoutMs = 2000, ackPaceRatio = .75 } = {}) {
  if (![width, height, fps, maxBacklogBytes, maxBufferedBytes, maxBufferedFrames, readyTimeoutMs, stopTimeoutMs]
    .every(value => Number.isFinite(value) && value > 0) || !Number.isInteger(width) || !Number.isInteger(height)
    || !Number.isFinite(ackPaceRatio) || ackPaceRatio < 0 || ackPaceRatio >= 1) {
    throw new Error('촬영 크기·프레임률·버퍼 제한이 올바르지 않습니다.');
  }
  const frameMs = 1000 / fps;
  // The browser captures the next screen only once the previous frame is
  // acknowledged, so acknowledging at once makes it grab two or three back to
  // back and then stall while they encode. At 4K that burst leaves half of the
  // output frame slots with no new screen at all — 44 of 100 in measurement.
  // Spacing the acknowledgements just under one output frame paces the capture
  // instead: the slots fill evenly (95 of 100) and less throughput is spent on
  // frames that would be dropped anyway.
  const ackPaceMs = frameMs * ackPaceRatio;
  let phase = 'created', timer = null, failure = null, stderrText = '';
  let buffered = [], bufferedBytes = 0, lastWritten = null, lastTimestamp = -Infinity;
  let startedAt = 0, startedMono = 0, capFrames = 0;
  let written = 0, received = 0, duplicated = 0, reordered = 0, superseded = 0, peakBacklog = 0, peakBufferedBytes = 0;
  let stall = 0, longestStall = 0;
  let nextAck = 0, lastAckSent = -Infinity;
  const ackTimers = new Set();
  const clearAcks = () => { for (const pending of ackTimers) clearTimeout(pending); ackTimers.clear(); };
  let rejectFailure, announceFirst;
  const failed = new Promise((_, reject) => { rejectFailure = reject; });
  failed.catch(() => {});
  const firstFrame = new Promise(resolve => { announceFirst = resolve; });
  const ffmpeg = spawn('ffmpeg', ['-xerror', ...ffmpegArgs], { stdio: ['pipe', 'ignore', 'pipe'] });
  const active = () => !['finished', 'failed', 'aborted'].includes(phase);
  const unlisten = () => {
    session.off('Page.screencastFrame', onFrame);
    for (const event of ['Disconnected', 'Inspector.detached', 'Inspector.targetCrashed']) session.off(event, onDisconnect);
  };
  function fail(error) {
    if (!active()) return;
    failure = error;
    phase = 'failed';
    clearInterval(timer);
    clearAcks();
    unlisten();
    buffered = []; bufferedBytes = 0; lastWritten = null;
    ffmpeg.stdin.destroy();
    ffmpeg.kill('SIGKILL');
    rejectFailure(error);
  }
  ffmpeg.stderr.on('data', chunk => { stderrText = (stderrText + chunk.toString()).slice(-16384); });
  ffmpeg.stdin.on('error', error => { if (active()) fail(new Error(`촬영 인코더 입력이 끊겼습니다: ${error.message}`)); });
  const encoded = new Promise((resolve, reject) => {
    ffmpeg.once('error', reject);
    ffmpeg.once('close', code => {
      if (code === 0 && phase === 'finishing') resolve();
      else reject(new Error(`ffmpeg 인코딩 실패 (code ${code}, ${phase})${stderrText.trim() ? `\n${stderrText.trim()}` : ''}`));
    });
  });
  encoded.catch(fail);
  function onDisconnect() {
    if (phase !== 'finishing') fail(new Error('브라우저 촬영 연결이 끊겼습니다. 마지막 화면을 복제해 완료하지 않습니다.'));
  }
  function onFrame(event) {
    if (!active() || phase === 'finishing') return;
    const data = Buffer.from(event.data, 'base64');
    const ts = Number(event.metadata?.timestamp) * 1000;
    // Chromium keeps sending frames only while each one is acknowledged, so a
    // frame we decline to buffer still has to be acknowledged.
    const ack = () => {
      const send = () => Promise.resolve().then(() => session.send('Page.screencastFrameAck', { sessionId: event.sessionId }))
        .catch(error => { if (phase !== 'finishing') fail(new Error(`촬영 프레임 수신 확인에 실패했습니다: ${error.message}`)); });
      if (!ackPaceMs) return void send();
      // 간격은 실제로 보낸 시각에서 잰다. 계획한 시각으로만 재면, 바쁠 때 늦게 깬 앞
      // 타이머 바로 뒤에 제때 깬 다음 타이머가 붙어 둘이 한꺼번에 나가고(부하 속 실측
      // 14~20ms), 브라우저가 다시 몰아 찍는다.
      const deliver = () => {
        const wait = lastAckSent + ackPaceMs - performance.now();
        if (wait > 0.5) {
          const again = setTimeout(() => { ackTimers.delete(again); if (active()) deliver(); }, wait);
          ackTimers.add(again);
          return;
        }
        lastAckSent = performance.now();
        send();
      };
      const now = performance.now(), at = Math.max(now, nextAck);
      nextAck = at + ackPaceMs;
      const pending = setTimeout(() => { ackTimers.delete(pending); if (active()) deliver(); }, at - now);
      ackTimers.add(pending);
    };
    if (data.length < 24 || data.toString('hex', 0, 8) !== '89504e470d0a1a0a'
      || data.readUInt32BE(16) !== width || data.readUInt32BE(20) !== height) {
      fail(new Error(`브라우저 프레임이 요청한 ${width}×${height} PNG가 아닙니다. 촬영을 중단합니다.`));
      return;
    }
    // The browser encodes screencast PNGs on a thread pool and emits them in
    // completion order, so two frames captured within a millisecond of each other
    // arrive swapped now and then — more often the larger the frame. That is
    // transport reordering, not a clock fault, so the frame is placed by its own
    // timestamp instead of by arrival order. Beyond the fill lag it could no
    // longer reach its output slot, and a jump that large means the clock itself
    // moved, so the capture still stops rather than freezing on one screen.
    if (!Number.isFinite(ts) || ts <= 0 || ts < lastTimestamp - LAG_MS) {
      fail(new Error('촬영 프레임 시각이 없거나 역전됐습니다. 동기화를 보장할 수 없어 중단합니다.'));
      return;
    }
    if (ts < lastTimestamp - .001) reordered++;
    lastTimestamp = Math.max(lastTimestamp, ts);
    // Before begin(), no output time has been assigned. Only the newest frame is needed.
    if (phase !== 'recording') {
      if (buffered.length && buffered[0].ts >= ts) { announceFirst(); ack(); return; }
      buffered = []; bufferedBytes = 0;
    } else if (lastWritten && ts <= lastWritten.ts) {
      // Output time only moves forward, so a frame no newer than the one already
      // written can never win a later slot. It is superseded, not discarded work.
      superseded++; ack(); return;
    }
    if (buffered.length >= maxBufferedFrames || bufferedBytes + data.length > maxBufferedBytes) {
      fail(new Error('촬영 프레임 버퍼가 가득 찼습니다. 필요한 화면을 버리지 않고 중단합니다.'));
      return;
    }
    received++;
    let at = buffered.length;
    while (at > 0 && buffered[at - 1].ts > ts) at--;
    buffered.splice(at, 0, { ts, data });
    bufferedBytes += data.length;
    peakBufferedBytes = Math.max(peakBufferedBytes, bufferedBytes);
    announceFirst();
    ack();
  }
  session.on('Page.screencastFrame', onFrame);
  for (const event of ['Disconnected', 'Inspector.detached', 'Inspector.targetCrashed']) session.on(event, onDisconnect);

  function atOrBefore(target) {
    let best = lastWritten && lastWritten.ts <= target + .001 ? lastWritten : null;
    for (const frame of buffered) {
      if (frame.ts > target + .001) break;
      best = frame;
    }
    return best;
  }
  function fill(deadline) {
    while (!failure && written < capFrames) {
      const target = startedAt + written * frameMs;
      if (target > deadline) break;
      const frame = atOrBefore(target);
      if (!frame) throw new Error('영상 시작 시각 이전의 촬영 프레임이 없습니다.');
      if (ffmpeg.stdin.writableLength + frame.data.length > maxBacklogBytes) {
        fail(new Error('영상 인코더가 실시간 촬영을 따라가지 못해 중단했습니다. 다른 실행 작업을 마친 뒤 같은 화질로 다시 촬영해 주세요.'));
        return;
      }
      if (frame === lastWritten) { duplicated++; stall++; longestStall = Math.max(longestStall, stall); }
      else stall = 0;
      ffmpeg.stdin.write(frame.data);
      peakBacklog = Math.max(peakBacklog, ffmpeg.stdin.writableLength);
      lastWritten = frame; written++;
      while (buffered.length && buffered[0].ts <= target + .001) bufferedBytes -= buffered.shift().data.length;
    }
  }
  async function bounded(promise, timeoutMs, message) {
    let timeout;
    try {
      return await Promise.race([promise, failed, new Promise((_, reject) => {
        timeout = setTimeout(() => reject(new Error(message)), timeoutMs);
      })]);
    } finally { clearTimeout(timeout); }
  }
  async function stopStream() {
    // Cleanup must remain bounded even if CDP has disconnected.
    let timeout;
    try {
      await Promise.race([Promise.resolve().then(() => session.send('Page.stopScreencast')).catch(() => {}),
        new Promise(resolve => { timeout = setTimeout(resolve, stopTimeoutMs); })]);
    } finally { clearTimeout(timeout); }
  }
  return {
    fail,
    async ready() {
      if (phase !== 'created') throw failure || new Error('촬영 준비를 중복 호출했습니다.');
      phase = 'preparing';
      try {
        await bounded((async () => {
          await session.send('Page.enable');
          await session.send('Page.startScreencast', { format: 'png', maxWidth: width, maxHeight: height, everyNthFrame: 1 });
          await firstFrame;
        })(), readyTimeoutMs, '브라우저가 첫 촬영 프레임을 보내지 않았습니다.');
        if (Math.abs(Date.now() - lastTimestamp) >= 5000) throw new Error('촬영 프레임 시각과 시스템 시계가 맞지 않습니다.');
        phase = 'ready';
      } catch (error) { fail(error); throw failure || error; }
    },
    begin(at, totalFrames) {
      if (phase !== 'ready') throw failure || new Error('촬영 준비 후 한 번만 시작할 수 있습니다.');
      if (!Number.isFinite(at) || !Number.isSafeInteger(totalFrames) || totalFrames <= 0) throw new Error('촬영 시작 시각과 프레임 수가 올바르지 않습니다.');
      startedAt = at; startedMono = performance.now(); capFrames = totalFrames; phase = 'recording';
      try { fill(at); } catch (error) { fail(error); }
      if (failure) throw failure;
      timer = setInterval(() => {
        try {
          const elapsed = performance.now() - startedMono;
          if (Math.abs(Date.now() - startedAt - elapsed) > 1000) throw new Error('촬영 중 시스템 시계가 변경됐습니다. 동기화를 위해 중단합니다.');
          fill(startedAt + elapsed - LAG_MS);
        } catch (error) { fail(error); }
      }, frameMs / 2);
    },
    async wait(ms) {
      let timeout;
      try { await Promise.race([failed, new Promise(resolve => { timeout = setTimeout(resolve, Math.max(0, ms)); })]); }
      finally { clearTimeout(timeout); }
    },
    // `endAt`은 강의 촬영처럼 길이를 미리 아는 쪽이 아니라, 앱 데모처럼 끝나는
    // 시각을 찍고 나서야 아는 쪽을 위한 것이다. 주면 그 시각까지만 채우고 끝낸다.
    // 주지 않으면 지금까지처럼 begin에서 정한 프레임 수를 마지막 화면으로 채운다.
    async finish({ endAt = null } = {}) {
      if (phase !== 'recording') throw failure || new Error('진행 중인 촬영이 없습니다.');
      if (endAt !== null) {
        if (!Number.isFinite(endAt) || endAt <= startedAt) throw new Error('촬영 종료 시각이 시작보다 뒤여야 합니다.');
        capFrames = Math.min(capFrames, captureFrameCount(endAt - startedAt, fps));
      }
      clearInterval(timer); timer = null; phase = 'finishing'; clearAcks(); unlisten();
      try {
        await stopStream();
        fill(Infinity);
        if (failure) throw failure;
        ffmpeg.stdin.end();
        await encoded;
        phase = 'finished';
        const result = { written, received, duplicated, reordered, superseded, peakBacklog, peakBufferedBytes, longestStall, timestamped: true };
        buffered = []; bufferedBytes = 0; lastWritten = null;
        return result;
      } catch (error) { fail(error); throw failure || error; }
    },
    async abort() {
      if (phase === 'finished' || phase === 'aborted') return;
      failure ||= new Error('촬영을 중단했습니다.');
      rejectFailure(failure);
      phase = 'aborted'; clearInterval(timer); timer = null; clearAcks(); unlisten();
      buffered = []; bufferedBytes = 0; lastWritten = null;
      ffmpeg.stdin.destroy(); ffmpeg.kill('SIGKILL');
      await Promise.all([encoded.catch(() => {}), stopStream()]);
    },
  };
}
