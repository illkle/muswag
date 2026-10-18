import type { MirrorTableInfo } from "../../drizzle.js";

export const quoteIdentifier = (name: string) => `"${name.replaceAll('"', '""')}"`;
const quoteLiteral = (value: string) => `'${value.replaceAll("'", "''")}'`;

// A value produced by json(), json_set(), -> etc. keeps SQLite's JSON subtype inside a trigger
// and would be embedded by json_object() as JSON instead of as a string; concatenation drops it.
const plainValue = (expression: string) => `CASE WHEN typeof(${expression}) = 'text' THEN ${expression} || '' ELSE ${expression} END`;

/** `json_object('col', <ref>."col", ...)` over the columns of `info`. */
export const rowJson = (info: MirrorTableInfo, ref: string) => `json_object(${info.columns.map(({ name }) => `${quoteLiteral(name)}, ${plainValue(`${ref}.${quoteIdentifier(name)}`)}`).join(", ")})`;

// `key` has no declared type so SQLite keeps integer and text keys as they were stored.
export const createChangeLogSql = (changeLog: string) => `CREATE TABLE IF NOT EXISTS ${quoteIdentifier(changeLog)} (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  tbl TEXT NOT NULL,
  op TEXT NOT NULL,
  key NOT NULL,
  value TEXT
)`;

/** Every capture trigger of a server is named with this prefix, so a start only drops its own. */
export const triggerPrefix = (changeLog: string) => `${changeLog}__`;

export const triggerNames = (info: MirrorTableInfo, changeLog: string) => ({
  insert: `${triggerPrefix(changeLog)}${info.name}_insert`,
  update: `${triggerPrefix(changeLog)}${info.name}_update`,
  delete: `${triggerPrefix(changeLog)}${info.name}_delete`,
});

/**
 * The capture triggers of a table, which capture the columns of `info`. They are temporary: they belong
 * to the server's connection and are gone with it, so a migration never meets a trigger that names a
 * column it is changing.
 */
export function createTriggerSql(info: MirrorTableInfo, changeLog: string): ReadonlyArray<string> {
  const names = triggerNames(info, changeLog);
  const table = `main.${quoteIdentifier(info.name)}`;
  const log = `main.${quoteIdentifier(changeLog)}`;
  const tableLiteral = quoteLiteral(info.name);
  const pk = quoteIdentifier(info.primaryKey.name);
  const changed = info.columns.map(({ name }) => `OLD.${quoteIdentifier(name)} IS NOT NEW.${quoteIdentifier(name)} COLLATE BINARY`).join(" OR ");

  return [
    `CREATE TEMP TRIGGER ${quoteIdentifier(names.insert)} AFTER INSERT ON ${table} BEGIN
  INSERT INTO ${log} (tbl, op, key, value) VALUES (${tableLiteral}, 'u', NEW.${pk}, ${rowJson(info, "NEW")});
END`,
    // An update that leaves every mirrored column as it was, such as an upsert of an unchanged row or a
    // change to omitted columns only, is not mirrored. A primary-key change is mirrored as a delete of
    // the old key followed by an upsert of the new one. BINARY so that a case-only change of a NOCASE
    // column, the key among them, still counts as a change.
    `CREATE TEMP TRIGGER ${quoteIdentifier(names.update)} AFTER UPDATE ON ${table} WHEN ${changed} BEGIN
  INSERT INTO ${log} (tbl, op, key, value) SELECT ${tableLiteral}, 'd', OLD.${pk}, NULL WHERE OLD.${pk} IS NOT NEW.${pk} COLLATE BINARY;
  INSERT INTO ${log} (tbl, op, key, value) VALUES (${tableLiteral}, 'u', NEW.${pk}, ${rowJson(info, "NEW")});
END`,
    `CREATE TEMP TRIGGER ${quoteIdentifier(names.delete)} AFTER DELETE ON ${table} BEGIN
  INSERT INTO ${log} (tbl, op, key, value) VALUES (${tableLiteral}, 'd', OLD.${pk}, NULL);
END`,
  ];
}
