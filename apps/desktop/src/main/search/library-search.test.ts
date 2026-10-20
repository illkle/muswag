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

/** Tells the search of changes as the mirror would. */
const broadcast = (...changes: Array<{ table: string; type: "changed" | "delete"; key: string } | { table: string; type: "upsert"; key: string; value: Record<string, unknown> }>) => {
  const fromSeq = seq;
  const batch = { epoch: 1, fromSeq, toSeq: (seq += changes.length), changes: changes.map((change, index) => ({ ...change, seq: fromSeq + index + 1 })) };
  for (const listener of listeners) listener(batch);
};

/** Writes a song as main would, and tells the search of it as the mirror would: by its id alone. */
const insertSong = (id: string, title: string) => {
  database.prepare(`INSERT INTO songs (id, title, artist, album, year, playCount) VALUES (?, ?, NULL, NULL, NULL, 0)`).run(id, title);
  broadcast({ table: "songs", type: "changed", key: id });
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

  it("reads the songs whose ids the mirror sends, and drops those that have gone", async () => {
    insertSong("song-b", "Cortez the Killer");
    await search.search("harvest", 20);

    database.prepare(`UPDATE songs SET title = 'Like a Hurricane' WHERE id = 'song-a'`).run();
    broadcast({ table: "songs", type: "changed", key: "song-a" });
    expect(found(await search.search("hurricane", 20))).toEqual(["song:song-a"]);

    // Written and then deleted before the worker reads it, as when both are in one batch.
    database.prepare(`DELETE FROM songs WHERE id = 'song-b'`).run();
    broadcast({ table: "songs", type: "changed", key: "song-b" });
    expect(found(await search.search("cortez", 20))).toEqual([]);
  });

  it("reads the albums whose ids the mirror sends, and drops those that have gone", async () => {
    await search.search("harvest", 20);

    database.prepare(`INSERT INTO albums VALUES ('album-b', 'Zuma', 'Someone', 1975)`).run();
    database.prepare(`DELETE FROM albums WHERE id = 'album-a'`).run();
    broadcast({ table: "albums", type: "changed", key: "album-b" }, { table: "albums", type: "changed", key: "album-a" });

    expect(found(await search.search("zuma", 20))).toEqual(["album:album-b"]);
    expect(found(await search.search("harvest", 20))).toEqual(["artist:artist-a", "song:song-a"]);
  });

  it("takes artists from the rows the mirror sends", async () => {
    await search.search("harvest", 20);

    database.prepare(`INSERT INTO artists VALUES ('artist-b', 'Crazy Horse')`).run();
    database.prepare(`DELETE FROM artists WHERE id = 'artist-a'`).run();
    broadcast({ table: "artists", type: "upsert", key: "artist-b", value: { id: "artist-b", name: "Crazy Horse" } }, { table: "artists", type: "delete", key: "artist-a" });

    expect(found(await search.search("crazy horse", 20))).toEqual(["artist:artist-b"]);
    expect(found(await search.search("harvest", 20))).toEqual(["album:album-a", "song:song-a"]);
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
