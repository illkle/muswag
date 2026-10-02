import { albums, artists, covers, playerQueue, playlists, songs, syncState, type AuthSnapshot, type SessionCredentials } from "@muswag/model";
import { MirrorServer } from "@muswag/tanstack-db-mirror/server";
import { Context, Crypto, Data, Effect, Layer, Scope, ScopedRef, Stream, SubscriptionRef } from "effect";
import { HttpClient } from "effect/http";
import { Path } from "effect/Path";

import SubsonicAPI, { makeSubsonicAPI, type SubsonicApiConfig } from "../api/subsonic-api.js";
import CoverManager, { CoverManagerLive, MiniFs } from "../covers/cover-manager.js";
import { Db } from "../db/database.js";
import { LibrarySync } from "../library/library-sync.js";
import { PlaylistEdits } from "../playlists/commands.js";
import { PlaylistSyncManager, PlaylistSyncManagerLive } from "../playlists/sync-manager.js";
import { CredentialsStore } from "./credentials-store.js";

export class SessionError extends Data.TaggedError("SessionError")<{
  readonly operation: "login" | "logout";
  readonly message: string;
  readonly cause: unknown;
}> {}

export class NotAuthenticated extends Data.TaggedError("NotAuthenticated")<{
  readonly message: string;
}> {}

export interface AuthenticatedSession {
  readonly user: AuthSnapshot & { readonly _tag: "LoggedIn" };
  readonly credentials: SessionCredentials;
  readonly api: typeof SubsonicAPI.Service;
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
  readonly login: (credentials: SessionCredentials) => Effect.Effect<AuthSnapshot, SessionError>;
  /** Ends the session and deletes the local library, playlists and covers. */
  readonly logout: Effect.Effect<AuthSnapshot, SessionError>;
  readonly use: <A, E, R>(f: (session: AuthenticatedSession) => Effect.Effect<A, E, R>) => Effect.Effect<A, E | NotAuthenticated, R>;
}

export class SessionManager extends Context.Service<SessionManager, SessionManagerService>()("@muswag/backend/SessionManager") {}

export interface SessionManagerOptions {
  /** Directory for cover files, relative to `MiniFs`. */
  readonly coverSaveLocation: string;
}

type SessionDependencies = Db | MirrorServer | PlaylistEdits | MiniFs | Path | HttpClient.HttpClient | Crypto.Crypto | CredentialsStore;
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

/** Tables that hold the logged-in user's data. */
const USER_TABLES = [albums, artists, songs, playlists, playerQueue, syncState, covers] as const;

const makeSessionManager = (options: SessionManagerOptions) =>
  Effect.gen(function* () {
    // Without the app's scope: the session's services are built into the scope `ScopedRef` gives
    // each session, so logging out or switching accounts stops them.
    const dependencies = Context.omit(Scope.Scope)(yield* Effect.context<SessionDependencies>());
    const credentialsStore = yield* CredentialsStore;
    const db = yield* Db;
    const mirror = yield* MirrorServer;
    const fs = yield* MiniFs;
    const path = yield* Path;
    const current = yield* ScopedRef.make<SessionState>(() => ({ _tag: "LoggedOut" }));
    const publicState = yield* SubscriptionRef.make<AuthSnapshot>({ _tag: "Initializing" });

    const acquire = (credentials: SessionCredentials, verify: boolean) => {
      const apiLayer = Layer.effect(SubsonicAPI, makeSubsonicAPI(toApiConfig(credentials)).pipe(Effect.tap((api) => (verify ? api.ping : Effect.void))));
      const authenticatedLayer = Layer.mergeAll(LibrarySync.layer, CoverManagerLive(options.coverSaveLocation), PlaylistSyncManagerLive()).pipe(Layer.provideMerge(apiLayer));

      return Layer.build(authenticatedLayer).pipe(
        Effect.provide(dependencies),
        Effect.map((context): SessionState => ({
          _tag: "LoggedIn",
          session: {
            user: loggedInSnapshot(credentials),
            credentials,
            api: Context.get(context, SubsonicAPI),
            covers: Context.get(context, CoverManager),
            playlists: Context.get(context, PlaylistSyncManager),
            library: Context.get(context, LibrarySync),
          },
        })),
      );
    };

    const install = (credentials: SessionCredentials, verify: boolean, persist: boolean) =>
      ScopedRef.set(current, acquire(credentials, verify).pipe(Effect.tap(() => (persist ? credentialsStore.save(credentials) : Effect.void)))).pipe(
        Effect.andThen(SubscriptionRef.set(publicState, loggedInSnapshot(credentials))),
        Effect.as(loggedInSnapshot(credentials)),
      );

    const loggedOut = SubscriptionRef.set(publicState, { _tag: "LoggedOut" }).pipe(Effect.as<AuthSnapshot>({ _tag: "LoggedOut" }));

    // Restoring always settles on LoggedIn or LoggedOut, even on a defect, so startup cannot hang.
    const restore = credentialsStore.load.pipe(
      Effect.flatMap((credentials) =>
        credentials
          ? install(credentials, false, false).pipe(Effect.catchCause((cause) => Effect.logError("Failed to restore the authenticated session", cause).pipe(Effect.andThen(loggedOut))))
          : loggedOut,
      ),
      Effect.catchCause((cause) => Effect.logError("Failed to load stored credentials", cause).pipe(Effect.andThen(loggedOut))),
    );

    const clearLocalData = Effect.gen(function* () {
      const files = yield* db.select({ fileName: covers.fileName }).from(covers);
      yield* mirror.write(Effect.forEach(USER_TABLES, (table) => db.delete(table), { discard: true }));
      yield* Effect.forEach(files, ({ fileName }) => fs.remove(path.join(options.coverSaveLocation, fileName)), { concurrency: 8, discard: true });
    });

    const login = (credentials: SessionCredentials) =>
      install(credentials, true, true).pipe(
        Effect.mapError(
          (cause) =>
            new SessionError({
              operation: "login",
              message: "Unable to connect to the Subsonic server",
              cause,
            }),
        ),
      );

    // The session's services stop first, so no sync pass can write again after the data is gone.
    const logout = ScopedRef.set(current, Effect.succeed<SessionState>({ _tag: "LoggedOut" })).pipe(
      Effect.andThen(SubscriptionRef.set(publicState, { _tag: "LoggedOut" })),
      Effect.andThen(credentialsStore.clear),
      Effect.andThen(clearLocalData),
      Effect.as<AuthSnapshot>({ _tag: "LoggedOut" }),
      Effect.mapError(
        (cause) =>
          new SessionError({
            operation: "logout",
            message: "The session was closed, but local cleanup failed",
            cause,
          }),
      ),
    );

    const use = <A, E, R>(f: (session: AuthenticatedSession) => Effect.Effect<A, E, R>): Effect.Effect<A, E | NotAuthenticated, R> =>
      ScopedRef.get(current).pipe(
        Effect.flatMap((state): Effect.Effect<A, E | NotAuthenticated, R> => {
          if (state._tag === "LoggedIn") return f(state.session);
          return Effect.fail(new NotAuthenticated({ message: "Log in before using server services" }));
        }),
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
