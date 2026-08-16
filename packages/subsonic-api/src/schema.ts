import { Data, Schema } from "effect";

export const subsonicErrorSchema = Schema.Struct({
  code: Schema.Finite,
  message: Schema.optional(Schema.String),
  helpUrl: Schema.optional(Schema.String),
});

export const baseResponseSchema = Schema.Struct({
  status: Schema.String,
  version: Schema.String,
  openSubsonic: Schema.optional(Schema.Boolean),
  type: Schema.optional(Schema.String),
  serverVersion: Schema.optional(Schema.String),
  error: Schema.optional(subsonicErrorSchema),
});

export const itemGenreSchema = Schema.Struct({
  name: Schema.String,
});

export const itemDateSchema = Schema.Struct({
  year: Schema.optional(Schema.Finite),
  month: Schema.optional(Schema.Finite),
  day: Schema.optional(Schema.Finite),
});

export const recordLabelSchema = Schema.Struct({
  name: Schema.String,
});

export const discTitleSchema = Schema.Struct({
  disc: Schema.Finite,
  title: Schema.String,
});

export const artistID3Schema = Schema.Struct({
  albumCount: Schema.optional(Schema.Finite),
  artistImageUrl: Schema.optional(Schema.String),
  coverArt: Schema.optional(Schema.String),
  id: Schema.String,
  name: Schema.String,
  starred: Schema.optional(Schema.String),
  musicBrainzId: Schema.optional(Schema.String),
  sortName: Schema.optional(Schema.String),
  roles: Schema.optional(Schema.Array(Schema.String)),
});

export const contributorSchema = Schema.Struct({
  role: Schema.String,
  subRole: Schema.optional(Schema.String),
  artist: Schema.optional(artistID3Schema),
});

export const replayGainSchema = Schema.Struct({
  trackGain: Schema.optional(Schema.Finite),
  albumGain: Schema.optional(Schema.Finite),
  trackPeak: Schema.optional(Schema.Finite),
  albumPeak: Schema.optional(Schema.Finite),
  baseGain: Schema.optional(Schema.Finite),
  fallbackGain: Schema.optional(Schema.Finite),
});

export const childSchema = Schema.Struct({
  album: Schema.optional(Schema.String),
  albumId: Schema.optional(Schema.String),
  artist: Schema.optional(Schema.String),
  artistId: Schema.optional(Schema.String),
  averageRating: Schema.optional(Schema.Finite),
  bitRate: Schema.optional(Schema.Finite),
  bookmarkPosition: Schema.optional(Schema.Finite),
  contentType: Schema.optional(Schema.String),
  coverArt: Schema.optional(Schema.String),
  created: Schema.optional(Schema.String),
  discNumber: Schema.optional(Schema.Finite),
  duration: Schema.optional(Schema.Finite),
  genre: Schema.optional(Schema.String),
  id: Schema.String,
  isDir: Schema.Boolean,
  isVideo: Schema.optional(Schema.Boolean),
  originalHeight: Schema.optional(Schema.Finite),
  originalWidth: Schema.optional(Schema.Finite),
  parent: Schema.optional(Schema.String),
  path: Schema.optional(Schema.String),
  playCount: Schema.optional(Schema.Finite),
  size: Schema.optional(Schema.Finite),
  starred: Schema.optional(Schema.String),
  suffix: Schema.optional(Schema.String),
  title: Schema.String,
  track: Schema.optional(Schema.Finite),
  transcodedContentType: Schema.optional(Schema.String),
  transcodedSuffix: Schema.optional(Schema.String),
  type: Schema.optional(Schema.Literals(["music", "podcast", "audiobook", "video"])),
  userRating: Schema.optional(Schema.Finite),
  year: Schema.optional(Schema.Finite),
  played: Schema.optional(Schema.String),
  bpm: Schema.optional(Schema.Finite),
  comment: Schema.optional(Schema.String),
  sortName: Schema.optional(Schema.String),
  musicBrainzId: Schema.optional(Schema.String),
  genres: Schema.optional(Schema.Array(itemGenreSchema)),
  artists: Schema.optional(Schema.Array(artistID3Schema)),
  displayArtist: Schema.optional(Schema.String),
  albumArtists: Schema.optional(Schema.Array(artistID3Schema)),
  displayAlbumArtist: Schema.optional(Schema.String),
  contributors: Schema.optional(Schema.Array(contributorSchema)),
  displayComposer: Schema.optional(Schema.String),
  moods: Schema.optional(Schema.Array(Schema.String)),
  replayGain: Schema.optional(replayGainSchema),
  explicitStatus: Schema.optional(Schema.String),
});

export const albumID3Schema = Schema.Struct({
  artist: Schema.optional(Schema.String),
  artistId: Schema.optional(Schema.String),
  coverArt: Schema.optional(Schema.String),
  created: Schema.String,
  duration: Schema.Finite,
  genre: Schema.optional(Schema.String),
  id: Schema.String,
  name: Schema.String,
  playCount: Schema.optional(Schema.Finite),
  songCount: Schema.Finite,
  starred: Schema.optional(Schema.String),
  year: Schema.optional(Schema.Finite),
  version: Schema.optional(Schema.String),
  played: Schema.optional(Schema.String),
  userRating: Schema.optional(Schema.Finite),
  recordLabels: Schema.optional(Schema.Array(recordLabelSchema)),
  musicBrainzId: Schema.optional(Schema.String),
  genres: Schema.optional(Schema.Array(itemGenreSchema)),
  artists: Schema.optional(Schema.Array(artistID3Schema)),
  displayArtist: Schema.optional(Schema.String),
  releaseTypes: Schema.optional(Schema.Array(Schema.String)),
  moods: Schema.optional(Schema.Array(Schema.String)),
  sortName: Schema.optional(Schema.String),
  originalReleaseDate: Schema.optional(itemDateSchema),
  releaseDate: Schema.optional(itemDateSchema),
  isCompilation: Schema.optional(Schema.Boolean),
  explicitStatus: Schema.optional(Schema.String),
  discTitles: Schema.optional(Schema.Array(discTitleSchema)),
});

export const albumWithSongsID3Schema = Schema.Struct({
  ...albumID3Schema.fields,
  song: Schema.optional(Schema.Array(childSchema)),
});

export const albumList2Schema = Schema.Struct({
  album: Schema.optional(Schema.Array(albumID3Schema)),
});

export const indexArtistSchema = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  starred: Schema.optional(Schema.String),
  userRating: Schema.optional(Schema.Finite),
  averageRating: Schema.optional(Schema.Finite),
  coverArt: Schema.optional(Schema.String),
  artistImageUrl: Schema.optional(Schema.String),
});

export const indexSchema = Schema.Struct({
  name: Schema.String,
  artist: Schema.optional(Schema.Array(indexArtistSchema)),
});

export const indexesSchema = Schema.Struct({
  index: Schema.optional(Schema.Array(indexSchema)),
  lastModified: Schema.Finite,
  ignoredArticles: Schema.optional(Schema.String),
});

export const playlistSchema = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  comment: Schema.optional(Schema.String),
  owner: Schema.optional(Schema.String),
  public: Schema.optional(Schema.Boolean),
  songCount: Schema.Finite,
  duration: Schema.Finite,
  created: Schema.String,
  changed: Schema.String,
  coverArt: Schema.optional(Schema.String),
  allowedUser: Schema.optional(Schema.Array(Schema.String)),
  readonly: Schema.optional(Schema.Boolean),
  validUntil: Schema.optional(Schema.String),
});

export const playlistWithSongsSchema = Schema.Struct({
  ...playlistSchema.fields,
  entry: Schema.optional(Schema.Array(childSchema)),
});

export const playlistsSchema = Schema.Struct({
  playlist: Schema.optional(Schema.Array(playlistSchema)),
});

export const pingResponseSchema = Schema.Struct({});
export const getAlbumResponseSchema = Schema.Struct({
  album: albumWithSongsID3Schema,
});
export const getAlbumList2ResponseSchema = Schema.Struct({
  albumList2: albumList2Schema,
});
export const getIndexesResponseSchema = Schema.Struct({
  indexes: indexesSchema,
});
export const getPlaylistsResponseSchema = Schema.Struct({
  playlists: playlistsSchema,
});
export const getPlaylistResponseSchema = Schema.Struct({
  playlist: playlistWithSongsSchema,
});
export const createPlaylistResponseSchema = Schema.Struct({
  playlist: playlistWithSongsSchema,
});

export const responseEnvelopeSchema = Schema.Struct({
  "subsonic-response": Schema.Unknown,
});

export type SubsonicBaseResponse = typeof baseResponseSchema.Type;
export type SubsonicError = typeof subsonicErrorSchema.Type;
export type ItemGenre = typeof itemGenreSchema.Type;
export type ItemDate = typeof itemDateSchema.Type;
export type RecordLabel = typeof recordLabelSchema.Type;
export type DiscTitle = typeof discTitleSchema.Type;
export type ArtistID3 = typeof artistID3Schema.Type;
export type Contributor = typeof contributorSchema.Type;
export type ReplayGain = typeof replayGainSchema.Type;
export type MediaType = "music" | "podcast" | "audiobook" | "video";
export type Child = typeof childSchema.Type;
export type AlbumID3 = typeof albumID3Schema.Type;
export type AlbumWithSongsID3 = typeof albumWithSongsID3Schema.Type;
export type AlbumList2 = typeof albumList2Schema.Type;
export type IndexArtist = typeof indexArtistSchema.Type;
export type SubsonicIndex = typeof indexSchema.Type;
export type Indexes = typeof indexesSchema.Type;
export type Playlist = typeof playlistSchema.Type;
export type PlaylistWithSongs = typeof playlistWithSongsSchema.Type;
export type Playlists = typeof playlistsSchema.Type;

export type GetAlbumList2Args = {
  type: "alphabeticalByName" | "alphabeticalByArtist" | "byYear" | "random" | "newest" | "highest" | "frequent" | "recent";
  size?: number;
  offset?: number;
  fromYear?: number;
  toYear?: number;
  genre?: string;
  musicFolderId?: string | number;
};

export type GetAlbumArgs = {
  id: string;
};

export type GetIndexesArgs = {
  musicFolderId?: string | number;
  ifModifiedSince?: number;
};

export type GetCoverArtArgs = {
  id: string;
  size?: number;
};

export type GetPlaylistArgs = {
  id: string;
};

export type CreatePlaylistArgs = {
  playlistId?: string;
  name?: string;
  songId?: string[];
};

export type UpdatePlaylistArgs = {
  playlistId: string;
  name?: string;
  comment?: string;
  public?: boolean;
  songIdToAdd?: string[];
  songIndexToRemove?: number[];
};

export type DeletePlaylistArgs = {
  id: string;
};

export class SubsonicConfigError extends Data.TaggedError("SubsonicConfigError")<{
  readonly message: string;
  readonly cause?: unknown;
}> {}

export class SubsonicHttpError extends Data.TaggedError("SubsonicHttpError")<{
  readonly method: string;
  readonly status: number;
  readonly message: string;
}> {}

export class SubsonicDecodeError extends Data.TaggedError("SubsonicDecodeError")<{
  readonly method: string;
  readonly message: string;
  readonly cause: unknown;
}> {}

export class SubsonicApiError extends Data.TaggedError("SubsonicApiError")<{
  readonly method: string;
  readonly code?: number;
  readonly helpUrl?: string;
  readonly message: string;
}> {}
