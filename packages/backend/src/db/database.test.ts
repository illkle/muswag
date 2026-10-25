import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { afterEach, describe, expect, it } from "vitest";
import { Effect, ManagedRuntime } from "effect";

import { DatabaseLive, Db } from "./database.js";

let directory: string | undefined;
afterEach(() => {
  if (directory) rmSync(directory, { recursive: true, force: true });
});

describe("DatabaseLive", () => {
  it("drops what the mirror before it left in the file, before it migrates", async () => {
    directory = mkdtempSync(join(tmpdir(), "muswag-database-"));
    const file = join(directory, "library.db");
    const old = new DatabaseSync(file);
    // A file from before the migrations, with a capture trigger an old mirror kept in it and its change log.
    old.exec(`
      CREATE TABLE "__mirror_changes" (seq INTEGER PRIMARY KEY AUTOINCREMENT, tbl TEXT, op TEXT, key, value TEXT);
      CREATE TABLE "__mirror_changes_meta" (key TEXT PRIMARY KEY, value INTEGER NOT NULL);
      CREATE TABLE leftover (id TEXT PRIMARY KEY);
      CREATE TRIGGER "__mirror_changes__leftover_insert" AFTER INSERT ON leftover BEGIN INSERT INTO "__mirror_changes" (tbl, op, key) VALUES ('leftover', 'u', NEW.id); END;
    `);
    old.close();

    const runtime = ManagedRuntime.make(DatabaseLive(file));
    await runtime.runPromise(Effect.asVoid(Effect.service(Db)));
    await runtime.dispose();

    const opened = new DatabaseSync(file, { readOnly: true });
    const names = (opened.prepare(`SELECT name FROM sqlite_master WHERE name LIKE '%mirror%'`).all() as Array<{ name: string }>).map(({ name }) => name);
    opened.close();
    expect(names).toEqual([]);
  });
});
