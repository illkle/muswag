import { Context, Data, Effect, Layer } from "effect";
import { MuswagDatabase } from "./db/database.js";
import SubsonicAPI from "./api/subsonic-api.js";
import type { AlbumID3, albumID3Schema, Child, indexArtistSchema } from "./api/subsonic-api-schema.js";
import { createTransaction, eq, inArray, queryOnce } from "@tanstack/db";

export type RefreshStatTarget = { type: "album" | "playlist"; id: string };
export type SyncMode = "full" | "quick";

export interface SyncManagerContextService {
  mode: "no_shortcuts" | "default";
}

export class SyncManagerContext extends Context.Service<SyncManagerContext, SyncManagerContextService>()("@muswag/shared/SyncManagerContext", {}) {}

export class SyncManager extends Context.Service<SyncManager>()("@muswag/shared/SyncManager", {
  make: Effect.gen(function* () {
    const db = yield* MuswagDatabase;
    const api = yield* SubsonicAPI;
    const deps = Effect.provide(Layer.mergeAll(Layer.succeed(MuswagDatabase, db), Layer.succeed(SubsonicAPI, api)));

    return {
      sync: (ctx: SyncManagerContextService) => sync.pipe(deps, Effect.provide(Layer.succeed(SyncManagerContext, ctx))),
      refreshStats: (target: RefreshStatTarget) => refreshStats(target).pipe(deps),
    } as const;
  }),
}) {
  static readonly layerWithoutDependencies = Layer.effect(this, this.make);
}

export default SyncManager;

const sync = Effect.gen(function* () {
  const db = yield* MuswagDatabase;
  const last = db.syncState.get(1);

  yield* syncArtistsFromIndexes(last?.indexesLastModified ?? 0);
  yield* syncAlbumList();

  return yield* Effect.succeed(null);
});

const ALBUM_STAT_FIELDS = ["playCount", "played", "starred", "userRating"] as const;
const SONG_STAT_FIELDS = ["playCount", "played", "starred", "userRating", "averageRating", "bookmarkPosition"] as const;

const refreshStats = (target: RefreshStatTarget) =>
  Effect.gen(function* () {
    const db = yield* MuswagDatabase;
    const api = yield* SubsonicAPI;

    const tx = createTransaction({
      mutationFn: async ({ transaction }) => {
        db.albums.utils.acceptMutations(transaction);
        db.songs.utils.acceptMutations(transaction);
      },
    });

    switch (target.type) {
      case "album": {
        const { album } = yield* api.getAlbum({ id: target.id });

        tx.mutate(() => {
          db.albums.update(target.id, (draft) => {
            assignFields(draft, album as AlbumID3, ALBUM_STAT_FIELDS);
          });

          for (const song of album.song ?? []) {
            if (!db.songs.get(song.id)) continue;
            db.songs.update(song.id, (draft) => assignFields(draft, song as Child, SONG_STAT_FIELDS));
          }
        });

        break;
      }
      case "playlist": {
        const { playlist } = yield* api.getPlaylist({ id: target.id });

        tx.mutate(() => {
          for (const song of playlist.entry ?? []) {
            if (!db.songs.get(song.id)) continue;
            db.songs.update(song.id, (draft) => assignFields(draft, song as Child, SONG_STAT_FIELDS));
          }
        });

        break;
      }
    }

    yield* Effect.promise(() => tx.isPersisted.promise);
  });

const syncArtistsFromIndexes = (lastSync: number) =>
  Effect.gen(function* () {
    const api = yield* SubsonicAPI;
    const db = yield* MuswagDatabase;
    const smc = yield* SyncManagerContext;

    const { indexes } = yield* api.getIndexes({ ifModifiedSince: smc.mode === "default" ? lastSync : 0 });

    if (!indexes.index) return;

    const toInsert = indexes.index.flatMap((i1) => (i1.artist ?? []).map((i2) => syncArtistFromIndex(i2)));
    if (!toInsert.length) return;

    const inserted = yield* Effect.all(toInsert, { concurrency: 10 });
    const insertedSet = new Set(inserted);

    const toRemove = [];

    for (const k of db.artists.keys()) {
      if (!insertedSet.has(k)) {
        toRemove.push(k);
      }
    }

    if (toRemove.length) {
      const tx = db.artists.delete(toRemove);
      yield* Effect.promise(() => tx.isPersisted.promise);
    }
  });

const syncArtistFromIndex = (artist: typeof indexArtistSchema.Type) =>
  Effect.gen(function* () {
    // todo: more artist info from api const api = yield* SubsonicAPI;
    const db = yield* MuswagDatabase;

    const existing = db.artists.get(artist.id);

    const tx = existing ? db.artists.update(artist.id, (draft) => Object.assign(draft, artist)) : db.artists.insert({ ...artist });

    yield* Effect.promise(() => tx.isPersisted.promise);

    return artist.id;
  });

const ALBUM_PAGE_SIZE = 500;

const syncAlbumList = () =>
  Effect.gen(function* () {
    const api = yield* SubsonicAPI;
    const db = yield* MuswagDatabase;

    const albumSet = new Set<string>(db.albums.keys());

    for (let offset = 0; ; offset += ALBUM_PAGE_SIZE) {
      const { albumList2 } = yield* api.getAlbumList2({ type: "alphabeticalByArtist", size: ALBUM_PAGE_SIZE, offset });
      const albums = albumList2.album ?? [];

      if (albums.length === 0) {
        break;
      }

      const tasks = albums.map((album) => syncAlbum(album));
      const res = yield* Effect.all(tasks, { concurrency: 10 });

      for (const id of res) albumSet.delete(id);

      if (albums.length < ALBUM_PAGE_SIZE) break;
    }

    const albumsToRemove = [...albumSet.keys()];
    const songsToRemove = yield* Effect.promise(() => queryOnce((q) => q.from({ s: db.songs }).where((v) => inArray(v.s.albumId, albumsToRemove))).then((v) => v.map((vv) => vv.id)));

    const tx = createTransaction({
      mutationFn: async ({ transaction }) => {
        db.albums.utils.acceptMutations(transaction);
        db.songs.utils.acceptMutations(transaction);
      },
    });

    tx.mutate(() => {
      if (albumsToRemove.length) db.albums.delete(albumsToRemove);
      if (songsToRemove.length) db.songs.delete(songsToRemove);
    });

    yield* Effect.promise(() => tx.isPersisted.promise);
  });

class AlbumWithoutSongs extends Data.TaggedError("AlbumWithoutSongs")<{
  readonly id: string;
  readonly expectedSongCount: number;
}> {}

const syncAlbum = (incoming: typeof albumID3Schema.Type) =>
  Effect.gen(function* () {
    const api = yield* SubsonicAPI;
    const db = yield* MuswagDatabase;
    const smc = yield* SyncManagerContext;

    const existing = db.albums.get(incoming.id);
    const existingSongs = existing?.id
      ? yield* Effect.promise(() =>
          queryOnce((q) =>
            q
              .from({ songs: db.songs })
              .where((v) => eq(v.songs.albumId, existing.id))
              .select((v) => ({
                id: v.songs.id,
              })),
          ).then((v) => v.map((s) => s.id)),
        )
      : [];

    if (smc.mode === "default") {
      const same =
        existing &&
        existing.songCount === incoming.songCount &&
        existing.duration === incoming.duration &&
        existing.created === incoming.created &&
        existing.name === incoming.name &&
        existing.artist === incoming.artist &&
        existingSongs.length === incoming.songCount;

      if (same) {
        return incoming.id;
      }
    }

    const { album } = yield* api.getAlbum({ id: incoming.id });

    if (!album.song && incoming.songCount > 0) {
      return yield* new AlbumWithoutSongs({ id: incoming.id, expectedSongCount: incoming.songCount });
    }

    if (existingSongs.length > 0) {
      const tx = db.songs.delete([...existingSongs]);
      yield* Effect.promise(() => tx.isPersisted.promise);
    }

    const tx = createTransaction({
      mutationFn: async ({ transaction }) => {
        db.albums.utils.acceptMutations(transaction);
        db.songs.utils.acceptMutations(transaction);
      },
    });

    tx.mutate(() => {
      if (existing) {
        db.albums.update(incoming.id, (draft) => Object.assign(draft, incoming));
      } else {
        db.albums.insert(incoming);
      }

      db.songs.insert([...(album.song ?? [])]);
    });

    yield* Effect.promise(() => tx.isPersisted.promise);

    return incoming.id;
  });

function assignFields<T extends object, K extends keyof T>(draft: T, source: T, fields: readonly K[]): void {
  for (const field of fields) {
    if (field in source) draft[field] = source[field];
    else delete draft[field];
  }
}
