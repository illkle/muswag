import { Context, Data, Effect } from "effect";
import { MuswagDatabase } from "./db/database.js";
import SubsonicAPI from "@muswag/subsonic-api/effect";
import type { albumID3Schema, indexArtistSchema } from "@muswag/subsonic-api/schema";
import CoverManager from "./covers/cov-effect.js";

export interface SyncManagerService {}
export interface SyncManagerContextService {
  mode: "no_shortcuts" | "default";
}

export class SyncManagerContext extends Context.Service<SyncManagerContext, SyncManagerContextService>()("@muswag/shared/SyncManagerContext") {}

export default class SyncManager extends Context.Service<SyncManager, SyncManagerService>()("@muswag/shared/SyncManager") {}

const syncArtistsFromIndexes = (lastSync: number) =>
  Effect.gen(function* () {
    const api = yield* SubsonicAPI;
    const db = yield* MuswagDatabase;
    const smc = yield* SyncManagerContext;

    const { indexes } = yield* api.getIndexes({ ifModifiedSince: smc.mode === "default" ? lastSync : 0 });

    if (!indexes.index) {
      return yield* Effect.succeedNone;
    }

    const toInsert = indexes.index.flatMap((i1) => (i1.artist ?? []).map((i2) => syncArtistFromIndex(i2)));
    if (!toInsert.length) {
      return yield* Effect.succeedNone;
    }

    const inserted = yield* Effect.all(toInsert, { concurrency: 10 });
    const insertedSet = new Set(inserted);

    const toRemove = [];

    for (const k of insertedSet) {
      if (!insertedSet.has(k)) {
        toRemove.push(k);
      }
    }

    if (toRemove.length) db.artists.delete(toRemove);

    return yield* Effect.succeedNone;
  });

const syncArtistFromIndex = (artist: typeof indexArtistSchema.Type) =>
  Effect.gen(function* () {
    // todo: more artist info from api const api = yield* SubsonicAPI;
    const db = yield* MuswagDatabase;

    const existing = db.artists.get(artist.id);

    if (!existing) {
      db.artists.insert({ ...artist });
    } else {
      db.artists.update(artist.id, () => artist);
    }

    return artist.id;
  });

const ALBUM_PAGE_SIZE = 500;

const syncAlbumList = () =>
  Effect.gen(function* () {
    const api = yield* SubsonicAPI;
    const db = yield* MuswagDatabase;
    const covers = yield* CoverManager;

    for (let offset = 0; ; offset += ALBUM_PAGE_SIZE) {
      const { albumList2 } = yield* api.getAlbumList2({ type: "alphabeticalByArtist", size: ALBUM_PAGE_SIZE, offset });

      if (!albumList2.album) {
        break;
      }

      const tasks = albumList2.album.map((v) => syncAlbums(v));

      const res = yield* Effect.all(tasks, { concurrency: 10 });

      if (albumList2.album.length < ALBUM_PAGE_SIZE) break;
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
        return Effect.succeed({ id: incoming.id, songs: [] });
      }
    }

    if (existing) {
      db.albums.update(incoming.id, () => incoming);
    } else {
      db.albums.insert(incoming);
    }

    const { album } = yield* api.getAlbum({ id: incoming.id });

    if (!album.song) {
      return yield* new AlbumWithoutSongs({ id: incoming.id });
    }

    const songIds = [];

    for (const song of album.song) {
      songIds.push(song.id);

      if (existing) {
        db.songs.update(song.id, () => song);
      } else {
        db.songs.insert(song);
      }
    }

    return Effect.succeed({ id: incoming.id, songs: songIds });
  });
