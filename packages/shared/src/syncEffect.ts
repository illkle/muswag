import { Context, Data, Effect, Layer } from "effect";
import { MuswagDatabase } from "./db/database.js";
import SubsonicAPI from "./api/subsonic-api.js";
import type { AlbumID3, albumID3Schema, Child, indexArtistSchema } from "./api/subsonic-api-schema.js";
import { eq, queryOnce } from "@tanstack/db";

export type RefreshStatTarget = { type: "album" | "playlist"; id: string };

export interface SyncManagerContextService {
  mode: "no_shortcuts" | "default";
}

export class SyncManagerContext extends Context.Service<SyncManagerContext, SyncManagerContextService>()("@muswag/shared/SyncManagerContext", {}) {}

export default class SyncManager extends Context.Service<SyncManager>()("@muswag/shared/SyncManager", {
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

    switch (target.type) {
      case "album": {
        const { album } = yield* api.getAlbum({ id: target.id });
        db.albums.update(target.id, (draft) => {
          assignFields(draft, album as AlbumID3, ALBUM_STAT_FIELDS);
        });

        for (const song of album.song ?? []) {
          if (!db.songs.get(song.id)) continue;
          db.songs.update(song.id, (draft) => assignFields(draft, song as Child, SONG_STAT_FIELDS));
        }
        break;
      }
      case "playlist": {
        const { playlist } = yield* api.getPlaylist({ id: target.id });
        for (const song of playlist.entry ?? []) {
          if (!db.songs.get(song.id)) continue;
          db.songs.update(song.id, (draft) => assignFields(draft, song as Child, SONG_STAT_FIELDS));
        }
        break;
      }
    }
  });

const syncArtistsFromIndexes = (lastSync: number) =>
  Effect.gen(function* () {
    const api = yield* SubsonicAPI;
    const db = yield* MuswagDatabase;
    const smc = yield* SyncManagerContext;

    const { indexes } = yield* api.getIndexes({ ifModifiedSince: smc.mode === "default" ? lastSync : 0 });

    if (!indexes.index) {
      return;
    }

    const toInsert = indexes.index.flatMap((i1) => (i1.artist ?? []).map((i2) => syncArtistFromIndex(i2)));
    if (!toInsert.length) {
      return;
    }

    const inserted = yield* Effect.all(toInsert, { concurrency: 10 });
    const insertedSet = new Set(inserted);

    const toRemove = [];

    for (const k of db.artists.keys()) {
      if (!insertedSet.has(k)) {
        toRemove.push(k);
      }
    }

    if (toRemove.length) db.artists.delete(toRemove);
  });

const syncArtistFromIndex = (artist: typeof indexArtistSchema.Type) =>
  Effect.gen(function* () {
    // todo: more artist info from api const api = yield* SubsonicAPI;
    const db = yield* MuswagDatabase;

    const existing = db.artists.get(artist.id);

    if (!existing) {
      db.artists.insert({ ...artist });
    } else {
      db.artists.update(artist.id, (draft) => Object.assign(draft, artist));
    }

    return artist.id;
  });

const ALBUM_PAGE_SIZE = 500;

const syncAlbumList = () =>
  Effect.gen(function* () {
    const api = yield* SubsonicAPI;
    const db = yield* MuswagDatabase;

    const albumSet = new Set<string>();

    for (let offset = 0; ; offset += ALBUM_PAGE_SIZE) {
      const { albumList2 } = yield* api.getAlbumList2({ type: "alphabeticalByArtist", size: ALBUM_PAGE_SIZE, offset });

      if (!albumList2.album) {
        break;
      }

      const tasks = albumList2.album.map((v) => syncAlbums(v));

      const res = yield* Effect.all(tasks, { concurrency: 10 });

      for (const item of res) {
        albumSet.add(item);
      }

      if (albumList2.album.length < ALBUM_PAGE_SIZE) break;
    }

    for (const alb of db.albums.keys()) {
      if (!albumSet.has(alb)) {
        db.albums.delete(alb);
      }
    }
  });

class AlbumWithoutSongs extends Data.TaggedError("AlbumWithoutSongs")<{
  readonly id: string;
}> {}

const syncAlbums = (incoming: typeof albumID3Schema.Type) =>
  Effect.gen(function* () {
    const api = yield* SubsonicAPI;
    const db = yield* MuswagDatabase;
    const smc = yield* SyncManagerContext;

    const existing = db.albums.get(incoming.id);
    if (smc.mode === "default") {
      const same =
        existing &&
        existing.songCount === incoming.songCount &&
        existing.duration === incoming.duration &&
        existing.created === incoming.created &&
        existing.name === incoming.name &&
        existing.artist === incoming.artist;

      if (same) {
        return yield* Effect.succeed(incoming.id);
      }
    }

    if (existing) {
      db.albums.update(incoming.id, (draft) => Object.assign(draft, incoming));
    } else {
      db.albums.insert(incoming);
    }

    const { album } = yield* api.getAlbum({ id: incoming.id });

    if (!album.song) {
      return yield* new AlbumWithoutSongs({ id: incoming.id });
    }

    const existingSongs = yield* Effect.promise(async () => queryOnce((q) => q.from({ songs: db.songs }).where((v) => eq(v.songs.albumId, incoming.id))));
    db.songs.delete(existingSongs.map(({ id }) => id));

    for (const song of album.song) {
      db.songs.insert(song);
    }

    return yield* Effect.succeed(incoming.id);
  });

function assignFields<T extends object, K extends keyof T>(draft: T, source: T, fields: readonly K[]): void {
  for (const field of fields) {
    if (field in source) draft[field] = source[field];
    else delete draft[field];
  }
}
