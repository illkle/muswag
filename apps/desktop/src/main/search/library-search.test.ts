import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";

import type { MirrorChangeBatch } from "@muswag/tanstack-db-mirror/protocol";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { startLibrarySearch } from "./library-search";

const workerPath = fileURLToPath(new URL("./search-worker.ts", import.meta.url));

let directory: string;
let database: DatabaseSync;
let search: ReturnType<typeof startLibrarySearch>;
const listeners = new Set<(batch: MirrorChangeBatch) => void>();
let seq = 0;

/** Writes a song as main would, and tells the search of it as the mirror would. */
const insertSong = (id: string, title: string) => {
  database.prepare(`INSERT INTO songs (id, title, artist, album, year, playCount) VALUES (?, ?, NULL, NULL, NULL, 0)`).run(id, title);
  const change = { seq: ++seq, table: "songs", type: "upsert", key: id, value: { id, title, artist: null, album: null, year: null, playCount: 0 } } as const;
  for (const listener of listeners) listener({ epoch: 1, fromSeq: seq, toSeq: seq, changes: [change] });
};

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "muswag-search-"));
  const databasePath = join(directory, "library.db");
  database = new DatabaseSync(databasePath);
  database.exec(`
    PRAGMA journal_mode = WAL;
    CREATE TABLE songs (id TEXT PRIMARY KEY, title TEXT NOT NULL, artist TEXT, album TEXT, year INTEGER, playCount REAL);
    CREATE TABLE albums (id TEXT PRIMARY KEY, name TEXT NOT NULL, artist TEXT, year INTEGER);
    CREATE TABLE artists (id TEXT PRIMARY KEY, name TEXT NOT NULL);
    INSERT INTO albums VALUES ('album-a', 'Harvest', 'Someone', 1972);
    INSERT INTO artists VALUES ('artist-a', 'Harvester');
  `);
  insertSong("song-a", "Harvest Moon");
  search = startLibrarySearch({
    databasePath,
    workerPath,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  });
});

afterEach(async () => {
  await search.dispose();
  database.close();
  await rm(directory, { recursive: true, force: true });
});

const found = (hits: ReadonlyArray<{ type: string; id: string }> | null) => hits?.map(({ type, id }) => `${type}:${id}`).sort();

describe("the library search", () => {
  it("searches the library in a worker, which reads it from the database", async () => {
    expect(found(await search.search("harvest", 20))).toEqual(["album:album-a", "artist:artist-a", "song:song-a"]);
  });

  it("finds what main has written since, once the mirror has told it", async () => {
    await search.search("harvest", 20);

    insertSong("song-b", "Cortez the Killer");

    expect(found(await search.search("cortez", 20))).toEqual(["song:song-b"]);
  });

  it("runs one search at a time, and skips the ones a later search took the place of before they ran", async () => {
    const [first, second, third] = [search.search("harvest", 20), search.search("harv", 20), search.search("moon", 20)];

    expect(found(await first)).toEqual(["album:album-a", "artist:artist-a", "song:song-a"]);
    expect(await second).toBeNull();
    expect(found(await third)).toEqual(["song:song-a"]);
  });

  it("answers what was asked of it when it stops", async () => {
    const asked = Promise.allSettled([search.search("harvest", 20), search.search("moon", 20)]);
    await search.dispose();

    const [running, waiting] = await asked;
    expect(running.status).toBe("rejected");
    expect(waiting).toEqual({ status: "fulfilled", value: null });
  });
});
