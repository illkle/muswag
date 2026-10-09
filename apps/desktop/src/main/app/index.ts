import { rm } from "node:fs/promises";
import { join } from "node:path";

import { BackendLive, LibraryQueries, SessionManager, type CoverOwner, type Db } from "@muswag/backend";
import { createElectronMainTransport } from "@muswag/tanstack-db-mirror/electron/main";
import type { MemoryMirrorService } from "@muswag/tanstack-db-mirror/server/memory";
import { SqliteMirror } from "@muswag/tanstack-db-mirror/server/sqlite";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { Cause, Effect, Exit, Layer, ManagedRuntime, Scope } from "effect";
import { FetchHttpClient } from "effect/http";
import type { IpcMain } from "electron";

import type { PlayerHandle } from "../player/ipc";
import { createQueue } from "../queue";
import type { SourceDb } from "../queue/source";
import { unplayableTracks } from "#shared/state/queue";
import { serveAppCommands } from "./commands";
import { COVER_DIRECTORY, MiniFsLive, safeStorageCipher } from "./platform";
import { makePlayerCredentialsSync, publishSession } from "./session";

export interface AppOptions {
  readonly databasePath: string;
  readonly userDataPath: string;
  readonly ipcMain: IpcMain;
  readonly player: PlayerHandle;
  /** Where renderers see the session and sync status; it must mirror `SESSION_TABLES`. */
  readonly stateMirror: MemoryMirrorService;
}

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

    yield* serveAppCommands({ ipcMain: options.ipcMain, queue, songsByIds: (ids) => run(LibraryQueries.songsByIds(ids)) });
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
  const backend = ManagedRuntime.make(BackendLive({ filename: options.databasePath, coverSaveLocation: COVER_DIRECTORY, cipher: safeStorageCipher }).pipe(Layer.provide(platform)));
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
  try {
    await backend.runPromise(makeApp(options).pipe(Scope.provide(scope)));
  } catch (cause) {
    await dispose();
    throw cause;
  }

  return {
    /** The file of a cover, relative to the app data directory: `CoverManager.ensure` of the session. Rejects without one. */
    coverPath: (owner: CoverOwner) => backend.runPromise(SessionManager.use((session) => session.use((active) => active.covers.ensure(owner)))),
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
    rm(join(userDataPath, COVER_DIRECTORY), { recursive: true, force: true }),
  ]);
}
