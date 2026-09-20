// 앱 데모 촬영 통합 검사용 최소 Electron 앱. 실제 앱(RICE·Bob)이 없어도 입력·대기·
// 승인·완료가 있는 화면을 같은 경로로 찍을 수 있다. 촬영 엔진은 이 앱을 모른다.
import path from "node:path";
import { fileURLToPath } from "node:url";
import { app, BrowserWindow } from "electron";

const here = path.dirname(fileURLToPath(import.meta.url));

app.whenReady().then(async () => {
  const window = new BrowserWindow({
    width: 960, height: 600, backgroundColor: "#0f1117",
    webPreferences: { backgroundThrottling: false },
  });
  await window.loadFile(path.join(here, "index.html"));
});

app.on("window-all-closed", () => app.quit());
