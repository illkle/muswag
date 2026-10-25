import type { AuthenticatedSession, SessionManager } from "@muswag/backend";
import { IDLE_LIBRARY_SYNC, IDLE_PLAYLIST_SYNC, type AuthSnapshot } from "@muswag/model";
import { Effect, Redacted, Stream } from "effect";

import type { AppStateHub } from "../app-state";
import type { PlayerHandle } from "../player/ipc";

type Session = typeof SessionManager.Service;

/** A stream of the logged-in session's values, switching whenever the session changes. */
const followSession = <A>(session: Session, loggedOut: A, select: (session: AuthenticatedSession) => Stream.Stream<A>) =>
  session.changes.pipe(
    Stream.switchMap((snapshot: AuthSnapshot) =>
      snapshot._tag === "LoggedIn" ? Stream.unwrap(session.use((active) => Effect.succeed(select(active)))).pipe(Stream.catch(() => Stream.make(loggedOut))) : Stream.make(loggedOut),
    ),
  );

/** Sends the session's credentials to the player, which signs stream URLs with them. The player ignores the ones it already has. */
export const makePlayerCredentialsSync = (session: Session, player: PlayerHandle) =>
  session.credentials.pipe(
    Effect.flatMap((credentials) => Effect.promise(() => player.setCredentials(credentials ? { ...credentials, token: Redacted.make(credentials.token) } : null))),
    Effect.asVoid,
  );

/**
 * Publishes the session and its sync status to `state` for as long as the scope lasts.
 * `onSessionChange` runs after every session change is published.
 */
export const publishSession = (session: Session, state: AppStateHub, onSessionChange: Effect.Effect<void>) =>
  Effect.gen(function* () {
    // Renderers wait for the session to leave Initializing before they show anything.
    yield* Effect.sync(() => {
      state.set("auth", { _tag: "Initializing" });
      state.set("librarySync", IDLE_LIBRARY_SYNC);
      state.set("playlistSync", IDLE_PLAYLIST_SYNC);
    });
    yield* session.changes.pipe(
      Stream.runForEach((snapshot) => Effect.sync(() => state.set("auth", snapshot)).pipe(Effect.andThen(onSessionChange))),
      Effect.forkScoped,
    );
    yield* followSession(session, IDLE_LIBRARY_SYNC, (active) => active.library.changes).pipe(
      Stream.runForEach((status) => Effect.sync(() => state.set("librarySync", status))),
      Effect.forkScoped,
    );
    yield* followSession(session, IDLE_PLAYLIST_SYNC, (active) => active.playlists.changes).pipe(
      Stream.runForEach((status) => Effect.sync(() => state.set("playlistSync", status))),
      Effect.forkScoped,
    );
  });
