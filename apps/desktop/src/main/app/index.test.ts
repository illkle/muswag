import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import type { IpcMain } from "electron";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { PlayerHandle } from "../player/ipc";
import { startStateMirror } from "../state-mirror";

vi.mock("electron", () => ({ safeStorage: { isEncryptionAvailable: () => false } }));

const { LibraryDatabaseError, resetLibrary, startApp } = await import("./index");

let userDataPath: string;
let databasePath: string;
let stateMirror: Awaited<ReturnType<typeof startStateMirror>>;

const ipcMain = { handle: () => {}, removeHandler: () => {} } as unknown as IpcMain;
// A player that never answers: nothing here plays.
const player = { execute: () => new Promise(() => {}), setCredentials: () => new Promise(() => {}), snapshot: () => new Promise(() => {}), subscribe: () => () => {} } as unknown as PlayerHandle;
const options = () => ({ databasePath, userDataPath, ipcMain, player, stateMirror: stateMirror.mirror });

beforeEach(async () => {
  userDataPath = await mkdtemp(join(tmpdir(), "muswag-start-"));
  databasePath = join(userDataPath, "library.db");
  stateMirror = await startStateMirror(ipcMain);
});

afterEach(async () => {
  await stateMirror.dispose();
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
    // No session yet, so there is no cover to give.
    await expect(app.coverPath({ type: "album", id: "1" })).rejects.toMatchObject({ _tag: "NotAuthenticated" });
    await app.dispose();
  });
});
