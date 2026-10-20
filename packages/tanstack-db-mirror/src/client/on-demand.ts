import { and, deepEquals, parseOrderByExpression, type ChangeMessageOrDeleteKeyMessage, type IR, type LoadSubsetOptions, type ParsedOrderBy, type SyncConfig } from "@tanstack/db";

import type { MirrorChangeBatch, MirrorExpression, MirrorOrder, MirrorPosition, MirrorQuery, MirrorResults, MirrorRow } from "../protocol.js";
import type { Interned } from "./intern.js";
import { MirrorClientDisposedError, type MirrorClient } from "./mirror-client.js";

/** The least time between the starts of two refreshes, so a burst of changes costs a few queries. */
const REFRESH_INTERVAL_MS = 250;
const RETRY_BASE_DELAY_MS = 500;
const RETRY_MAX_DELAY_MS = 30_000;

/**
 * The sync of an on-demand mirror collection, which serves the tables a server sends as keys only
 * (`SqliteMirror`'s `keyOnlyTables`): it holds only the rows its live queries ask for. TanStack DB hands
 * each query's demand to `loadSubset`, which reads it from the server as a query; the rows stay while a
 * loaded subset holds them.
 *
 * A change says which row changed, not how, so the collection cannot tell which subsets it concerns.
 * Any change to the table runs every loaded subset's query again, and what comes back replaces what that
 * subset held: rows that differ from the collection's are written, rows no subset holds any more are
 * deleted. Refreshes run one at a time, the first right after a quiet spell and then at most one per
 * REFRESH_INTERVAL_MS, so a library sync that sends batch after batch costs a few queries per subset.
 */
export function onDemandSync<Row extends object, Key extends string | number>(options: {
  readonly client: MirrorClient;
  readonly table: string;
  readonly getKey: (row: Row) => Key;
  readonly decode: (row: MirrorRow, interned: Interned) => Row | undefined;
  /** Every change up to `position` is in the collection. */
  readonly onPosition: (position: MirrorPosition) => void;
  /** The collection's rows may be stale until the next `onPosition`. */
  readonly onInvalidate: () => void;
  readonly onCleanup: () => void;
}): SyncConfig<Row, Key> {
  const { client, table, getKey, decode } = options;

  type Subset = {
    readonly request: MirrorQuery;
    /** The rows of the last result applied to the subset. */
    keys: Set<Key>;
    /** That result's position, so an older result that arrives after it does not replace it. */
    seq: number;
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

      /** A change has arrived that the subsets have not been read again for. */
      let dirty = false;
      let refreshing = false;
      let refreshTimer: ReturnType<typeof setTimeout> | undefined;
      let lastRefreshAt = -Infinity;
      let refreshFailures = 0;

      /** Writes `writes` in one sync transaction. The receipt settles once they are visible. */
      const flush = (writes: ReadonlyArray<Write>) => {
        if (writes.length === 0) return true;
        begin();
        for (const message of writes) write(message);
        return commit();
      };

      const reach = (seq: number) => {
        if (epoch !== null) options.onPosition({ epoch, seq });
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

      const requestRefresh = () => {
        dirty = true;
        if (!active || refreshing || refreshTimer !== undefined) return;
        refreshTimer = setTimeout(() => void refresh(), Math.max(0, lastRefreshAt + REFRESH_INTERVAL_MS - Date.now()));
      };

      /** Runs every subset's request again and replaces what each holds with the result. */
      const refresh = async () => {
        refreshTimer = undefined;
        // While reconnecting there is nothing to compare positions with; `connect` asks again.
        if (!active || refreshing || epoch === null) return;
        refreshing = true;
        dirty = false;
        lastRefreshAt = Date.now();
        const startEpoch = epoch;
        const startSeq = streamSeq;
        const targets = Array.from(subsets);
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
            if (outcome.status === "rejected") {
              failure ??= outcome.reason;
              return;
            }
            const result = outcome.value;
            if (result.epoch !== epoch) {
              // A newer epoch resets the client and with it this collection; an older one came from a
              // server that has been replaced, so the subset is read again.
              client.observeEpoch(result.epoch);
              failure ??= new Error(`A query was answered by a server of epoch ${result.epoch}, not ${String(epoch)}`);
              return;
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
        } finally {
          refreshing = false;
        }
        if (!active) return;
        if (epoch !== startEpoch) {
          // Once reconnected the subsets are read again: now if `connect` has already asked, else when it does.
          dirty = true;
          if (epoch !== null) requestRefresh();
          return;
        }
        if (failure !== undefined && !(failure instanceof MirrorClientDisposedError)) {
          console.error(`[tanstack-db-mirror] failed to refresh the on-demand rows of "${table}"`, failure);
          dirty = true;
          if (refreshTimer === undefined) {
            refreshTimer = setTimeout(() => void refresh(), Math.min(RETRY_MAX_DELAY_MS, RETRY_BASE_DELAY_MS * 2 ** refreshFailures++));
          }
          return;
        }
        refreshFailures = 0;
        // Queries sent from now on are read after these deletes. A load still in flight may have been
        // sent before them; it is at most one round trip behind, and the refresh its change asks for follows.
        for (const [key, seq] of deleted) if (seq <= startSeq) deleted.delete(key);
        // The queries were sent after every change up to `startSeq` had arrived, so their rows have them.
        reach(dirty ? startSeq : streamSeq);
        if (dirty) requestRefresh();
      };

      const applyBatch = (batch: MirrorChangeBatch) => {
        if (batch.epoch !== epoch) return;
        streamSeq = batch.toSeq;
        let changed = false;
        const writes: Array<Write> = [];
        for (const change of batch.changes) {
          if (change.table !== table) continue;
          changed = true;
          if (change.type !== "delete") continue;
          // A deleted row is in no subset's result any more, so it goes at once; the refresh brings in
          // whatever takes its place in a window.
          const key = change.key as Key;
          // Only a query that is loading can bring it back, and every query is a subset's.
          if (subsets.size > 0) deleted.set(key, change.seq);
          const row = held.get(key);
          if (!row || change.seq <= row.seq) continue;
          held.delete(key);
          for (const subset of subsets.values()) subset.keys.delete(key);
          writes.push({ type: "delete", key });
        }
        flush(writes);
        if (changed && subsets.size > 0) requestRefresh();
        else if (!dirty && !refreshing) reach(streamSeq);
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
        if (dirty || subsets.size > 0) requestRefresh();
        else reach(streamSeq);
      };

      const unsubscribe = client.subscribe((event) => {
        if (!active) return;
        if (event.type === "batch") return applyBatch(event.batch);
        // The stream restarted or lost changes, so every held row may be stale. TanStack DB still
        // considers the subsets loaded and would never ask for them again: keep them, and read them
        // again once reconnected. Positions of another server say nothing about the rows held.
        epoch = null;
        options.onInvalidate();
        for (const subset of subsets.values()) subset.seq = -1;
        for (const row of held.values()) row.seq = -1;
        if (subsets.size > 0) dirty = true;
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
      };

      const loadSubset = (demand: LoadSubsetOptions): Promise<void> => {
        const subset: Subset = { request: queryOf(table, demand), keys: new Set(), seq: -1 };
        subsets.set(demand, subset);
        return (async () => {
          try {
            await client.ensureConnected();
            const result = await client.request("query", subset.request);
            // An unloaded subset takes nothing in; one a refresh filled meanwhile has newer rows.
            if (!active || subsets.get(demand) !== subset || result.seq < subset.seq) return;
            if (result.epoch !== epoch) {
              // A newer epoch resets the client, and the refresh after it fills the subset; an older one
              // came from a server that has been replaced.
              client.observeEpoch(result.epoch);
              requestRefresh();
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
