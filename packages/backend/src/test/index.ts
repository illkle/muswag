import { albums, artists, playlists, songs, toRow, toSongRow, type AlbumID3, type Child, type PlaylistRecord, type PlaylistWithSongs } from "@muswag/model";
import { eq } from "drizzle-orm";
import { Effect, Layer } from "effect";

import { makeSubsonicAPI, SubsonicAPI, type SubsonicApiConfig, type SubsonicApiService } from "../api/subsonic-api.js";
import { MiniFs } from "../covers/cover-manager.js";
import { DatabaseLive, Db, write } from "../db/database.js";

/** A migrated in-memory database with its mirror server. */
export const TestDatabase = () => DatabaseLive(":memory:");

/** Cover files that are never written: for tests that sync a library and do not look at covers. */
export const NoCoverFiles = Layer.succeed(MiniFs, { writeFile: () => Effect.void, remove: () => Effect.void, exists: () => Effect.succeed(false) });

const unexpected = (method: string): Effect.Effect<never> => Effect.die(new Error(`Unexpected ${method} call`));

/** An API whose every method dies unless overridden. */
export function makeApi(overrides: Partial<SubsonicApiService> = {}): SubsonicApiService {
  return {
    username: "alice",
    ping: unexpected("ping"),
    getAlbum: () => unexpected("getAlbum"),
    getAlbumList2: () => unexpected("getAlbumList2"),
    getIndexes: () => unexpected("getIndexes"),
    getCoverArt: () => unexpected("getCoverArt"),
    getPlaylists: unexpected("getPlaylists"),
    getPlaylist: () => unexpected("getPlaylist"),
    createPlaylist: () => unexpected("createPlaylist"),
    updatePlaylist: () => unexpected("updatePlaylist"),
    deletePlaylist: () => unexpected("deletePlaylist"),
    ...overrides,
  };
}

export const apiLayer = (overrides: Partial<SubsonicApiService> = {}) => Layer.succeed(SubsonicAPI, makeApi(overrides));

/** The real client against the server of `config`, without a session around it. */
export const SubsonicAPILive = (config: SubsonicApiConfig) => Layer.effect(SubsonicAPI, makeSubsonicAPI(config));

export const apiAlbum = (id: string, overrides: Partial<AlbumID3> = {}): AlbumID3 => ({
  id,
  name: `Album ${id}`,
  artist: "Artist",
  created: "2026-01-01T00:00:00Z",
  duration: 120,
  songCount: 1,
  ...overrides,
});

export const apiSong = (id: string, albumId: string, overrides: Partial<Child> = {}): Child => ({
  id,
  albumId,
  title: `Song ${id}`,
  isDir: false,
  ...overrides,
});

export const apiPlaylist = (id: string, entry: Child[]): PlaylistWithSongs => ({
  id,
  name: `Playlist ${id}`,
  songCount: entry.length,
  duration: 120,
  created: "2026-01-01T00:00:00Z",
  changed: "2026-01-01T00:00:00Z",
  entry,
});

/** Inserts library rows directly, as a previous sync would have. */
export const seed = (data: { albums?: AlbumID3[]; artists?: Array<{ id: string; name: string }>; songs?: Child[]; playlists?: PlaylistRecord[] }) =>
  Effect.gen(function* () {
    const db = yield* Db;
    yield* write(
      Effect.gen(function* () {
        if (data.albums?.length) yield* db.insert(albums).values(data.albums.map((album) => toRow(albums, album)));
        if (data.artists?.length) yield* db.insert(artists).values(data.artists.map((artist) => toRow(artists, artist)));
        if (data.songs?.length) yield* db.insert(songs).values(data.songs.map(toSongRow));
        if (data.playlists?.length) yield* db.insert(playlists).values(data.playlists);
      }),
    );
  });

/** Ids of every row in a table, sorted. */
export const idsOf = (table: typeof albums | typeof artists | typeof songs | typeof playlists) =>
  Effect.gen(function* () {
    const db = yield* Db;
    const rows = yield* db.select({ id: table.id }).from(table);
    return rows.map(({ id }) => id).sort();
  });

/** One row by id, or undefined. */
export const rowOf = <TTable extends typeof albums | typeof artists | typeof songs | typeof playlists>(table: TTable, id: string) =>
  Effect.gen(function* () {
    const db = yield* Db;
    const anyTable = table as typeof albums;
    const rows = yield* db.select().from(anyTable).where(eq(anyTable.id, id));
    return rows[0] as TTable["$inferSelect"] | undefined;
  });
