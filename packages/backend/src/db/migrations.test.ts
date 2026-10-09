import { execFileSync } from "node:child_process";
import { cpSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { getTableName } from "drizzle-orm";
import { getTableConfig } from "drizzle-orm/sqlite-core";
import { describe, expect, it } from "@effect/vitest";
import * as Schema from "@muswag/model";
import { Effect } from "effect";
import { SqlClient } from "effect/sql/SqlClient";

import config from "../../drizzle.config.ts";
import { renderMigrations } from "../../scripts/embed-migrations.ts";
import { TestDatabase } from "../test/index.js";

const packageRoot = fileURLToPath(new URL("../..", import.meta.url));

describe("migrations", () => {
  it("are embedded from the drizzle-kit output", () => {
    const embedded = readFileSync(fileURLToPath(new URL("./migrations.generated.ts", import.meta.url)), "utf8");
    // Out of date: run `pnpm db:generate`.
    expect(embedded).toBe(renderMigrations());
  });

  it("leave nothing for drizzle-kit to generate from the schema", () => {
    // Whatever the schema says that the migrations do not, drizzle-kit writes as a further migration:
    // a column, and just as well an index, a type, a default or a constraint. It gets a copy of the
    // migrations to write to, with the options of `drizzle.config.ts`.
    const migrations = join(packageRoot, config.out!);
    const copy = mkdtempSync(join(tmpdir(), "muswag-migrations-"));
    try {
      cpSync(migrations, copy, { recursive: true });
      execFileSync(process.execPath, [join(packageRoot, "node_modules/drizzle-kit/bin.cjs"), "generate", "--dialect", config.dialect, "--schema", String(config.schema), "--out", copy], {
        cwd: packageRoot,
        stdio: "pipe",
      });
      // Out of date: run `pnpm db:generate`.
      expect(readdirSync(copy)).toEqual(readdirSync(migrations));
    } finally {
      rmSync(copy, { recursive: true, force: true });
    }
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
