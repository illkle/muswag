import { execFileSync } from "node:child_process";
import { cpSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { DatabaseSync } from "node:sqlite";

import { getTableName } from "drizzle-orm";
import { getTableConfig } from "drizzle-orm/sqlite-core";
import { describe, expect, it } from "@effect/vitest";
import * as Schema from "@muswag/model";
import { Effect } from "effect";
import { SqlClient } from "effect/sql/SqlClient";

import config from "../../drizzle.config.ts";
import { renderMigrations } from "../../scripts/embed-migrations.ts";
import { TestDatabase } from "../test/index.js";
import { migrations } from "./migrations.generated.js";

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

  it("keep whose library it is when the stored password gives way to a token", () => {
    const db = new DatabaseSync(":memory:");
    const [init, ...later] = migrations;
    for (const statement of init!.sql) db.exec(statement);
    db.exec("INSERT INTO credentials (id, url, username, password, encrypted) VALUES (1, 'https://music.example', 'alice', 'c2VjcmV0', 1)");

    for (const statement of later.flatMap((migration) => migration.sql)) db.exec(statement);

    // Without a token the app starts at the login form, and a login as alice keeps the library.
    expect(db.prepare("SELECT * FROM credentials").all()).toEqual([{ id: 1, url: "https://music.example", username: "alice", salt: "", token: "" }]);
    db.close();
  });

  it("give the songs already stored the order keys a sync would, as far as SQLite can make them", () => {
    const db = new DatabaseSync(":memory:");
    const at = migrations.findIndex((migration) => migration.name.endsWith("_songs_order_keys"));
    for (const statement of migrations.slice(0, at).flatMap((migration) => migration.sql)) db.exec(statement);
    // Text SQLite lowercases and trims as `sortKey` does: ASCII, with spaces around it.
    const stored = [
      { id: "a", title: "A", artist: " The Band ", album: "First LP", albumId: "al-1", discNumber: 1, track: 12 },
      { id: "b", title: "B", artist: null, album: null, albumId: null, discNumber: null, track: null },
      { id: "c", title: "C", artist: "x", album: "y", albumId: "al-2", discNumber: -1, track: 1234567 },
    ];
    const insert = db.prepare("INSERT INTO songs (id, title, isDir, artist, album, albumId, discNumber, track) VALUES (?, ?, 0, ?, ?, ?, ?, ?)");
    for (const song of stored) insert.run(song.id, song.title, song.artist, song.album, song.albumId, song.discNumber, song.track);

    for (const statement of migrations.slice(at).flatMap((migration) => migration.sql)) db.exec(statement);

    expect(db.prepare("SELECT id, artistOrderKey, albumOrderKey FROM songs ORDER BY id").all()).toEqual(
      stored.map((song) => ({ id: song.id, artistOrderKey: Schema.artistOrderKey(song), albumOrderKey: Schema.albumOrderKey(song) })),
    );
    db.close();
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
