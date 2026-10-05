import { Db, LibraryQueries, PlaylistCommands, PlaylistEdits, write } from "@muswag/backend";
import { apiSong, seed, TestDatabase } from "@muswag/backend/testing";
import { albumOccurrenceKey, LIBRARY_ORDERS, libraryOccurrenceKey, songs, titleSortKey } from "@muswag/model";
import { SqliteMirror } from "@muswag/tanstack-db-mirror/server/sqlite";
import { Layer, ManagedRuntime } from "effect";
import { SqlClient } from "effect/sql/SqlClient";
import { afterEach, describe, expect, it } from "vitest";

import { AlbumSource, LibrarySource, PlaylistSource, type SourceDb } from "./db-sources";
import { VirtualSourceWindow } from "./virtual-source-window";

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
    librarySize: () => run(LibraryQueries.librarySize),
    librarySongs: (sort, start, end) => run(LibraryQueries.librarySongs(sort, start, end)),
    libraryOffset: (sort, songId) => run(LibraryQueries.libraryOffset(sort, songId)),
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

describe("LibrarySource", () => {
  const titled = (id: string, title: string) => apiSong(id, "album", { title });
  const titlesOf = (items: ReadonlyArray<{ track: { title: string } }>) => items.map(({ track }) => track.title);

  it("reads the library alphabetically, a page at a time", async () => {
    const { run, db } = await setup();
    await run(seed({ songs: [titled("1", "zebra"), titled("2", "Apple"), titled("3", "Élan"), titled("4", "banana"), titled("5", "Zoo")] }));
    const source = new LibrarySource({ sort: "title", db });

    const first = await source.read({ start: 0, end: 3, signal: signal() });
    const rest = await source.read({ start: 3, end: 6, signal: signal() });

    expect(titlesOf(first.items)).toEqual(["Apple", "banana", "Élan"]);
    expect(first).toMatchObject({ nextOffset: 3, isEnd: false });
    expect(titlesOf(rest.items)).toEqual(["zebra", "Zoo"]);
    expect(rest.items.map(({ offset }) => offset)).toEqual([3, 4]);
    expect(rest).toMatchObject({ nextOffset: 5, isEnd: true, revision: first.revision });
    expect(await source.read({ start: 5, end: 5, signal: signal() })).toMatchObject({ items: [], nextOffset: 5, isEnd: true });
  });

  it("locates a song by how many come before it, telling songs with one title apart", async () => {
    const { run, db } = await setup();
    await run(seed({ songs: [titled("c", "Intro"), titled("a", "Intro"), titled("b", "Intro"), titled("x", "Aaa"), titled("y", "Zzz")] }));
    const source = new LibrarySource({ sort: "title", db });

    const page = await source.read({ start: 0, end: 10, signal: signal() });

    expect(page.items.map(({ track }) => track.id)).toEqual(["x", "a", "b", "c", "y"]);
    for (const item of page.items) {
      expect(await source.locate({ key: item.key, signal: signal() })).toEqual({ offset: item.offset, revision: page.revision });
    }
    expect(await source.locate({ key: libraryOccurrenceKey("missing"), signal: signal() })).toBeNull();
    expect(await source.locate({ key: albumOccurrenceKey("album", "a"), signal: signal() })).toBeNull();
  });

  it("orders the library as the renderer does, by comparing the sort columns as JavaScript strings", async () => {
    const { run, db } = await setup();
    // Titles the two comparisons would order differently if they were sorted as they are.
    const titles = ["🎵 Notes", "\uFFFD?", "\uE000 Private", "ＡＢＣ", "abd", "Abc", "ábc", "zz", "Zz", "中文", "\u{1F600}", "\uF8FF", "a\u{10000}", "a\uFF21", "", "10", "9"];
    await run(seed({ songs: titles.map((title, index) => titled(`id-${index}`, title)) }));
    const source = new LibrarySource({ sort: "title", db });

    const page = await source.read({ start: 0, end: titles.length, signal: signal() });

    const columns = LIBRARY_ORDERS.title;
    const expected = [...page.items].sort((left, right) => {
      for (const column of columns) {
        if (left.track[column] < right.track[column]) return -1;
        if (left.track[column] > right.track[column]) return 1;
      }
      return 0;
    });
    expect(page.items.map(({ track }) => track.id)).toEqual(expected.map(({ track }) => track.id));
    expect(page.items).toHaveLength(titles.length);
  });

  it("moves to a new revision when songs join or leave, but not when they only change", async () => {
    const { run, db } = await setup();
    await run(seed({ songs: [titled("a", "Aaa"), titled("b", "Bbb")] }));
    const source = new LibrarySource({ sort: "title", db });
    const revision = async () => (await source.read({ start: 0, end: 1, signal: signal() })).revision;
    const seen = [await revision()];
    const moved = async () => {
      seen.push(await revision());
      return seen.at(-1) !== seen.at(-2);
    };

    await run(Db.use((database) => write(database.update(songs).set({ playCount: 5 }))));
    expect(await moved()).toBe(false);

    await run(seed({ songs: [titled("c", "Ccc")] }));
    expect(await moved()).toBe(true);

    await run(write(SqlClient.use((sql) => sql`DELETE FROM songs WHERE id = 'b'`)));
    expect(await moved()).toBe(true);
  });

  it("finds a renamed song at its new place, though the revision stays", async () => {
    const { run, db } = await setup();
    await run(seed({ songs: [titled("a", "Aaa"), titled("b", "Bbb"), titled("c", "Ccc")] }));
    const source = new LibrarySource({ sort: "title", db });
    const before = await source.locate({ key: libraryOccurrenceKey("a"), signal: signal() });

    await run(write(SqlClient.use((sql) => sql`UPDATE songs SET title = 'Zzz', titleSortKey = ${titleSortKey("Zzz")} WHERE id = 'a'`)));

    expect(before).toMatchObject({ offset: 0 });
    expect(await source.locate({ key: libraryOccurrenceKey("a"), signal: signal() })).toEqual({ offset: 2, revision: before!.revision });
    expect(titlesOf((await source.read({ start: 0, end: 10, signal: signal() })).items)).toEqual(["Bbb", "Ccc", "Zzz"]);
  });

  it("reports a change to subscribers when songs join the library, but not for stat updates", async () => {
    const { run, db } = await setup();
    await run(seed({ songs: [titled("a", "Aaa")] }));
    const source = new LibrarySource({ sort: "title", db });
    const watch = revisions((listener) => source.subscribe(listener));
    await watch.settle();

    await run(Db.use((database) => write(database.update(songs).set({ playCount: 5 }))));
    expect(await watch.settle()).toEqual([]);

    await run(seed({ songs: [titled("b", "Bbb")] }));
    expect(await watch.settle()).toHaveLength(1);
    expect(watch.seen[0]).toBe((await source.read({ start: 0, end: 1, signal: signal() })).revision);
    watch.unsubscribe();
  });

  it("keeps a playback window around the song it started at as the library changes", async () => {
    const { run, db } = await setup();
    const number = (index: number) => String(index).padStart(2, "0");
    await run(seed({ songs: Array.from({ length: 60 }, (_, index) => titled(`id-${number(index)}`, `Song ${number(index)}`)) }));
    const changes: number[] = [];
    const window = await VirtualSourceWindow.create({
      source: new LibrarySource({ sort: "title", db }),
      start: { key: libraryOccurrenceKey("id-20") },
      onChange: ({ cursor }) => changes.push(cursor.offset),
    });

    expect(window.snapshot.cursor).toMatchObject({ type: "item", offset: 20 });
    expect(titlesOf(window.snapshot.previous)).toEqual(Array.from({ length: 10 }, (_, index) => `Song ${number(index + 10)}`));
    expect(window.snapshot.current?.track.title).toBe("Song 20");
    expect(titlesOf(window.snapshot.next)).toEqual(Array.from({ length: 30 }, (_, index) => `Song ${number(index + 21)}`));
    expect(window.snapshot.hasMore).toBe(true);

    // A song that sorts before the one playing pushes it one place down.
    await run(seed({ songs: [titled("early", "Song 05 again")] }));
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(changes).toEqual([21]);
    expect(window.snapshot.current?.track.title).toBe("Song 20");
    window.dispose();
  });
});
