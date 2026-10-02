import { playerQueue, playlists, songs, type QueueManagerSnapshot } from "@muswag/model";
import { asc, eq, inArray } from "drizzle-orm";
import { Effect } from "effect";

import { Db } from "../db/database.js";
import { chunks, STATEMENT_IDS } from "../db/upsert.js";

/** Reads main itself needs, such as the playback queue's sources. */
export const LibraryQueries = {
  playlist: (playlistId: string) => Db.use((db) => db.select().from(playlists).where(eq(playlists.id, playlistId))).pipe(Effect.map((rows) => rows[0])),

  songsByIds: (ids: ReadonlyArray<string>) =>
    Db.use((db) =>
      Effect.forEach(chunks([...new Set(ids)], STATEMENT_IDS), (chunk) =>
        db
          .select()
          .from(songs)
          .where(inArray(songs.id, [...chunk])),
      ),
    ).pipe(Effect.map((pages) => pages.flat())),

  /** The album's songs in playback order. */
  albumSongs: (albumId: string) => Db.use((db) => db.select().from(songs).where(eq(songs.albumId, albumId)).orderBy(asc(songs.discNumber), asc(songs.track), asc(songs.id))),

  /** The persisted queue, unvalidated. */
  loadQueue: Db.use((db) => db.select().from(playerQueue).where(eq(playerQueue.id, 1))).pipe(Effect.map((rows): unknown => rows[0]?.snapshot)),

  saveQueue: (snapshot: QueueManagerSnapshot) =>
    Db.use((db) => db.insert(playerQueue).values({ id: 1, snapshot }).onConflictDoUpdate({ target: playerQueue.id, set: { snapshot } })).pipe(Effect.asVoid),

  clearQueue: Db.use((db) => db.delete(playerQueue)).pipe(Effect.asVoid),
};
