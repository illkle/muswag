import { Db, LibraryQueries, PlaylistCommands, PlaylistEdits, write } from "@muswag/backend";
import { apiSong, seed, TestDatabase } from "@muswag/backend/testing";
import { albumOccurrenceKey, songs } from "@muswag/model";
import { SqliteMirror } from "@muswag/tanstack-db-mirror/server/sqlite";
import { Layer, ManagedRuntime } from "effect";
import { SqlClient } from "effect/sql/SqlClient";
import { afterEach, describe, expect, it } from "vitest";

import { AlbumSource, PlaylistSource, type SourceDb } from "./db-sources";

const layer = () => PlaylistCommands.layer.pipe(Layer.provideMerge(PlaylistEdits.layer), Layer.provideMerge(TestDatabase()));
let runtime: ManagedRuntime.ManagedRuntime<Layer.Success<ReturnType<typeof layer>>, unknown> | null = null;

afterEach(async () => {
  await runtime?.dispose();
  runtime = null;
});

async function setup() {
  runtime = ManagedRuntime.make(layer());
  const run = runtime.runPromise;
  const mirror = await run(SqliteMirror);
  const db: SourceDb = {
    playlist: (id) => run(LibraryQueries.playlist(id)),
    songsByIds: (ids) => run(LibraryQueries.songsByIds(ids)),
    albumSongs: (albumId) => run(LibraryQueries.albumSongs(albumId)),
    subscribe: (listener) => mirror.subscribe(listener),
  };
  return { run, db, commands: await run(PlaylistCommands) };
}

const signal = () => new AbortController().signal;

/** Collects revisions, and resolves once `count` arrived or a short wait passed. */
function revisions(subscribe: (listener: (revision: string) => void) => () => void) {
  const seen: string[] = [];
  const unsubscribe = subscribe((revision) => seen.push(revision));
  return {
    seen,
    settle: async () => {
      await new Promise((resolve) => setTimeout(resolve, 50));
      return seen;
    },
    unsubscribe,
  };
}

describe("AlbumSource", () => {
  it("reads the album in disc and track order", async () => {
    const { run, db } = await setup();
    await run(
      seed({
        songs: [apiSong("b", "album", { discNumber: 1, track: 2 }), apiSong("c", "album", { discNumber: 2, track: 1 }), apiSong("a", "album", { discNumber: 1, track: 1 }), apiSong("x", "other")],
      }),
    );
    const source = new AlbumSource({ albumId: "album", db });

    const page = await source.read({ start: 0, end: 10, signal: signal() });

    expect(page.items.map(({ key }) => key)).toEqual(["a", "b", "c"].map((id) => albumOccurrenceKey("album", id)));
    expect(page.isEnd).toBe(true);
    expect(await source.locate({ key: albumOccurrenceKey("album", "c"), signal: signal() })).toEqual({ offset: 2, revision: page.revision });
  });

  it("gives pages read before and after a reorder different revisions", async () => {
    const { run, db } = await setup();
    await run(seed({ songs: [apiSong("a", "album", { track: 1 }), apiSong("b", "album", { track: 2 })] }));
    const source = new AlbumSource({ albumId: "album", db });

    const before = await source.read({ start: 0, end: 1, signal: signal() });
    await run(write(SqlClient.use((sql) => sql`UPDATE songs SET track = 3 WHERE id = 'a'`)));
    const after = await source.read({ start: 1, end: 2, signal: signal() });

    expect(after.revision).not.toBe(before.revision);
    expect(after.items.map(({ track }) => track.id)).toEqual(["a"]);
  });

  it("moves to a new revision when songs join or leave, but not for stat updates", async () => {
    const { run, db } = await setup();
    await run(seed({ songs: [apiSong("a", "album", { track: 1 })] }));
    const source = new AlbumSource({ albumId: "album", db });
    const watch = revisions((listener) => source.subscribe(listener));
    await watch.settle();

    await run(Db.use((database) => write(database.update(songs).set({ playCount: 5 }))));
    expect(await watch.settle()).toEqual([]);

    await run(seed({ songs: [apiSong("b", "album", { track: 2 })] }));
    expect(await watch.settle()).toHaveLength(1);

    await run(seed({ songs: [apiSong("y", "other")] }));
    expect(await watch.settle()).toHaveLength(1);
    watch.unsubscribe();
  });
});

describe("PlaylistSource", () => {
  it("reads entries in order, skipping songs the library does not have", async () => {
    const { run, db, commands } = await setup();
    await run(seed({ songs: [apiSong("a", "album"), apiSong("b", "album")] }));
    const playlist = await run(commands.create({ name: "Mix", songIds: ["b", "missing", "a"] }));
    const source = new PlaylistSource({ playlistId: playlist.id, db });

    const page = await source.read({ start: 0, end: 10, signal: signal() });

    expect(page.items.map(({ track, offset }) => [track.id, offset])).toEqual([
      ["b", 0],
      ["a", 2],
    ]);
  });

  it("moves to a new revision when entries change or a song appears, but not for a rename", async () => {
    const { run, db, commands } = await setup();
    await run(seed({ songs: [apiSong("a", "album")] }));
    const playlist = await run(commands.create({ name: "Mix", songIds: ["a", "late"] }));
    const source = new PlaylistSource({ playlistId: playlist.id, db });
    const watch = revisions((listener) => source.subscribe(listener));
    await watch.settle();

    await run(commands.rename(playlist.id, "Renamed"));
    expect(await watch.settle()).toEqual([]);

    await run(commands.addEntries(playlist.id, ["a"]));
    expect(await watch.settle()).toHaveLength(1);

    await run(seed({ songs: [apiSong("late", "album")] }));
    expect(await watch.settle()).toHaveLength(2);
    watch.unsubscribe();
  });
});
