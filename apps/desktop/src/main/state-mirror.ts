import { createElectronMainTransport, type IpcMainLike } from "@muswag/tanstack-db-mirror/electron/main";
import { MemoryMirror } from "@muswag/tanstack-db-mirror/server/memory";
import { Effect, Exit, Scope } from "effect";

import { STATE_MIRROR_CHANNEL, STATE_TABLES } from "#shared/player-state";

/**
 * Serves main's in-memory state to renderers, on a channel of its own. Read-only: renderers change it
 * only through commands.
 */
export async function startStateMirror(ipcMain: IpcMainLike) {
  const scope = Effect.runSync(Scope.make());
  const mirror = await Effect.runPromise(
    Effect.gen(function* () {
      const mirror = yield* MemoryMirror.make({ tables: STATE_TABLES, readOnly: true });
      yield* mirror.serve(createElectronMainTransport({ ipcMain, channel: STATE_MIRROR_CHANNEL }));
      return mirror;
    }).pipe(Scope.provide(scope)),
  );
  return { mirror, dispose: () => Effect.runPromise(Scope.close(scope, Exit.void)) };
}
