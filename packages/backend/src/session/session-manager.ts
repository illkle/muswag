import {
  albums,
  artists,
  normalizeServerUrl,
  playlists,
  queueItems,
  queueResume,
  queueState,
  songs,
  SubsonicApiError,
  SubsonicConfigError,
  SubsonicDecodeError,
  SubsonicHttpError,
  syncState,
  type AuthSnapshot,
  type SessionCredentials,
} from "@muswag/model";
import { SqliteMirror } from "@muswag/tanstack-db-mirror/server/sqlite";
import { Context, Crypto, Data, Effect, Layer, Scope, ScopedRef, Semaphore, Stream, SubscriptionRef } from "effect";
import { HttpClient, HttpClientError } from "effect/http";
import { Path } from "effect/Path";

import { locateSubsonicServer, makeSubsonicAPI, SubsonicAPI, WRONG_CREDENTIALS, type SubsonicApiConfig } from "../api/subsonic-api.js";
import { CoverManager, CoverManagerLive, MiniFs } from "../covers/cover-manager.js";
import { Db } from "../db/database.js";
import { LibrarySync } from "../library/library-sync.js";
import { PlaylistEdits } from "../playlists/commands.js";
import { PlaylistSyncManager, PlaylistSyncManagerLive } from "../playlists/sync-manager.js";
import { CredentialsStore, type StoredAccount } from "./credentials-store.js";

export class SessionError extends Data.TaggedError("SessionError")<{
  readonly operation: "login" | "logout";
  readonly message: string;
  readonly cause: unknown;
}> {}

export class NotAuthenticated extends Data.TaggedError("NotAuthenticated")<{
  readonly message: string;
}> {}

export interface AuthenticatedSession {
  readonly credentials: SessionCredentials;
  readonly covers: typeof CoverManager.Service;
  readonly playlists: typeof PlaylistSyncManager.Service;
  readonly library: typeof LibrarySync.Service;
}

export interface SessionManagerService {
  readonly snapshot: Effect.Effect<AuthSnapshot>;
  readonly changes: Stream.Stream<AuthSnapshot>;
  /** Credentials of the current session, for services such as playback that sign their own requests. */
  readonly credentials: Effect.Effect<SessionCredentials | null>;
  readonly restore: Effect.Effect<AuthSnapshot>;
  /**
   * Starts a session once the server accepts the credentials; a login that fails changes nothing. The
   * local data is deleted first unless it belongs to the same server and user. The session's
   * credentials carry the address the server was found at, which is the one that is stored.
   */
  readonly login: (credentials: SessionCredentials, options?: LoginOptions) => Effect.Effect<AuthSnapshot, SessionError>;
  /** Ends the session and deletes the local library, playlists and covers. */
  readonly logout: Effect.Effect<AuthSnapshot, SessionError>;
  readonly use: <A, E, R>(f: (session: AuthenticatedSession) => Effect.Effect<A, E, R>) => Effect.Effect<A, E | NotAuthenticated, R>;
}

export interface LoginOptions {
  /** Runs before the data of another account is deleted, for what holds that data outside the database, such as the queue being played. */
  readonly beforeDataIsDeleted?: Effect.Effect<void>;
}

export class SessionManager extends Context.Service<SessionManager, SessionManagerService>()("@muswag/backend/SessionManager") {}

export interface SessionManagerOptions {
  /** Directory for cover files, relative to `MiniFs`. */
  readonly coverSaveLocation: string;
}

type SessionDependencies = Db | SqliteMirror | PlaylistEdits | MiniFs | Path | HttpClient.HttpClient | Crypto.Crypto | CredentialsStore;
type SessionState = { readonly _tag: "LoggedOut" } | { readonly _tag: "LoggedIn"; readonly session: AuthenticatedSession };

const toApiConfig = (credentials: SessionCredentials): SubsonicApiConfig => ({
  url: credentials.url,
  auth: {
    username: credentials.username,
    password: credentials.password,
  },
});

const loggedInSnapshot = (credentials: SessionCredentials): AuthSnapshot & { readonly _tag: "LoggedIn" } => ({
  _tag: "LoggedIn",
  url: credentials.url,
  username: credentials.username,
});

/** The innermost reason a request never got an answer, such as "getaddrinfo ENOTFOUND music.example" or "self-signed certificate". */
const transportDetail = (cause: unknown): string => {
  let detail = "the connection failed";
  for (let error = cause, depth = 0; error instanceof Error && depth < 5; error = error.cause, depth += 1) {
    const [first] = error instanceof AggregateError ? error.errors : [];
    const message = error.message || (first instanceof Error ? first.message : "");
    if (message) detail = message;
  }
  return detail;
};

const NOT_A_SUBSONIC_SERVER = "This address does not answer like a Subsonic server";

class InvalidServerUrl extends Data.TaggedError("InvalidServerUrl")<{}> {}

/**
 * Why a login failed, in one line for the login form. It repeats what the server or the network said,
 * which names the address at most: the username and the password travel in the request's body.
 */
const loginFailureMessage = (error: { readonly _tag: string }): string => {
  if (HttpClientError.isHttpClientError(error)) {
    const { reason } = error;
    if (reason._tag === "TransportError") return `The server could not be reached: ${reason.description ?? transportDetail(reason.cause)}`;
    // An answer that is not JSON, such as the page of another web server.
    return NOT_A_SUBSONIC_SERVER;
  }
  if (error instanceof InvalidServerUrl) return "The server address is not a valid http or https address";
  if (error instanceof SubsonicApiError) return error.code === WRONG_CREDENTIALS ? "Wrong username or password" : `The server refused the login: ${error.message}`;
  // A redirect that was not followed: it leads to another host, or nowhere.
  if (error instanceof SubsonicHttpError && error.location !== undefined) return `This address redirects to ${error.location}. If that is your server, enter its address`;
  if (error instanceof SubsonicHttpError) return `${NOT_A_SUBSONIC_SERVER} (HTTP ${error.status})`;
  if (error instanceof SubsonicDecodeError) return NOT_A_SUBSONIC_SERVER;
  if (error instanceof SubsonicConfigError) return `The login is incomplete: ${error.message}`;
  // What is left failed on this machine: the database, the keychain or the cover files.
  return "The server accepted the login, but it could not be set up on this computer";
};

/** Tables that hold the logged-in user's data. */
const USER_TABLES = [albums, artists, songs, playlists, queueItems, queueState, queueResume, syncState] as const;

const makeSessionManager = (options: SessionManagerOptions) =>
  Effect.gen(function* () {
    // Without the app's scope: the session's services are built into the scope `ScopedRef` gives
    // each session, so logging out or switching accounts stops them.
    const dependencies = Context.omit(Scope.Scope)(yield* Effect.context<SessionDependencies>());
    const scope = yield* Effect.scope;
    const credentialsStore = yield* CredentialsStore;
    const db = yield* Db;
    const mirror = yield* SqliteMirror;
    const fs = yield* MiniFs;
    // Login, logout and a session the server ends each replace the session, one at a time.
    const transitions = yield* Semaphore.make(1);
    const current = yield* ScopedRef.make<SessionState>(() => ({ _tag: "LoggedOut" }));
    const publicState = yield* SubscriptionRef.make<AuthSnapshot>({ _tag: "Initializing" });

    const loggedOut = (expired?: StoredAccount) => {
      const snapshot: AuthSnapshot = expired ? { _tag: "LoggedOut", expired } : { _tag: "LoggedOut" };
      return ScopedRef.set(current, Effect.succeed<SessionState>({ _tag: "LoggedOut" })).pipe(Effect.andThen(SubscriptionRef.set(publicState, snapshot)), Effect.as(snapshot));
    };

    /**
     * Ends the session the server answered with "wrong username or password", and nothing else: the
     * library, the playlists and whose they are stay, so logging in again as the same user goes on
     * from here. The password is forgotten, or every start would try it again.
     *
     * Forked, because ending the session interrupts the request that reports this.
     */
    const expire = (credentials: SessionCredentials) =>
      Effect.gen(function* () {
        const state = yield* ScopedRef.get(current);
        // Reported by a request of a session that has ended since.
        if (state._tag !== "LoggedIn" || state.session.credentials !== credentials) return;
        // One refusal is not taken at its word: a server answers the same when its own lookup of the
        // user fails. The question is asked once more, and only the same answer ends the session.
        const refusedAgain = yield* makeSubsonicAPI(toApiConfig(credentials)).pipe(
          Effect.flatMap((api) => api.ping),
          Effect.provide(dependencies),
          Effect.as(false),
          Effect.catch((error) => Effect.succeed(error instanceof SubsonicApiError && error.code === WRONG_CREDENTIALS)),
        );
        if (!refusedAgain) return;
        yield* credentialsStore.forgetPassword.pipe(Effect.catchCause((cause) => Effect.logError("Failed to forget the password the server refused", cause)));
        yield* loggedOut({ url: credentials.url, username: credentials.username });
      }).pipe(
        transitions.withPermit,
        Effect.catchCause((cause) => Effect.logError("Failed to end the session the server refused", cause)),
        Effect.forkIn(scope),
        Effect.asVoid,
      );

    const acquire = (credentials: SessionCredentials) => {
      const apiLayer = Layer.effect(SubsonicAPI, makeSubsonicAPI({ ...toApiConfig(credentials), onCredentialsRejected: expire(credentials) }));
      const authenticatedLayer = Layer.mergeAll(LibrarySync.layer, CoverManagerLive(options.coverSaveLocation), PlaylistSyncManagerLive()).pipe(Layer.provideMerge(apiLayer));

      return Layer.build(authenticatedLayer).pipe(
        Effect.provide(dependencies),
        Effect.map((context): SessionState => ({
          _tag: "LoggedIn",
          session: {
            credentials,
            covers: Context.get(context, CoverManager),
            playlists: Context.get(context, PlaylistSyncManager),
            library: Context.get(context, LibrarySync),
          },
        })),
      );
    };

    const use = <A, E, R>(f: (session: AuthenticatedSession) => Effect.Effect<A, E, R>): Effect.Effect<A, E | NotAuthenticated, R> =>
      ScopedRef.get(current).pipe(
        Effect.flatMap((state): Effect.Effect<A, E | NotAuthenticated, R> => {
          if (state._tag === "LoggedIn") return f(state.session);
          return Effect.fail(new NotAuthenticated({ message: "Log in before using server services" }));
        }),
      );

    // Every session starts by catching up with the server, as its playlists do on their own. The
    // sync's status says how it went, and the session ending interrupts it.
    const startLibrarySync = use((session) => session.library.sync("quick")).pipe(Effect.ignore, Effect.forkIn(scope), Effect.asVoid);

    const install = (credentials: SessionCredentials, persist: boolean) =>
      ScopedRef.set(current, acquire(credentials).pipe(Effect.tap(() => (persist ? credentialsStore.save(credentials) : Effect.void)))).pipe(
        Effect.andThen(SubscriptionRef.set(publicState, loggedInSnapshot(credentials))),
        Effect.andThen(startLibrarySync),
        Effect.as(loggedInSnapshot(credentials)),
      );

    // Restoring always settles on LoggedIn or LoggedOut, even on a defect, so startup cannot hang.
    const restore = Effect.gen(function* () {
      const credentials = yield* credentialsStore.load;
      if (credentials) return yield* install(credentials, false);
      // An account left without its password is one the server refused, which the login form says.
      return yield* loggedOut((yield* credentialsStore.account) ?? undefined);
    }).pipe(
      Effect.catchCause((cause) => Effect.logError("Failed to restore the session", cause).pipe(Effect.andThen(loggedOut()))),
      transitions.withPermit,
    );

    const clearLocalData = mirror.write(Effect.forEach(USER_TABLES, (table) => db.delete(table), { discard: true })).pipe(Effect.andThen(fs.remove(options.coverSaveLocation)));

    const login = (entered: SessionCredentials, loginOptions: LoginOptions = {}) =>
      Effect.gen(function* () {
        const url = normalizeServerUrl(entered.url);
        if (url === null) return yield* new InvalidServerUrl();
        // The server is asked before anything changes, so a login that fails leaves everything as it was.
        const located = yield* locateSubsonicServer(toApiConfig({ ...entered, url })).pipe(Effect.provide(dependencies));
        const credentials: SessionCredentials = { ...entered, url: located };

        return yield* Effect.gen(function* () {
          const account = yield* credentialsStore.account;
          if (account?.url !== credentials.url || account.username !== credentials.username) {
            // What the database holds is another account's, left by a session that could not be
            // restored or still running. Its services stop first, as on logout.
            yield* loggedOut();
            yield* loginOptions.beforeDataIsDeleted ?? Effect.void;
            // With its data goes the account itself, so a login that fails from here on does not
            // leave the next start restoring an account whose library is gone.
            yield* credentialsStore.clear;
            yield* clearLocalData;
          }
          return yield* install(credentials, true);
        }).pipe(transitions.withPermit);
      }).pipe(Effect.mapError((cause) => new SessionError({ operation: "login", message: loginFailureMessage(cause), cause })));

    // The session's services stop first, so no sync pass can write again after the data is gone.
    const logout = loggedOut().pipe(
      Effect.andThen(credentialsStore.clear),
      Effect.andThen(clearLocalData),
      Effect.as<AuthSnapshot>({ _tag: "LoggedOut" }),
      transitions.withPermit,
      Effect.mapError(
        (cause) =>
          new SessionError({
            operation: "logout",
            message: "The session was closed, but local cleanup failed",
            cause,
          }),
      ),
    );

    return {
      snapshot: SubscriptionRef.get(publicState),
      changes: SubscriptionRef.changes(publicState),
      credentials: ScopedRef.get(current).pipe(Effect.map((state) => (state._tag === "LoggedIn" ? state.session.credentials : null))),
      restore,
      login,
      logout,
      use,
    } satisfies SessionManagerService;
  });

export const SessionManagerLive = (options: SessionManagerOptions) => Layer.effect(SessionManager, makeSessionManager(options));
