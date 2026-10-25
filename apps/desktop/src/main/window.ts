import { join } from "node:path";
import { pathToFileURL } from "node:url";

import { BrowserWindow, nativeTheme, shell, type TitleBarOverlayOptions } from "electron";
import { is } from "@electron-toolkit/utils";

import { TOP_HEIGHT } from "#shared/layout";
import type { Theme } from "#shared/theme";

import { isAppPage } from "./app-page";

const devServerUrl = is.dev ? process.env.ELECTRON_RENDERER_URL : undefined;

/** The page the window shows: the dev server's in development, the bundled renderer otherwise. */
export const APP_PAGE_URL = devServerUrl ?? pathToFileURL(join(__dirname, "../renderer/index.html")).href;

/**
 * The window controls on Windows, which sit in the top right of the app's top bar rather than in a title
 * bar of their own. The page shows through behind them, whichever surface of it is there: the top bar or
 * the queue. Their symbols are `--foreground` of styles.css in the theme the window is drawn in.
 */
const titleBarOverlay = (): TitleBarOverlayOptions => ({
  color: "#00000000",
  symbolColor: nativeTheme.shouldUseDarkColors ? "#fafafa" : "#0a0a0a",
  height: TOP_HEIGHT,
});

/** Draws what the OS draws of the windows, their controls and native menus and dialogs, in the theme the user picked in the app. */
export function setWindowTheme(theme: Theme): void {
  nativeTheme.themeSource = theme;
}

export function createWindow(): void {
  const mainWindow = new BrowserWindow({
    width: 1280,
    height: 720,
    minHeight: 600,
    minWidth: 800,
    show: false,
    // What is behind the page until it has painted: `--background` of the theme the OS asks for.
    backgroundColor: nativeTheme.shouldUseDarkColors ? "#0b0b0b" : "#ffffff",
    autoHideMenuBar: true,
    ...(process.platform === "darwin"
      ? {
          titleBarStyle: "hiddenInset" as const,
          trafficLightPosition: { x: 14, y: 14 },
        }
      : process.platform === "win32"
        ? { titleBarStyle: "hidden" as const, titleBarOverlay: titleBarOverlay() }
        : {}),
    webPreferences: {
      preload: join(__dirname, "../preload/index.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      // The preload is written for the sandbox: it reaches nothing but `electron`.
      sandbox: true,
      focusOnNavigation: !is.dev,
    },
  });

  mainWindow.once("ready-to-show", () => {
    mainWindow.show();
  });

  if (process.platform === "win32") {
    const redrawControls = () => mainWindow.setTitleBarOverlay(titleBarOverlay());
    nativeTheme.on("updated", redrawControls);
    mainWindow.once("closed", () => nativeTheme.off("updated", redrawControls));
  }

  mainWindow.webContents.setWindowOpenHandler((details) => {
    // Links open in the browser; anything else a page asks for is dropped.
    if (/^https?:/i.test(details.url)) void shell.openExternal(details.url);
    return { action: "deny" };
  });
  // The window shows the app and nothing else. A link or a file dropped on it would otherwise replace
  // the app with a page of its own, which the preload hands the app's channels to.
  mainWindow.webContents.on("will-navigate", (event) => {
    if (!isAppPage(APP_PAGE_URL, event.url)) event.preventDefault();
  });
  mainWindow.webContents.on("will-attach-webview", (event) => event.preventDefault());

  mainWindow.loadURL(APP_PAGE_URL);
  if (devServerUrl) mainWindow.webContents.openDevTools({ mode: "detach" });
}
