import { DatabaseSync } from "node:sqlite";
import { parentPort, workerData } from "node:worker_threads";

import { packSongIds } from "./song-ids.ts";

export type SongIdsWorkerData = { readonly databasePath: string };

/**
 * Reads every song id once and ends. It takes half a second at a million songs, and on main's thread
 * that would hold up every window's input and IPC, and what the player says, meanwhile. WAL lets it
 * read beside main's writes through a connection of its own.
 */
const { databasePath } = workerData as SongIdsWorkerData;
const database = new DatabaseSync(databasePath, { readOnly: true });
const rows = database.prepare("SELECT id FROM songs ORDER BY id").all() as unknown as ReadonlyArray<{ id: string }>;
database.close();

const packed = packSongIds(rows.map(({ id }) => id));
parentPort!.postMessage(packed, [packed.bytes.buffer as ArrayBuffer, packed.ends.buffer as ArrayBuffer]);
