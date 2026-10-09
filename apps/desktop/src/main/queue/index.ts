import type { PlayerHandle } from "../player/ipc";
import type { PlayerCommand } from "#shared/commands/player";
import { DbQueueStorage, type QueueTables } from "./db-queue-storage";
import { runtimeView } from "./player-port";
import { QueueManager } from "./queue-manager";
import { createQueueSources, type SourceDb } from "./source";
import type { UnplayableTrack } from "#shared/state/queue";

const playerCommand = (player: PlayerHandle, command: PlayerCommand) =>
  player.execute(command).then((result) => {
    if (!result.ok) throw new Error(result.message);
  });

/**
 * The playback queue, driving `player` with sources read from `library` and stored in `tables`.
 * `onUnplayable` is told the tracks that could not be played, for renderers to see.
 */
export function createQueue(options: { player: PlayerHandle; library: SourceDb; tables: QueueTables; onUnplayable?: (tracks: readonly UnplayableTrack[]) => void }): QueueManager {
  const { player } = options;
  return new QueueManager({
    ...(options.onUnplayable ? { onUnplayable: options.onUnplayable } : {}),
    player: {
      applyQueue: ({ items, select }) => playerCommand(player, { _tag: "ApplyQueue", items, select: select ? { ...select, positionSeconds: select.positionSeconds ?? 0 } : null }),
      restartCurrent: () => playerCommand(player, { _tag: "Restart" }),
      stop: () => playerCommand(player, { _tag: "Stop" }),
      getState: async () => runtimeView(await player.snapshot()),
      subscribe: (listener) => player.subscribe((snapshot) => listener(runtimeView(snapshot))),
    },
    sources: createQueueSources(options.library),
    // Stored in mirrored tables, which is also how renderers see the queue.
    storage: new DbQueueStorage(options.tables),
  });
}
