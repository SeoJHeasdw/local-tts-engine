import { app, BrowserWindow, dialog, ipcMain, Notification, powerMonitor, powerSaveBlocker, shell } from "electron";
import { startStudio } from "./main/application.mjs";

startStudio({ app, BrowserWindow, dialog, ipcMain, Notification, powerMonitor, powerSaveBlocker, shell });
