import { encodeValue, type MirrorColumn, type MirrorTableInfo } from "../../drizzle.js";
import type { MirrorExpression, MirrorOrder } from "../../protocol.js";
import { MirrorRequestError } from "../shared.js";
import { quoteIdentifier } from "./sql.js";

export type SqlFragment = { readonly sql: string; readonly params: ReadonlyArray<unknown> };

const COMPARISONS: Record<string, string> = { eq: "=", gt: ">", gte: ">=", lt: "<", lte: "<=" };

const refused = (message: string) => new MirrorRequestError({ message });

/** A row property of `info` as a column; the mirror only knows the columns it sends. */
function columnOf(info: MirrorTableInfo, expression: MirrorExpression): MirrorColumn | undefined {
  if (expression.type !== "ref") return undefined;
  const [property, ...rest] = expression.path;
  if (property === undefined || rest.length > 0) throw refused(`Only top-level properties can be queried, not ${expression.path.join(".")}`);
  const column = info.columnsByKey.get(property);
  if (!column) throw refused(`Unknown column "${property}" for table "${info.name}"`);
  return column;
}

/**
 * `expression` as an SQLite condition over the columns of `info`. Constants compared with a column are
 * encoded as that column stores them, so a boolean or a JSON value matches what is in the table.
 */
export function whereSql(info: MirrorTableInfo, expression: MirrorExpression): SqlFragment {
  const params: Array<unknown> = [];

  const operand = (expression: MirrorExpression, against: MirrorColumn | undefined): string => {
    if (expression.type === "val") {
      params.push(against ? encodeValue(against.column, expression.value) : expression.value);
      return "?";
    }
    const column = columnOf(info, expression);
    if (column) return quoteIdentifier(column.name);
    return condition(expression);
  };

  const condition = (expression: MirrorExpression): string => {
    if (expression.type !== "func") throw refused(`Expected a condition, got a ${expression.type}`);
    const { name, args } = expression;
    const [left, right] = args;

    const comparison = COMPARISONS[name];
    if (comparison && left && right) {
      const leftColumn = columnOf(info, left);
      const rightColumn = columnOf(info, right);
      return `${operand(left, rightColumn)} ${comparison} ${operand(right, leftColumn)}`;
    }
    switch (name) {
      case "and":
      case "or":
        if (args.length === 0) return name === "and" ? "1" : "0";
        return `(${args.map(condition).join(name === "and" ? " AND " : " OR ")})`;
      case "not":
        if (!left) break;
        return `NOT (${condition(left)})`;
      case "isNull":
        if (!left) break;
        return `${operand(left, undefined)} IS NULL`;
      // A row read from the table has every column, a missing value as null, so nothing in it is undefined.
      case "isUndefined":
        if (!left) break;
        return "0";
      case "in": {
        if (!left || right?.type !== "val" || !Array.isArray(right.value)) break;
        const column = columnOf(info, left);
        const values = right.value as ReadonlyArray<unknown>;
        if (values.length === 0) return "0";
        // One array parameter instead of one per value: SQLite caps the parameters of a statement.
        params.push(JSON.stringify(values.map((value) => (column ? encodeValue(column.column, value) : value))));
        return `${operand(left, undefined)} IN (SELECT value FROM json_each(?))`;
      }
      case "ilike":
        if (!left || !right) break;
        // SQLite's LIKE ignores the case of ASCII letters only. TanStack DB's `like`, which keeps case, is not offered.
        return `${operand(left, undefined)} LIKE ${operand(right, undefined)}`;
    }
    throw refused(`The mirror cannot query with "${name}" over ${args.length} arguments`);
  };

  return { sql: condition(expression), params };
}

/**
 * `orderBy` as an SQLite ORDER BY. Text compares by code unit, which is TanStack DB's `lexical`
 * string sort, so both put rows in the same order.
 */
export function orderBySql(info: MirrorTableInfo, orderBy: ReadonlyArray<MirrorOrder>): string {
  return orderBy
    .map(({ property, direction, nulls }) => {
      const column = info.columnsByKey.get(property);
      if (!column) throw refused(`Unknown column "${property}" for table "${info.name}"`);
      return `${quoteIdentifier(column.name)} ${direction === "desc" ? "DESC" : "ASC"} NULLS ${nulls === "first" ? "FIRST" : "LAST"}`;
    })
    .join(", ");
}
