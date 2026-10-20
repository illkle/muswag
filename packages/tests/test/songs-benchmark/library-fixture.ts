import { existsSync, mkdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";

/** The library the fixtures are made from: the dev app's, unless `MUSWAG_BENCH_SOURCE` names another. */
export const SOURCE_LIBRARY = process.env.MUSWAG_BENCH_SOURCE ?? resolve(import.meta.dirname, "../../../../apps/desktop/dev-library.db");

const FIXTURE_DIR = join(tmpdir(), "muswag-songs-benchmark");

/**
 * A copy of the source library with `songCount` songs: its songs and albums again and again, each copy
 * under new ids and with its number added to the titles, so the copies sort among the originals rather
 * than tying with them. Made once and kept in the temp directory.
 */
export function libraryWithSongs(songCount: number): string {
  if (!existsSync(SOURCE_LIBRARY)) throw new Error(`No library to build the fixture from at ${SOURCE_LIBRARY}; set MUSWAG_BENCH_SOURCE`);
  mkdirSync(FIXTURE_DIR, { recursive: true });
  const file = join(FIXTURE_DIR, `library-${songCount}-${Math.round(statSync(SOURCE_LIBRARY).mtimeMs)}.db`);
  if (existsSync(file)) return file;

  const source = new DatabaseSync(SOURCE_LIBRARY, { readOnly: true });
  source.exec(`VACUUM INTO '${file.replaceAll("'", "''")}'`);
  source.close();

  const db = new DatabaseSync(file);
  try {
    const columns = (table: string) => (db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map(({ name }) => name);
    const base = (db.prepare(`SELECT count(*) AS count FROM songs`).get() as { count: number }).count;
    const copies = Math.ceil(songCount / base) - 1;

    const renamed = (table: string, replace: Record<string, string>) => {
      const names = columns(table);
      return { list: names.map((name) => `"${name}"`).join(", "), select: names.map((name) => replace[name] ?? `"${name}"`).join(", ") };
    };
    const suffix = (column: string) => `CASE WHEN "${column}" IS NULL THEN NULL ELSE "${column}" || ' ' || $copy END`;
    const songsCopy = renamed("songs", {
      id: `id || '~' || $copy`,
      albumId: `CASE WHEN albumId IS NULL THEN NULL ELSE albumId || '~' || $copy END`,
      parent: `CASE WHEN parent IS NULL THEN NULL ELSE parent || '~' || $copy END`,
      title: suffix("title"),
      titleSortKey: `titleSortKey || ' ' || $copy`,
      // A library the app has opened since songs had them; one that has not gets them from the migration.
      artistOrderKey: `artistOrderKey || ' ' || $copy`,
      albumOrderKey: `albumOrderKey || ' ' || $copy`,
      album: suffix("album"),
    });
    const albumsCopy = renamed("albums", { id: `id || '~' || $copy`, name: suffix("name") });
    const insertSongs = db.prepare(`INSERT INTO songs (${songsCopy.list}) SELECT ${songsCopy.select} FROM songs WHERE instr(id, '~') = 0`);
    const insertAlbums = db.prepare(`INSERT INTO albums (${albumsCopy.list}) SELECT ${albumsCopy.select} FROM albums WHERE instr(id, '~') = 0`);

    db.exec("BEGIN");
    for (let copy = 1; copy <= copies; copy++) {
      insertSongs.run({ copy: String(copy) });
      insertAlbums.run({ copy: String(copy) });
    }
    db.prepare(`DELETE FROM songs WHERE rowid IN (SELECT rowid FROM songs ORDER BY rowid LIMIT -1 OFFSET ?)`).run(songCount);
    db.exec("COMMIT");
    db.exec("VACUUM");
  } catch (error) {
    db.close();
    rmSync(file, { force: true });
    throw error;
  }
  db.close();
  return file;
}
