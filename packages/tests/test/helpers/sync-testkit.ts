import { expect } from "vitest";
import { queryOnce } from "@tanstack/db";

import type SubsonicAPI from "@muswag/subsonic-api";
import type { AlbumID3, AlbumWithSongsID3, Child, GetAlbumArgs, GetAlbumList2Args } from "@muswag/subsonic-api";
import {
  type Album,
  createCoverArtStore,
  type CoverArtStore,
  type MuswagDb,
  syncAlbums,
} from "@muswag/shared";
import { createNodeCoverArtFileSystem } from "@muswag/shared/sync-node";
import { createInMemoryDb } from "../navidrome-testkit.js";

export type FullDbState = Awaited<ReturnType<typeof readFullState>>;

export interface FakeSubsonicApi {
  api: SubsonicAPI;
  albumListCalls: GetAlbumList2Args[];
  albumDetailCalls: GetAlbumArgs[];
}

export interface MemoryCoverArtStore extends CoverArtStore {
  fetchCalls: Array<{ albumId: string; coverArtId: string | null }>;
  removedAlbumIds: string[];
}

export function stripVirtualProps<T extends object>(obj: T): T {
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(obj)) {
    if (!key.startsWith("$")) {
      result[key] = value;
    }
  }
  return result as T;
}

export function stripVirtualPropsFromRows<T extends object>(rows: T[]): T[] {
  return rows.map((row) => stripVirtualProps(row));
}

export function countSongsInLibrary(
  albums: ReadonlyArray<{
    songs: ReadonlyArray<unknown>;
  }>,
): number {
  return albums.reduce((count, album) => count + album.songs.length, 0);
}

export async function readFullState(db: MuswagDb) {
  const albums = await queryOnce((q) => q.from({ albums: db.albums }));
  albums.sort((a, b) => a.id.localeCompare(b.id));

  const songs = await queryOnce((q) => q.from({ songs: db.songs }));
  songs.sort((a, b) => a.id.localeCompare(b.id));

  return { albums, songs };
}

export function assertNoDanglingRelations(state: FullDbState): void {
  const albumIds = new Set(state.albums.map((album) => album.id));
  for (const song of state.songs) {
    expect(albumIds.has(song.albumId || "never-never")).toBe(true);
  }
}

export function coverArtStoreFor(
  connection: { baseUrl: string; username: string; password: string },
  coverArtDir: string,
): CoverArtStore {
  return createCoverArtStore({
    url: connection.baseUrl,
    username: connection.username,
    password: connection.password,
    fileSystem: createNodeCoverArtFileSystem(coverArtDir),
  });
}

export function expectSyncedCounts(
  state: FullDbState,
  expected: {
    albums: number;
    songs: number;
  },
): void {
  expect(state.albums).toHaveLength(expected.albums);
  expect(state.songs).toHaveLength(expected.songs);
}

export function expectAlbumSongCounts(state: FullDbState, expectedAlbums: ReadonlyArray<AlbumWithSongsID3>): void {
  for (const expectedAlbum of expectedAlbums) {
    const album = state.albums.find((candidate) => candidate.id === expectedAlbum.id);
    expect(album).toBeDefined();
    expect(album?.songCount).toBe(expectedAlbum.song?.length ?? 0);
  }
}

export function expectSongLinkedToAlbum(state: FullDbState, songId: string, albumId: string): void {
  const song = state.songs.find((candidate) => candidate.id === songId);
  expect(song).toBeDefined();
  expect(song?.albumId).toBe(albumId);
}

export function expectSongMetadata(
  song: Child | undefined,
  expected: {
    album: string;
    title: string;
    artist: string;
    albumArtist?: string;
  },
): void {
  expect(song).toBeDefined();
  expect(song).toMatchObject({
    album: expected.album,
    title: expected.title,
    artist: expected.artist,
  });
  if (expected.albumArtist) {
    expect(song?.albumArtists?.map((artist) => artist.name)).toEqual([expected.albumArtist]);
  }
}

function toAlbumListItem(album: AlbumWithSongsID3): AlbumID3 {
  const { song: _song, ...albumListItem } = album;
  return albumListItem;
}

export function createFakeSubsonicApi(
  pages: AlbumID3[][],
  details: ReadonlyMap<string, AlbumWithSongsID3> | Record<string, AlbumWithSongsID3>,
  options: { failAlbumListAttempts?: number } = {},
): FakeSubsonicApi {
  const albumListCalls: GetAlbumList2Args[] = [];
  const albumDetailCalls: GetAlbumArgs[] = [];
  const detailMap = details instanceof Map ? details : new Map(Object.entries(details));
  let remainingAlbumListFailures = options.failAlbumListAttempts ?? 0;

  const api = {
    async getAlbumList2(args: GetAlbumList2Args) {
      albumListCalls.push(args);
      if (remainingAlbumListFailures > 0) {
        remainingAlbumListFailures -= 1;
        throw new Error("Transient album list failure");
      }

      const offset = args.offset ?? 0;
      const size = args.size ?? 500;
      const pageIndex = Math.floor(offset / size);
      return {
        status: "ok",
        version: "1.16.1",
        albumList2: {
          album: pages[pageIndex] ?? [],
        },
      };
    },

    async getAlbum(args: GetAlbumArgs) {
      albumDetailCalls.push(args);
      const album = detailMap.get(args.id);
      if (!album) {
        throw new Error(`Missing fake album detail for ${args.id}`);
      }

      return {
        status: "ok",
        version: "1.16.1",
        album,
      };
    },
  };

  return {
    api: api as unknown as SubsonicAPI,
    albumListCalls,
    albumDetailCalls,
  };
}

export function createMemoryCoverArtStore(
  options: {
    fetchResult?: string | null | undefined;
    fetchResults?: Record<string, string | null | undefined>;
  } = {},
): MemoryCoverArtStore {
  const fetchCalls: Array<{ albumId: string; coverArtId: string | null }> = [];
  const removedAlbumIds: string[] = [];

  return {
    fetchCalls,
    removedAlbumIds,

    async fetch(albumId, coverArtId) {
      fetchCalls.push({ albumId, coverArtId });
      if (options.fetchResults && albumId in options.fetchResults) {
        return options.fetchResults[albumId];
      }
      if ("fetchResult" in options) {
        return options.fetchResult;
      }
      return `/covers/${albumId}.jpg`;
    },

    async remove(albumId) {
      removedAlbumIds.push(albumId);
    },
  };
}

export async function syncAlbumsInMemory({
  albums,
  pages,
  existingAlbums = [],
  existingSongs = [],
  coverArt = createMemoryCoverArtStore(),
  failAlbumListAttempts,
}: {
  albums: AlbumWithSongsID3[];
  pages?: AlbumID3[][];
  existingAlbums?: Array<Album | (AlbumWithSongsID3 & { coverArtPath?: string | undefined })>;
  existingSongs?: Child[];
  coverArt?: MemoryCoverArtStore;
  failAlbumListAttempts?: number;
}) {
  const db = createInMemoryDb();

  for (const album of existingAlbums) {
    const { song: _song, ...albumRecord } = album as AlbumWithSongsID3 & { coverArtPath?: string | undefined };
    const coverArtPath =
      "coverArtPath" in album ? album.coverArtPath : album.coverArt ? `/covers/${album.id}.jpg` : undefined;
    db.albums.insert({ ...albumRecord, coverArtPath });
  }

  for (const song of existingSongs) {
    db.songs.insert(song);
  }

  const fakeApi = createFakeSubsonicApi(
    pages ?? [albums.map(toAlbumListItem)],
    new Map(albums.map((album) => [album.id, album])),
    { failAlbumListAttempts },
  );

  const result = await syncAlbums({
    api: fakeApi.api,
    db,
    coverArt,
    syncId: "test-sync",
  });
  const state = await readFullState(db);

  return {
    db,
    result,
    state,
    coverArt,
    fakeApi,
  };
}
