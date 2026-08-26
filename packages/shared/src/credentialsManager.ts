import { Context, Data, Effect, Layer, ScopedRef, Stream, SubscriptionRef } from "effect";
import { Crypto } from "effect/Crypto";
import { Path } from "effect/Path";
import { HttpClient } from "effect/unstable/http";

import SubsonicAPI, { makeSubsonicAPI, type SubsonicApiConfig } from "./api/subsonic-api.js";
import CoverManager, { CoverManagerLive, MiniFs } from "./coverManager.js";
import { MuswagDatabase } from "./db/database.js";
import { PlaylistSyncManager, PlaylistSyncManagerLive } from "./playlists/sync-manager.js";
import SyncManager from "./syncEffect.js";

export interface SessionCredentials {
  readonly url: string;
  readonly username: string;
  readonly password: string;
}

export type AuthSnapshot = { readonly _tag: "Initializing" } | { readonly _tag: "LoggedOut" } | { readonly _tag: "LoggedIn"; readonly url: string; readonly username: string };

export class CredentialsStoreError extends Data.TaggedError("CredentialsStoreError")<{
  readonly operation: "load" | "save" | "clear";
  readonly message: string;
  readonly cause: unknown;
}> {}

export interface CredentialsStoreService {
  readonly load: Effect.Effect<SessionCredentials | null, CredentialsStoreError>;
  readonly save: (credentials: SessionCredentials) => Effect.Effect<void, CredentialsStoreError>;
  readonly clear: Effect.Effect<void, CredentialsStoreError>;
}

export class CredentialsStore extends Context.Service<CredentialsStore, CredentialsStoreService>()("@muswag/shared/CredentialsStore") {}

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
  readonly api: typeof SubsonicAPI.Service;
  readonly covers: typeof CoverManager.Service;
  readonly playlists: typeof PlaylistSyncManager.Service;
  readonly sync: typeof SyncManager.Service;
}

export interface SessionManagerService {
  readonly snapshot: Effect.Effect<AuthSnapshot>;
  readonly changes: Stream.Stream<AuthSnapshot>;
  readonly restore: Effect.Effect<AuthSnapshot>;
  readonly login: (credentials: SessionCredentials) => Effect.Effect<AuthSnapshot, SessionError>;
  readonly logout: Effect.Effect<AuthSnapshot, SessionError>;
  readonly use: <A, E, R>(f: (session: AuthenticatedSession) => Effect.Effect<A, E, R>) => Effect.Effect<A, E | NotAuthenticated, R>;
}

export class SessionManager extends Context.Service<SessionManager, SessionManagerService>()("@muswag/shared/SessionManager") {}

export interface SessionManagerOptions {
  readonly coverSaveLocation: string;
}

type SessionDependencies = MuswagDatabase | MiniFs | Path | HttpClient.HttpClient | Crypto | CredentialsStore;
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

const makeSessionManager = (options: SessionManagerOptions) =>
  Effect.gen(function* () {
    const dependencies = yield* Effect.context<SessionDependencies>();
    const credentialsStore = yield* CredentialsStore;
    const db = yield* MuswagDatabase;
    const fs = yield* MiniFs;
    const path = yield* Path;
    const current = yield* ScopedRef.make<SessionState>(() => ({ _tag: "LoggedOut" }));
    const publicState = yield* SubscriptionRef.make<AuthSnapshot>({ _tag: "Initializing" });

    const acquire = (credentials: SessionCredentials, verify: boolean) => {
      const apiLayer = Layer.effect(SubsonicAPI, makeSubsonicAPI(toApiConfig(credentials)).pipe(Effect.tap((api) => (verify ? api.ping : Effect.void))));
      const authenticatedLayer = Layer.mergeAll(SyncManager.layerWithoutDependencies, CoverManagerLive(options.coverSaveLocation), PlaylistSyncManagerLive()).pipe(Layer.provideMerge(apiLayer));

      return Layer.build(authenticatedLayer).pipe(
        Effect.provide(dependencies),
        Effect.map((context): SessionState => ({
          _tag: "LoggedIn",
          session: {
            user: loggedInSnapshot(credentials),
            api: Context.get(context, SubsonicAPI),
            covers: Context.get(context, CoverManager),
            playlists: Context.get(context, PlaylistSyncManager),
            sync: Context.get(context, SyncManager),
          },
        })),
      );
    };

    const install = (credentials: SessionCredentials, verify: boolean, persist: boolean) =>
      ScopedRef.set(current, acquire(credentials, verify).pipe(Effect.tap(() => (persist ? credentialsStore.save(credentials) : Effect.void)))).pipe(
        Effect.andThen(SubscriptionRef.set(publicState, loggedInSnapshot(credentials))),
        Effect.as(loggedInSnapshot(credentials)),
      );

    const restore = credentialsStore.load.pipe(
      Effect.flatMap((credentials) =>
        credentials
          ? install(credentials, false, false).pipe(
              Effect.catch((cause) =>
                Effect.logError("Failed to restore the authenticated session", cause).pipe(
                  Effect.andThen(SubscriptionRef.set(publicState, { _tag: "LoggedOut" })),
                  Effect.as<AuthSnapshot>({ _tag: "LoggedOut" }),
                ),
              ),
            )
          : SubscriptionRef.set(publicState, { _tag: "LoggedOut" }).pipe(Effect.as<AuthSnapshot>({ _tag: "LoggedOut" })),
      ),
      Effect.catch((cause) =>
        Effect.logError("Failed to load stored credentials", cause).pipe(Effect.andThen(SubscriptionRef.set(publicState, { _tag: "LoggedOut" })), Effect.as<AuthSnapshot>({ _tag: "LoggedOut" })),
      ),
    );

    const clearCollections = Effect.sync(() => {
      const clear = (collection: { keys: () => IterableIterator<string | number>; delete: (keys: readonly (string | number)[]) => unknown }) => {
        const keys = [...collection.keys()];
        if (keys.length > 0) collection.delete(keys);
      };

      clear(db.playlists as never);
      clear(db.songs as never);
      clear(db.albums as never);
      clear(db.artists as never);
      clear(db.syncs as never);
      clear(db.syncState as never);
      clear(db.playerQueue as never);
      clear(db.covers as never);
    });

    const clearLocalData = Effect.forEach([...db.covers.values()], ({ fileName }) => fs.remove(path.join(options.coverSaveLocation, fileName)), {
      concurrency: 8,
      discard: true,
    }).pipe(Effect.ensuring(clearCollections));

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
      restore,
      login,
      logout,
      use,
    } satisfies SessionManagerService;
  });

export const SessionManagerLive = (options: SessionManagerOptions) => Layer.effect(SessionManager, makeSessionManager(options));
