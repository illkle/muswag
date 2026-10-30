import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it, vi } from "vitest";

import type { LibraryChange } from "@muswag/backend";
import { libraryOccurrenceKey, songRow, type QueueSourceRef } from "@muswag/model";

import { readSongIds } from "./read-song-ids";
import { packSongIds, songIdList } from "./song-ids";
import { createQueueSources, type SourceDb } from "./source";

const workerPath = fileURLToPath(new URL("./song-ids-worker.ts", import.meta.url));

/** These come in another order as UTF-16, which is how JavaScript compares strings, than as UTF-8, which is how SQLite does. */
const IDS = ["0a", "abc", "Ab", "a-b", "é", "z", "￮", "😀", "日本語", "tr-1", "tr-10", "tr-2"];

const inSqliteOrder = (ids: readonly string[]) => {
  const database = new DatabaseSync(":memory:");
  database.exec("CREATE TABLE songs (id TEXT PRIMARY KEY)");
  for (const id of ids) database.prepare("INSERT INTO songs VALUES (?)").run(id);
  const ordered = (database.prepare("SELECT id FROM songs ORDER BY id").all() as unknown as Array<{ id: string }>).map(({ id }) => id);
  database.close();
  return ordered;
};

describe("songIdList", () => {
  it("gives every id back and finds it in the order SQLite keeps them", () => {
    const ordered = inSqliteOrder(IDS);
    expect(ordered).not.toEqual([...IDS].sort());

    const list = songIdList(packSongIds(ordered));
    expect(list.length).toBe(ordered.length);
    ordered.forEach((id, index) => {
      expect(list.at(index)).toBe(id);
      expect(list.indexOf(id)).toBe(index);
    });
  });

  it("does not find an id it does not hold, not even a part of one", () => {
    const list = songIdList(packSongIds(inSqliteOrder(IDS)));
    for (const id of ["", "a", "tr-", "tr-11", "zz", "😁"]) expect(list.indexOf(id)).toBe(-1);
    expect(songIdList(packSongIds([])).indexOf("a")).toBe(-1);
  });
});

describe("readSongIds", () => {
  let directory: string;
  afterEach(() => rm(directory, { recursive: true, force: true }));

  it("reads the ids of a library in its own thread", async () => {
    directory = await mkdtemp(join(tmpdir(), "muswag-song-ids-"));
    const databasePath = join(directory, "library.db");
    const database = new DatabaseSync(databasePath);
    database.exec("PRAGMA journal_mode = WAL; CREATE TABLE songs (id TEXT PRIMARY KEY)");
    for (const id of IDS) database.prepare("INSERT INTO songs VALUES (?)").run(id);

    const list = await readSongIds(workerPath, databasePath);
    database.close();

    expect(Array.from({ length: list.length }, (_, index) => list.at(index))).toEqual(inSqliteOrder(IDS));
    expect(list.indexOf("😀")).toBeGreaterThanOrEqual(0);
  });

  it("fails when the library cannot be read", async () => {
    directory = await mkdtemp(join(tmpdir(), "muswag-song-ids-"));
    await expect(readSongIds(workerPath, join(directory, "missing.db"))).rejects.toThrow("unable to open database file");
  });
});

describe("the shuffled library's ids", () => {
  const shuffled: QueueSourceRef = { type: "library", sort: "title", shuffle: { seed: 1, first: null } };
  const inOrder: QueueSourceRef = { type: "library", sort: "title" };
  const at = { key: libraryOccurrenceKey("a"), offset: null };

  const setup = () => {
    let listener: (changes: ReadonlyArray<LibraryChange>) => void = () => {};
    const songIds = vi.fn<SourceDb["songIds"]>(async () => songIdList(packSongIds(["a"])));
    const sourceWindow = vi.fn<SourceDb["sourceWindow"]>(async () => ({
      cursor: { type: "gap", offset: 0 },
      previous: [],
      current: null,
      next: [{ key: "a", offset: 0, track: songRow({ id: "a", title: "a" }) }],
      hasMore: false,
    }));
    const sources = createQueueSources({
      sourceWindow,
      songIds,
      subscribe: (added) => {
        listener = added;
        return () => {};
      },
    });
    sources.subscribe(() => {});
    return { sources, songIds, sourceWindow, write: (...changes: LibraryChange[]) => listener(changes) };
  };

  it("are read only for a shuffled library, once, and are not read again when it is shuffled again", async () => {
    const { sources, songIds, sourceWindow } = setup();
    await sources.window(inOrder, at);
    expect(songIds).not.toHaveBeenCalled();
    expect(sourceWindow.mock.lastCall?.[3]).toBeUndefined();

    await sources.window(shuffled, at);
    await sources.window({ ...shuffled, shuffle: { seed: 2, first: null } }, at);
    expect(songIds).toHaveBeenCalledTimes(1);
    expect(sourceWindow.mock.lastCall?.[3]?.length).toBe(1);
  });

  it("are read again when songs came or went, the next time they are needed", async () => {
    const { sources, songIds, write } = setup();
    await sources.window(shuffled, at);

    write({ table: "albums", type: "changed", key: "a" });
    write({ table: "songs", type: "changed", key: "new" });
    expect(songIds).toHaveBeenCalledTimes(1);
    await sources.window(shuffled, at);
    expect(songIds).toHaveBeenCalledTimes(2);

    write({ table: "songs", type: "deleted", key: "a" });
    await sources.window(shuffled, at);
    expect(songIds).toHaveBeenCalledTimes(3);
  });

  it("are kept when a sync only edited songs", async () => {
    const { sources, songIds, write } = setup();
    await sources.window(shuffled, at);

    write({ table: "songs", type: "changed", key: "a" });
    await sources.window(shuffled, at);
    expect(songIds).toHaveBeenCalledTimes(1);
  });

  it("are not trusted when songs changed while they were being read", async () => {
    const { sources, songIds, write } = setup();
    const reading = sources.window(shuffled, at);
    write({ table: "songs", type: "changed", key: "a" });
    await reading;

    await sources.window(shuffled, at);
    expect(songIds).toHaveBeenCalledTimes(2);
  });

  it("are read again after a read failed", async () => {
    const { sources, songIds } = setup();
    songIds.mockRejectedValueOnce(new Error("no"));
    await expect(sources.window(shuffled, at)).rejects.toThrow("no");
    await sources.window(shuffled, at);
    expect(songIds).toHaveBeenCalledTimes(2);
  });
});
