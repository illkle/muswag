import type { AuthenticatedSession, SessionManager } from "@muswag/backend";
import { IDLE_LIBRARY_SYNC, IDLE_PLAYLIST_SYNC, type AuthSnapshot, type PlaylistSyncStatus } from "@muswag/model";
import type { MemoryMirrorService } from "@muswag/tanstack-db-mirror/server/memory";
import { Effect, Queue, Redacted, Stream } from "effect";

import { auth, librarySync, playlistSync } from "#shared/state/session";
import type { PlayerHandle } from "../player/ipc";

type Session = typeof SessionManager.Service;

/** A stream of the logged-in session's values, switching whenever the session changes. */
const followSession = <A>(session: Session, loggedOut: A, select: (session: AuthenticatedSession) => Stream.Stream<A>) =>
  session.changes.pipe(
    Stream.switchMap((snapshot: AuthSnapshot) =>
      snapshot._tag === "LoggedIn" ? Stream.unwrap(session.use((active) => Effect.succeed(select(active)))).pipe(Stream.catch(() => Stream.make(loggedOut))) : Stream.make(loggedOut),
    ),
  );

const playlistStatusStream = (session: AuthenticatedSession): Stream.Stream<PlaylistSyncStatus> =>
  Stream.callback<PlaylistSyncStatus>((queue) =>
    Effect.gen(function* () {
      Queue.offerUnsafe(queue, yield* session.playlists.getStatus);
      const unsubscribe = yield* session.playlists.subscribe((status) => {
        Queue.offerUnsafe(queue, status);
      });
      yield* Effect.addFinalizer(() => Effect.sync(unsubscribe));
    }),
  );

/**
 * Sends the session's credentials to the player. Every credentials change preempts the player's
 * in-flight operation, so only real changes are sent.
 */
export const makePlayerCredentialsSync = (session: Session, player: PlayerHandle) => {
  let pushed: string | undefined;
  return session.credentials.pipe(
    Effect.flatMap((credentials) => {
      const key = JSON.stringify(credentials);
      if (key === pushed) return Effect.void;
      pushed = key;
      return Effect.promise(() => player.setCredentials(credentials ? { url: credentials.url, username: credentials.username, password: Redacted.make(credentials.password) } : null));
    }),
    Effect.asVoid,
  );
};

/**
 * Publishes the session and its sync status to `state`, which must mirror `SESSION_TABLES`, for as long
 * as the scope lasts. `onSessionChange` runs after every session change is published.
 */
export const publishSession = (session: Session, state: MemoryMirrorService, onSessionChange: Effect.Effect<void>) =>
  Effect.gen(function* () {
    // Renderers wait for the session to leave Initializing before they show anything.
    yield* state.write(
      Effect.all([
        state.upsert(auth, { id: "auth", value: { _tag: "Initializing" } }),
        state.upsert(librarySync, { id: "library_sync", value: IDLE_LIBRARY_SYNC }),
        state.upsert(playlistSync, { id: "playlist_sync", value: IDLE_PLAYLIST_SYNC }),
      ]),
    );
    yield* session.changes.pipe(
      Stream.runForEach((snapshot) => state.upsert(auth, { id: "auth", value: snapshot }).pipe(Effect.andThen(onSessionChange))),
      Effect.forkScoped,
    );
    yield* followSession(session, IDLE_LIBRARY_SYNC, (active) => active.library.changes).pipe(
      Stream.runForEach((status) => state.upsert(librarySync, { id: "library_sync", value: status })),
      Effect.forkScoped,
    );
    yield* followSession(session, IDLE_PLAYLIST_SYNC, playlistStatusStream).pipe(
      Stream.runForEach((status) => state.upsert(playlistSync, { id: "playlist_sync", value: status })),
      Effect.forkScoped,
    );
  });
