import nativeFs from "node:fs/promises";
import path from "node:path";
import { APP_DIR, RENDERER_DIR } from "./paths.mjs";

export function createWindowService({
  BrowserWindow,
  app,
  fs = nativeFs,
  state,
}) {
  function createWindow() {
    state.mainWindow = new BrowserWindow({
      // 검수 목록이 옆에 서면서 영상이 좁아졌다. 목록을 줄이는 대신 창을 넓힌다.
      // 14인치(1512x982)에도 들어가는 크기다.
      width: 1440,
      height: 900,
      minWidth: 980,
      minHeight: 680,
      titleBarStyle: "hiddenInset",
      backgroundColor: "#10120f",
      show: false,
      webPreferences: {
        preload: path.join(APP_DIR, "preload.cjs"),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
      },
    });
    state.mainWindow.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
    state.mainWindow.webContents.on("will-navigate", (event, url) => {
      if (url !== state.mainWindow.webContents.getURL()) event.preventDefault();
    });
    const initialView = process.env.TTS_STUDIO_SCREENSHOT_VIEW;
    state.mainWindow.loadFile(
      path.join(RENDERER_DIR, "index.html"),
      initialView ? { query: { view: initialView } } : undefined,
    );
    state.mainWindow.once("ready-to-show", () => state.mainWindow.show());
    const screenshotPath = process.env.TTS_STUDIO_SCREENSHOT;
    if (screenshotPath) {
      state.mainWindow.webContents.once("did-finish-load", async () => {
        await new Promise((resolve) => setTimeout(resolve, 900));
        const image = await state.mainWindow.webContents.capturePage();
        await fs.writeFile(screenshotPath, image.toPNG());
        app.quit();
      });
    }
  }

  return { createWindow };
}
