import { BackendLive, LibraryQueries, SessionManager, type Db } from "@muswag/backend";
import { createElectronMainTransport } from "@muswag/tanstack-db-mirror/electron/main";
import type { MemoryMirrorService } from "@muswag/tanstack-db-mirror/server/memory";
import { SqliteMirror } from "@muswag/tanstack-db-mirror/server/sqlite";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { Effect, Layer, ManagedRuntime } from "effect";
import { FetchHttpClient } from "effect/http";
import type { IpcMain } from "electron";
import type { IpcListener } from "@electron-toolkit/typed-ipc/main";

import type { MuswagMainIpc } from "#shared/ipc";
import type { PlayerHandle } from "../player/ipc";
import { createQueue } from "../queue";
import type { SourceDb } from "../queue/source";
import { serveAppCommands } from "./commands";
import { COVER_DIRECTORY, MiniFsLive, safeStorageCipher } from "./platform";
import { makePlayerCredentialsSync, publishSession } from "./session";

export interface AppOptions {
  readonly databasePath: string;
  readonly userDataPath: string;
  readonly ipcMain: IpcMain;
  readonly mainIpc: IpcListener<MuswagMainIpc>;
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

    yield* serveAppCommands({ ipcMain: options.ipcMain, mainIpc: options.mainIpc, queue, songsByIds: (ids) => run(LibraryQueries.songsByIds(ids)) });
  });

/** Starts main's side of the app once the database is migrated and the session is being restored. */
export async function startApp(options: AppOptions) {
  const platform = Layer.mergeAll(NodeServices.layer, FetchHttpClient.layer, MiniFsLive(options.userDataPath));
  const services = BackendLive({ filename: options.databasePath, coverSaveLocation: COVER_DIRECTORY, cipher: safeStorageCipher }).pipe(Layer.provide(platform));
  const runtime = ManagedRuntime.make(Layer.effectDiscard(makeApp(options)).pipe(Layer.provideMerge(services)));
  await runtime.runPromise(Effect.void);
  return { dispose: () => runtime.dispose() };
}
