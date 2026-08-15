import { Context, Data, Effect, Layer, Schema } from "effect";
import { FetchHttpClient, HttpClient, HttpClientError, HttpClientRequest, HttpClientResponse } from "effect/unstable/http";

const API_VERSION = "1.16.1";
const CLIENT_NAME = "muswag";

type RequestParams = Record<string, string | number | boolean | Array<string | number | boolean> | null | undefined>;

export interface SubsonicConfig {
  url: string;
  auth:
    | {
        username: string;
        password: string;
        apiKey?: never;
      }
    | {
        username?: never;
        password?: never;
        apiKey: string;
      };
  salt?: string;
  reuseSalt?: boolean;
  post?: boolean;
}

const subsonicErrorSchema = Schema.Struct({
  code: Schema.Finite,
  message: Schema.optional(Schema.String),
  helpUrl: Schema.optional(Schema.String),
});

const baseResponseSchema = Schema.Struct({
  status: Schema.String,
  version: Schema.String,
  openSubsonic: Schema.optional(Schema.Boolean),
  type: Schema.optional(Schema.String),
  serverVersion: Schema.optional(Schema.String),
  error: Schema.optional(subsonicErrorSchema),
});

const itemGenreSchema = Schema.Struct({
  name: Schema.String,
});

const itemDateSchema = Schema.Struct({
  year: Schema.optional(Schema.Finite),
  month: Schema.optional(Schema.Finite),
  day: Schema.optional(Schema.Finite),
});

const recordLabelSchema = Schema.Struct({
  name: Schema.String,
});

const discTitleSchema = Schema.Struct({
  disc: Schema.Finite,
  title: Schema.String,
});

const artistID3Schema = Schema.Struct({
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

const contributorSchema = Schema.Struct({
  role: Schema.String,
  subRole: Schema.optional(Schema.String),
  artist: Schema.optional(artistID3Schema),
});

const replayGainSchema = Schema.Struct({
  trackGain: Schema.optional(Schema.Finite),
  albumGain: Schema.optional(Schema.Finite),
  trackPeak: Schema.optional(Schema.Finite),
  albumPeak: Schema.optional(Schema.Finite),
  baseGain: Schema.optional(Schema.Finite),
  fallbackGain: Schema.optional(Schema.Finite),
});

const childSchema = Schema.Struct({
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

const albumID3Schema = Schema.Struct({
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

const albumWithSongsID3Schema = Schema.Struct({
  ...albumID3Schema.fields,
  song: Schema.optional(Schema.Array(childSchema)),
});

const albumList2Schema = Schema.Struct({
  album: Schema.optional(Schema.Array(albumID3Schema)),
});

const indexArtistSchema = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  starred: Schema.optional(Schema.String),
  userRating: Schema.optional(Schema.Finite),
  averageRating: Schema.optional(Schema.Finite),
  coverArt: Schema.optional(Schema.String),
  artistImageUrl: Schema.optional(Schema.String),
});

const indexSchema = Schema.Struct({
  name: Schema.String,
  artist: Schema.optional(Schema.Array(indexArtistSchema)),
});

const indexesSchema = Schema.Struct({
  index: Schema.optional(Schema.Array(indexSchema)),
  lastModified: Schema.Finite,
  ignoredArticles: Schema.optional(Schema.String),
});

const playlistSchema = Schema.Struct({
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

const playlistWithSongsSchema = Schema.Struct({
  ...playlistSchema.fields,
  entry: Schema.optional(Schema.Array(childSchema)),
});

const playlistsSchema = Schema.Struct({
  playlist: Schema.optional(Schema.Array(playlistSchema)),
});

const pingResponseSchema = Schema.Struct({});
const getAlbumResponseSchema = Schema.Struct({
  album: albumWithSongsID3Schema,
});
const getAlbumList2ResponseSchema = Schema.Struct({
  albumList2: albumList2Schema,
});
const getIndexesResponseSchema = Schema.Struct({
  indexes: indexesSchema,
});
const getPlaylistsResponseSchema = Schema.Struct({
  playlists: playlistsSchema,
});
const getPlaylistResponseSchema = Schema.Struct({
  playlist: playlistWithSongsSchema,
});
const createPlaylistResponseSchema = Schema.Struct({
  playlist: playlistWithSongsSchema,
});

const responseEnvelopeSchema = Schema.Struct({
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

export interface SubsonicCryptoService {
  readonly md5: (input: string) => Effect.Effect<string>;
  readonly cachedSaltGenerator: () => string;
}

/** Cryptography required by Subsonic token authentication. */
export class SubsonicCrypto extends Context.Service<SubsonicCrypto, SubsonicCryptoService>()("@muswag/subsonic-api/SubsonicCrypto") {}

export type SubsonicClientError = HttpClientError.HttpClientError | SubsonicHttpError | SubsonicDecodeError | SubsonicApiError;

export interface SubsonicApiService {
  readonly baseUrl: URL;
  readonly ping: Effect.Effect<SubsonicBaseResponse, SubsonicClientError>;
  readonly getAlbum: (args: GetAlbumArgs) => Effect.Effect<SubsonicBaseResponse & { album: AlbumWithSongsID3 }, SubsonicClientError>;
  readonly getAlbumList2: (args: GetAlbumList2Args) => Effect.Effect<SubsonicBaseResponse & { albumList2: AlbumList2 }, SubsonicClientError>;
  readonly getIndexes: (args?: GetIndexesArgs) => Effect.Effect<SubsonicBaseResponse & { indexes: Indexes }, SubsonicClientError>;
  readonly getCoverArt: (args: GetCoverArtArgs) => Effect.Effect<HttpClientResponse.HttpClientResponse, HttpClientError.HttpClientError | SubsonicHttpError>;
  readonly getPlaylists: Effect.Effect<SubsonicBaseResponse & { playlists: Playlists }, SubsonicClientError>;
  readonly getPlaylist: (args: GetPlaylistArgs) => Effect.Effect<SubsonicBaseResponse & { playlist: PlaylistWithSongs }, SubsonicClientError>;
  readonly createPlaylist: (args: CreatePlaylistArgs) => Effect.Effect<SubsonicBaseResponse & { playlist: PlaylistWithSongs }, SubsonicClientError>;
  readonly updatePlaylist: (args: UpdatePlaylistArgs) => Effect.Effect<SubsonicBaseResponse, SubsonicClientError>;
  readonly deletePlaylist: (args: DeletePlaylistArgs) => Effect.Effect<SubsonicBaseResponse, SubsonicClientError>;
}

/** Effect service for the Subsonic REST API. */
export default class SubsonicAPI extends Context.Service<SubsonicAPI, SubsonicApiService>()("@muswag/subsonic-api/SubsonicAPI") {
  static make(config: SubsonicConfig): Effect.Effect<SubsonicApiService, SubsonicConfigError, HttpClient.HttpClient | SubsonicCrypto> {
    return make(config);
  }

  static layer(config: SubsonicConfig): Layer.Layer<SubsonicAPI, SubsonicConfigError, HttpClient.HttpClient | SubsonicCrypto> {
    return Layer.effect(this, make(config));
  }

  static layerFetch(config: SubsonicConfig): Layer.Layer<SubsonicAPI, SubsonicConfigError, SubsonicCrypto> {
    return this.layer(config).pipe(Layer.provide(FetchHttpClient.layer));
  }
}

function normalizeRestUrl(rawUrl: string): URL {
  let value = rawUrl;
  if (!/^https?:\/\//i.test(value)) value = `https://${value}`;
  if (!value.endsWith("/")) value += "/";
  if (!value.endsWith("rest/")) value += "rest/";
  return new URL(value);
}

function validateConfig(config: SubsonicConfig): URL {
  if (!config) throw new Error("no config provided");
  if (!config.url) throw new Error("no url provided");
  if (!config.auth) throw new Error("no auth provided");
  if (!("apiKey" in config.auth) || !config.auth.apiKey) {
    if (!config.auth.username) throw new Error("no username provided");
    if (!config.auth.password) throw new Error("no password provided");
  }
  return normalizeRestUrl(config.url);
}

function parseResponse<T extends Schema.Struct<Schema.Struct.Fields>>(
  method: string,
  payloadSchema: T,
  payload: unknown,
): Effect.Effect<SubsonicBaseResponse & T["Type"], SubsonicDecodeError | SubsonicApiError> {
  return Effect.gen(function* () {
    const envelope = yield* Schema.decodeUnknownEffect(responseEnvelopeSchema)(payload).pipe(
      Effect.mapError((cause) => new SubsonicDecodeError({ method, message: `${method} returned an invalid response envelope`, cause })),
    );
    const response = yield* Schema.decodeUnknownEffect(baseResponseSchema)(envelope["subsonic-response"]).pipe(
      Effect.mapError((cause) => new SubsonicDecodeError({ method, message: `${method} returned invalid Subsonic metadata`, cause })),
    );

    if (response.status !== "ok") {
      return yield* new SubsonicApiError({
        method,
        ...(response.error?.code === undefined ? {} : { code: response.error.code }),
        ...(response.error?.helpUrl === undefined ? {} : { helpUrl: response.error.helpUrl }),
        message: response.error?.message ?? `${method} failed: Subsonic status ${response.status}`,
      });
    }

    const responseSchema = Schema.Struct({ ...baseResponseSchema.fields, ...payloadSchema.fields });
    return (yield* Schema.decodeUnknownEffect(responseSchema)(envelope["subsonic-response"]).pipe(
      Effect.mapError((cause) => new SubsonicDecodeError({ method, message: `${method} returned an invalid payload`, cause })),
    )) as SubsonicBaseResponse & T["Type"];
  });
}

export function make(config: SubsonicConfig): Effect.Effect<SubsonicApiService, SubsonicConfigError, HttpClient.HttpClient | SubsonicCrypto> {
  return Effect.gen(function* () {
    const baseUrl = yield* Effect.try({
      try: () => validateConfig(config),
      catch: (cause) => new SubsonicConfigError({ message: cause instanceof Error ? cause.message : "invalid Subsonic configuration", cause }),
    });
    const httpClient = yield* HttpClient.HttpClient;
    const crypto = yield* SubsonicCrypto;

    const requestUrl = (method: string, params: RequestParams): Effect.Effect<URL> =>
      Effect.gen(function* () {
        const url = new URL(`${method}.view`, baseUrl);
        setSearchParams(url, {
          v: API_VERSION,
          c: CLIENT_NAME,
          f: "json",
          ...params,
        });

        if (config.auth.apiKey) {
          url.searchParams.set("apiKey", config.auth.apiKey);
        } else {
          const s = crypto.cachedSaltGenerator();

          setSearchParams(url, {
            u: config.auth.username,
            t: yield* crypto.md5(config.auth.password! + s),
            s: s,
          });
        }

        return url;
      });

    const request = (method: string, params: RequestParams) =>
      Effect.gen(function* () {
        const url = yield* requestUrl(method, params);
        const outgoing = config.post
          ? HttpClientRequest.post(new URL(url.pathname, url.origin)).pipe(HttpClientRequest.bodyUrlParams(url.searchParams))
          : HttpClientRequest.get(url, { accept: "application/json" });

        // Subsonic credentials are query/body parameters, so the default HTTP span
        // would expose them as url.query. The endpoint-level Effect span is safe.
        const response = yield* httpClient.execute(outgoing).pipe(Effect.provideService(HttpClient.TracerDisabledWhen, () => true));
        if (response.status < 200 || response.status >= 300) {
          return yield* new SubsonicHttpError({ method, status: response.status, message: `${method} failed: HTTP ${response.status}` });
        }
        return response;
      });

    const json = <T extends Schema.Struct<Schema.Struct.Fields>>(method: string, params: RequestParams, schema: T) =>
      Effect.gen(function* () {
        const response = yield* request(method, params);
        const payload = yield* response.json;
        return yield* parseResponse(method, schema, payload);
      }).pipe(Effect.withSpan(`SubsonicAPI.${method}`));

    return {
      baseUrl,
      ping: json("ping", {}, pingResponseSchema),
      getAlbum: (args) => json("getAlbum", args, getAlbumResponseSchema),
      getAlbumList2: (args) => json("getAlbumList2", args, getAlbumList2ResponseSchema),
      getIndexes: (args = {}) => json("getIndexes", args, getIndexesResponseSchema),
      getCoverArt: (args) => request("getCoverArt", args).pipe(Effect.withSpan("SubsonicAPI.getCoverArt")),
      getPlaylists: json("getPlaylists", {}, getPlaylistsResponseSchema),
      getPlaylist: (args) => json("getPlaylist", args, getPlaylistResponseSchema),
      createPlaylist: (args) => json("createPlaylist", args, createPlaylistResponseSchema),
      updatePlaylist: (args) => json("updatePlaylist", args, pingResponseSchema),
      deletePlaylist: (args) => json("deletePlaylist", args, pingResponseSchema),
    };
  });
}

export const layer = (config: SubsonicConfig) => SubsonicAPI.layer(config);
export const layerFetch = (config: SubsonicConfig) => SubsonicAPI.layerFetch(config);

const setSearchParams = (url: URL, map: Record<string, unknown>) => {
  for (const [k, v] of Object.entries(map)) {
    if (v === null || v === undefined) {
      continue;
    }

    if (Array.isArray(v)) {
      for (const item of v) {
        url.searchParams.append(k, String(item));
      }
    }

    url.searchParams.set(k, String(v));
  }
};
