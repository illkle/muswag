import { describe, expect, it } from "@effect/vitest";
import { albums, artists, songs, toRow, toSongRow } from "@muswag/model";
import { eq, sql } from "drizzle-orm";
import { Effect } from "effect";

import { apiAlbum, apiSong, TestDatabase } from "../test/index.js";
import { LibraryChanges, type LibraryChange } from "./changes.js";
import { Db, write } from "./database.js";

/** What the writes of `effect` announce, write by write. */
const announced = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  Effect.gen(function* () {
    const writes: Array<ReadonlyArray<LibraryChange>> = [];
    const unsubscribe = (yield* LibraryChanges).subscribe((changes) => writes.push(changes));
    yield* effect;
    unsubscribe();
    return writes;
  });

const short = (changes: ReadonlyArray<LibraryChange>) => changes.map(({ table, type, key }) => `${type} ${table}:${key}`);

describe("LibraryChanges", () => {
  it.effect("announces each write's inserts, updates and deletes once it commits, by key", () =>
    Effect.gen(function* () {
      const db = yield* Db;
      const writes = yield* announced(
        Effect.gen(function* () {
          yield* write(db.insert(albums).values([toRow(albums, apiAlbum("a")), toRow(albums, apiAlbum("b"))]));
          yield* write(db.update(albums).set({ name: "Renamed" }).where(eq(albums.id, "a")));
          yield* write(db.delete(albums).where(eq(albums.id, "b")));
        }),
      );
      expect(writes.map(short)).toEqual([["changed albums:a", "changed albums:b"], ["changed albums:a"], ["deleted albums:b"]]);
    }).pipe(Effect.provide(TestDatabase())),
  );

  it.effect("announces nothing for an update that changes nothing, or only columns it ignores", () =>
    Effect.gen(function* () {
      const db = yield* Db;
      yield* write(db.insert(albums).values(toRow(albums, apiAlbum("a"))));
      yield* write(db.insert(artists).values({ id: "artist", name: "Artist" }));
      const writes = yield* announced(
        Effect.gen(function* () {
          yield* write(db.update(albums).set({ name: "Album a" }).where(eq(albums.id, "a")));
          yield* write(db.update(albums).set({ coverArtPath: "covers/a.jpg" }).where(eq(albums.id, "a")));
          yield* write(db.update(artists).set({ coverArtPath: "covers/artist.jpg" }).where(eq(artists.id, "artist")));
        }),
      );
      expect(writes).toEqual([]);
    }).pipe(Effect.provide(TestDatabase())),
  );

  it.effect("announces a key that changed as the old one deleted and the new one changed", () =>
    Effect.gen(function* () {
      const db = yield* Db;
      yield* write(db.insert(songs).values(toSongRow(apiSong("old", "album"))));
      const writes = yield* announced(write(db.update(songs).set({ id: "new" }).where(eq(songs.id, "old"))));
      expect(writes.map(short)).toEqual([["deleted songs:old", "changed songs:new"]]);
    }).pipe(Effect.provide(TestDatabase())),
  );

  it.effect("tells a row once per write, as what was last done to it", () =>
    Effect.gen(function* () {
      const db = yield* Db;
      yield* write(db.insert(songs).values(toSongRow(apiSong("kept", "album"))));
      const writes = yield* announced(
        write(
          Effect.gen(function* () {
            yield* db.insert(songs).values(toSongRow(apiSong("brief", "album")));
            yield* db.update(songs).set({ title: "Once" }).where(eq(songs.id, "kept"));
            yield* db.update(songs).set({ title: "Twice" }).where(eq(songs.id, "kept"));
            yield* db.delete(songs).where(eq(songs.id, "brief"));
          }),
        ),
      );
      expect(writes.map(short)).toEqual([["changed songs:kept", "deleted songs:brief"]]);
    }).pipe(Effect.provide(TestDatabase())),
  );

  it.effect("announces the rows a REPLACE removes", () =>
    Effect.gen(function* () {
      const db = yield* Db;
      yield* write(db.insert(artists).values({ id: "artist", name: "Artist" }));
      const writes = yield* announced(write(db.run(sql`INSERT OR REPLACE INTO artists (id, name) VALUES ('artist', 'Again')`)));
      expect(writes.map(short)).toEqual([["changed artists:artist"]]);
    }).pipe(Effect.provide(TestDatabase())),
  );

  it.effect("announces nested writes once, after the outer one commits, and nothing of one that rolled back", () =>
    Effect.gen(function* () {
      const db = yield* Db;
      const changes = yield* LibraryChanges;
      const writes = yield* announced(
        Effect.gen(function* () {
          yield* write(
            Effect.gen(function* () {
              yield* write(db.insert(artists).values({ id: "inner", name: "Inner" }));
              yield* db.insert(artists).values({ id: "outer", name: "Outer" });
            }),
          );
          yield* Effect.exit(
            write(
              db
                .insert(artists)
                .values({ id: "failed", name: "Failed" })
                .pipe(Effect.andThen(Effect.fail("rolled back"))),
            ),
          );
          // The nested write announces from a fiber of its own, once the connection is free.
          yield* changes.flush;
        }),
      );
      expect(writes.map(short)).toEqual([["changed artists:inner", "changed artists:outer"]]);
    }).pipe(Effect.provide(TestDatabase())),
  );

  it.effect("announces nothing of a nested write whose outer transaction rolled back, and goes on announcing after", () =>
    Effect.gen(function* () {
      const db = yield* Db;
      const changes = yield* LibraryChanges;
      const writes = yield* announced(
        Effect.gen(function* () {
          const failed = yield* Effect.exit(
            write(
              Effect.gen(function* () {
                yield* write(db.insert(artists).values({ id: "nested", name: "Nested" }));
                // The nested write's flush waits for the connection, which the outer transaction holds.
                yield* Effect.yieldNow;
                return yield* Effect.fail("rolled back");
              }),
            ),
          );
          expect(failed._tag).toBe("Failure");
          yield* changes.flush;
          yield* write(db.insert(artists).values({ id: "after", name: "After" }));
        }),
      );
      expect(writes.map(short)).toEqual([["changed artists:after"]]);
    }).pipe(Effect.provide(TestDatabase())),
  );

  it.effect("announces, with the next flush, writes that did not go through write", () =>
    Effect.gen(function* () {
      const db = yield* Db;
      const changes = yield* LibraryChanges;
      const writes = yield* announced(
        Effect.gen(function* () {
          yield* db.insert(artists).values({ id: "artist", name: "Artist" });
          yield* changes.flush;
        }),
      );
      expect(writes.map(short)).toEqual([["changed artists:artist"]]);
    }).pipe(Effect.provide(TestDatabase())),
  );
});
