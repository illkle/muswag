import type { AlbumID3, AlbumWithSongsID3, ArtistID3, Child, Contributor, ReplayGain } from "@muswag/subsonic-api";

let nextId = 1;

function id(prefix: string): string {
  const value = `${prefix}-${nextId}`;
  nextId += 1;
  return value;
}

export function artistFixture(overrides: Partial<ArtistID3> = {}): ArtistID3 {
  return {
    id: id("artist"),
    name: "Test Artist",
    ...overrides,
  } as ArtistID3;
}

export function contributorFixture(overrides: Partial<Contributor> = {}): Contributor {
  return {
    role: "composer",
    artist: artistFixture({ id: "composer-1", name: "Test Composer" }),
    ...overrides,
  } as Contributor;
}

export function replayGainFixture(overrides: Partial<ReplayGain> = {}): ReplayGain {
  return {
    trackGain: -6.1,
    albumGain: -5.4,
    trackPeak: 0.91,
    albumPeak: 0.95,
    ...overrides,
  } as ReplayGain;
}

export function songFixture(overrides: Partial<Child> = {}): Child {
  return {
    id: id("song"),
    title: "Test Song",
    album: "Test Album",
    albumId: "album-1",
    artist: "Test Artist",
    isDir: false,
    track: 1,
    year: 2024,
    genre: "Synthpop",
    contentType: "audio/mpeg",
    suffix: "mp3",
    type: "music",
    musicBrainzId: id("mb-track"),
    genres: [{ name: "Synthpop" }],
    artists: [artistFixture({ id: "artist-1", name: "Test Artist" })],
    albumArtists: [artistFixture({ id: "album-artist-1", name: "Test Album Artist" })],
    contributors: [contributorFixture()],
    replayGain: replayGainFixture(),
    ...overrides,
  } as Child;
}

export function albumFixture(overrides: Partial<AlbumID3> = {}): AlbumID3 {
  return {
    id: id("album"),
    name: "Test Album",
    artist: "Test Artist",
    coverArt: "cover-1",
    created: "2026-01-01T00:00:00Z",
    duration: 120,
    songCount: 1,
    year: 2024,
    genre: "Synthpop",
    musicBrainzId: id("mb-album"),
    genres: [{ name: "Synthpop" }],
    artists: [artistFixture({ id: "album-list-artist-1", name: "Test Artist" })],
    ...overrides,
  } as AlbumID3;
}

export function albumWithSongsFixture(
  overrides: Partial<AlbumWithSongsID3> & { song?: Child[] } = {},
): AlbumWithSongsID3 {
  const albumId = overrides.id ?? id("album");
  const name = overrides.name ?? "Test Album";
  const artist = overrides.artist ?? "Test Artist";
  const songs =
    overrides.song ??
    [
      songFixture({
        id: `${albumId}-song-1`,
        album: name,
        albumId,
        artist,
      }),
    ];

  return {
    ...albumFixture({
      id: albumId,
      name,
      artist,
      songCount: songs.length,
    }),
    ...overrides,
    song: songs,
  } as AlbumWithSongsID3;
}
