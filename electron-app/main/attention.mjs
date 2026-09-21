// 한 챕터 제작은 일곱 시간을 넘는다. 그동안 맥이 잠들면 제작도 함께 멈춘다.
// 지금까지는 잠들었던 시간을 나중에 빼서 남은 시간 계산만 바로잡았지, 잠드는
// 것 자체를 막지는 않았다. 그리고 두 시간 뒤에 끝나는 작업을 계속 들여다볼
// 수는 없으므로, 끝나면 맥이 알려 주어야 한다. 둘 다 '작업이 도는 동안 사람이
// 자리를 비울 수 있게' 하는 일이라 한 모듈에 둔다.
//
// Electron 객체는 실행 진입점에서 주입된다. 없으면(테스트·구버전) 조용히
// 아무것도 하지 않는다 — 알림을 못 띄운다고 제작이 멈출 이유는 없다.

// 작업이 끝났다고 볼 수 있는 사건들. 무엇으로 끝났는지에 따라 말이 달라진다.
const FINISHED = {
  complete: { tone: "done", title: "제작 완료", body: (event) => summarize(event, "영상을 만들었습니다.") },
  "partial-complete": { tone: "warn", title: "일부만 완료", body: (event) => summarize(event, "일부 편이 실패했습니다. 실패한 편만 다시 만들 수 있습니다.") },
  failed: { tone: "fail", title: "제작 실패", body: (event) => event.cancelled ? "작업을 중지했습니다." : event.message || "원인을 확인해 주세요." },
  "edit-complete": { tone: "done", title: "편집 완료", body: () => "새 영상을 만들었습니다." },
  "edit-failed": { tone: "fail", title: "편집 실패", body: (event) => event.cancelled ? "작업을 중지했습니다." : event.message || "원인을 확인해 주세요." },
  "training-complete": { tone: "done", title: "파인튜닝 완료", body: (event) => `${event.adapter?.label || "새 어댑터"}를 학습했습니다.` },
  "training-failed": { tone: "fail", title: "파인튜닝 실패", body: (event) => event.message || "원인을 확인해 주세요." },
  "record-complete": { tone: "done", title: "녹화 완료", body: (event) => event.report?.warnings?.length ? "녹화했지만 확인할 경고가 있습니다." : "화면 녹화를 저장했습니다." },
  "record-failed": { tone: "fail", title: "녹화 실패", body: (event) => event.cancelled ? "녹화를 취소했습니다." : event.message || "원인을 확인해 주세요." },
  "voice-candidates-ready": { tone: "done", title: "후보 준비됨", body: () => "만든 목소리 후보를 듣고 고르세요." },
  "text-voices-ready": { tone: "done", title: "후보 준비됨", body: () => "만든 목소리 후보를 듣고 고르세요." },
  "text-voice-failed": { tone: "fail", title: "목소리 만들기 실패", body: (event) => event.message || "원인을 확인해 주세요." },
  // 앱 데모는 촬영·목소리·렌더가 단계마다 몇 분씩 걸리고, 끝나면 다음 단계는 사람이 한다.
  "demo-complete": { tone: "done", title: "앱 데모", body: (event) => DEMO_NEXT[event.step] || "다음 단계를 진행하세요." },
  "demo-failed": { tone: "fail", title: "앱 데모 실패", body: (event) => event.cancelled ? "작업을 중지했습니다." : event.message || "원인을 확인해 주세요." },
};

const DEMO_NEXT = {
  "demo-record": "촬영을 마쳤습니다. 장면마다 대본을 쓰세요.",
  "demo-voice": "목소리 후보가 나왔습니다. 듣고 고르세요.",
  "demo-render": "완성본을 만들었습니다.",
};

function summarize(event, fallback) {
  const units = event.report?.units?.length;
  return units > 1 ? `${units}편을 만들었습니다.` : fallback;
}

export function createAttentionService({
  powerSaveBlocker = null,
  Notification = null,
  readAppSettings,
  state,
}) {
  let blockerId = null;

  // 'prevent-app-suspension'은 화면은 꺼지게 두고 시스템만 깨어 있게 한다.
  // 제작은 화면을 쓰지 않으므로 화면까지 켜 둘 이유가 없다.
  function hold(enabled) {
    if (!enabled || !powerSaveBlocker?.start) return;
    if (blockerId !== null && powerSaveBlocker.isStarted?.(blockerId)) return;
    try { blockerId = powerSaveBlocker.start("prevent-app-suspension"); }
    catch { blockerId = null; }
  }

  function release() {
    if (blockerId === null) return;
    try { powerSaveBlocker.stop?.(blockerId); } catch { /* 이미 풀렸으면 그만이다. */ }
    blockerId = null;
  }

  function notify(enabled, event) {
    const finished = FINISHED[event.type];
    if (!enabled || !finished || !Notification?.isSupported?.()) return;
    try {
      new Notification({ title: finished.title, body: finished.body(event), silent: finished.tone === "done" })
        .on("click", () => {
          if (state.mainWindow && !state.mainWindow.isDestroyed()) {
            if (state.mainWindow.isMinimized()) state.mainWindow.restore();
            state.mainWindow.focus();
          }
        })
        .show();
    } catch { /* 알림을 못 띄워도 작업 결과는 그대로다. */ }
  }

  // 모든 작업 사건이 여기를 지난다. 끝난 사건이면 무조건 붙잡은 것을 놓는다 —
  // 상태 표시가 늦게 따라오더라도 잠을 막은 채로 남지 않아야 한다.
  async function watch(event = {}) {
    const finished = Boolean(FINISHED[event.type]);
    const running = state.activeJob?.state === "running";
    if (!finished && !running) { release(); return; }
    let settings = null;
    try { settings = await readAppSettings(); }
    catch { settings = null; }
    if (finished) {
      release();
      notify(settings?.notifyOnFinish !== false, event);
      return;
    }
    hold(settings?.preventSleep !== false);
  }

  return { watch, release, get holdsSleep() { return blockerId !== null; } };
}
