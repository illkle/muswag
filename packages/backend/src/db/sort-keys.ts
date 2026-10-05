import { songs, titleSortKey } from "@muswag/model";
import { and, eq, ne } from "drizzle-orm";
import { Effect } from "effect";

import type { Database } from "./database.js";

/** Gives the songs stored before sort keys existed theirs. A sync writes the key of every song it stores. */
export const fillSortKeys = (db: Database) =>
  db.transaction((tx) =>
    Effect.gen(function* () {
      const unkeyed = yield* tx
        .select({ id: songs.id, title: songs.title })
        .from(songs)
        .where(and(eq(songs.titleSortKey, ""), ne(songs.title, "")));
      for (const { id, title } of unkeyed) {
        yield* tx
          .update(songs)
          .set({ titleSortKey: titleSortKey(title) })
          .where(eq(songs.id, id));
      }
    }),
  );
