export type ItemDate = {
  year?: number | undefined;
  month?: number | undefined;
  day?: number | undefined;
};

export interface ArtistInfo {
  id: string;
  name: string;
  coverArt: string | null;
  artistImageUrl: string | null;
  albumCount: number | null;
  starred: string | null;
  musicBrainzId: string | null;
  sortName: string | null;
  roles: string[];
}

export interface ContributorInfo {
  role: string;
  subRole: string | null;
  artistId: string | null;
  artistName: string | null;
  coverArt: string | null;
  artistImageUrl: string | null;
  albumCount: number | null;
  starred: string | null;
  musicBrainzId: string | null;
  sortName: string | null;
}

export interface ReplayGainInfo {
  trackGain: number | null;
  albumGain: number | null;
  trackPeak: number | null;
  albumPeak: number | null;
  baseGain: number | null;
  fallbackGain: number | null;
}

/**
 * Denormalized album record stored in the albums collection.
 * Contains all nested metadata that was previously in separate relational tables.
 */
export interface Album {
  id: string;
  name: string;
  version: string | null;
  artist: string | null;
  artistId: string | null;
  coverArt: string | null;
  coverArtPath: string | null;
  songCount: number;
  duration: number;
  playCount: number | null;
  created: string;
  starred: string | null;
  year: number | null;
  genre: string | null;
  played: string | null;
  userRating: number | null;
  musicBrainzId: string | null;
  displayArtist: string | null;
  sortName: string | null;
  originalReleaseDate: ItemDate | null;
  releaseDate: ItemDate | null;
  isCompilation: boolean | null;
  explicitStatus: string | null;
  recordLabels: Array<{ name: string }>;
  genres: Array<{ value: string }>;
  artists: ArtistInfo[];
  releaseTypes: Array<{ value: string }>;
  moods: Array<{ value: string }>;
  discTitles: Array<{ disc: number; title: string }>;
}

/**
 * Denormalized song record stored in the songs collection.
 * Contains all nested metadata that was previously in separate relational tables.
 */
export interface Song {
  id: string;
  album: string;
  albumId: string;
  artist: string | null;
  artistId: string | null;
  averageRating: number | null;
  bitRate: number | null;
  bookmarkPosition: number | null;
  contentType: string | null;
  coverArt: string | null;
  created: string | null;
  discNumber: number | null;
  duration: number | null;
  genre: string | null;
  isDir: boolean;
  isVideo: boolean | null;
  originalHeight: number | null;
  originalWidth: number | null;
  parent: string | null;
  path: string | null;
  playCount: number | null;
  size: number | null;
  starred: string | null;
  suffix: string | null;
  title: string;
  track: number | null;
  transcodedContentType: string | null;
  transcodedSuffix: string | null;
  type: string | null;
  userRating: number | null;
  year: number | null;
  played: string | null;
  bpm: number | null;
  comment: string | null;
  sortName: string | null;
  musicBrainzId: string | null;
  displayArtist: string | null;
  displayAlbumArtist: string | null;
  displayComposer: string | null;
  explicitStatus: string | null;
  genres: Array<{ value: string }>;
  artists: ArtistInfo[];
  albumArtists: ArtistInfo[];
  contributors: ContributorInfo[];
  moods: Array<{ value: string }>;
  replayGain: ReplayGainInfo | null;
}

export interface UserCredentials {
  id: number;
  url: string;
  username: string;
  password: string;
}

export type SyncStatus = "running" | "completed" | "failed" | "aborted";

export interface SyncRecord {
  id: string;
  timeStarted: string;
  timeEnded: string | null;
  lastStatus: SyncStatus;
  error: string | null;
}

/**
 * Flat album record without nested metadata.
 * Used for backward-compatible API responses (e.g. album list views).
 */
export type AlbumRecord = Omit<Album, "recordLabels" | "genres" | "artists" | "releaseTypes" | "moods" | "discTitles">;

/**
 * Flat song record without nested metadata.
 * Used for backward-compatible API responses (e.g. song list views).
 */
export type SongRecord = Omit<Song, "genres" | "artists" | "albumArtists" | "contributors" | "moods" | "replayGain">;

export interface AlbumDetail {
  album: AlbumRecord;
  recordLabels: Array<{ albumId: string; position: number; name: string }>;
  genres: Array<{ albumId: string; position: number; value: string }>;
  artists: Array<{
    albumId: string;
    position: number;
    id: string;
    name: string;
    coverArt: string | null;
    artistImageUrl: string | null;
    albumCount: number | null;
    starred: string | null;
    musicBrainzId: string | null;
    sortName: string | null;
  }>;
  releaseTypes: Array<{ albumId: string; position: number; value: string }>;
  moods: Array<{ albumId: string; position: number; value: string }>;
  discTitles: Array<{ albumId: string; position: number; disc: number; title: string }>;
  songs: SongRecord[];
}

export type GetSongsInput = {
  albumId?: string;
};

export type GetAlbumsResult = AlbumRecord[];
export type GetSongsResult = SongRecord[];
export type GetSongByIdResult = SongRecord | null;
export type GetAlbumDetailResult = AlbumDetail | null;
