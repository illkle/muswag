import { md5 } from "@noble/hashes/legacy.js";
import { bytesToHex, utf8ToBytes } from "@noble/hashes/utils.js";
import { Context, Crypto, Effect, PlatformError, Schema } from "effect";
import { FetchHttpClient, HttpClient, HttpClientError, HttpClientRequest, HttpClientResponse } from "effect/http";
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
  normalizeServerUrl,
  pingResponseSchema,
  responseEnvelopeSchema,
  subsonicRestUrl,
} from "@muswag/model";
const API_VERSION = "1.16.1";
const CLIENT_NAME = "muswag";
/**
 * How long the server has to start answering. Headers normally arrive within a second and a server
 * that first wakes its disks needs ten to fifteen, so half a minute means it is not answering.
 * `fetch` on its own would give the headers five minutes.
 */
const RESPONSE_TIMEOUT_SECONDS = 30;
/** Further attempts at a request that only reads, after a transport error. */
const READ_RETRIES = 2;
/** Redirects followed while looking for the server at login. */
const MAX_REDIRECTS = 5;
/** Subsonic's code for a wrong username or password. */
export const WRONG_CREDENTIALS = 40;

type RequestParams = Record<string, string | number | boolean | Array<string | number | boolean> | null | undefined>;

export type SubsonicClientError = HttpClientError.HttpClientError | PlatformError.PlatformError | SubsonicHttpError | SubsonicDecodeError | SubsonicApiError;

export interface SubsonicApiConfig {
  /** The server's address as `normalizeServerUrl` gives it. */
  readonly url: string;
  readonly auth: {
    readonly username: string;
    readonly password: string;
  };
  /** Runs when the server answers a request with "wrong username or password". */
  readonly onCredentialsRejected?: Effect.Effect<void>;
}

export interface SubsonicApiService {
  readonly username: string;
  readonly ping: Effect.Effect<SubsonicBaseResponse, SubsonicClientError>;
  readonly getAlbum: (args: GetAlbumArgs) => Effect.Effect<SubsonicBaseResponse & { album: AlbumWithSongsID3 }, SubsonicClientError>;
  readonly getAlbumList2: (args: GetAlbumList2Args) => Effect.Effect<SubsonicBaseResponse & { albumList2: AlbumList2 }, SubsonicClientError>;
  readonly getIndexes: (args?: GetIndexesArgs) => Effect.Effect<SubsonicBaseResponse & { indexes: Indexes }, SubsonicClientError>;
  readonly getCoverArt: (args: GetCoverArtArgs) => Effect.Effect<HttpClientResponse.HttpClientResponse, HttpClientError.HttpClientError | PlatformError.PlatformError | SubsonicHttpError>;
  readonly getPlaylists: Effect.Effect<SubsonicBaseResponse & { playlists: Playlists }, SubsonicClientError>;
  readonly getPlaylist: (args: GetPlaylistArgs) => Effect.Effect<SubsonicBaseResponse & { playlist: PlaylistWithSongs }, SubsonicClientError>;
  readonly createPlaylist: (args: CreatePlaylistArgs) => Effect.Effect<SubsonicBaseResponse & { playlist: PlaylistWithSongs }, SubsonicClientError>;
  readonly updatePlaylist: (args: UpdatePlaylistArgs) => Effect.Effect<SubsonicBaseResponse, SubsonicClientError>;
  readonly deletePlaylist: (args: DeletePlaylistArgs) => Effect.Effect<SubsonicBaseResponse, SubsonicClientError>;
}

export class SubsonicAPI extends Context.Service<SubsonicAPI, SubsonicApiService>()("@muswag/backend/SubsonicAPI") {}

function validateConfig(config: SubsonicApiConfig): URL {
  if (!config) throw new Error("no config provided");
  if (!config.url) throw new Error("no url provided");
  if (!config.auth) throw new Error("no auth provided");
  if (!config.auth.username) throw new Error("no username provided");
  if (!config.auth.password) throw new Error("no password provided");
  return new URL(subsonicRestUrl(config.url));
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
      continue;
    }

    url.searchParams.set(k, String(v));
  }
};

export const makeSubsonicAPI = (config: SubsonicApiConfig) =>
  Effect.gen(function* () {
    const baseUrl = yield* Effect.try({
      try: () => validateConfig(config),
      catch: (cause) => new SubsonicConfigError({ message: cause instanceof Error ? cause.message : "invalid Subsonic configuration", cause }),
    });
    const httpClient = yield* HttpClient.HttpClient;
    const crypto = yield* Crypto.Crypto;

    const requestUrl = (method: string, params: RequestParams): Effect.Effect<URL, PlatformError.PlatformError> =>
      Effect.gen(function* () {
        const url = new URL(`${method}.view`, baseUrl);
        setSearchParams(url, {
          v: API_VERSION,
          c: CLIENT_NAME,
          f: "json",
          ...params,
        });

        const s = bytesToHex(yield* crypto.randomBytes(16));
        setSearchParams(url, {
          u: config.auth.username,
          t: bytesToHex(md5(utf8ToBytes(config.auth.password + s))),
          s,
        });

        return url;
      });

    /**
     * Sends a request and answers once the response's headers are in. A request that changes
     * something gets `retries` 0: the server may have applied it although its answer was lost, and
     * sending it again would create a second playlist or remove entries twice.
     */
    const request = (method: string, params: RequestParams, retries: number) =>
      Effect.gen(function* () {
        const url = yield* requestUrl(method, params);
        const outgoing = HttpClientRequest.post(new URL(url.pathname, url.origin)).pipe(HttpClientRequest.bodyUrlParams(url.searchParams));

        // The time limit covers every attempt, and ends with the headers: a cover or a long album
        // list streams after them for as long as it takes.
        const response = yield* Effect.retry(httpClient.execute(outgoing), { times: retries }).pipe(
          Effect.timeoutOrElse({
            duration: `${RESPONSE_TIMEOUT_SECONDS} seconds`,
            orElse: () =>
              Effect.fail(
                new HttpClientError.HttpClientError({ reason: new HttpClientError.TransportError({ request: outgoing, description: `no answer within ${RESPONSE_TIMEOUT_SECONDS} seconds` }) }),
              ),
          }),
        );
        if (response.status < 200 || response.status >= 300) {
          const location = response.headers["location"];
          return yield* new SubsonicHttpError({ method, status: response.status, message: `${method} failed: HTTP ${response.status}`, ...(location !== undefined && { location }) });
        }
        return response;
      });

    const json = <T extends Schema.Struct<Schema.Struct.Fields>>(method: string, params: RequestParams, schema: T, retries: number) =>
      Effect.gen(function* () {
        const response = yield* request(method, params, retries);
        const payload = yield* response.json;
        return yield* parseResponse(method, schema, payload);
      }).pipe(
        // The one place every decoded answer passes, so the one place a refused password is noticed.
        Effect.tapError((error) => (error._tag === "SubsonicApiError" && error.code === WRONG_CREDENTIALS ? (config.onCredentialsRejected ?? Effect.void) : Effect.void)),
        Effect.withSpan(`SubsonicAPI.${method}`),
      );

    const read = <T extends Schema.Struct<Schema.Struct.Fields>>(method: string, params: RequestParams, schema: T) => json(method, params, schema, READ_RETRIES);
    const change = <T extends Schema.Struct<Schema.Struct.Fields>>(method: string, params: RequestParams, schema: T) => json(method, params, schema, 0);

    return {
      username: config.auth.username,
      ping: read("ping", {}, pingResponseSchema),
      getAlbum: (args) => read("getAlbum", args, getAlbumResponseSchema),
      getAlbumList2: (args) => read("getAlbumList2", args, getAlbumList2ResponseSchema),
      getIndexes: (args = {}) => read("getIndexes", args, getIndexesResponseSchema),
      getCoverArt: (args) => request("getCoverArt", args, READ_RETRIES).pipe(Effect.withSpan("SubsonicAPI.getCoverArt")),
      getPlaylists: read("getPlaylists", {}, getPlaylistsResponseSchema),
      getPlaylist: (args) => read("getPlaylist", args, getPlaylistResponseSchema),
      createPlaylist: (args) => change("createPlaylist", args, createPlaylistResponseSchema),
      updatePlaylist: (args) => change("updatePlaylist", args, pingResponseSchema),
      deletePlaylist: (args) => change("deletePlaylist", args, pingResponseSchema),
    } satisfies SubsonicApiService;
  });

/**
 * Checks the credentials against the server at `config.url` and answers with the address the server is
 * really at, which is another one when the server redirects there, as from http to https.
 *
 * `fetch` follows a 301 or 302 by turning the POST into a GET without its body, so behind such a
 * redirect the server would never see the request's parameters. The redirect is followed here, by
 * asking again at the address it names, and later requests go to that address directly.
 */
export const locateSubsonicServer = (config: SubsonicApiConfig) =>
  Effect.gen(function* () {
    let url = config.url;
    for (let redirects = 0; ; redirects += 1) {
      const api = yield* makeSubsonicAPI({ ...config, url });
      const redirect = yield* api.ping.pipe(
        Effect.as(null),
        Effect.provideService(FetchHttpClient.RequestInit, { redirect: "manual" }),
        Effect.catchTag("SubsonicHttpError", (error) => {
          const moved = redirectedServer(url, error.location);
          // The request carries the login. It follows to another scheme, port or folder of the host
          // the user named, and to no other host: the error names it, for the user to enter if they trust it.
          const followed = moved !== null && moved !== url && new URL(moved).hostname === new URL(url).hostname && redirects < MAX_REDIRECTS;
          return followed ? Effect.succeed(moved) : Effect.fail(error);
        }),
      );
      if (redirect === null) return url;
      url = redirect;
    }
  });

/** The server a redirect of `ping.view` points to: `location` names where the request went, inside that server's `rest` folder. */
function redirectedServer(from: string, location: string | undefined): string | null {
  const requested = `${subsonicRestUrl(from)}ping.view`;
  if (location === undefined || !URL.canParse(location, requested)) return null;
  return normalizeServerUrl(new URL(".", new URL(location, requested)).href);
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
