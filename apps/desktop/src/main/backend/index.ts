import { BackendLive, LibraryQueries, PlaylistCommands, SessionManager, type AuthenticatedSession, type Db } from "@muswag/backend";
import type { AuthSnapshot, LibrarySyncStatus, PlaylistSyncStatus, Song } from "@muswag/model";
import { createElectronMainTransport } from "@muswag/tanstack-db-mirror/electron/main";
import type { MemoryMirrorService } from "@muswag/tanstack-db-mirror/server/memory";
import { SqliteMirror } from "@muswag/tanstack-db-mirror/server/sqlite";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { Cause, Effect, Exit, Layer, ManagedRuntime, Queue, Redacted, Schema, Stream } from "effect";
import { FetchHttpClient } from "effect/http";
import type { IpcMain } from "electron";
import type { IpcListener } from "@electron-toolkit/typed-ipc/main";

import { AppCommandArgs, type AppCommandName, type AppCommandReply, type AppCommandResults } from "#shared/app-contract";
import { auth, librarySync, playlistSync } from "#shared/app-state";
import type { MuswagMainIpc } from "#shared/ipc";
import { runtimeView } from "#shared/player-snapshot";
import type { CommandResult, PlayerCommand, PlayerSnapshot } from "#shared/player-contract";
import { DbQueueStorage } from "../queue/db-queue-storage";
import { QueueManager } from "../queue/queue-manager";
import { createQueueSourceFactory, type SourceDb } from "../queue/source/db-sources";
import { MiniFsLive, safeStorageCipher } from "./platform";

/** What the backend needs from the main-process player. */
export interface PlayerHandle {
  readonly execute: (command: PlayerCommand) => Promise<CommandResult>;
  readonly setCredentials: (credentials: { url: string; username: string; password: Redacted.Redacted<string> } | null) => Promise<CommandResult>;
  readonly snapshot: () => Promise<PlayerSnapshot>;
  readonly subscribe: (listener: (snapshot: PlayerSnapshot) => void) => () => void;
}

export interface BackendOptions {
  readonly databasePath: string;
  readonly userDataPath: string;
  readonly ipcMain: IpcMain;
  readonly mainIpc: IpcListener<MuswagMainIpc>;
  readonly player: PlayerHandle;
  /** Where renderers see the session and sync status; it must mirror `APP_TABLES`. */
  readonly stateMirror: MemoryMirrorService;
}

const playerCommand = (player: PlayerHandle, command: PlayerCommand) =>
  player.execute(command).then((result) => {
    if (!result.ok) throw new Error(result.issue.message);
  });

const IDLE_LIBRARY_SYNC: LibrarySyncStatus = { running: null, error: null, lastSyncedAt: null };
const IDLE_PLAYLIST_SYNC: PlaylistSyncStatus = { state: "idle", error: null, lastSyncedAt: null };

/** A stream of the logged-in session's values, switching whenever the session changes. */
const followSession = <A>(session: typeof SessionManager.Service, loggedOut: A, select: (session: AuthenticatedSession) => Stream.Stream<A>) =>
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
 * Main's side of the app: the library database and its mirror, the session with its sync services,
 * playlist commands and the playback queue, reachable from renderers through `app:command`.
 */
const makeBackend = (options: BackendOptions) =>
  Effect.gen(function* () {
    const session = yield* SessionManager;
    const commands = yield* PlaylistCommands;
    const mirror = yield* SqliteMirror;
    const run = Effect.runPromiseWith(yield* Effect.context<Db | SqliteMirror>());
    const state = options.stateMirror;
    // Renderers wait for the session to leave Initializing before they show anything.
    yield* state.write(
      Effect.all([
        state.upsert(auth, { id: "auth", value: { _tag: "Initializing" } }),
        state.upsert(librarySync, { id: "library_sync", value: IDLE_LIBRARY_SYNC }),
        state.upsert(playlistSync, { id: "playlist_sync", value: IDLE_PLAYLIST_SYNC }),
      ]),
    );

    yield* mirror.serve(createElectronMainTransport({ ipcMain: options.ipcMain }));

    // ---- Queue ----

    const sourceDb: SourceDb = {
      playlist: (playlistId) => run(LibraryQueries.playlist(playlistId)),
      songsByIds: (ids) => run(LibraryQueries.songsByIds(ids)),
      albumSongs: (albumId) => run(LibraryQueries.albumSongs(albumId)),
      subscribe: (listener) => mirror.subscribe(listener),
    };
    const queue = yield* Effect.acquireRelease(
      Effect.sync(
        () =>
          new QueueManager({
            player: {
              applyQueue: ({ snapshot, select }) =>
                playerCommand(options.player, { _tag: "ApplyQueue", items: snapshot.items, select: select ? { ...select, positionSeconds: select.positionSeconds ?? 0 } : null }),
              restartCurrent: () => playerCommand(options.player, { _tag: "Restart" }),
              stop: () => playerCommand(options.player, { _tag: "Stop" }),
              getState: async () => runtimeView(await options.player.snapshot()),
              subscribe: (listener) => options.player.subscribe((snapshot) => listener(runtimeView(snapshot))),
            },
            sources: createQueueSourceFactory(sourceDb),
            // Stored in mirrored tables, which is also how renderers see the queue.
            storage: new DbQueueStorage({
              load: () => run(LibraryQueries.loadQueue),
              write: (change) => run(LibraryQueries.writeQueue(change)),
              clear: () => run(LibraryQueries.clearQueue),
            }),
          }),
      ),
      (manager) => Effect.sync(() => manager.dispose()),
    );

    /** Songs in the order of `ids`, skipping any that are gone. */
    const songsInOrder = async (ids: readonly string[]): Promise<Song[]> => {
      const byId = new Map((await sourceDb.songsByIds([...new Set(ids)])).map((song) => [song.id, song]));
      return ids.flatMap((id) => byId.get(id) ?? []);
    };

    // ---- Session and playback credentials ----

    // Every credentials change preempts the player's in-flight operation, so only real changes are sent.
    let pushedCredentials: string | undefined;
    const syncPlayerCredentials = session.credentials.pipe(
      Effect.flatMap((credentials) => {
        const key = JSON.stringify(credentials);
        if (key === pushedCredentials) return Effect.void;
        pushedCredentials = key;
        return Effect.promise(() => options.player.setCredentials(credentials ? { url: credentials.url, username: credentials.username, password: Redacted.make(credentials.password) } : null));
      }),
      Effect.asVoid,
    );

    yield* session.changes.pipe(
      Stream.runForEach((snapshot) => state.upsert(auth, { id: "auth", value: snapshot }).pipe(Effect.andThen(syncPlayerCredentials))),
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

    // Playback resumes only once the session it streams from is back.
    yield* session.restore.pipe(
      Effect.andThen(syncPlayerCredentials),
      Effect.andThen(Effect.promise(() => queue.restore())),
      Effect.catchCause((cause) => Effect.logError("Startup restoration failed", cause)),
      Effect.forkScoped,
    );

    // ---- Commands ----

    const written = <A, E>(effect: Effect.Effect<A, E>) => effect.pipe(Effect.flatMap((value) => mirror.position.pipe(Effect.map((position) => ({ value, position })))));

    const handlers: { [K in AppCommandName]: (...args: (typeof AppCommandArgs)[K]["Type"]) => Effect.Effect<AppCommandResults[K], unknown> } = {
      "session:login": (credentials) => session.login(credentials),
      // Logging out must work even when playback cannot be stopped cleanly.
      "session:logout": () =>
        Effect.tryPromise(() => queue.clear()).pipe(
          Effect.catch((cause) => Effect.logWarning("Failed to stop playback before logout", cause)),
          Effect.andThen(session.logout),
        ),
      "library:sync": (mode) => session.use((active) => active.library.sync(mode)),
      "library:cancelSync": () => session.use((active) => active.library.cancel).pipe(Effect.catchTag("NotAuthenticated", () => Effect.void)),
      "library:refreshStats": (target) => session.use((active) => active.library.refreshStats(target)),
      "covers:ensure": (target) => session.use((active) => active.covers.ensure(target)),
      "covers:repair": (target, failedPath) => session.use((active) => active.covers.repair(target, failedPath)),
      "playlists:create": (input) =>
        written(
          commands.create({
            name: input.name,
            ...(input.comment !== undefined && { comment: input.comment }),
            ...(input.public !== undefined && { public: input.public }),
            ...(input.songIds && { songIds: [...input.songIds] }),
          }),
        ),
      "playlists:rename": (id, name) => written(commands.rename(id, name)),
      "playlists:setComment": (id, comment) => written(commands.setComment(id, comment)),
      "playlists:setVisibility": (id, isPublic) => written(commands.setVisibility(id, isPublic)),
      "playlists:addEntries": (id, songIds, beforeEntryId) => written(commands.addEntries(id, songIds, beforeEntryId)),
      "playlists:removeEntry": (id, entryId) => written(commands.removeEntry(id, entryId)),
      "playlists:moveEntry": (id, entryId, beforeEntryId) => written(commands.moveEntry(id, entryId, beforeEntryId)),
      "playlists:delete": (id) => written(commands.delete(id)),
      "playlists:sync": () => session.use((active) => active.playlists.sync),
      "queue:playSource": (ref, key) => Effect.promise(() => queue.playSource({ ...ref }, key)),
      "queue:enqueue": (songIds) => Effect.promise(() => songsInOrder(songIds).then((tracks) => queue.enqueue(tracks))),
      "queue:removeQueued": (key) => Effect.promise(() => queue.removeQueued(key)),
      "queue:clearQueued": () => Effect.promise(() => queue.clearQueued()),
      "queue:next": () => Effect.promise(() => queue.next()),
      "queue:previous": () => Effect.promise(() => queue.previous()),
    };

    const execute = <K extends AppCommandName>(name: K, input: unknown): Effect.Effect<AppCommandReply<K>> =>
      Schema.decodeUnknownEffect(AppCommandArgs[name])(input).pipe(
        Effect.mapError(() => ({ _tag: "InvalidCommand", message: `Invalid arguments for ${name}` })),
        Effect.flatMap((args) => (handlers[name] as (...args: ReadonlyArray<unknown>) => Effect.Effect<AppCommandResults[K], unknown>)(...(args as ReadonlyArray<unknown>))),
        Effect.exit,
        Effect.flatMap((exit) => {
          if (Exit.isSuccess(exit)) return Effect.succeed<AppCommandReply<K>>({ ok: true, value: exit.value });
          const error = Cause.squash(exit.cause) as { _tag?: unknown; message?: unknown };
          return Effect.logError(`Command ${name} failed`, exit.cause).pipe(
            Effect.as<AppCommandReply<K>>({
              ok: false,
              error: { tag: typeof error?._tag === "string" ? error._tag : "Error", message: typeof error?.message === "string" ? error.message : String(error) },
            }),
          );
        }),
      );

    yield* Effect.acquireRelease(
      Effect.sync(() => {
        options.mainIpc.handle("app:command", (_event, name, args) => {
          if (!Object.hasOwn(AppCommandArgs, name)) return { ok: false, error: { tag: "InvalidCommand", message: `Unknown command ${name}` } };
          return run(execute(name as AppCommandName, args));
        });
      }),
      () =>
        Effect.sync(() => {
          options.ipcMain.removeHandler("app:command");
        }),
    );
  });

/** Starts the backend once the database is migrated and the session is being restored. */
export async function startBackend(options: BackendOptions) {
  const platform = Layer.mergeAll(NodeServices.layer, FetchHttpClient.layer, MiniFsLive(options.userDataPath));
  const services = BackendLive({ filename: options.databasePath, coverSaveLocation: "covers", cipher: safeStorageCipher }).pipe(Layer.provide(platform));
  const runtime = ManagedRuntime.make(Layer.effectDiscard(makeBackend(options)).pipe(Layer.provideMerge(services)));
  await runtime.runPromise(Effect.void);
  return { dispose: () => runtime.dispose() };
}
