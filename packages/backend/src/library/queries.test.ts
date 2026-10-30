import { it } from "@effect/vitest";
import {
  ALBUM_ORDER,
  albumOccurrenceKey,
  artistOccurrenceKey,
  LIBRARY_ORDERS,
  libraryOccurrenceKey,
  librarySortParts,
  playlistOccurrenceKey,
  songRow,
  sortKey,
  toSongRow,
  type AlbumSort,
  type LibrarySort,
  type PlaylistState,
  type QueueSourceRef,
  type SourceWindow,
} from "@muswag/model";
import { Effect, Layer } from "effect";
import { SqlClient } from "effect/sql/SqlClient";
import { describe, expect } from "vitest";

import { LibraryChanges } from "../db/changes.js";
import { write } from "../db/database.js";
import { PlaylistCommands, PlaylistEdits } from "../playlists/commands.js";
import { apiAlbum, apiSong, seed, TestDatabase } from "../test/index.js";
import { LibraryQueries } from "./queries.js";

const layer = PlaylistCommands.layer.pipe(Layer.provideMerge(PlaylistEdits.layer), Layer.provideMerge(TestDatabase()));

const SIZE = { behind: 10, ahead: 30 };
const windowAt = (ref: QueueSourceRef, key: string, size = SIZE) => LibraryQueries.sourceWindow(ref, { key, offset: null }, size).pipe(Effect.map((window) => window!));
const idsOf = (items: SourceWindow["next"]) => items.map(({ track }) => track.id);
const titled = (id: string, title: string) => apiSong(id, "album", { title });
const number = (index: number) => String(index).padStart(2, "0");
const SORTS: ReadonlyArray<LibrarySort> = ["title", "artist", "album", "title-desc", "artist-desc", "album-desc"];

/** A library whose orders all differ: artists and albums with case and accents, shared names, songs without disc or track numbers. */
const LIBRARY = Array.from({ length: 25 }, (_, index) =>
  apiSong(`id-${number(index)}`, `album-${index % 4}`, {
    title: ["Intro", "été", "Zebra", "apple", "Outro"][index % 5]!,
    artist: ["Beta", "alpha", "Älpha", "gamma"][index % 4 === 3 ? 3 : index % 3]!,
    album: ["One", "two", "One", "Ünder"][index % 4]!,
    ...(index % 6 !== 0 && { track: index % 5 }),
    ...(index % 7 !== 0 && { discNumber: 1 + (index % 2) }),
  }),
);
/** The ids of `LIBRARY` in an order, sorted here by the keys `toSongRow` makes, compared as JavaScript strings. */
const libraryOrder = (sort: LibrarySort) => {
  const { by, descending } = librarySortParts(sort);
  const ids = LIBRARY.map(toSongRow)
    .sort((left, right) => {
      for (const column of LIBRARY_ORDERS[by]) {
        if (left[column] < right[column]) return -1;
        if (left[column] > right[column]) return 1;
      }
      return 0;
    })
    .map(({ id }) => id);
  return descending ? ids.reverse() : ids;
};

describe("LibraryQueries.sourceWindow", () => {
  it.effect("reads an album in disc and track order, around the occurrence asked for", () =>
    Effect.gen(function* () {
      yield* seed({
        songs: [apiSong("b", "album", { discNumber: 1, track: 2 }), apiSong("c", "album", { discNumber: 2, track: 1 }), apiSong("a", "album", { discNumber: 1, track: 1 }), apiSong("x", "other")],
      });
      const ref: QueueSourceRef = { type: "album", albumId: "album" };

      const window = yield* windowAt(ref, albumOccurrenceKey("album", "b"));

      expect(window.cursor).toEqual({ type: "item", key: albumOccurrenceKey("album", "b"), offset: 1 });
      expect([idsOf(window.previous), window.current?.track.id, idsOf(window.next)]).toEqual([["a"], "b", ["c"]]);
      expect(window.next[0]).toMatchObject({ key: albumOccurrenceKey("album", "c"), offset: 2 });
      expect(window.hasMore).toBe(false);
      expect(yield* LibraryQueries.sourceWindow(ref, { key: albumOccurrenceKey("album", "x"), offset: null }, SIZE)).toBeNull();
    }).pipe(Effect.provide(layer)),
  );

  it.effect("orders an album as the album page does: no number before any number, and by id where the numbers tie", () =>
    Effect.gen(function* () {
      // Without disc or track numbers, with some of them, and with the same ones twice.
      const numbered: Array<[id: string, discNumber: number | null, track: number | null]> = [
        ["m", 1, 2],
        ["b", 2, 1],
        ["z", null, null],
        ["k", 1, 2],
        ["c", 1, null],
        ["a", 2, null],
        ["y", null, 3],
        ["d", 1, 1],
        ["e", null, null],
        ["B", 1, 2],
        ["x", null, 1],
      ];
      yield* seed({ songs: numbered.map(([id, discNumber, track]) => apiSong(id, "album", { ...(discNumber !== null && { discNumber }), ...(track !== null && { track }) })) });

      const window = yield* LibraryQueries.sourceWindow({ type: "album", albumId: "album" }, { key: null, offset: 0 }, { behind: 0, ahead: numbered.length });

      // TanStack DB's comparison with `nulls: "first"` and `stringSort: "lexical"`, which the album page asks for.
      const expected = [...window!.next].sort((left, right) => {
        for (const column of ALBUM_ORDER) {
          const [a, b] = [left.track[column], right.track[column]];
          if (a === b) continue;
          if (a === null) return -1;
          if (b === null) return 1;
          return a < b ? -1 : 1;
        }
        return 0;
      });
      expect(idsOf(window!.next)).toEqual(idsOf(expected));
      expect(idsOf(window!.next)).toEqual(["e", "z", "x", "y", "c", "d", "B", "k", "m", "a", "b"]);
    }).pipe(Effect.provide(layer)),
  );

  it.effect("reads an artist's albums newest first, undated ones last and tied years by id, each album in disc and track order", () =>
    Effect.gen(function* () {
      yield* seed({
        albums: [
          apiAlbum("old", { artistId: "artist", year: 2001 }),
          apiAlbum("undated", { artistId: "artist" }),
          apiAlbum("new-b", { artistId: "artist", year: 2020 }),
          apiAlbum("new-a", { artistId: "artist", year: 2020 }),
          apiAlbum("other", { artistId: "someone else", year: 2030 }),
        ],
        songs: [
          apiSong("old-2", "old", { track: 2 }),
          apiSong("old-1", "old", { track: 1 }),
          apiSong("undated-1", "undated", { track: 1 }),
          apiSong("new-b-1", "new-b", { track: 1 }),
          apiSong("new-a-1", "new-a", { track: 1 }),
          apiSong("other-1", "other", { track: 1 }),
        ],
      });
      const ref: QueueSourceRef = { type: "artist", artistId: "artist" };

      const window = yield* windowAt(ref, artistOccurrenceKey("artist", "new-b-1"));

      expect([idsOf(window.previous), window.current?.track.id, idsOf(window.next)]).toEqual([["new-a-1"], "new-b-1", ["old-1", "old-2", "undated-1"]]);
      expect(yield* LibraryQueries.sourceWindow(ref, { key: artistOccurrenceKey("artist", "other-1"), offset: null }, SIZE)).toBeNull();
    }).pipe(Effect.provide(layer)),
  );

  it.effect("keeps to the size asked for and says whether the source goes on", () =>
    Effect.gen(function* () {
      yield* seed({ songs: Array.from({ length: 10 }, (_, index) => apiSong(number(index), "album", { track: index })) });
      const ref: QueueSourceRef = { type: "album", albumId: "album" };
      const size = { behind: 2, ahead: 5 };

      const start = yield* windowAt(ref, albumOccurrenceKey("album", "00"), size);
      expect(idsOf(start.next)).toEqual(["01", "02", "03", "04", "05"]);
      expect(start.hasMore).toBe(true);

      const later = yield* windowAt(ref, albumOccurrenceKey("album", "04"), size);
      expect(idsOf(later.previous)).toEqual(["02", "03"]);
      expect(idsOf(later.next)).toEqual(["05", "06", "07", "08", "09"]);
      expect(later.hasMore).toBe(false);
    }).pipe(Effect.provide(layer)),
  );

  it.effect("finds an occurrence that moved, and leaves a gap where one was removed", () =>
    Effect.gen(function* () {
      yield* seed({ songs: [apiSong("a", "album", { track: 1 }), apiSong("b", "album", { track: 2 }), apiSong("c", "album", { track: 3 })] });
      const ref: QueueSourceRef = { type: "album", albumId: "album" };
      const key = albumOccurrenceKey("album", "b");

      yield* write(SqlClient.use((sql) => sql`UPDATE songs SET track = 4 WHERE id = 'b'`));
      const moved = yield* LibraryQueries.sourceWindow(ref, { key, offset: 1 }, SIZE);
      expect(moved?.cursor).toEqual({ type: "item", key, offset: 2 });
      expect(idsOf(moved!.previous)).toEqual(["a", "c"]);

      yield* write(SqlClient.use((sql) => sql`DELETE FROM songs WHERE id = 'b'`));
      const gone = yield* LibraryQueries.sourceWindow(ref, { key, offset: 1 }, SIZE);
      expect(gone).toMatchObject({ cursor: { type: "gap", offset: 1 }, current: null });
      // What took the removed occurrence's place comes next.
      expect([idsOf(gone!.previous), idsOf(gone!.next)]).toEqual([["a"], ["c"]]);
    }).pipe(Effect.provide(layer)),
  );

  it.effect("reads a playlist's entries in order, leaving out songs the library does not have", () =>
    Effect.gen(function* () {
      yield* seed({ songs: [apiSong("a", "album"), apiSong("b", "album")] });
      const commands = yield* PlaylistCommands;
      const playlist = yield* commands.create({ name: "Mix", songIds: ["b", "missing", "a", "b"] });
      const entries = playlist.local!.entries;
      const ref: QueueSourceRef = { type: "playlist", playlistId: playlist.id };

      const window = yield* windowAt(ref, playlistOccurrenceKey(playlist.id, entries[0]!.id));

      expect(window.current).toMatchObject({ offset: 0, track: { id: "b" } });
      // The same song twice is two occurrences, each at its own offset.
      expect(window.next.map(({ key, offset, track }) => [key, offset, track.id])).toEqual([
        [playlistOccurrenceKey(playlist.id, entries[2]!.id), 2, "a"],
        [playlistOccurrenceKey(playlist.id, entries[3]!.id), 3, "b"],
      ]);
      expect(yield* LibraryQueries.sourceWindow({ type: "playlist", playlistId: "none" }, { key: "none", offset: null }, SIZE)).toBeNull();
    }).pipe(Effect.provide(layer)),
  );

  it.effect("reads past entries that cannot be played until the window is full", () =>
    Effect.gen(function* () {
      yield* seed({ songs: [apiSong("a", "album"), apiSong("z", "album")] });
      const commands = yield* PlaylistCommands;
      const missing = Array.from({ length: 35 }, (_, index) => `missing-${index}`);
      const playlist = yield* commands.create({ name: "Mix", songIds: ["z", ...missing, "a", ...missing, "z"] });
      const entries = playlist.local!.entries;
      const ref: QueueSourceRef = { type: "playlist", playlistId: playlist.id };

      const window = yield* windowAt(ref, playlistOccurrenceKey(playlist.id, entries[36]!.id));

      expect(window.previous.map(({ offset }) => offset)).toEqual([0]);
      expect(window.current).toMatchObject({ offset: 36, track: { id: "a" } });
      expect(window.next.map(({ offset }) => offset)).toEqual([72]);
      expect(window.hasMore).toBe(false);
    }).pipe(Effect.provide(layer)),
  );

  it.effect("reads what is left before a gap that is past the end of a source that shrank", () =>
    Effect.gen(function* () {
      yield* seed({ songs: Array.from({ length: 20 }, (_, index) => apiSong(number(index), "album", { track: index })) });

      const window = yield* LibraryQueries.sourceWindow({ type: "album", albumId: "album" }, { key: null, offset: 500 }, SIZE);

      expect(window).toMatchObject({ cursor: { type: "gap", offset: 500 }, current: null, next: [], hasMore: false });
      expect(idsOf(window!.previous)).toEqual(Array.from({ length: 10 }, (_, index) => number(index + 10)));
    }).pipe(Effect.provide(layer)),
  );

  it.effect("reads the library alphabetically around a song, telling songs with one title apart", () =>
    Effect.gen(function* () {
      yield* seed({ songs: [titled("c", "Intro"), titled("a", "Intro"), titled("b", "Intro"), titled("x", "apple"), titled("y", "Zzz"), titled("z", "Élan")] });
      const ref: QueueSourceRef = { type: "library", sort: "title" };

      const window = yield* windowAt(ref, libraryOccurrenceKey("b"));

      expect(window.cursor).toMatchObject({ type: "item", offset: 3 });
      expect([idsOf(window.previous), window.current?.track.id, idsOf(window.next)]).toEqual([["x", "z", "a"], "b", ["c", "y"]]);
      expect(yield* LibraryQueries.sourceWindow(ref, { key: libraryOccurrenceKey("missing"), offset: null }, SIZE)).toBeNull();
      expect(yield* LibraryQueries.sourceWindow(ref, { key: albumOccurrenceKey("album", "a"), offset: null }, SIZE)).toBeNull();
    }).pipe(Effect.provide(layer)),
  );

  it.effect("orders the library as the renderer does, by comparing the sort columns as JavaScript strings", () =>
    Effect.gen(function* () {
      // Titles the two comparisons would order differently if they were sorted as they are.
      const titles = ["🎵 Notes", "�?", " Private", "ＡＢＣ", "abd", "Abc", "ábc", "zz", "Zz", "中文", "\u{1F600}", "", "a\u{10000}", "aＡ", "", "10", "9"];
      yield* seed({ songs: titles.map((title, index) => titled(`id-${index}`, title)) });

      const window = yield* LibraryQueries.sourceWindow({ type: "library", sort: "title" }, { key: null, offset: 0 }, { behind: 0, ahead: titles.length });

      const expected = [...window!.next].sort((left, right) => {
        for (const column of LIBRARY_ORDERS.title) {
          if (left.track[column] < right.track[column]) return -1;
          if (left.track[column] > right.track[column]) return 1;
        }
        return 0;
      });
      expect(idsOf(window!.next)).toEqual(idsOf(expected));
      expect(window!.next).toHaveLength(titles.length);
    }).pipe(Effect.provide(layer)),
  );

  it.effect("keeps a window of the library around its song as the library changes", () =>
    Effect.gen(function* () {
      yield* seed({ songs: Array.from({ length: 60 }, (_, index) => titled(`id-${number(index)}`, `Song ${number(index)}`)) });
      const ref: QueueSourceRef = { type: "library", sort: "title" };
      const key = libraryOccurrenceKey("id-20");

      const window = yield* windowAt(ref, key);
      expect(window.cursor).toMatchObject({ type: "item", offset: 20 });
      expect(idsOf(window.previous)).toEqual(Array.from({ length: 10 }, (_, index) => `id-${number(index + 10)}`));
      expect(idsOf(window.next)).toEqual(Array.from({ length: 30 }, (_, index) => `id-${number(index + 21)}`));
      expect(window.hasMore).toBe(true);

      // A song that sorts before the one playing pushes it one place down, and a rename moves it.
      yield* seed({ songs: [titled("early", "Song 05 again")] });
      expect((yield* LibraryQueries.sourceWindow(ref, { key, offset: 20 }, SIZE))?.cursor).toMatchObject({ type: "item", offset: 21 });
      yield* write(SqlClient.use((sql) => sql`UPDATE songs SET title = 'Zzz', titleSortKey = ${sortKey("Zzz")} WHERE id = 'id-20'`));
      const renamed = yield* LibraryQueries.sourceWindow(ref, { key, offset: 21 }, SIZE);
      expect(renamed).toMatchObject({ cursor: { type: "item", offset: 60 }, next: [], hasMore: false });
      expect(renamed?.previous).toHaveLength(10);
    }).pipe(Effect.provide(layer)),
  );
});

describe("LibraryQueries.sourceWindow of the library", () => {
  it.effect("plays the library in each order as the songs list shows it, from the song played", () =>
    Effect.gen(function* () {
      yield* seed({ songs: LIBRARY });
      expect(new Set(SORTS.map((sort) => libraryOrder(sort).join())).size).toBe(SORTS.length);
      for (const sort of SORTS) {
        const ref: QueueSourceRef = { type: "library", sort };
        const order = libraryOrder(sort);
        const listed = yield* LibraryQueries.songPage(sort, { offset: 0, limit: 100 }, false);
        expect(listed!.songs.map(({ id }) => id)).toEqual(order);

        const window = yield* windowAt(ref, libraryOccurrenceKey(order[12]!), { behind: 100, ahead: 100 });
        expect(window.cursor).toMatchObject({ type: "item", offset: 12 });
        expect([...idsOf(window.previous), window.current?.track.id, ...idsOf(window.next)]).toEqual(order);
      }
    }).pipe(Effect.provide(layer)),
  );
});

describe("LibraryQueries songs list", () => {
  it.effect("orders by artist, then album, then disc and track, and by album the same without the artist", () =>
    Effect.gen(function* () {
      yield* seed({
        songs: [
          apiSong("b-x-2", "bx", { artist: "B", album: "X", track: 2 }),
          apiSong("b-x-1", "bx", { artist: "B", album: "X", track: 1 }),
          apiSong("a-y-1", "ay", { artist: "a", album: "Y", track: 1 }),
          apiSong("a-x", "ax", { artist: "a", album: "X" }),
          // An artist whose name another begins with comes before it.
          apiSong("ab-a-1", "aba", { artist: "a b", album: "A", track: 1 }),
        ],
      });
      const ids = (sort: LibrarySort) => LibraryQueries.songPage(sort, { offset: 0, limit: 10 }, false).pipe(Effect.map((page) => page!.songs.map(({ id }) => id)));

      expect(yield* ids("artist")).toEqual(["a-x", "a-y-1", "ab-a-1", "b-x-1", "b-x-2"]);
      // Two albums of one name are each kept together, by the album's id.
      expect(yield* ids("album")).toEqual(["ab-a-1", "a-x", "b-x-1", "b-x-2", "a-y-1"]);
    }).pipe(Effect.provide(layer)),
  );

  it.effect("reads the same pages by offset as after and before a song, with the total when asked for", () =>
    Effect.gen(function* () {
      yield* seed({ songs: LIBRARY });
      const limit = 7;
      for (const sort of SORTS) {
        const order = libraryOrder(sort);
        const pages: string[][] = [];
        for (let offset = 0; offset < order.length; offset += limit) {
          const page = yield* LibraryQueries.songPage(sort, { offset, limit }, offset === 0);
          expect(page!.total).toBe(offset === 0 ? order.length : null);
          pages.push(page!.songs.map(({ id }) => id));
        }
        expect(pages.flat()).toEqual(order);
        for (const [index, page] of pages.entries()) {
          const after = yield* LibraryQueries.songPage(sort, { after: page.at(-1)!, limit }, true);
          expect(after).toEqual({ songs: expect.any(Array), total: order.length });
          expect(after!.songs.map(({ id }) => id)).toEqual(pages[index + 1] ?? []);
          const before = yield* LibraryQueries.songPage(sort, { before: page[0]!, limit }, false);
          expect(before!.songs.map(({ id }) => id)).toEqual(pages[index - 1] ?? []);
        }
        // Before a song closer to the start than a page, the page is short.
        expect((yield* LibraryQueries.songPage(sort, { before: order[3]!, limit }, false))!.songs.map(({ id }) => id)).toEqual(order.slice(0, 3));
      }
    }).pipe(Effect.provide(layer)),
  );

  it.effect("gives songs as renderers get them, and no page around a song the library no longer has", () =>
    Effect.gen(function* () {
      yield* seed({ songs: [apiSong("a", "album", { path: "music/a.flac" })] });

      const page = yield* LibraryQueries.songPage("title", { offset: 0, limit: 10 }, true);
      expect(page).toMatchObject({ songs: [{ id: "a", albumId: "album" }], total: 1 });
      expect(["path", "bitRate", "comment"].filter((column) => column in page!.songs[0]!)).toEqual([]);

      expect(yield* LibraryQueries.songPage("title", { after: "gone", limit: 10 }, true)).toBeNull();
      expect(yield* LibraryQueries.songPage("artist", { before: "gone", limit: 10 }, true)).toBeNull();
      expect(yield* LibraryQueries.songPage("album", { offset: 5, limit: 10 }, true)).toEqual({ songs: [], total: 1 });
    }).pipe(Effect.provide(layer)),
  );

  it.effect("reads the ids at ranges of positions in list order, ranges that overlap or meet read once", () =>
    Effect.gen(function* () {
      yield* seed({ songs: LIBRARY });
      for (const sort of SORTS) {
        const order = libraryOrder(sort);
        const ranges = [
          { start: 5, end: 8 },
          { start: 0, end: 3 },
          { start: 2, end: 4 },
          { start: 8, end: 10 },
          { start: 12, end: 12 },
          { start: 20, end: 40 },
        ];
        expect(yield* LibraryQueries.songIds(sort, ranges)).toEqual([...order.slice(0, 4), ...order.slice(5, 10), ...order.slice(20)]);
      }
      expect(yield* LibraryQueries.songIds("title", [])).toEqual([]);
    }).pipe(Effect.provide(layer)),
  );

  it.effect("finds where the songs whose title, artist or album starts at or after a text begin", () =>
    Effect.gen(function* () {
      yield* seed({
        songs: [
          apiSong("1", "x", { title: "apple", artist: "Zed", album: "Moon" }),
          apiSong("2", "x", { title: "Banana", artist: "Zed", album: "Moon" }),
          apiSong("3", "y", { title: "cherry", artist: "Ábba", album: "Ünder" }),
          apiSong("4", "y", { title: "Élan", artist: "Ábba", album: "Ünder" }),
          apiSong("5", "z", { title: "zebra", artist: "Beatles", album: "Abbey Road" }),
        ],
      });
      const positions = (sort: LibrarySort, texts: string[]) => Effect.forEach(texts, (text) => LibraryQueries.songPosition(sort, text));

      expect(yield* positions("title", ["", "a", "BANANA", "c", "d", "É", "zz"])).toEqual([0, 0, 1, 2, 3, 3, 5]);
      // A text that is a whole artist or album comes before its songs.
      expect(yield* positions("artist", ["abba", "b", "beatles", "beatlesz", "z", "zed", "zz"])).toEqual([0, 2, 2, 3, 3, 3, 5]);
      expect(yield* positions("album", ["abbey road", "m", "u", "under", "v"])).toEqual([0, 1, 3, 3, 5]);
      // Going down, the songs that start with the text come after those past it.
      expect(yield* positions("title-desc", ["", "a", "BANANA", "c", "d", "É", "zz"])).toEqual([0, 4, 3, 2, 2, 1, 0]);
      expect(yield* positions("artist-desc", ["zed", "z", "beatles", "b", "abba"])).toEqual([0, 0, 2, 2, 3]);
    }).pipe(Effect.provide(layer)),
  );
});

describe("LibraryQueries albums list", () => {
  it.effect("reads the albums newest first, those without a year last, albums of a year by id, with the total when asked for", () =>
    Effect.gen(function* () {
      yield* seed({
        albums: [apiAlbum("c", { year: 1990 }), apiAlbum("none-b"), apiAlbum("b", { year: 2001 }), apiAlbum("a", { year: 1990 }), apiAlbum("none-a"), apiAlbum("d", { year: 2020 })],
      });
      const order = ["d", "b", "a", "c", "none-a", "none-b"];
      const pages: string[][] = [];
      for (let offset = 0; offset < order.length; offset += 4) {
        const page = yield* LibraryQueries.albumPage("year-desc", { offset, limit: 4 }, offset === 0);
        expect(page.total).toBe(offset === 0 ? order.length : null);
        pages.push(page.albums.map(({ id }) => id));
      }

      expect(pages).toEqual([order.slice(0, 4), order.slice(4)]);
      expect(yield* LibraryQueries.albumPage("year-desc", { offset: 10, limit: 4 }, true)).toEqual({ albums: [], total: order.length });
    }).pipe(Effect.provide(layer)),
  );

  it.effect("reads the albums oldest first, by artist either way, and the most recently added first, those without a year last", () =>
    Effect.gen(function* () {
      yield* seed({
        albums: [
          apiAlbum("c", { year: 1990, artist: "beta", created: "2026-03-01T00:00:00Z" }),
          apiAlbum("none", { artist: "Alpha", created: "2026-01-01T00:00:00Z" }),
          apiAlbum("b", { year: 2001, artist: "Beta", created: "2026-05-01T00:00:00Z" }),
          apiAlbum("a", { year: 1990, artist: "alpha", created: "2026-02-01T00:00:00Z" }),
          apiAlbum("anonymous", { year: 2020, artist: undefined, created: "2026-04-01T00:00:00Z" }),
          apiAlbum("u", { year: 1995, artist: "Ärzte", created: "2026-06-01T00:00:00Z" }),
          apiAlbum("x", { year: 2000, artist: "баста", created: "2026-07-01T00:00:00Z" }),
          apiAlbum("y", { year: 2010, artist: "Баста", created: "2026-08-01T00:00:00Z" }),
        ],
      });
      const ids = (sort: AlbumSort) => LibraryQueries.albumPage(sort, { offset: 0, limit: 10 }, false).pipe(Effect.map(({ albums }) => albums.map(({ id }) => id)));

      expect(yield* ids("year")).toEqual(["a", "c", "u", "x", "b", "y", "anonymous", "none"]);
      // An artist's albums newest first, whatever the case or accents of its name, in any script.
      expect(yield* ids("artist")).toEqual(["anonymous", "a", "none", "u", "b", "c", "y", "x"]);
      expect(yield* ids("artist-desc")).toEqual(["y", "x", "b", "c", "u", "a", "none", "anonymous"]);
      expect(yield* ids("added")).toEqual(["y", "x", "u", "b", "anonymous", "c", "a", "none"]);
    }).pipe(Effect.provide(layer)),
  );

  it.effect("finds the artists with an album of their own, once each, by name with numbers by their value, and the rest apart", () =>
    Effect.gen(function* () {
      yield* seed({
        albums: [apiAlbum("one", { artistId: "a" }), apiAlbum("two", { artistId: "a" }), apiAlbum("three", { artistId: "b" }), apiAlbum("four", { artistId: "c" }), apiAlbum("various")],
        artists: [
          { id: "a", name: "band 10" },
          { id: "b", name: "Band 9" },
          { id: "c", name: "Ärzte" },
          { id: "credited", name: "Credited only" },
          { id: "another", name: "another credit" },
        ],
      });

      const listed = yield* LibraryQueries.artistIndex();
      expect(listed.withAlbums.map(({ id }) => id)).toEqual(["c", "b", "a"]);
      expect(listed.withAlbums[0]).not.toHaveProperty("coverArtPath");
      expect(listed.featured.map(({ id }) => id)).toEqual(["another", "credited"]);
    }).pipe(Effect.provide(layer)),
  );

  it.effect("reads an album with its songs in the order it plays in, and nothing for one it does not have", () =>
    Effect.gen(function* () {
      yield* seed({
        albums: [apiAlbum("album"), apiAlbum("other")],
        songs: [apiSong("b", "album", { discNumber: 1, track: 2 }), apiSong("c", "album", { discNumber: 2, track: 1 }), apiSong("a", "album", { discNumber: 1, track: 1 }), apiSong("x", "other")],
      });

      const { album, songs } = yield* LibraryQueries.album("album");
      expect(album).toMatchObject({ id: "album", name: "Album album" });
      expect(album).not.toHaveProperty("coverArtPath");
      expect(songs.map(({ id }) => id)).toEqual(["a", "b", "c"]);
      expect(songs[0]).not.toHaveProperty("path");
      expect(yield* LibraryQueries.album("gone")).toEqual({ album: null, songs: [] });
    }).pipe(Effect.provide(layer)),
  );

  it.effect("reads an artist's albums newest first and their songs in the order the artist plays in", () =>
    Effect.gen(function* () {
      yield* seed({
        albums: [
          apiAlbum("old", { artistId: "artist", year: 1990 }),
          apiAlbum("undated", { artistId: "artist" }),
          apiAlbum("new", { artistId: "artist", year: 2020 }),
          apiAlbum("theirs", { artistId: "else" }),
        ],
        artists: [{ id: "artist", name: "Artist" }],
        songs: [apiSong("old-1", "old", { track: 1 }), apiSong("new-2", "new", { track: 2 }), apiSong("undated-1", "undated"), apiSong("new-1", "new", { track: 1 }), apiSong("else-1", "theirs")],
      });

      const discography = yield* LibraryQueries.discography("artist");
      expect(discography.albums.map(({ id }) => id)).toEqual(["new", "old", "undated"]);
      expect(discography.songs.map(({ id }) => id)).toEqual(["new-1", "new-2", "old-1", "undated-1"]);
      expect(discography.appearsOn).toEqual([]);
      // What playback goes through is the same order.
      const window = yield* windowAt({ type: "artist", artistId: "artist" }, artistOccurrenceKey("artist", "new-1"));
      expect(idsOf(window.next)).toEqual(["new-2", "old-1", "undated-1"]);

      const artist = yield* LibraryQueries.artist("artist");
      expect(artist.artist).toMatchObject({ id: "artist", name: "Artist" });
      expect(artist.albums.map(({ id }) => id)).toEqual(["new", "old", "undated"]);
      expect((yield* LibraryQueries.artist("credited")).artist).toBeNull();
    }).pipe(Effect.provide(layer)),
  );

  it.effect("reads albums and songs by id, leaving out those the library does not have", () =>
    Effect.gen(function* () {
      yield* seed({ albums: [apiAlbum("a", { year: 2000 }), apiAlbum("b", { year: 2010 })], songs: [apiSong("one", "a"), apiSong("two", "b")] });

      expect((yield* LibraryQueries.albumsByIds(["a", "gone", "b", "a"])).map(({ id }) => id)).toEqual(["b", "a"]);
      expect((yield* LibraryQueries.librarySongsByIds(["two", "gone", "one"])).map(({ id }) => id).sort()).toEqual(["one", "two"]);
      expect(yield* LibraryQueries.albumsByIds([])).toEqual([]);
      // More ids than SQLite takes parameters in a statement.
      expect(yield* LibraryQueries.librarySongsByIds(Array.from({ length: 40_000 }, (_, index) => `missing-${index}`))).toEqual([]);
    }).pipe(Effect.provide(layer)),
  );

  it.effect("reads a playlist with the songs of its entries that the library has", () =>
    Effect.gen(function* () {
      yield* seed({ songs: [apiSong("one", "album"), apiSong("two", "album")] });
      const playlist = yield* (yield* PlaylistCommands).create({ name: "Mix", songIds: ["two", "gone", "one", "two"] });

      const detail = yield* LibraryQueries.playlist(playlist.id);
      expect(detail.playlist?.local?.entries.map(({ songId }) => songId)).toEqual(["two", "gone", "one", "two"]);
      expect(detail.songs.map(({ id }) => id).sort()).toEqual(["one", "two"]);
      expect(detail.songs[0]).not.toHaveProperty("path");
      expect(yield* LibraryQueries.playlist("missing")).toEqual({ playlist: null, songs: [] });
    }).pipe(Effect.provide(layer)),
  );

  it.effect("names the album, artist or playlist a queue plays from", () =>
    Effect.gen(function* () {
      yield* seed({ albums: [apiAlbum("album")], artists: [{ id: "artist", name: "The Artist" }] });
      const playlist = yield* (yield* PlaylistCommands).create({ name: "Mix" });

      expect(yield* LibraryQueries.sourceName({ type: "album", albumId: "album" })).toBe("Album album");
      expect(yield* LibraryQueries.sourceName({ type: "artist", artistId: "artist" })).toBe("The Artist");
      expect(yield* LibraryQueries.sourceName({ type: "playlist", playlistId: playlist.id })).toBe("Mix");
      expect(yield* LibraryQueries.sourceName({ type: "album", albumId: "gone" })).toBeNull();
      expect(yield* LibraryQueries.sourceName({ type: "library", sort: "title" })).toBeNull();
      expect((yield* LibraryQueries.playlists()).map(({ local }) => local?.name)).toEqual(["Mix"]);
    }).pipe(Effect.provide(layer)),
  );

  it.effect("reads the songs of albums, album after album as asked, each in the order its page lists them", () =>
    Effect.gen(function* () {
      yield* seed({
        albums: [apiAlbum("one"), apiAlbum("two")],
        songs: [apiSong("one-2", "one", { track: 2 }), apiSong("two-1", "two", { track: 1 }), apiSong("one-1", "one", { track: 1 })],
      });

      expect(yield* LibraryQueries.albumSongIds(["two", "gone", "one"])).toEqual(["two-1", "one-1", "one-2"]);
      expect(yield* LibraryQueries.albumSongIds([])).toEqual([]);
    }).pipe(Effect.provide(layer)),
  );

  it.effect("reads the cover art ids of the albums asked for that the library has", () =>
    Effect.gen(function* () {
      yield* seed({ albums: [apiAlbum("covered", { coverArt: "al-covered" }), apiAlbum("bare"), apiAlbum("other", { coverArt: "al-other" })] });

      const coverArts = yield* LibraryQueries.albumCoverArts(["covered", "bare", "gone", "covered"]);
      expect([...coverArts].sort((left, right) => left.id.localeCompare(right.id))).toEqual([
        { id: "bare", coverArt: null },
        { id: "covered", coverArt: "al-covered" },
      ]);
      expect(yield* LibraryQueries.albumCoverArts([])).toEqual([]);
    }).pipe(Effect.provide(layer)),
  );
});

describe("LibraryQueries queue storage", () => {
  it.effect("stores the queue and where it resumes, which announces nothing", () =>
    Effect.gen(function* () {
      const announced: string[] = [];
      (yield* LibraryChanges).subscribe((changes) => announced.push(...changes.map(({ table }) => table)));
      const track = songRow({ id: "a", title: "A" });

      yield* LibraryQueries.writeQueue({
        upsert: [{ key: "now", list: "now", position: 0, track }],
        remove: [],
        state: { id: 1, nowPlayingKey: "now", nowPlayingOrigin: "user", source: null },
        resumePositionSeconds: 12,
      });
      expect(yield* LibraryQueries.loadQueue).toMatchObject({ state: { nowPlayingKey: "now" }, items: [{ key: "now" }], resumePositionSeconds: 12 });

      yield* LibraryQueries.writeQueue({ upsert: [], remove: [], state: null, resumePositionSeconds: 30.5 });
      expect((yield* LibraryQueries.loadQueue).resumePositionSeconds).toBe(30.5);

      // A change of the queue alone leaves the position where it was.
      yield* LibraryQueries.writeQueue({ upsert: [{ key: "next", list: "user", position: 0, track }], remove: [], state: null, resumePositionSeconds: null });
      const stored = yield* LibraryQueries.loadQueue;
      expect([stored.items.map(({ key }) => key).sort(), stored.resumePositionSeconds]).toEqual([["next", "now"], 30.5]);

      yield* LibraryQueries.clearQueue;
      expect(yield* LibraryQueries.loadQueue).toEqual({ state: null, items: [], resumePositionSeconds: 0 });
      expect(announced).toEqual([]);
    }).pipe(Effect.provide(layer)),
  );
});

describe("LibraryQueries.discography of an artist on others' albums", () => {
  it.effect("lists the others' albums after its own with only the songs that credit it, and plays through them in that order", () =>
    Effect.gen(function* () {
      const guest = { id: "guest", name: "The Guest" };
      const host = { id: "host", name: "Host" };
      yield* seed({
        albums: [apiAlbum("own", { artistId: "guest" }), apiAlbum("old", { artistId: "host", year: 1990 }), apiAlbum("new", { artistId: "host", year: 2020 })],
        songs: [
          apiSong("own-1", "own", { artists: [guest] }),
          apiSong("old-2", "old", { track: 2, artists: [host, guest] }),
          apiSong("old-1", "old", { track: 1, artists: [host] }),
          apiSong("new-1", "new", { artists: [guest] }),
        ],
      });

      const discography = yield* LibraryQueries.discography("guest");
      expect(discography.songs.map(({ id }) => id)).toEqual(["own-1"]);
      expect(discography.appearsOn.map(({ id }) => id)).toEqual(["new-1", "old-2"]);
      const window = yield* windowAt({ type: "artist", artistId: "guest" }, artistOccurrenceKey("guest", "own-1"));
      expect(idsOf(window.next)).toEqual(["new-1", "old-2"]);
    }).pipe(Effect.provide(layer)),
  );
});

describe("LibraryQueries of an album with several main artists", () => {
  it.effect("counts the album as the own of every artist it names, and not of those only featured on it", () =>
    Effect.gen(function* () {
      const first = { id: "first", name: "First" };
      const second = { id: "second", name: "Toxi$" };
      // A part of a main artist's name, which is not that name.
      const guest = { id: "guest", name: "Toxi" };
      yield* seed({
        albums: [apiAlbum("shared", { artistId: "first", artist: "First • Toxi$", displayArtist: "First • Toxi$", artists: [first, second, guest] })],
        artists: [first, second, guest],
        songs: [apiSong("shared-1", "shared", { track: 1, artists: [first] }), apiSong("shared-2", "shared", { track: 2, artists: [second, guest] })],
      });

      expect((yield* LibraryQueries.artist("second")).albums.map(({ id }) => id)).toEqual(["shared"]);
      expect(yield* LibraryQueries.artistAppearances("second")).toEqual({ albumIds: [], name: null });
      const discography = yield* LibraryQueries.discography("second");
      expect(discography.songs.map(({ id }) => id)).toEqual(["shared-1", "shared-2"]);
      expect(discography.appearsOn).toEqual([]);
      const window = yield* windowAt({ type: "artist", artistId: "second" }, artistOccurrenceKey("second", "shared-1"));
      expect(idsOf(window.next)).toEqual(["shared-2"]);

      const index = yield* LibraryQueries.artistIndex();
      expect(index.withAlbums.map(({ id }) => id)).toEqual(["first", "second"]);
      expect(index.featured.map(({ id }) => id)).toEqual(["guest"]);

      expect((yield* LibraryQueries.artist("guest")).albums).toEqual([]);
      expect(yield* LibraryQueries.artistAppearances("guest")).toEqual({ albumIds: ["shared"], name: "Toxi" });
    }).pipe(Effect.provide(layer)),
  );
});

describe("LibraryQueries.artistAppearances", () => {
  it.effect("finds the other artists' albums with a song that credits the artist, and the name a credit gives it", () =>
    Effect.gen(function* () {
      const guest = { id: "guest", name: "The Guest" };
      const host = { id: "host", name: "Host" };
      yield* seed({
        albums: [apiAlbum("own", { artistId: "guest" }), apiAlbum("featured", { artistId: "host" }), apiAlbum("various"), apiAlbum("without")],
        songs: [
          apiSong("own-1", "own", { artists: [guest] }),
          apiSong("featured-1", "featured", { artists: [host, guest] }),
          apiSong("featured-2", "featured", { artists: [guest] }),
          apiSong("various-1", "various", { artists: [guest] }),
          apiSong("without-1", "without", { artists: [host] }),
          apiSong("uncredited", "without"),
          apiSong("no-album", "gone", { artists: [guest] }),
        ],
      });

      const appearances = yield* LibraryQueries.artistAppearances("guest");
      expect([...appearances.albumIds].sort()).toEqual(["featured", "various"]);
      expect(appearances.name).toBe("The Guest");
      expect(yield* LibraryQueries.artistAppearances("nobody")).toEqual({ albumIds: [], name: null });
    }).pipe(Effect.provide(layer)),
  );
  it.effect("finds the artist by an id JSON escapes, and not by a name that is its id", () =>
    Effect.gen(function* () {
      const odd = { id: 'say "hi"\\ ünï', name: "Odd" };
      yield* seed({
        albums: [apiAlbum("featured", { artistId: "host" }), apiAlbum("named")],
        songs: [apiSong("featured-1", "featured", { artists: [{ id: "host", name: "Host" }, odd] }), apiSong("named-1", "named", { artists: [{ id: "someone", name: odd.id }] })],
      });

      expect(yield* LibraryQueries.artistAppearances(odd.id)).toEqual({ albumIds: ["featured"], name: "Odd" });
    }).pipe(Effect.provide(layer)),
  );
});

describe("LibraryQueries.searchResults", () => {
  it.effect("reads the rows of what a search found, in its order, songs without the columns only main reads, leaving out what has gone", () =>
    Effect.gen(function* () {
      yield* seed({ albums: [apiAlbum("album")], artists: [{ id: "artist", name: "Someone" }], songs: [apiSong("song", "album", { title: "Harvest", path: "music/harvest.flac" })] });

      const results = yield* LibraryQueries.searchResults([
        { type: "song", id: "song" },
        { type: "artist", id: "gone" },
        { type: "artist", id: "artist" },
        { type: "album", id: "album" },
      ]);

      expect(results.map(({ type, id }) => `${type}:${id}`)).toEqual(["song:song", "artist:artist", "album:album"]);
      expect(results[0]).toMatchObject({ song: { title: "Harvest", albumId: "album" } });
      expect(results[0]?.type === "song" && "path" in results[0].song).toBe(false);
      expect(results[1]).toMatchObject({ artist: { name: "Someone" } });
      expect(yield* LibraryQueries.searchResults([])).toEqual([]);
    }).pipe(Effect.provide(layer)),
  );

  it.effect("reads the playlists a search found with the first four albums they draw on, but not those awaiting deletion", () =>
    Effect.gen(function* () {
      const state = (name: string, songIds: string[]): PlaylistState => ({
        name,
        comment: "",
        public: false,
        readonly: false,
        owner: "someone",
        entries: songIds.map((songId, index) => ({ id: `entry-${index}`, songId })),
      });
      yield* seed({
        songs: ["a", "b", "c", "d", "e"].flatMap((album) => [apiSong(`${album}-1`, album), apiSong(`${album}-2`, album)]),
        playlists: [
          { id: "mix", serverId: "mix", base: null, local: state("Mix", ["a-1", "missing", "a-2", "b-1", "c-1", "d-1", "e-1"]), revision: 0 },
          { id: "gone", serverId: "gone", base: state("Gone", []), local: null, revision: 0 },
        ],
      });

      expect(
        yield* LibraryQueries.searchResults([
          { type: "playlist", id: "gone" },
          { type: "playlist", id: "mix" },
        ]),
      ).toEqual([{ type: "playlist", id: "mix", playlist: { id: "mix", name: "Mix", songCount: 7, owner: "someone", albumIds: ["a", "b", "c", "d"] } }]);
    }).pipe(Effect.provide(layer)),
  );
});
