import { app, BrowserWindow, dialog, ipcMain, powerMonitor, shell } from "electron";
import { startStudio } from "./main/application.mjs";

startStudio({ app, BrowserWindow, dialog, ipcMain, powerMonitor, shell });
