import { app, BrowserWindow, desktopCapturer, dialog, ipcMain, Notification, powerMonitor, powerSaveBlocker, screen, shell } from "electron";
import { startStudio } from "./main/application.mjs";

startStudio({ app, BrowserWindow, desktopCapturer, dialog, ipcMain, Notification, powerMonitor, powerSaveBlocker, screen, shell });
