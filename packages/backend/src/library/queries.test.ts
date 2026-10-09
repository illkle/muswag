import { it } from "@effect/vitest";
import { albumOccurrenceKey, LIBRARY_ORDERS, libraryOccurrenceKey, playlistOccurrenceKey, titleSortKey, type QueueSourceRef, type SourceWindow } from "@muswag/model";
import { Effect, Layer } from "effect";
import { SqlClient } from "effect/sql/SqlClient";
import { describe, expect } from "vitest";

import { write } from "../db/database.js";
import { PlaylistCommands, PlaylistEdits } from "../playlists/commands.js";
import { apiSong, seed, TestDatabase } from "../test/index.js";
import { LibraryQueries } from "./queries.js";

const layer = PlaylistCommands.layer.pipe(Layer.provideMerge(PlaylistEdits.layer), Layer.provideMerge(TestDatabase()));

const SIZE = { behind: 10, ahead: 30 };
const windowAt = (ref: QueueSourceRef, key: string, size = SIZE) => LibraryQueries.sourceWindow(ref, { key, offset: null }, size).pipe(Effect.map((window) => window!));
const idsOf = (items: SourceWindow["next"]) => items.map(({ track }) => track.id);
const titled = (id: string, title: string) => apiSong(id, "album", { title });
const number = (index: number) => String(index).padStart(2, "0");

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
      yield* write(SqlClient.use((sql) => sql`UPDATE songs SET title = 'Zzz', titleSortKey = ${titleSortKey("Zzz")} WHERE id = 'id-20'`));
      const renamed = yield* LibraryQueries.sourceWindow(ref, { key, offset: 21 }, SIZE);
      expect(renamed).toMatchObject({ cursor: { type: "item", offset: 60 }, next: [], hasMore: false });
      expect(renamed?.previous).toHaveLength(10);
    }).pipe(Effect.provide(layer)),
  );
});
