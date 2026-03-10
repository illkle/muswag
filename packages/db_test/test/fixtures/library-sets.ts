export interface SongFixture {
  title: string;
  track: number;
  durationSec: number;
  artist?: string;
  musicBrainzTrackId: string;
}

export interface AlbumFixture {
  artist: string;
  album: string;
  albumArtist: string;
  year: number;
  genre: string;
  composer: string;
  comment: string;
  disc: number;
  compilation: boolean;
  musicBrainzAlbumId: string;
  musicBrainzArtistId: string;
  musicBrainzReleaseGroupId: string;
  songs: SongFixture[];
}

export const librarySetA: AlbumFixture[] = [
  {
    artist: "Aurora Lane",
    album: "Sky Patterns",
    albumArtist: "Aurora Lane",
    year: 2022,
    genre: "Indie",
    composer: "A. Lane",
    comment: "Set A - Album 1",
    disc: 1,
    compilation: false,
    musicBrainzAlbumId: "11111111-1111-4111-8111-111111111111",
    musicBrainzArtistId: "11111111-1111-4111-8111-111111111112",
    musicBrainzReleaseGroupId: "11111111-1111-4111-8111-111111111113",
    songs: [
      {
        title: "Morning Grid",
        track: 1,
        durationSec: 1.2,
        musicBrainzTrackId: "11111111-1111-4111-8111-111111111114",
      },
      {
        title: "Cloud Cursor",
        track: 2,
        durationSec: 1.3,
        musicBrainzTrackId: "11111111-1111-4111-8111-111111111115",
      },
    ],
  },
  {
    artist: "Neon Harbor",
    album: "City Echoes",
    albumArtist: "Neon Harbor",
    year: 2021,
    genre: "Synthwave",
    composer: "N. Harbor",
    comment: "Set A - Album 2",
    disc: 1,
    compilation: false,
    musicBrainzAlbumId: "22222222-2222-4222-8222-222222222221",
    musicBrainzArtistId: "22222222-2222-4222-8222-222222222222",
    musicBrainzReleaseGroupId: "22222222-2222-4222-8222-222222222223",
    songs: [
      {
        title: "Subway Sparks",
        track: 1,
        durationSec: 1.1,
        musicBrainzTrackId: "22222222-2222-4222-8222-222222222224",
      },
      {
        title: "Late Bus",
        track: 2,
        durationSec: 1.1,
        musicBrainzTrackId: "22222222-2222-4222-8222-222222222225",
      },
      {
        title: "Window Rain",
        track: 3,
        durationSec: 1.4,
        musicBrainzTrackId: "22222222-2222-4222-8222-222222222226",
      },
    ],
  },
  {
    artist: "The Cassettes",
    album: "Dusty Roads",
    albumArtist: "The Cassettes",
    year: 2019,
    genre: "Rock",
    composer: "T. Cassettes",
    comment: "Set A - Album 3",
    disc: 1,
    compilation: false,
    musicBrainzAlbumId: "33333333-3333-4333-8333-333333333331",
    musicBrainzArtistId: "33333333-3333-4333-8333-333333333332",
    musicBrainzReleaseGroupId: "33333333-3333-4333-8333-333333333333",
    songs: [
      {
        title: "Single Lantern",
        track: 1,
        durationSec: 1.2,
        musicBrainzTrackId: "33333333-3333-4333-8333-333333333334",
      },
    ],
  },
  {
    artist: "Various Artists",
    album: "Summer Sampler",
    albumArtist: "Various Artists",
    year: 2020,
    genre: "Pop",
    composer: "Various",
    comment: "Set A - Album 4",
    disc: 1,
    compilation: true,
    musicBrainzAlbumId: "44444444-4444-4444-8444-444444444441",
    musicBrainzArtistId: "44444444-4444-4444-8444-444444444442",
    musicBrainzReleaseGroupId: "44444444-4444-4444-8444-444444444443",
    songs: [
      {
        title: "Sunline",
        track: 1,
        durationSec: 1.0,
        artist: "Mira Holt",
        musicBrainzTrackId: "44444444-4444-4444-8444-444444444444",
      },
      {
        title: "Poolside Thread",
        track: 2,
        durationSec: 1.3,
        artist: "June Pixel",
        musicBrainzTrackId: "44444444-4444-4444-8444-444444444445",
      },
    ],
  },
  {
    artist: "Quartz Bloom",
    album: "Fractal Hearts",
    albumArtist: "Quartz Bloom",
    year: 2023,
    genre: "Electronic",
    composer: "Q. Bloom",
    comment: "Set A - Album 5",
    disc: 1,
    compilation: false,
    musicBrainzAlbumId: "55555555-5555-4555-8555-555555555551",
    musicBrainzArtistId: "55555555-5555-4555-8555-555555555552",
    musicBrainzReleaseGroupId: "55555555-5555-4555-8555-555555555553",
    songs: [
      {
        title: "Hex Bloom",
        track: 1,
        durationSec: 1.2,
        musicBrainzTrackId: "55555555-5555-4555-8555-555555555554",
      },
      {
        title: "Vector Pulse",
        track: 2,
        durationSec: 1.2,
        musicBrainzTrackId: "55555555-5555-4555-8555-555555555555",
      },
      {
        title: "Ribbon Loop",
        track: 3,
        durationSec: 1.3,
        musicBrainzTrackId: "55555555-5555-4555-8555-555555555556",
      },
    ],
  },
];

export const SYNC_BENCHMARK_ARTIST_COUNT = 250;
export const SYNC_BENCHMARK_ALBUM_COUNT = 1_000;
export const SYNC_BENCHMARK_SONGS_PER_ALBUM = 10;
export const SYNC_BENCHMARK_SONG_COUNT =
  SYNC_BENCHMARK_ALBUM_COUNT * SYNC_BENCHMARK_SONGS_PER_ALBUM;

const benchmarkGenres = [
  "Ambient",
  "Electronic",
  "Indie",
  "Jazz",
  "Pop",
  "Rock",
] as const;

function padNumber(value: number, width: number): string {
  return String(value).padStart(width, "0");
}

function createFixtureUuid(seed: number): string {
  const hex = seed.toString(16).padStart(32, "0");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

export function buildSyncBenchmarkLibrary(): AlbumFixture[] {
  return Array.from({ length: SYNC_BENCHMARK_ALBUM_COUNT }, (_, albumIndex) => {
    const artistIndex = albumIndex % SYNC_BENCHMARK_ARTIST_COUNT;
    const artistNumber = artistIndex + 1;
    const albumNumber = albumIndex + 1;
    const genre = benchmarkGenres[albumIndex % benchmarkGenres.length] ?? benchmarkGenres[0];

    return {
      artist: `Benchmark Artist ${padNumber(artistNumber, 3)}`,
      album: `Benchmark Album ${padNumber(albumNumber, 4)}`,
      albumArtist: `Benchmark Artist ${padNumber(artistNumber, 3)}`,
      year: 2000 + (albumIndex % 25),
      genre,
      composer: `Benchmark Composer ${padNumber((artistIndex % 50) + 1, 2)}`,
      comment: `Sync benchmark fixture album ${padNumber(albumNumber, 4)}`,
      disc: 1,
      compilation: false,
      musicBrainzAlbumId: createFixtureUuid(1_000_000 + albumIndex),
      musicBrainzArtistId: createFixtureUuid(2_000_000 + artistIndex),
      musicBrainzReleaseGroupId: createFixtureUuid(3_000_000 + albumIndex),
      songs: Array.from({ length: SYNC_BENCHMARK_SONGS_PER_ALBUM }, (_, songIndex) => {
        const trackNumber = songIndex + 1;
        const globalSongIndex = albumIndex * SYNC_BENCHMARK_SONGS_PER_ALBUM + songIndex;

        return {
          title: `Benchmark Song ${padNumber(albumNumber, 4)}-${padNumber(trackNumber, 2)}`,
          track: trackNumber,
          durationSec: 1,
          musicBrainzTrackId: createFixtureUuid(4_000_000 + globalSongIndex),
        };
      }),
    };
  });
}

export const librarySetB: AlbumFixture[] = [
  {
    artist: "Polar Grid",
    album: "Midnight Tides",
    albumArtist: "Polar Grid",
    year: 2024,
    genre: "Ambient",
    composer: "P. Grid",
    comment: "Set B - Album 1",
    disc: 1,
    compilation: false,
    musicBrainzAlbumId: "66666666-6666-4666-8666-666666666661",
    musicBrainzArtistId: "66666666-6666-4666-8666-666666666662",
    musicBrainzReleaseGroupId: "66666666-6666-4666-8666-666666666663",
    songs: [
      {
        title: "North Arc",
        track: 1,
        durationSec: 1.1,
        musicBrainzTrackId: "66666666-6666-4666-8666-666666666664",
      },
      {
        title: "Frozen Wake",
        track: 2,
        durationSec: 1.4,
        musicBrainzTrackId: "66666666-6666-4666-8666-666666666665",
      },
    ],
  },
  {
    artist: "Signal Cartel",
    album: "Burned Maps",
    albumArtist: "Signal Cartel",
    year: 2018,
    genre: "Alternative",
    composer: "S. Cartel",
    comment: "Set B - Album 2",
    disc: 1,
    compilation: false,
    musicBrainzAlbumId: "77777777-7777-4777-8777-777777777771",
    musicBrainzArtistId: "77777777-7777-4777-8777-777777777772",
    musicBrainzReleaseGroupId: "77777777-7777-4777-8777-777777777773",
    songs: [
      {
        title: "Coal Streets",
        track: 1,
        durationSec: 1.2,
        musicBrainzTrackId: "77777777-7777-4777-8777-777777777774",
      },
    ],
  },
  {
    artist: "Glass Forest",
    album: "Helix Bloom",
    albumArtist: "Glass Forest",
    year: 2022,
    genre: "Downtempo",
    composer: "G. Forest",
    comment: "Set B - Album 3",
    disc: 1,
    compilation: false,
    musicBrainzAlbumId: "88888888-8888-4888-8888-888888888881",
    musicBrainzArtistId: "88888888-8888-4888-8888-888888888882",
    musicBrainzReleaseGroupId: "88888888-8888-4888-8888-888888888883",
    songs: [
      {
        title: "Slow Prism",
        track: 1,
        durationSec: 1.0,
        musicBrainzTrackId: "88888888-8888-4888-8888-888888888884",
      },
      {
        title: "Moss Array",
        track: 2,
        durationSec: 1.3,
        musicBrainzTrackId: "88888888-8888-4888-8888-888888888885",
      },
      {
        title: "Final Lens",
        track: 3,
        durationSec: 1.5,
        musicBrainzTrackId: "88888888-8888-4888-8888-888888888886",
      },
    ],
  },
  {
    artist: "Mono River",
    album: "Soft Engines",
    albumArtist: "Mono River",
    year: 2020,
    genre: "Folk",
    composer: "M. River",
    comment: "Set B - Album 4",
    disc: 1,
    compilation: false,
    musicBrainzAlbumId: "99999999-9999-4999-8999-999999999991",
    musicBrainzArtistId: "99999999-9999-4999-8999-999999999992",
    musicBrainzReleaseGroupId: "99999999-9999-4999-8999-999999999993",
    songs: [
      {
        title: "Satin Static",
        track: 1,
        durationSec: 1.1,
        musicBrainzTrackId: "99999999-9999-4999-8999-999999999994",
      },
    ],
  },
  {
    artist: "Night Courier",
    album: "Paper Satellites",
    albumArtist: "Night Courier",
    year: 2025,
    genre: "Indietronica",
    composer: "N. Courier",
    comment: "Set B - Album 5",
    disc: 1,
    compilation: false,
    musicBrainzAlbumId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1",
    musicBrainzArtistId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa2",
    musicBrainzReleaseGroupId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa3",
    songs: [
      {
        title: "Transit Fold",
        track: 1,
        durationSec: 1.1,
        musicBrainzTrackId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa4",
      },
      {
        title: "Postal Glow",
        track: 2,
        durationSec: 1.2,
        musicBrainzTrackId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa5",
      },
    ],
  },
];
