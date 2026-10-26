import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";

import type { IpcMain } from "electron";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { AppStateHub } from "../app-state";
import type { PlayerHandle } from "../player/ipc";
import { serveRenderers } from "../renderers";

const { LibraryDatabaseError, resetLibrary, startApp } = await import("./index");

let userDataPath: string;
let databasePath: string;
let appState: AppStateHub;
let renderers: ReturnType<typeof serveRenderers>;

const handlers = new Map<string, (event: unknown, ...args: Array<unknown>) => unknown>();
const ipcMain = { handle: (channel: string, listener: never) => void handlers.set(channel, listener), removeHandler: (channel: string) => void handlers.delete(channel) } as unknown as IpcMain;
const executed: unknown[] = [];

// A player that never answers, but for the commands it is given: nothing here plays.
const player = {
  execute: async (command: unknown) => (executed.push(command), { ok: true, version: 0 }),
  locate: async () => null,
  setCredentials: () => new Promise(() => {}),
  snapshot: () => new Promise(() => {}),
  subscribe: () => () => {},
} as unknown as PlayerHandle;
let updateChecks = 0;
const updates = { check: async () => void updateChecks++, install: () => {}, setChannel: async () => {} };
const searchWorkerPath = fileURLToPath(new URL("../search/search-worker.ts", import.meta.url));
const syncSettings = { get: () => ({ syncAfter: { amount: 1, unit: "weeks" as const } }), set: async () => {} };
const options = () => ({ databasePath, userDataPath, ipcMain, player, updates, syncSettings, setTheme: () => {}, appState, renderers, searchWorkerPath });

beforeEach(async () => {
  userDataPath = await mkdtemp(join(tmpdir(), "muswag-start-"));
  databasePath = join(userDataPath, "library.db");
  appState = new AppStateHub();
  renderers = serveRenderers(ipcMain, appState);
});

afterEach(async () => {
  renderers.dispose();
  await rm(userDataPath, { recursive: true, force: true });
});

describe("startApp", () => {
  it("names the database file and what SQLite said when the file is not a database", async () => {
    await writeFile(databasePath, randomBytes(4096));

    const failure = await startApp(options()).catch((cause: unknown) => cause);

    expect(failure).toBeInstanceOf(LibraryDatabaseError);
    expect(failure).toMatchObject({ databasePath, message: "file is not a database", resettable: true });
  });

  it("does not offer to delete a database that is only out of reach", async () => {
    // Where the file should be there is a directory, so it cannot be opened, which deleting it would not help.
    await mkdir(databasePath);

    const failure = await startApp(options()).catch((cause: unknown) => cause);

    expect(failure).toBeInstanceOf(LibraryDatabaseError);
    expect(failure).toMatchObject({ databasePath, resettable: false });
  });

  it("fails the same way for a database that cannot be migrated, and starts once the library is reset", async () => {
    // A table of the schema is there already, as in a database made before the migrations were squashed.
    const old = new DatabaseSync(databasePath);
    old.exec("CREATE TABLE albums (id text PRIMARY KEY)");
    old.close();
    await mkdir(join(userDataPath, "covers"));
    await writeFile(join(userDataPath, "covers", "album_3a_1"), "cover");

    const failure = await startApp(options()).catch((cause: unknown) => cause);
    expect(failure).toBeInstanceOf(LibraryDatabaseError);
    expect((failure as Error).message).toContain("already exists");
    expect(failure).toMatchObject({ resettable: true });

    await resetLibrary(options());
    expect(existsSync(databasePath)).toBe(false);
    expect(existsSync(join(userDataPath, "covers"))).toBe(false);

    const app = await startApp(options());
    // Renderers see the queue and the session from the start.
    expect(appState.get("queue")).toEqual({ nowPlaying: null, userQueue: [], source: null });
    expect(appState.get("auth")).toBeDefined();
    // No session yet, so there is no cover to give.
    await expect(app.coverPath({ type: "album", id: "1" })).rejects.toMatchObject({ _tag: "NotAuthenticated" });
    await app.dispose();
  });
});

describe("app:command", () => {
  it("runs the player's and the updater's commands, and turns down what does not decode", async () => {
    const app = await startApp(options());
    const command = (name: unknown, args: unknown) => handlers.get("app:command")!({}, name, args);
    try {
      expect(await command("player:execute", [{ _tag: "Seek", seconds: 12 }])).toEqual({ ok: true, value: { ok: true, version: 0 } });
      expect(executed).toEqual([{ _tag: "Seek", seconds: 12 }]);
      expect(await command("player:locate", [])).toEqual({ ok: true, value: null });
      expect(await command("appUpdate:check", [])).toEqual({ ok: true, value: undefined });
      expect(updateChecks).toBe(1);

      // Main's own commands, such as one that names the binary to run, are not a renderer's to send.
      expect(await command("player:execute", [{ _tag: "SetBinaryPath", path: "/tmp/mpv" }])).toMatchObject({ ok: false, error: { tag: "InvalidCommand" } });
      expect(await command("player:execute", [{ _tag: "Seek", seconds: -1 }])).toMatchObject({ ok: false, error: { tag: "InvalidCommand" } });
      expect(await command("player:command", [{ _tag: "Play" }])).toMatchObject({ ok: false, error: { tag: "InvalidCommand" } });
      expect(executed).toHaveLength(1);
    } finally {
      await app.dispose();
    }
  });
});
