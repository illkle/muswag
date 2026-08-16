import { Context, Effect, Layer, Schema } from "effect";
import { HttpClient, HttpClientError, HttpClientRequest, HttpClientResponse } from "effect/unstable/http";
import {
  type AlbumList2,
  type AlbumWithSongsID3,
  type CreatePlaylistArgs,
  type DeletePlaylistArgs,
  type GetAlbumArgs,
  type GetAlbumList2Args,
  type GetCoverArtArgs,
  type GetIndexesArgs,
  type GetPlaylistArgs,
  type Indexes,
  type PlaylistWithSongs,
  type Playlists,
  SubsonicApiError,
  type SubsonicBaseResponse,
  SubsonicConfigError,
  SubsonicDecodeError,
  SubsonicHttpError,
  type UpdatePlaylistArgs,
  baseResponseSchema,
  createPlaylistResponseSchema,
  getAlbumList2ResponseSchema,
  getAlbumResponseSchema,
  getIndexesResponseSchema,
  getPlaylistResponseSchema,
  getPlaylistsResponseSchema,
  pingResponseSchema,
  responseEnvelopeSchema,
} from "./schema.js";

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
}

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

export default class SubsonicAPI extends Context.Service<SubsonicAPI, SubsonicApiService>()("@muswag/subsonic-api/SubsonicAPI") {}

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

export const SubsonicAPILive = (config: SubsonicConfig) =>
  Layer.effect(
    SubsonicAPI,
    Effect.gen(function* () {
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
              t: yield* crypto.md5(config.auth.password! + crypto.cachedSaltGenerator()),
              s: s,
            });
          }

          return url;
        });

      const request = (method: string, params: RequestParams) =>
        Effect.gen(function* () {
          const url = yield* requestUrl(method, params);
          const outgoing = HttpClientRequest.post(new URL(url.pathname, url.origin)).pipe(HttpClientRequest.bodyUrlParams(url.searchParams));

          const response = yield* Effect.retry(httpClient.execute(outgoing), { times: 2 });
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
    }),
  );

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
