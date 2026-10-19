export interface SongFixture {
  title: string;
  track: number;
  /** 1 when left out. */
  disc?: number;
  durationSec: number;
  /** The song's artists, the album artist when left out. */
  artists?: string[];
  replayGain?: { track: number; album: number };
  musicBrainzId?: string;
}

export interface AlbumFixture {
  title: string;
  albumArtist: string;
  year: number;
  genre: string;
  compilation?: boolean;
  /** Whether the album's folder has a cover image. It has unless this is `false`. */
  cover?: boolean;
  musicBrainzId?: string;
  songs: SongFixture[];
}

export const songCount = (albums: readonly AlbumFixture[]) => albums.reduce((total, album) => total + album.songs.length, 0);

export const librarySetA: AlbumFixture[] = [
  {
    title: "Sky Patterns",
    albumArtist: "Aurora Lane",
    year: 2022,
    genre: "Indie",
    songs: [
      { title: "Morning Grid", track: 1, durationSec: 1.2 },
      { title: "Cloud Cursor", track: 2, durationSec: 1.3 },
    ],
  },
  {
    title: "City Echoes",
    albumArtist: "Neon Harbor",
    year: 2021,
    genre: "Synthwave",
    songs: [
      { title: "Subway Sparks", track: 1, durationSec: 1.1 },
      { title: "Late Bus", track: 2, durationSec: 1.1 },
      { title: "Window Rain", track: 3, durationSec: 1.4 },
    ],
  },
  {
    title: "Dusty Roads",
    albumArtist: "The Cassettes",
    year: 2019,
    genre: "Rock",
    songs: [{ title: "Single Lantern", track: 1, durationSec: 1.2 }],
  },
  {
    title: "Summer Sampler",
    albumArtist: "Various Artists",
    year: 2020,
    genre: "Pop",
    compilation: true,
    songs: [
      { title: "Sunline", track: 1, durationSec: 1.2, artists: ["Mira Holt"] },
      { title: "Poolside Thread", track: 2, durationSec: 1.2, artists: ["June Pixel"] },
    ],
  },
];

export const librarySetB: AlbumFixture[] = [
  {
    title: "Fractal Hearts",
    albumArtist: "Quartz Bloom",
    year: 2023,
    genre: "Electronic",
    songs: [
      { title: "Hex Bloom", track: 1, durationSec: 1.1 },
      { title: "Vector Pulse", track: 2, durationSec: 1.2 },
      { title: "Ribbon Loop", track: 3, durationSec: 1.3 },
    ],
  },
  {
    title: "Midnight Tides",
    albumArtist: "Polar Grid",
    year: 2018,
    genre: "Ambient",
    songs: [
      { title: "North Arc", track: 1, durationSec: 1.4 },
      { title: "Frozen Wake", track: 2, durationSec: 1.2 },
    ],
  },
  {
    title: "Burned Maps",
    albumArtist: "Signal Cartel",
    year: 2017,
    genre: "Post-Rock",
    songs: [{ title: "Coal Streets", track: 1, durationSec: 1.5 }],
  },
  {
    title: "Helix Bloom",
    albumArtist: "Glass Forest",
    year: 2024,
    genre: "Indie",
    songs: [
      { title: "Slow Prism", track: 1, durationSec: 1.1 },
      { title: "Moss Array", track: 2, durationSec: 1.2 },
      { title: "Final Lens", track: 3, durationSec: 1.3 },
    ],
  },
  {
    title: "Soft Engines",
    albumArtist: "Mono River",
    year: 2016,
    genre: "Folk",
    songs: [{ title: "Satin Static", track: 1, durationSec: 1.2 }],
  },
];

/**
 * A library with what servers tell apart differently: ReplayGain on some songs only, a song by two
 * artists, two discs, names outside ASCII, an album without a cover and MusicBrainz identifiers.
 */
export const variedLibrary: AlbumFixture[] = [
  {
    title: "Ágætis byrjun",
    albumArtist: "Sigur Rós",
    year: 1999,
    genre: "Post-Rock",
    musicBrainzId: "5f9cc4a5-0bd7-4a49-9d6b-2b3e1c1b1f01",
    songs: [
      { title: "Svefn-g-englar", track: 1, durationSec: 2.1, replayGain: { track: -7.25, album: -6.5 }, musicBrainzId: "0a7c1f7e-6a43-4b8e-9a51-6f0d1f1b2c01" },
      { title: "Starálfur", track: 2, durationSec: 1.6 },
    ],
  },
  {
    title: "東京の夜",
    albumArtist: "夜の街",
    year: 2015,
    genre: "J-Pop",
    cover: false,
    songs: [{ title: "ネオン", track: 1, durationSec: 1.3 }],
  },
  {
    title: "Double Feature",
    albumArtist: "The Projectionists",
    year: 2010,
    genre: "Rock",
    songs: [
      { title: "Opening Reel", track: 1, disc: 1, durationSec: 1.2 },
      { title: "Intermission", track: 2, disc: 1, durationSec: 1.1 },
      { title: "Second Reel", track: 1, disc: 2, durationSec: 1.4 },
      { title: "Duet for Two", track: 2, disc: 2, durationSec: 1.2, artists: ["The Projectionists", "Ada Reel"] },
    ],
  },
];

/** Songs of a few minutes, long enough to seek in when trying the app by hand. */
export const longSongs: AlbumFixture = {
  title: "Long Player",
  albumArtist: "Slow Motion",
  year: 2001,
  genre: "Ambient",
  songs: [
    { title: "First Side", track: 1, durationSec: 240 },
    { title: "Second Side", track: 2, durationSec: 200 },
    { title: "Run-out Groove", track: 3, durationSec: 180 },
  ],
};

/** `albums` albums of `songsPerAlbum` songs each, for libraries larger than a page. */
export function largeLibrary(albums: number, songsPerAlbum: number): AlbumFixture[] {
  return Array.from({ length: albums }, (_, album) => ({
    title: `Album ${String(album + 1).padStart(4, "0")}`,
    albumArtist: `Artist ${String((album % 40) + 1).padStart(2, "0")}`,
    year: 2000 + (album % 25),
    genre: "Test",
    cover: false,
    songs: Array.from({ length: songsPerAlbum }, (_, song) => ({ title: `Song ${album + 1}.${song + 1}`, track: song + 1, durationSec: 0.3 })),
  }));
}
