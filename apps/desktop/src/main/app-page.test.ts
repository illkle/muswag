import type { IpcMainInvokeEvent } from "electron";
import { describe, expect, it } from "vitest";

import { guardIpc, isAppPage, type AppIpc } from "./app-page";

const DEV_PAGE = "http://127.0.0.1:5173/";
const PACKAGED_PAGE = "file:///Applications/muswag.app/Contents/Resources/app.asar/out/renderer/index.html";

describe("isAppPage", () => {
  it("takes any page of the dev server in development", () => {
    expect(isAppPage(DEV_PAGE, "http://127.0.0.1:5173/#/app/albums")).toBe(true);
    expect(isAppPage(DEV_PAGE, "http://127.0.0.1:5173/index.html")).toBe(true);
    expect(isAppPage(DEV_PAGE, "http://127.0.0.1:5174/")).toBe(false);
    expect(isAppPage(DEV_PAGE, "http://localhost:5173/")).toBe(false);
    expect(isAppPage(DEV_PAGE, "https://example.com/")).toBe(false);
  });

  it("takes only the renderer's index.html in a build, whatever its route", () => {
    expect(isAppPage(PACKAGED_PAGE, PACKAGED_PAGE)).toBe(true);
    expect(isAppPage(PACKAGED_PAGE, `${PACKAGED_PAGE}#/app/playlists/1`)).toBe(true);
    // A file dropped on the window.
    expect(isAppPage(PACKAGED_PAGE, "file:///Users/someone/Downloads/page.html")).toBe(false);
    expect(isAppPage(PACKAGED_PAGE, "file:///Applications/muswag.app/Contents/Resources/app.asar/out/renderer/other.html")).toBe(false);
    expect(isAppPage(PACKAGED_PAGE, "file://elsewhere/Applications/muswag.app/Contents/Resources/app.asar/out/renderer/index.html")).toBe(false);
    expect(isAppPage(PACKAGED_PAGE, "https://example.com/index.html")).toBe(false);
  });

  it("turns down what is not a URL", () => {
    expect(isAppPage(DEV_PAGE, "")).toBe(false);
    expect(isAppPage(PACKAGED_PAGE, "not a url")).toBe(false);
  });
});

describe("guardIpc", () => {
  type Listener = Parameters<AppIpc["handle"]>[1];

  const setup = () => {
    const handlers = new Map<string, Listener>();
    const ipcMain: AppIpc = {
      handle: (channel, listener) => void handlers.set(channel, listener),
      removeHandler: (channel) => void handlers.delete(channel),
    };
    const guarded = guardIpc(ipcMain, PACKAGED_PAGE);
    guarded.handle("app:command", (_event, ...args) => ({ answered: args }));
    const invoke = (senderFrame: { url: string; parent: unknown } | null) => handlers.get("app:command")!({ senderFrame } as unknown as IpcMainInvokeEvent, "queue:next", []);
    return { handlers, guarded, invoke };
  };

  it("answers the app's own page", () => {
    const { invoke } = setup();
    expect(invoke({ url: `${PACKAGED_PAGE}#/app/albums`, parent: null })).toEqual({ answered: ["queue:next", []] });
  });

  it("turns down another page, a frame inside the app's, and a frame that is gone", () => {
    const { invoke } = setup();
    expect(() => invoke({ url: "file:///Users/someone/Downloads/page.html", parent: null })).toThrow("only answered for the app's own page");
    expect(() => invoke({ url: PACKAGED_PAGE, parent: {} })).toThrow("only answered for the app's own page");
    expect(() => invoke(null)).toThrow("only answered for the app's own page");
  });

  it("removes handlers from ipcMain", () => {
    const { handlers, guarded } = setup();
    guarded.removeHandler("app:command");
    expect(handlers.size).toBe(0);
  });
});
