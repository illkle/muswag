import type { MirrorTableInfo } from "../../drizzle.js";

export const quoteIdentifier = (name: string) => `"${name.replaceAll('"', '""')}"`;
const quoteLiteral = (value: string) => `'${value.replaceAll("'", "''")}'`;

// A value produced by json(), json_set(), -> etc. keeps SQLite's JSON subtype inside a trigger
// and would be embedded by json_object() as JSON instead of as a string; concatenation drops it.
const plainValue = (expression: string) => `CASE WHEN typeof(${expression}) = 'text' THEN ${expression} || '' ELSE ${expression} END`;

/** `json_object('col', <ref>."col", ...)` over every column of the table. */
export const rowJson = (info: MirrorTableInfo, ref: string) => `json_object(${info.columns.map(({ name }) => `${quoteLiteral(name)}, ${plainValue(`${ref}.${quoteIdentifier(name)}`)}`).join(", ")})`;

// `key` has no declared type so SQLite keeps integer and text keys as they were stored.
export const createChangeLogSql = (changeLog: string) => `CREATE TABLE IF NOT EXISTS ${quoteIdentifier(changeLog)} (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  tbl TEXT NOT NULL,
  op TEXT NOT NULL,
  key NOT NULL,
  value TEXT
)`;

/** Every capture trigger of a server is named with this prefix, so restarts only drop their own. */
export const triggerPrefix = (changeLog: string) => `${changeLog}__`;

export const triggerNames = (info: MirrorTableInfo, changeLog: string) => ({
  insert: `${triggerPrefix(changeLog)}${info.name}_insert`,
  update: `${triggerPrefix(changeLog)}${info.name}_update`,
  delete: `${triggerPrefix(changeLog)}${info.name}_delete`,
});

export function createTriggerSql(info: MirrorTableInfo, changeLog: string): ReadonlyArray<string> {
  const names = triggerNames(info, changeLog);
  const table = quoteIdentifier(info.name);
  const log = quoteIdentifier(changeLog);
  const tableLiteral = quoteLiteral(info.name);
  const pk = quoteIdentifier(info.primaryKey.name);

  return [
    `CREATE TRIGGER ${quoteIdentifier(names.insert)} AFTER INSERT ON ${table} BEGIN
  INSERT INTO ${log} (tbl, op, key, value) VALUES (${tableLiteral}, 'u', NEW.${pk}, ${rowJson(info, "NEW")});
END`,
    // A primary-key change is mirrored as a delete of the old key followed by an upsert of the new
    // one. BINARY so a case-only change of a NOCASE key still counts as a new key.
    `CREATE TRIGGER ${quoteIdentifier(names.update)} AFTER UPDATE ON ${table} BEGIN
  INSERT INTO ${log} (tbl, op, key, value) SELECT ${tableLiteral}, 'd', OLD.${pk}, NULL WHERE OLD.${pk} IS NOT NEW.${pk} COLLATE BINARY;
  INSERT INTO ${log} (tbl, op, key, value) VALUES (${tableLiteral}, 'u', NEW.${pk}, ${rowJson(info, "NEW")});
END`,
    `CREATE TRIGGER ${quoteIdentifier(names.delete)} AFTER DELETE ON ${table} BEGIN
  INSERT INTO ${log} (tbl, op, key, value) VALUES (${tableLiteral}, 'd', OLD.${pk}, NULL);
END`,
  ];
}
