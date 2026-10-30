import { Worker } from "node:worker_threads";

import type { SongIdList } from "@muswag/backend";

import { songIdList, type PackedSongIds } from "./song-ids";
import type { SongIdsWorkerData } from "./song-ids-worker";

/** Every song id of the library at `databasePath`, read by `song-ids-worker.ts`, which is at `workerPath` as built next to main's. */
export function readSongIds(workerPath: string, databasePath: string): Promise<SongIdList> {
  return new Promise((resolve, reject) => {
    const worker = new Worker(workerPath, { workerData: { databasePath } satisfies SongIdsWorkerData });
    worker.once("message", (packed: PackedSongIds) => resolve(songIdList(packed)));
    worker.once("error", reject);
    worker.once("exit", () => reject(new Error("The song ids could not be read.")));
  });
}
