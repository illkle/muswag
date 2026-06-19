import { describe, expect, it } from "vitest";

import type { AlbumID3 } from "@muswag/subsonic-api";
import { albumWithSongsFixture, songFixture } from "../fixtures/sync-fixtures.js";
import {
  assertNoDanglingRelations,
  createFakeSubsonicApi,
  createMemoryCoverArtStore,
  expectAlbumSongCounts,
  expectSongLinkedToAlbum,
  readFullState,
  stripVirtualPropsFromRows,
  syncAlbumsInMemory,
} from "../helpers/sync-testkit.js";
import { createInMemoryDb } from "../navidrome-testkit.js";
import { sync, syncAlbums } from "@muswag/shared";

describe("syncAlbums", () => {
  it("persists nested song metadata", async () => {
    const album = albumWithSongsFixture({
      id: "album-nested",
      name: "Nested Album",
      artist: "Album Artist",
      song: [
        songFixture({
          id: "song-nested-1",
          title: "Nested One",
          album: "Nested Album",
          albumId: "album-nested",
          artist: "Lead Artist",
          track: 1,
          musicBrainzId: "mb-track-1",
        }),
        songFixture({
          id: "song-nested-2",
          title: "Nested Two",
          album: "Nested Album",
          albumId: "album-nested",
          artist: "Guest Artist",
          track: 2,
          musicBrainzId: "mb-track-2",
        }),
      ],
    });

    const { state } = await syncAlbumsInMemory({ albums: [album] });
    const firstSong = state.songs.find((song) => song.id === "song-nested-1");

    expect(firstSong).toMatchObject({
      id: "song-nested-1",
      title: "Nested One",
      album: "Nested Album",
      artist: "Lead Artist",
      track: 1,
      musicBrainzId: "mb-track-1",
      genres: [{ name: "Synthpop" }],
      artists: [{ id: "artist-1", name: "Test Artist" }],
      albumArtists: [{ id: "album-artist-1", name: "Test Album Artist" }],
      contributors: [
        {
          role: "composer",
          artist: { id: "composer-1", name: "Test Composer" },
        },
      ],
      replayGain: {
        trackGain: -6.1,
        albumGain: -5.4,
        trackPeak: 0.91,
        albumPeak: 0.95,
      },
    });
    expectAlbumSongCounts(state, [album]);
    assertNoDanglingRelations(state);
  });

  it("updates existing albums and replaces songs idempotently", async () => {
    const album = albumWithSongsFixture({
      id: "album-idempotent",
      name: "Fresh Album",
      song: [
        songFixture({
          id: "song-idempotent",
          title: "Fresh Song",
          album: "Fresh Album",
          albumId: "album-idempotent",
        }),
      ],
    });
    const staleAlbum = albumWithSongsFixture({
      id: "album-idempotent",
      name: "Stale Album",
      song: [],
    });
    const staleSong = songFixture({
      id: "song-idempotent",
      title: "Stale Song",
      album: "Stale Album",
      albumId: "album-idempotent",
    });

    const first = await syncAlbumsInMemory({
      albums: [album],
      existingAlbums: [staleAlbum],
      existingSongs: [staleSong],
    });
    const second = await syncAlbumsInMemory({
      albums: [album],
      existingAlbums: first.state.albums,
      existingSongs: first.state.songs,
      coverArt: createMemoryCoverArtStore({ fetchResult: "/covers/album-idempotent.jpg" }),
    });

    expect(first.result).toMatchObject({
      fetched: 1,
      inserted: 0,
      updated: 1,
      deleted: 0,
      pages: 1,
    });
    expect(second.result).toMatchObject({
      fetched: 1,
      inserted: 0,
      updated: 1,
      deleted: 0,
      pages: 1,
    });
    expect(stripVirtualPropsFromRows(second.state.albums)).toEqual(stripVirtualPropsFromRows(first.state.albums));
    expect(stripVirtualPropsFromRows(second.state.songs)).toEqual(stripVirtualPropsFromRows(first.state.songs));
  });

  it("deletes stale songs by incoming song id even when albumId is wrong", async () => {
    const album = albumWithSongsFixture({
      id: "album-canonical",
      name: "Canonical Album",
      song: [
        songFixture({
          id: "song-canonical",
          title: "Canonical Song",
          album: "Canonical Album",
          albumId: "album-canonical",
        }),
      ],
    });
    const staleSong = songFixture({
      id: "song-canonical",
      title: "Wrong Link",
      albumId: "stale-server-album-id",
    });

    const { state } = await syncAlbumsInMemory({
      albums: [album],
      existingSongs: [staleSong],
    });

    expect(state.songs.filter((song) => song.id === "song-canonical")).toHaveLength(1);
    expectSongLinkedToAlbum(state, "song-canonical", "album-canonical");
  });

  it("deletes missing albums and their songs", async () => {
    const removedAlbum = albumWithSongsFixture({
      id: "album-a",
      name: "Removed Album",
      song: [songFixture({ id: "song-a", albumId: "album-a" })],
    });
    const keptAlbum = albumWithSongsFixture({
      id: "album-b",
      name: "Kept Album",
      song: [songFixture({ id: "song-b", albumId: "album-b" })],
    });

    const { state, coverArt, result } = await syncAlbumsInMemory({
      albums: [keptAlbum],
      existingAlbums: [removedAlbum, keptAlbum],
      existingSongs: [...(removedAlbum.song ?? []), ...(keptAlbum.song ?? [])],
    });

    expect(result.deleted).toBe(1);
    expect(state.albums.map((album) => album.id)).toEqual(["album-b"]);
    expect(state.songs.some((song) => song.albumId === "album-a")).toBe(false);
    expect(coverArt.removedAlbumIds).toEqual(["album-a"]);
  });

  it("preserves existing coverArtPath when coverArt.fetch returns undefined", async () => {
    const album = albumWithSongsFixture({
      id: "album-preserve-cover",
      coverArt: "cover-preserve",
    });
    const existingAlbum = {
      ...album,
      coverArtPath: "/covers/existing.jpg",
    };

    const { state } = await syncAlbumsInMemory({
      albums: [album],
      existingAlbums: [existingAlbum],
      coverArt: createMemoryCoverArtStore({ fetchResult: undefined }),
    });

    expect(state.albums[0]?.coverArtPath).toBe("/covers/existing.jpg");
  });

  it("clears coverArtPath when coverArt.fetch returns null", async () => {
    const album = albumWithSongsFixture({
      id: "album-clear-cover",
      coverArt: "cover-clear",
    });
    const existingAlbum = {
      ...album,
      coverArtPath: "/covers/existing.jpg",
    };

    const { state } = await syncAlbumsInMemory({
      albums: [album],
      existingAlbums: [existingAlbum],
      coverArt: createMemoryCoverArtStore({ fetchResult: null }),
    });

    expect(state.albums[0]?.coverArtPath).toBeUndefined();
  });

  it("paginates album list requests", async () => {
    const albums = Array.from({ length: 501 }, (_, index) =>
      albumWithSongsFixture({
        id: `album-page-${index}`,
        name: `Paged Album ${index}`,
        song: [songFixture({ id: `song-page-${index}`, albumId: `album-page-${index}` })],
      }),
    );
    const pages: AlbumID3[][] = [
      albums.slice(0, 500).map(({ song: _song, ...album }) => album),
      albums.slice(500).map(({ song: _song, ...album }) => album),
    ];

    const { result, fakeApi } = await syncAlbumsInMemory({ albums, pages });

    expect(result.pages).toBe(2);
    expect(fakeApi.albumListCalls.map((call) => call.offset ?? 0)).toEqual([0, 500]);
  });

  it("retries transient album list failures", async () => {
    const album = albumWithSongsFixture({
      id: "album-retry",
      song: [songFixture({ id: "song-retry", albumId: "album-retry" })],
    });

    const { result, fakeApi } = await syncAlbumsInMemory({
      albums: [album],
      failAlbumListAttempts: 1,
    });

    expect(result.fetched).toBe(1);
    expect(fakeApi.albumListCalls).toHaveLength(2);
  });

  it("requires login before syncManager sync", async () => {
    const db = createInMemoryDb();

    await expect(sync(db, createMemoryCoverArtStore())).rejects.toThrow("login() must be called before sync()");
  });

  it("can run directly with a fake API and fake cover art store", async () => {
    const db = createInMemoryDb();
    const album = albumWithSongsFixture({
      id: "album-direct",
      song: [songFixture({ id: "song-direct", albumId: "album-direct" })],
    });
    const listedAlbum = (({ song: _song, ...listItem }) => listItem)(album);
    const fakeApi = createFakeSubsonicApi([[listedAlbum]], { [album.id]: album });
    const coverArt = createMemoryCoverArtStore({ fetchResult: "/covers/direct.jpg" });

    const result = await syncAlbums({
      api: fakeApi.api,
      db,
      coverArt,
      syncId: "direct-sync",
    });
    const state = await readFullState(db);

    expect(result.inserted).toBe(1);
    expect(state.albums[0]?.coverArtPath).toBe("/covers/direct.jpg");
    expect(coverArt.fetchCalls).toEqual([{ albumId: "album-direct", coverArtId: "cover-1" }]);
  });
});
