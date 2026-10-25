import { md5 } from "@noble/hashes/legacy.js";
import { bytesToHex, utf8ToBytes } from "@noble/hashes/utils.js";
import { Context, Data, Effect, Schedule, Schema } from "effect";
import { FetchHttpClient, HttpClient, HttpClientError, HttpClientRequest, HttpClientResponse } from "effect/http";
import {
  type AlbumList2,
  type AlbumWithSongsID3,
  type CreatePlaylistArgs,
  type DeletePlaylistArgs,
  type GetAlbumArgs,
  type GetAlbumList2Args,
  type GetCoverArtArgs,
  type GetArtistsArgs,
  type GetPlaylistArgs,
  type ArtistsID3,
  type PlaylistWithSongs,
  type Playlists,
  type ScanStatus,
  type Search3Args,
  type SearchResult3,
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
  getArtistsResponseSchema,
  getPlaylistResponseSchema,
  getPlaylistsResponseSchema,
  getScanStatusResponseSchema,
  normalizeServerUrl,
  pingResponseSchema,
  responseEnvelopeSchema,
  search3ResponseSchema,
  SUBSONIC_API_VERSION,
  SUBSONIC_CLIENT_NAME,
  subsonicRestUrl,
} from "@muswag/model";
/**
 * How long the server has to start answering. Headers normally arrive within a second and a server
 * that first wakes its disks needs ten to fifteen, so half a minute means it is not answering.
 * `fetch` on its own would give the headers five minutes.
 */
const RESPONSE_TIMEOUT_SECONDS = 30;
/** Further attempts at a request that only reads, after a transport error or an answer of `RETRY_STATUSES`. */
const READ_RETRIES = 3;
/**
 * The waits before them: half a second, then doubled each time, every one jittered so that clients a
 * restarting server turned away do not all come back at once. Together they take about three and a
 * half seconds of `RESPONSE_TIMEOUT_SECONDS`.
 */
const RETRY_BACKOFF = Schedule.exponential("500 millis").pipe(Schedule.jittered);
/** What a server answers when it failed, is starting or is behind a proxy that lost it, or asks for fewer requests. */
const RETRY_STATUSES: ReadonlyArray<number> = [429, 500, 502, 503, 504];
/** Redirects followed while looking for the server at login. */
const MAX_REDIRECTS = 5;
/** Subsonic's code for a wrong username or password. */
export const WRONG_CREDENTIALS = 40;

/**
 * Reads what is left of an answer nobody reads, so that its connection goes back to the pool rather
 * than waiting for the garbage collector. One read already, or cut off, has nothing to give.
 */
const discardBody = (response: HttpClientResponse.HttpClientResponse) => Effect.exit(response.arrayBuffer);

/** An answer to a request that may get another the next time it is sent. */
class RetryableAnswer extends Data.TaggedError("RetryableAnswer")<{ readonly response: HttpClientResponse.HttpClientResponse }> {}

type RequestParams = Record<string, string | number | boolean | Array<string | number | boolean> | null | undefined>;

export type SubsonicClientError = HttpClientError.HttpClientError | SubsonicHttpError | SubsonicDecodeError | SubsonicApiError;

export interface SubsonicApiConfig {
  /** The server's address as `normalizeServerUrl` gives it. */
  readonly url: string;
  /** `token` is `subsonicToken` of the password and `salt`. Every request is signed with the one pair. */
  readonly auth: {
    readonly username: string;
    readonly salt: string;
    readonly token: string;
  };
  /** Runs when the server answers a request with "wrong username or password". */
  readonly onCredentialsRejected?: Effect.Effect<void>;
}

export interface SubsonicApiService {
  readonly username: string;
  readonly ping: Effect.Effect<SubsonicBaseResponse, SubsonicClientError>;
  readonly getAlbum: (args: GetAlbumArgs) => Effect.Effect<SubsonicBaseResponse & { album: AlbumWithSongsID3 }, SubsonicClientError>;
  readonly getAlbumList2: (args: GetAlbumList2Args) => Effect.Effect<SubsonicBaseResponse & { albumList2: AlbumList2 }, SubsonicClientError>;
  readonly getArtists: (args?: GetArtistsArgs) => Effect.Effect<SubsonicBaseResponse & { artists: ArtistsID3 }, SubsonicClientError>;
  readonly getScanStatus: Effect.Effect<SubsonicBaseResponse & { scanStatus: ScanStatus }, SubsonicClientError>;
  readonly search3: (args: Search3Args) => Effect.Effect<SubsonicBaseResponse & { searchResult3: SearchResult3 }, SubsonicClientError>;
  readonly getCoverArt: (args: GetCoverArtArgs) => Effect.Effect<HttpClientResponse.HttpClientResponse, HttpClientError.HttpClientError | SubsonicHttpError>;
  readonly getPlaylists: Effect.Effect<SubsonicBaseResponse & { playlists: Playlists }, SubsonicClientError>;
  readonly getPlaylist: (args: GetPlaylistArgs) => Effect.Effect<SubsonicBaseResponse & { playlist: PlaylistWithSongs }, SubsonicClientError>;
  readonly createPlaylist: (args: CreatePlaylistArgs) => Effect.Effect<SubsonicBaseResponse & { playlist: PlaylistWithSongs }, SubsonicClientError>;
  readonly updatePlaylist: (args: UpdatePlaylistArgs) => Effect.Effect<SubsonicBaseResponse, SubsonicClientError>;
  readonly deletePlaylist: (args: DeletePlaylistArgs) => Effect.Effect<SubsonicBaseResponse, SubsonicClientError>;
}

/** What Subsonic takes in place of a password: the MD5 of the password followed by a salt, in hex. */
export const subsonicToken = (password: string, salt: string) => bytesToHex(md5(utf8ToBytes(password + salt)));

export class SubsonicAPI extends Context.Service<SubsonicAPI, SubsonicApiService>()("@muswag/backend/SubsonicAPI") {}

function validateConfig(config: SubsonicApiConfig): URL {
  if (!config) throw new Error("no config provided");
  if (!config.url) throw new Error("no url provided");
  if (!config.auth) throw new Error("no auth provided");
  if (!config.auth.username) throw new Error("no username provided");
  if (!config.auth.salt || !config.auth.token) throw new Error("no token provided");
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

    const requestUrl = (method: string, params: RequestParams): URL => {
      const url = new URL(`${method}.view`, baseUrl);
      setSearchParams(url, {
        v: SUBSONIC_API_VERSION,
        c: SUBSONIC_CLIENT_NAME,
        f: "json",
        ...params,
        u: config.auth.username,
        t: config.auth.token,
        s: config.auth.salt,
      });
      return url;
    };

    /**
     * Sends a request and answers once the response's headers are in. A request that changes
     * something gets `retries` 0: the server may have applied it although its answer was lost, and
     * sending it again would create a second playlist or remove entries twice.
     */
    const request = (method: string, params: RequestParams, retries: number) =>
      Effect.gen(function* () {
        const url = requestUrl(method, params);
        const outgoing = HttpClientRequest.post(new URL(url.pathname, url.origin)).pipe(HttpClientRequest.bodyUrlParams(url.searchParams));
        // An answer worth asking again for fails the attempt, so that it is retried as a lost one is.
        // The last one is answered with as it is.
        const attempt = httpClient
          .execute(outgoing)
          .pipe(
            Effect.flatMap((response) =>
              retries > 0 && RETRY_STATUSES.includes(response.status) ? discardBody(response).pipe(Effect.andThen(Effect.fail(new RetryableAnswer({ response })))) : Effect.succeed(response),
            ),
          );

        // The time limit covers every attempt and wait, and ends with the headers: a cover or a long
        // album list streams after them for as long as it takes.
        const response = yield* Effect.retry(attempt, { schedule: RETRY_BACKOFF, times: retries }).pipe(
          Effect.catchTag("RetryableAnswer", ({ response }) => Effect.succeed(response)),
          Effect.timeoutOrElse({
            duration: `${RESPONSE_TIMEOUT_SECONDS} seconds`,
            orElse: () =>
              Effect.fail(
                new HttpClientError.HttpClientError({ reason: new HttpClientError.TransportError({ request: outgoing, description: `no answer within ${RESPONSE_TIMEOUT_SECONDS} seconds` }) }),
              ),
          }),
        );
        if (response.status < 200 || response.status >= 300) {
          yield* discardBody(response);
          const location = response.headers["location"];
          return yield* new SubsonicHttpError({ method, status: response.status, message: `${method} failed: HTTP ${response.status}`, ...(location !== undefined && { location }) });
        }
        return response;
      });

    const json = <T extends Schema.Struct<Schema.Struct.Fields>>(method: string, params: RequestParams, parse: ResponseParser<T>, retries: number) =>
      Effect.gen(function* () {
        const response = yield* request(method, params, retries);
        const text = yield* response.text;
        const payload = yield* Effect.try({
          try: () => (text === "" ? null : JSON.parse(text)),
          catch: (cause) => new HttpClientError.HttpClientError({ reason: new HttpClientError.DecodeError({ request: response.request, response, cause }) }),
        });
        // Only an answer with a null in it has one to take out, which saves walking a long list again.
        return yield* parse(NULL_VALUE.test(text) ? withoutNulls(payload) : payload);
      }).pipe(
        // The one place every decoded answer passes, so the one place refused credentials are noticed.
        Effect.tapError((error) => (error._tag === "SubsonicApiError" && error.code === WRONG_CREDENTIALS ? (config.onCredentialsRejected ?? Effect.void) : Effect.void)),
        Effect.withSpan(`SubsonicAPI.${method}`),
      );

    // Each method's parser is made once, here, rather than with every request.
    const read = <T extends Schema.Struct<Schema.Struct.Fields>>(method: string, schema: T, retries = READ_RETRIES) => {
      const parse = responseParser(method, schema);
      return (params: RequestParams = {}) => json(method, params, parse, retries);
    };
    const change = <T extends Schema.Struct<Schema.Struct.Fields>>(method: string, schema: T) => {
      const parse = responseParser(method, schema);
      return (params: RequestParams) => json(method, params, parse, 0);
    };

    return {
      username: config.auth.username,
      // Asked once: it checks an address someone has just typed in, whose mistakes they should hear of at once.
      ping: read("ping", pingResponseSchema, 0)(),
      getAlbum: read("getAlbum", getAlbumResponseSchema),
      getAlbumList2: read("getAlbumList2", getAlbumList2ResponseSchema),
      getArtists: read("getArtists", getArtistsResponseSchema),
      getScanStatus: read("getScanStatus", getScanStatusResponseSchema)(),
      search3: read("search3", search3ResponseSchema),
      getCoverArt: (args) => request("getCoverArt", args, READ_RETRIES).pipe(Effect.withSpan("SubsonicAPI.getCoverArt")),
      getPlaylists: read("getPlaylists", getPlaylistsResponseSchema)(),
      getPlaylist: read("getPlaylist", getPlaylistResponseSchema),
      createPlaylist: change("createPlaylist", createPlaylistResponseSchema),
      updatePlaylist: change("updatePlaylist", pingResponseSchema),
      deletePlaylist: change("deletePlaylist", pingResponseSchema),
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

/** A field sent as `null`, as JSON writes it. A string that holds the same text costs a walk for nothing. */
const NULL_VALUE = /:\s*null\b/;

/**
 * `value` without the fields it has as `null`, at any depth. gonic writes a field it has no value for
 * as `null`, as `"replayGain": null` on a song without ReplayGain tags, where others leave it out.
 */
function withoutNulls(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(withoutNulls);
  if (typeof value !== "object" || value === null) return value;
  const kept: Record<string, unknown> = {};
  for (const [key, field] of Object.entries(value)) if (field !== null) kept[key] = withoutNulls(field);
  return kept;
}

type ResponseParser<T extends Schema.Struct<Schema.Struct.Fields>> = (payload: unknown) => Effect.Effect<SubsonicBaseResponse & T["Type"], SubsonicDecodeError | SubsonicApiError>;

const decodeEnvelope = Schema.decodeUnknownEffect(responseEnvelopeSchema);
const decodeBase = Schema.decodeUnknownEffect(baseResponseSchema);

/** Reads `method`'s answer: an error the server sent, or the response with the fields of `payloadSchema`. */
function responseParser<T extends Schema.Struct<Schema.Struct.Fields>>(method: string, payloadSchema: T): ResponseParser<T> {
  const decodeResponse = Schema.decodeUnknownEffect(Schema.Struct({ ...baseResponseSchema.fields, ...payloadSchema.fields }));
  return (payload) =>
    Effect.gen(function* () {
      const envelope = yield* decodeEnvelope(payload).pipe(Effect.mapError((cause) => new SubsonicDecodeError({ method, message: `${method} returned an invalid response envelope`, cause })));
      const response = yield* decodeBase(envelope["subsonic-response"]).pipe(
        Effect.mapError((cause) => new SubsonicDecodeError({ method, message: `${method} returned invalid Subsonic metadata`, cause })),
      );

      if (response.status !== "ok") {
        return yield* new SubsonicApiError({
          method,
          ...(response.error?.code === undefined ? {} : { code: response.error.code }),
          ...(response.type === undefined ? {} : { server: response.type }),
          ...(response.error?.helpUrl === undefined ? {} : { helpUrl: response.error.helpUrl }),
          message: response.error?.message ?? `${method} failed: Subsonic status ${response.status}`,
        });
      }

      return (yield* decodeResponse(envelope["subsonic-response"]).pipe(
        Effect.mapError((cause) => new SubsonicDecodeError({ method, message: `${method} returned an invalid payload`, cause })),
      )) as SubsonicBaseResponse & T["Type"];
    });
}
