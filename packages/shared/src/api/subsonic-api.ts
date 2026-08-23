import { Context, Effect, Layer, Schema } from "effect";
import { FetchHttpClient, HttpClient, HttpClientError, HttpClientRequest, HttpClientResponse } from "effect/unstable/http";
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
} from "./subsonic-api-schema.js";

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
export class SubsonicCrypto extends Context.Service<SubsonicCrypto, SubsonicCryptoService>()("@muswag/shared/SubsonicCrypto") {}

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

export interface SubsonicPromiseApi {
  readonly baseUrl: URL;
  readonly ping: () => Promise<SubsonicBaseResponse>;
  readonly getAlbum: (args: GetAlbumArgs) => Promise<SubsonicBaseResponse & { album: AlbumWithSongsID3 }>;
  readonly getAlbumList2: (args: GetAlbumList2Args) => Promise<SubsonicBaseResponse & { albumList2: AlbumList2 }>;
  readonly getIndexes: (args?: GetIndexesArgs) => Promise<SubsonicBaseResponse & { indexes: Indexes }>;
  readonly getCoverArt: (args: GetCoverArtArgs) => Promise<HttpClientResponse.HttpClientResponse>;
  readonly getPlaylists: () => Promise<SubsonicBaseResponse & { playlists: Playlists }>;
  readonly getPlaylist: (args: GetPlaylistArgs) => Promise<SubsonicBaseResponse & { playlist: PlaylistWithSongs }>;
  readonly createPlaylist: (args: CreatePlaylistArgs) => Promise<SubsonicBaseResponse & { playlist: PlaylistWithSongs }>;
  readonly updatePlaylist: (args: UpdatePlaylistArgs) => Promise<SubsonicBaseResponse>;
  readonly deletePlaylist: (args: DeletePlaylistArgs) => Promise<SubsonicBaseResponse>;
}

export class SubsonicAPI extends Context.Service<SubsonicAPI, SubsonicApiService>()("@muswag/shared/SubsonicAPI") {}

export default SubsonicAPI;

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
              t: yield* crypto.md5(config.auth.password! + s),
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

export function createSubsonicApi(config: SubsonicConfig, options: { signal?: AbortSignal } = {}): SubsonicPromiseApi {
  const baseUrl = validateConfig(config);
  const layer = SubsonicAPILive(config).pipe(
    Layer.provide(
      Layer.merge(
        FetchHttpClient.layer,
        Layer.succeed(
          SubsonicCrypto,
          SubsonicCrypto.of({
            md5: (input) => Effect.sync(() => md5(input)),
            cachedSaltGenerator: () => randomHex(16),
          }),
        ),
      ),
    ),
  );
  const run = <A, E>(use: (api: SubsonicApiService) => Effect.Effect<A, E>) =>
    Effect.runPromise(
      Effect.gen(function* () {
        return yield* use(yield* SubsonicAPI);
      }).pipe(Effect.provide(layer)),
      options.signal ? { signal: options.signal } : undefined,
    );

  return {
    baseUrl,
    ping: () => run((api) => api.ping),
    getAlbum: (args) => run((api) => api.getAlbum(args)),
    getAlbumList2: (args) => run((api) => api.getAlbumList2(args)),
    getIndexes: (args) => run((api) => api.getIndexes(args)),
    getCoverArt: (args) => run((api) => api.getCoverArt(args)),
    getPlaylists: () => run((api) => api.getPlaylists),
    getPlaylist: (args) => run((api) => api.getPlaylist(args)),
    createPlaylist: (args) => run((api) => api.createPlaylist(args)),
    updatePlaylist: (args) => run((api) => api.updatePlaylist(args)),
    deletePlaylist: (args) => run((api) => api.deletePlaylist(args)),
  };
}

function rotateLeft(value: number, shift: number): number {
  return (value << shift) | (value >>> (32 - shift));
}

function add32(...values: number[]): number {
  return values.reduce((sum, value) => (sum + value) >>> 0, 0);
}

function md5(input: string): string {
  const message = new TextEncoder().encode(input);
  const bitLength = message.length * 8;
  const paddedLength = (((message.length + 8) >>> 6) + 1) << 6;
  const padded = new Uint8Array(paddedLength);
  padded.set(message);
  padded[message.length] = 0x80;

  const view = new DataView(padded.buffer);
  view.setUint32(paddedLength - 8, bitLength >>> 0, true);
  view.setUint32(paddedLength - 4, Math.floor(bitLength / 0x100000000), true);

  let a0 = 0x67452301;
  let b0 = 0xefcdab89;
  let c0 = 0x98badcfe;
  let d0 = 0x10325476;

  const shifts = [
    7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 6, 10, 15, 21, 6,
    10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21,
  ];
  const constants = Array.from({ length: 64 }, (_, index) => Math.floor(Math.abs(Math.sin(index + 1)) * 0x100000000) >>> 0);

  for (let offset = 0; offset < paddedLength; offset += 64) {
    let a = a0;
    let b = b0;
    let c = c0;
    let d = d0;

    for (let index = 0; index < 64; index += 1) {
      let f: number;
      let g: number;

      if (index < 16) {
        f = (b & c) | (~b & d);
        g = index;
      } else if (index < 32) {
        f = (d & b) | (~d & c);
        g = (5 * index + 1) % 16;
      } else if (index < 48) {
        f = b ^ c ^ d;
        g = (3 * index + 5) % 16;
      } else {
        f = c ^ (b | ~d);
        g = (7 * index) % 16;
      }

      const next = d;
      d = c;
      c = b;
      b = add32(b, rotateLeft(add32(a, f, constants[index] ?? 0, view.getUint32(offset + g * 4, true)), shifts[index] ?? 0));
      a = next;
    }

    a0 = add32(a0, a);
    b0 = add32(b0, b);
    c0 = add32(c0, c);
    d0 = add32(d0, d);
  }

  return [a0, b0, c0, d0]
    .map((word) => {
      let output = "";
      for (let index = 0; index < 4; index += 1) {
        const byte = (word >>> (index * 8)) & 0xff;
        output += byte.toString(16).padStart(2, "0");
      }
      return output;
    })
    .join("");
}

function randomHex(byteCount: number): string {
  const bytes = new Uint8Array(byteCount);
  const cryptoApi = globalThis.crypto;
  if (cryptoApi) cryptoApi.getRandomValues(bytes);
  else for (let index = 0; index < bytes.length; index += 1) bytes[index] = Math.floor(Math.random() * 256);
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}
