import { describe, expect, it } from "@effect/vitest";
import { songs, titleSortKey } from "@muswag/model";
import { Effect } from "effect";
import { SqlClient } from "effect/sql/SqlClient";

import { apiSong, seed, TestDatabase } from "../test/index.js";
import { Db } from "./database.js";
import { fillSortKeys } from "./sort-keys.js";

describe("fillSortKeys", () => {
  it.effect("gives songs stored before sort keys existed theirs", () =>
    Effect.gen(function* () {
      const db = yield* Db;
      const sql = yield* SqlClient;
      yield* seed({ songs: [apiSong("a", "album", { title: "Élan" }), apiSong("b", "album", { title: "Kept" })] });
      yield* sql`UPDATE songs SET titleSortKey = '' WHERE id = 'a'`;

      yield* fillSortKeys(db);

      const rows = yield* db.select({ id: songs.id, key: songs.titleSortKey }).from(songs).orderBy(songs.id);
      expect(rows).toEqual([
        { id: "a", key: titleSortKey("Élan") },
        { id: "b", key: titleSortKey("Kept") },
      ]);
    }).pipe(Effect.provide(TestDatabase())),
  );
});
