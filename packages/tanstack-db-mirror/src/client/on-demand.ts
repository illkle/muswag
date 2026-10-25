import { and, deepEquals, parseOrderByExpression, type ChangeMessageOrDeleteKeyMessage, type IR, type LoadSubsetOptions, type ParsedOrderBy, type SyncConfig } from "@tanstack/db";

import type { MirrorChangeBatch, MirrorExpression, MirrorKey, MirrorOrder, MirrorPosition, MirrorQuery, MirrorResults, MirrorRow } from "../protocol.js";
import type { Interned } from "./intern.js";
import { MirrorClientDisposedError, type MirrorClient } from "./mirror-client.js";

/** The least time between the starts of two refreshes. */
const REFRESH_INTERVAL_MS = 250;
/** How long a table has to go without changes before the subsets any of its changes can touch are read again. */
const QUIET_MS = 300;
/** The longest such a subset waits while the changes keep coming, as they do during a library sync. */
const MAX_WAIT_MS = 2_000;
const RETRY_BASE_DELAY_MS = 500;
const RETRY_MAX_DELAY_MS = 30_000;

/**
 * The sync of an on-demand mirror collection, which serves the tables a server sends as keys only
 * (`SqliteMirror`'s `keyOnlyTables`): it holds only the rows its live queries ask for. TanStack DB hands
 * each query's demand to `loadSubset`, which reads it from the server as a query; the rows stay while a
 * loaded subset holds them.
 *
 * A change says which row changed, not how, so the collection cannot tell which subsets it concerns,
 * except for a subset that asks for rows by key: only a change to one of its keys concerns that one. A
 * change runs the query of every subset it concerns again, and what comes back replaces what that subset
 * held: rows that differ from the collection's are written, rows no subset holds any more are deleted.
 * Refreshes run one at a time, at most one per REFRESH_INTERVAL_MS. A subset asked for by key is read
 * again at once; any other once the table has been quiet for QUIET_MS, or at the latest MAX_WAIT_MS after
 * its first change, so a library sync that sends batch after batch costs a query every few seconds.
 */
export function onDemandSync<Row extends object, Key extends string | number>(options: {
  readonly client: MirrorClient;
  readonly table: string;
  /** The row property that holds the key. */
  readonly primaryKey: string;
  readonly getKey: (row: Row) => Key;
  readonly decode: (row: MirrorRow, interned: Interned) => Row | undefined;
  /** Every change up to `position` is in the collection. */
  readonly onPosition: (position: MirrorPosition) => void;
  /** The collection's rows may be stale until the next `onPosition`. */
  readonly onInvalidate: () => void;
  readonly onCleanup: () => void;
}): SyncConfig<Row, Key> {
  const { client, table, primaryKey, getKey, decode } = options;

  type Subset = {
    readonly request: MirrorQuery;
    /** The only keys the subset can hold, when it asks for rows by key; `null` when any row may be its. */
    readonly bound: ReadonlySet<MirrorKey> | null;
    /** The rows of the last result applied to the subset. */
    keys: Set<Key>;
    /** That result's position, so an older result that arrives after it does not replace it. */
    seq: number;
    /** The first change that concerns the subset and that it has not been read again for; `null` when there is none. */
    stale: number | null;
    /** When it went stale, `-Infinity` when it is to be read again as soon as it can. */
    staleSince: number;
  };
  /**
   * A row the collection holds: the object written to it, which TanStack DB keeps as the synced row, the
   * number of subsets that hold it, and the position it is known as of.
   */
  type Held = { value: Row; holders: number; seq: number };
  type Write = ChangeMessageOrDeleteKeyMessage<Row, Key>;

  return {
    rowUpdateMode: "full",
    sync: ({ begin, write, commit, markReady, markError }) => {
      let active = true;
      let ready = false;
      /** The epoch of the server the collection is connected to, `null` while it (re)connects. */
      let epoch: number | null = null;
      /** The last change the stream has delivered. */
      let streamSeq = 0;
      let connectGeneration = 0;
      let connectFailures = 0;
      const subsets = new Map<LoadSubsetOptions, Subset>();
      const held = new Map<Key, Held>();
      /**
       * Rows deleted since the queries in flight were read, by the position of the delete: a result read
       * before it would bring the row back. Forgotten once every query has been sent after it.
       */
      const deleted = new Map<Key, number>();

      /** Loads whose query is out. */
      let loading = 0;
      let refreshing = false;
      let refreshTimer: ReturnType<typeof setTimeout> | undefined;
      /** When `refreshTimer` fires. */
      let refreshAt = Infinity;
      let lastRefreshAt = -Infinity;
      /** When the last change to the table arrived. */
      let lastChangeAt = -Infinity;
      /** After a failed refresh, the next one waits until then. */
      let retryAt = -Infinity;
      let refreshFailures = 0;

      /** Writes `writes` in one sync transaction. The receipt settles once they are visible. */
      const flush = (writes: ReadonlyArray<Write>) => {
        if (writes.length === 0) return true;
        begin();
        for (const message of writes) write(message);
        return commit();
      };

      /** A position before every change of the stream: after a reset, the rows of a stale subset belong to another one. */
      const BEFORE_STREAM = 0;

      // A negative position says the rows held are from before the stream: nothing of it can be reached yet.
      const reach = (seq: number) => {
        if (epoch !== null && seq >= 0) options.onPosition({ epoch, seq });
      };

      /** How far the collection has every change: up to the stream, but not past a change a subset has not been read again for. */
      const settledSeq = () => {
        let seq = streamSeq;
        for (const subset of subsets.values()) if (subset.stale !== null) seq = Math.min(seq, subset.stale - 1);
        return seq;
      };

      const markStale = (subset: Subset, seq: number, since: number) => {
        subset.stale = Math.min(subset.stale ?? Infinity, seq);
        subset.staleSince = Math.min(subset.staleSince, since);
      };

      /** When a stale subset is to be read again. */
      const dueAt = (subset: Subset) => (subset.bound ? subset.staleSince : Math.min(lastChangeAt + QUIET_MS, subset.staleSince + MAX_WAIT_MS));

      // With no query out, nothing read before a delete can bring its row back.
      const forgetDeletes = () => {
        if (loading === 0 && !refreshing) deleted.clear();
      };

      /** Makes `subset` hold the rows of `result`. The keys it lets go of are added to `orphans`. */
      const apply = (subset: Subset, result: MirrorResults["query"], writes: Array<Write>, orphans: Set<Key>, interned: Interned) => {
        const keys = new Set<Key>();
        for (const raw of result.rows) {
          const value = decode(raw, interned);
          if (value === undefined) continue;
          const key = getKey(value);
          if (result.seq < (deleted.get(key) ?? -1)) continue;
          keys.add(key);
          const row = held.get(key);
          if (!row) {
            held.set(key, { value, holders: 0, seq: result.seq });
            // Full-row updates upsert, which also covers a delete of the key still queued behind a user transaction.
            writes.push({ type: "update", value });
          } else if (result.seq >= row.seq) {
            row.seq = result.seq;
            // The rows a refresh brings back are mostly the ones the collection has; writing those again
            // would make every live query over them recompute. Both sides are rows as decoded, without
            // TanStack DB's virtual `$` properties.
            if (deepEquals(row.value, value)) continue;
            row.value = value;
            writes.push({ type: "update", value });
          }
        }
        for (const key of keys) {
          if (!subset.keys.has(key)) held.get(key)!.holders++;
        }
        for (const key of subset.keys) {
          if (keys.has(key)) continue;
          const row = held.get(key);
          if (row && --row.holders === 0) orphans.add(key);
        }
        subset.keys = keys;
        subset.seq = result.seq;
      };

      // A key one subset let go of may have been taken by another applied after it.
      const release = (orphans: Iterable<Key>, writes: Array<Write>) => {
        for (const key of orphans) {
          if (held.get(key)?.holders !== 0) continue;
          held.delete(key);
          writes.push({ type: "delete", key });
        }
      };

      /** Sets the timer for the next refresh of a stale subset, unless one is set that fires as soon. */
      const schedule = () => {
        // A refresh that is out schedules the next when it is done; while reconnecting, `connect` does.
        if (!active || refreshing || epoch === null) return;
        let at = Infinity;
        for (const subset of subsets.values()) if (subset.stale !== null) at = Math.min(at, dueAt(subset));
        if (at === Infinity) return;
        at = Math.max(at, lastRefreshAt + REFRESH_INTERVAL_MS, retryAt);
        if (refreshTimer !== undefined) {
          if (refreshAt <= at) return;
          clearTimeout(refreshTimer);
        }
        refreshAt = at;
        refreshTimer = setTimeout(() => void refresh(), Math.max(0, at - Date.now()));
      };

      /** Runs the request of every subset that is due again, and replaces what each holds with the result. */
      const refresh = async () => {
        refreshTimer = undefined;
        refreshAt = Infinity;
        // While reconnecting there is nothing to compare positions with; `connect` asks again.
        if (!active || refreshing || epoch === null) return;
        const now = Date.now();
        const targets = Array.from(subsets).filter(([, subset]) => subset.stale !== null && dueAt(subset) <= now);
        if (targets.length === 0) return schedule();
        refreshing = true;
        lastRefreshAt = now;
        const startEpoch = epoch;
        const startSeq = streamSeq;
        // Changes that arrive from now on find the subsets fresh and mark them again, unless the read had them.
        const previous = targets.map(([, subset]) => subset.stale!);
        for (const [, subset] of targets) {
          subset.stale = null;
          subset.staleSince = Infinity;
        }
        let failure: unknown;
        try {
          const outcomes = await Promise.allSettled(targets.map(([, subset]) => client.request("query", subset.request)));
          const writes: Array<Write> = [];
          const orphans = new Set<Key>();
          const interned: Interned = new Map();
          outcomes.forEach((outcome, index) => {
            // After a reset, even one a result below causes, the rows read belong to the old stream.
            if (!active || epoch !== startEpoch) return;
            const [demand, subset] = targets[index]!;
            // A subset that could not be read is as stale as before, and read again once the retry is due.
            const retry = (error: unknown) => {
              failure ??= error;
              markStale(subset, previous[index]!, -Infinity);
            };
            if (outcome.status === "rejected") return retry(outcome.reason);
            const result = outcome.value;
            if (result.epoch !== epoch) {
              // A newer epoch resets the client and with it this collection; an older one came from a
              // server that has been replaced, so the subset is read again.
              client.observeEpoch(result.epoch);
              return retry(new Error(`A query was answered by a server of epoch ${result.epoch}, not ${String(epoch)}`));
            }
            // An unloaded subset holds nothing any more; a load that answered after this read is newer.
            if (subsets.get(demand) !== subset || result.seq < subset.seq) return;
            apply(subset, result, writes, orphans, interned);
          });
          release(orphans, writes);
          // Not awaited: the writes may stay queued behind a user transaction that waits for this refresh's position.
          flush(writes);
        } catch (error) {
          failure ??= error;
          for (const [index, [, subset]] of targets.entries()) markStale(subset, previous[index]!, -Infinity);
        } finally {
          refreshing = false;
        }
        if (!active) return;
        // After a reset every subset is stale; once reconnected they are read again, now if `connect` has
        // already run, else when it does.
        if (epoch !== startEpoch) return schedule();
        if (failure !== undefined && !(failure instanceof MirrorClientDisposedError)) {
          console.error(`[tanstack-db-mirror] failed to refresh the on-demand rows of "${table}"`, failure);
          retryAt = Date.now() + Math.min(RETRY_MAX_DELAY_MS, RETRY_BASE_DELAY_MS * 2 ** refreshFailures++);
          return schedule();
        }
        refreshFailures = 0;
        retryAt = -Infinity;
        // Queries sent from now on are read after these deletes. A load still in flight may have been
        // sent before them; it is at most one round trip behind, and the refresh its change asks for follows.
        for (const [key, seq] of deleted) if (seq <= startSeq) deleted.delete(key);
        forgetDeletes();
        // The queries were sent after every change up to `startSeq` had arrived, so their rows have them;
        // a later change that concerns a subset has made it stale again.
        reach(settledSeq());
        schedule();
      };

      const applyBatch = (batch: MirrorChangeBatch) => {
        if (batch.epoch !== epoch) return;
        streamSeq = batch.toSeq;
        const writes: Array<Write> = [];
        const now = Date.now();
        for (const change of batch.changes) {
          if (change.table !== table) continue;
          lastChangeAt = now;
          const key = change.key as Key;
          for (const subset of subsets.values()) {
            // A read at or after the change has it already.
            if (change.seq > subset.seq && (subset.bound === null || subset.bound.has(key))) markStale(subset, change.seq, now);
          }
          if (change.type !== "delete") continue;
          // A deleted row is in no subset's result any more, so it goes at once; the refresh brings in
          // whatever takes its place in a window. Only a query that is out can bring it back.
          if (loading > 0 || refreshing) deleted.set(key, change.seq);
          const row = held.get(key);
          if (!row || change.seq <= row.seq) continue;
          held.delete(key);
          for (const subset of subsets.values()) subset.keys.delete(key);
          writes.push({ type: "delete", key });
        }
        flush(writes);
        schedule();
        // A refresh that is out reaches its position when it is done.
        if (!refreshing) reach(settledSeq());
      };

      const connect = async () => {
        const generation = ++connectGeneration;
        const isCurrent = () => active && generation === connectGeneration;
        try {
          await client.ensureConnected();
        } catch (error) {
          if (!isCurrent()) return;
          if (!ready) markError(error);
          if (error instanceof MirrorClientDisposedError) return;
          if (ready) console.error(`[tanstack-db-mirror] failed to reconnect the on-demand rows of "${table}"`, error);
          setTimeout(
            () => {
              if (isCurrent()) void connect();
            },
            Math.min(RETRY_MAX_DELAY_MS, RETRY_BASE_DELAY_MS * 2 ** connectFailures++),
          );
          return;
        }
        const position = client.position;
        // Another reset came in meanwhile; the connect it started takes over.
        if (!isCurrent() || position === null) return;
        connectFailures = 0;
        epoch = position.epoch;
        streamSeq = position.seq;
        if (!ready) {
          ready = true;
          markReady();
        }
        schedule();
        if (!refreshing) reach(settledSeq());
      };

      const unsubscribe = client.subscribe((event) => {
        if (!active) return;
        if (event.type === "batch") return applyBatch(event.batch);
        // The stream restarted or lost changes, so every held row may be stale. TanStack DB still
        // considers the subsets loaded and would never ask for them again: keep them, and read them
        // again once reconnected. Positions of another server say nothing about the rows held.
        epoch = null;
        options.onInvalidate();
        for (const subset of subsets.values()) {
          subset.seq = -1;
          markStale(subset, BEFORE_STREAM, -Infinity);
        }
        for (const row of held.values()) row.seq = -1;
        void connect();
      });
      void connect();

      const unloadSubset = (demand: LoadSubsetOptions) => {
        const subset = subsets.get(demand);
        if (!subset) return;
        subsets.delete(demand);
        const writes: Array<Write> = [];
        for (const key of subset.keys) {
          const row = held.get(key);
          if (!row || --row.holders > 0) continue;
          held.delete(key);
          writes.push({ type: "delete", key });
        }
        flush(writes);
        // A stale subset no longer holds the position back.
        if (!refreshing) reach(settledSeq());
      };

      const loadSubset = (demand: LoadSubsetOptions): Promise<void> => {
        const request = queryOf(table, demand);
        const subset: Subset = { request, bound: request.where ? keyBound(request.where, primaryKey) : null, keys: new Set(), seq: -1, stale: null, staleSince: Infinity };
        subsets.set(demand, subset);
        return (async () => {
          loading++;
          try {
            await client.ensureConnected();
            const result = await client.request("query", subset.request);
            // An unloaded subset takes nothing in; one a refresh filled meanwhile has newer rows.
            if (!active || subsets.get(demand) !== subset || result.seq < subset.seq) return;
            if (result.epoch !== epoch) {
              // A newer epoch resets the client, and the refresh after it fills the subset; an older one
              // came from a server that has been replaced.
              client.observeEpoch(result.epoch);
              markStale(subset, BEFORE_STREAM, -Infinity);
              schedule();
              return;
            }
            const writes: Array<Write> = [];
            const orphans = new Set<Key>();
            apply(subset, result, writes, orphans, new Map());
            release(orphans, writes);
            await flush(writes);
          } catch (error) {
            // A subset that failed to load is not refreshed: its request would most likely fail again.
            if (subsets.get(demand) === subset) unloadSubset(demand);
            throw error;
          } finally {
            loading--;
            forgetDeletes();
          }
        })();
      };

      return {
        loadSubset,
        unloadSubset,
        cleanup: () => {
          active = false;
          if (refreshTimer !== undefined) clearTimeout(refreshTimer);
          unsubscribe();
          options.onCleanup();
        },
      };
    },
  };
}

/** The server query that reads `demand`. Throws for an order the server cannot reproduce. */
function queryOf(table: string, demand: LoadSubsetOptions): MirrorQuery {
  const where = demand.cursor ? (demand.where ? and(demand.where, demand.cursor.whereFrom) : demand.cursor.whereFrom) : demand.where;
  const order = parseOrderByExpression(demand.orderBy);
  return {
    table,
    where: where ? toWire(where) : undefined,
    orderBy: order.length ? order.map(toWireOrder) : undefined,
    limit: demand.limit,
    // A cursor stands in for the rows before it.
    offset: demand.cursor ? undefined : demand.offset,
  };
}

/**
 * The keys a row has to have to match `where`, when it asks for rows by key: `eq` or `in` on the key,
 * alone or in an `and` or an `or`. `null` when a row with any key may match.
 */
export function keyBound(where: MirrorExpression, primaryKey: string): ReadonlySet<MirrorKey> | null {
  if (where.type !== "func") return null;
  const isKey = (expression: MirrorExpression | undefined) => expression?.type === "ref" && expression.path.length === 1 && expression.path[0] === primaryKey;
  const [left, right] = where.args;
  switch (where.name) {
    case "eq": {
      const value = isKey(left) ? right : isKey(right) ? left : undefined;
      return value?.type === "val" && isMirrorKey(value.value) ? new Set([value.value]) : null;
    }
    case "in":
      return isKey(left) && right?.type === "val" && Array.isArray(right.value) && right.value.every(isMirrorKey) ? new Set(right.value) : null;
    case "and": {
      // Every condition has to hold, so the keys of any one bound the rest.
      let smallest: ReadonlySet<MirrorKey> | null = null;
      for (const arg of where.args) {
        const bound = keyBound(arg, primaryKey);
        if (bound && (!smallest || bound.size < smallest.size)) smallest = bound;
      }
      return smallest;
    }
    case "or": {
      if (where.args.length === 0) return null;
      const keys = new Set<MirrorKey>();
      for (const arg of where.args) {
        const bound = keyBound(arg, primaryKey);
        if (!bound) return null;
        for (const key of bound) keys.add(key);
      }
      return keys;
    }
    default:
      return null;
  }
}

const isMirrorKey = (value: unknown): value is MirrorKey => typeof value === "string" || typeof value === "number";

/** TanStack DB's expression as the protocol carries it. Properties are read off the collection's own rows. */
export function toWire(expression: IR.BasicExpression): MirrorExpression {
  switch (expression.type) {
    case "ref":
      return { type: "ref", path: expression.path.map(String) };
    case "val":
      return { type: "val", value: expression.value };
    case "func":
      return { type: "func", name: expression.name, args: expression.args.map(toWire) };
  }
}

function toWireOrder(order: ParsedOrderBy): MirrorOrder {
  const [property, ...rest] = order.field;
  if (property === undefined || rest.length > 0) throw new Error(`On-demand mirrors order by top-level properties only, not ${order.field.join(".")}`);
  if (order.stringSort === "locale" || order.stringSort === "custom") throw new Error("On-demand mirrors sort text lexically, the way SQLite does");
  return { property: String(property), direction: order.direction, nulls: order.nulls };
}
