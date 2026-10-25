import { rm } from "node:fs/promises";
import { join } from "node:path";

import { BackendLive, LibraryQueries, SessionManager, type CoverOwner, type Db } from "@muswag/backend";
import { createElectronMainTransport } from "@muswag/tanstack-db-mirror/electron/main";
import type { MemoryMirrorService } from "@muswag/tanstack-db-mirror/server/memory";
import { SqliteMirror } from "@muswag/tanstack-db-mirror/server/sqlite";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { Cause, Effect, Exit, Layer, ManagedRuntime, Scope } from "effect";
import { FetchHttpClient } from "effect/http";

import type { AppIpc } from "../app-page";
import type { PlayerHandle } from "../player/ipc";
import { createQueue } from "../queue";
import { startLibrarySearch } from "../search/library-search";
import type { SourceDb } from "../queue/source";
import { unplayableTracks } from "#shared/state/queue";
import { serveAppCommands, type AppUpdates } from "./commands";
import { coverDirectoryOf, MiniFsLive } from "./platform";
import { makePlayerCredentialsSync, publishSession } from "./session";

export interface AppOptions {
  readonly databasePath: string;
  readonly userDataPath: string;
  readonly ipcMain: AppIpc;
  readonly player: PlayerHandle;
  readonly updates: AppUpdates;
  /** Where renderers see the session and sync status; it must mirror `SESSION_TABLES`. */
  readonly stateMirror: MemoryMirrorService;
  /** The search worker's script (`search/search-worker.ts`), which runs apart from main's. */
  readonly searchWorkerPath: string;
  /** Calls `listener` whenever a window of the app gains focus, until the returned function is called. */
  readonly onWindowFocus?: (listener: () => void) => () => void;
}

/** A library sync younger than this is not repeated when a window gains focus. */
const SYNC_ON_FOCUS_AFTER_MS = 10 * 60_000;

/**
 * Main's side of the app: the library database and its mirror, the session with its sync services,
 * playlist commands and the playback queue, reachable from renderers through `app:command`.
 */
const makeApp = (options: AppOptions) =>
  Effect.gen(function* () {
    const session = yield* SessionManager;
    const mirror = yield* SqliteMirror;
    const run = Effect.runPromiseWith(yield* Effect.context<Db | SqliteMirror>());

    yield* mirror.serve(createElectronMainTransport({ ipcMain: options.ipcMain }));

    const library: SourceDb = {
      sourceWindow: (ref, at, size) => run(LibraryQueries.sourceWindow(ref, at, size)),
      subscribe: (listener) => mirror.subscribe(listener),
    };
    const queue = yield* Effect.acquireRelease(
      Effect.sync(() =>
        createQueue({
          player: options.player,
          library,
          tables: {
            load: () => run(LibraryQueries.loadQueue),
            write: (change) => run(LibraryQueries.writeQueue(change)),
            clear: () => run(LibraryQueries.clearQueue),
          },
          onUnplayable: (tracks) => void Effect.runPromise(options.stateMirror.replace(unplayableTracks, tracks)).catch((cause) => console.error("[queue] failed to publish unplayable tracks", cause)),
        }),
      ),
      (manager) => Effect.sync(() => manager.dispose()),
    );

    const syncPlayerCredentials = makePlayerCredentialsSync(session, options.player);
    yield* publishSession(session, options.stateMirror, syncPlayerCredentials);

    // Playback resumes only once the session it streams from is back.
    yield* session.restore.pipe(
      Effect.andThen(syncPlayerCredentials),
      Effect.andThen(Effect.promise(() => queue.restore())),
      Effect.catchCause((cause) => Effect.logError("Startup restoration failed", cause)),
      Effect.forkScoped,
    );

    const search = yield* Effect.acquireRelease(
      Effect.sync(() => startLibrarySearch({ databasePath: options.databasePath, workerPath: options.searchWorkerPath, subscribe: (listener) => mirror.subscribe(listener) })),
      (search) => Effect.promise(() => search.dispose()),
    );

    yield* serveAppCommands({ ipcMain: options.ipcMain, queue, player: options.player, updates: options.updates, songsByIds: (ids) => run(LibraryQueries.songsByIds(ids)), search: search.search });

    // Coming back to the app catches up with the server, unless a sync did a moment ago.
    const { onWindowFocus } = options;
    if (onWindowFocus) {
      const syncIfStale = session.use((active) => active.library.syncIfStale(SYNC_ON_FOCUS_AFTER_MS)).pipe(Effect.ignore);
      yield* Effect.acquireRelease(
        Effect.sync(() => onWindowFocus(() => void Effect.runFork(syncIfStale))),
        (unsubscribe) => Effect.sync(unsubscribe),
      );
    }
    return { queue };
  });

/** What SQLite says of a file that is not a database, is damaged, or was left by a build with another schema. */
const UNUSABLE_FILE = /already exists|no such (table|column)|duplicate column|not a database|malformed|unsupported file format/i;

/** The library database could not be opened or brought up to date. Its message is what SQLite said. */
export class LibraryDatabaseError extends Error {
  /**
   * Whether deleting the file would help. It would not for a database that is locked by another
   * process, or cannot be read or written where it is: that one may be perfectly good.
   */
  readonly resettable: boolean;

  constructor(
    readonly databasePath: string,
    cause: unknown,
  ) {
    super(rootMessage(cause), { cause });
    this.name = "LibraryDatabaseError";
    this.resettable = UNUSABLE_FILE.test(this.message);
  }
}

/** The message at the bottom of a chain of causes: the layers above it only say which statement failed. */
const rootMessage = (error: unknown): string => {
  const failure = Cause.isCause(error) ? Cause.squash(error) : error;
  const inner = (failure as { readonly cause?: unknown } | null)?.cause;
  if (inner !== undefined && inner !== null) return rootMessage(inner);
  return failure instanceof Error ? failure.message : String(failure);
};

/**
 * Starts main's side of the app once the database is migrated and the session is being restored.
 * Rejects with a `LibraryDatabaseError` when the database is what failed.
 */
export async function startApp(options: AppOptions) {
  const platform = Layer.mergeAll(NodeServices.layer, FetchHttpClient.layer, MiniFsLive(options.userDataPath));
  const backend = ManagedRuntime.make(BackendLive({ filename: options.databasePath, coverSaveLocation: coverDirectoryOf(options.databasePath, options.userDataPath) }).pipe(Layer.provide(platform)));
  try {
    // Building the backend opens and migrates the database; nothing else in it reaches outside the process.
    await backend.runPromise(Effect.void);
  } catch (cause) {
    await backend.dispose();
    throw new LibraryDatabaseError(options.databasePath, cause);
  }

  const scope = Effect.runSync(Scope.make());
  const dispose = async () => {
    await Effect.runPromise(Scope.close(scope, Exit.void));
    await backend.dispose();
  };
  const { queue } = await backend.runPromise(makeApp(options).pipe(Scope.provide(scope))).catch(async (cause: unknown) => {
    await dispose();
    throw cause;
  });

  return {
    /** The file of a cover, relative to the app data directory: `CoverManager.ensure` of the session. Rejects without one. */
    coverPath: (owner: CoverOwner) => backend.runPromise(SessionManager.use((session) => session.use((active) => active.covers.ensure(owner)))),
    /** Stores where playback has got to and stops the queue following the player: the first step of quitting, see `QueueManager.close`. */
    closeQueue: () => queue.close(),
    dispose,
  };
}

/**
 * Deletes the library database and the covers downloaded for it. Both are copies of what the server
 * has; the stored login and the playlist changes not yet sent go with them.
 */
export async function resetLibrary({ databasePath, userDataPath }: Pick<AppOptions, "databasePath" | "userDataPath">): Promise<void> {
  await Promise.all([
    ...[databasePath, `${databasePath}-wal`, `${databasePath}-shm`].map((file) => rm(file, { force: true })),
    rm(join(userDataPath, coverDirectoryOf(databasePath, userDataPath)), { recursive: true, force: true }),
  ]);
}
