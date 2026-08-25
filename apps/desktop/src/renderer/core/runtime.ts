import { db } from "#/lib/db-renderer.ts";
import { CoverManagerLive, FileSystemError, MiniFs, MuswagDatabase, PlaylistSyncManagerLive, SessionManager, SubsonicAPILive } from "@muswag/shared";
import { SyncManager } from "@muswag/shared";
import { Effect, Layer, ManagedRuntime } from "effect";
import { BrowserCrypto } from "@effect/platform-browser";
import { FetchHttpClient } from "effect/unstable/http";
import { FilesystemIpc } from "#/lib/ipc.ts";
import { layer as PathLayer } from "effect/Path";

const baseLayer = Layer.mergeAll(FetchHttpClient.layer, BrowserCrypto.layer);
const dbLayer = Layer.succeed(MuswagDatabase, db);
const credentialManager = Layer.effect(SessionManager, SessionManager.make);
const miniFs = Layer.succeed(MiniFs, {
  writeFile: (path, data) =>
    Effect.tryPromise({
      try: () => FilesystemIpc.writeFile(path, data),
      catch: (cause) =>
        new FileSystemError({
          cause: String(cause),
          message: `Failed to write ${path}`,
        }),
    }),
  remove: (path) =>
    Effect.tryPromise({
      try: () => FilesystemIpc.remove(path),
      catch: (cause) =>
        new FileSystemError({
          cause: String(cause),
          message: `Failed to remove ${path}`,
        }),
    }),
});

const merged = Layer.mergeAll(baseLayer, dbLayer, credentialManager, miniFs, PathLayer);

const coverManager = CoverManagerLive("/covers");
const playlistManager = PlaylistSyncManagerLive();
const syncManager = SyncManager.layerWithoutDependencies;

const runtime = ManagedRuntime.make(merged);
