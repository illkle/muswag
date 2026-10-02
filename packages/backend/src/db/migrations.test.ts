import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { getTableName } from "drizzle-orm";
import { getTableConfig } from "drizzle-orm/sqlite-core";
import { describe, expect, it } from "@effect/vitest";
import * as Schema from "@muswag/model";
import { Effect } from "effect";
import { SqlClient } from "effect/sql/SqlClient";

import { renderMigrations } from "../../scripts/embed-migrations.ts";
import { TestDatabase } from "../test/index.js";

describe("migrations", () => {
  it("are embedded from the drizzle-kit output", () => {
    const embedded = readFileSync(fileURLToPath(new URL("./migrations.generated.ts", import.meta.url)), "utf8");
    // Out of date: run `pnpm db:generate`.
    expect(embedded).toBe(renderMigrations());
  });

  it.effect("create every column of the schema", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient;
      const tables = Object.values(Schema).filter((value) => typeof value === "object" && value !== null && Symbol.for("drizzle:IsDrizzleTable") in value);
      expect(tables.length).toBeGreaterThan(0);
      for (const table of tables as Array<Parameters<typeof getTableConfig>[0]>) {
        const name = getTableName(table);
        const columns = yield* sql<{ name: string }>`SELECT name FROM pragma_table_info(${name})`;
        expect({ table: name, columns: columns.map((column) => column.name).sort() }).toEqual({
          table: name,
          columns: getTableConfig(table)
            .columns.map((column) => column.name)
            .sort(),
        });
      }
    }).pipe(Effect.provide(TestDatabase())),
  );
});
