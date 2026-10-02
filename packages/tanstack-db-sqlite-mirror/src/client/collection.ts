import type { BaseCollectionConfig, CollectionConfig, SyncConfig, UtilsRecord } from "@tanstack/db";

import type { MirrorChangeBatch, MirrorPosition } from "../protocol.js";
import { describeTable, type AnyMirrorTable, type MirrorKeyOf, type MirrorRowOf } from "../table.js";
import { attachCollectionHandle, MirrorClientDisposedError, MirrorTimeoutError, type MirrorClient } from "./mirror-client.js";

const RETRY_BASE_DELAY_MS = 500;
const RETRY_MAX_DELAY_MS = 30_000;

export interface MirrorCollectionUtils extends UtilsRecord {
  /**
   * Resolves once the collection has synced everything up to `position`, e.g. the position a
   * main-process command returned after writing through `MirrorServer.write`.
   */
  awaitPosition: (position: MirrorPosition, timeoutMs?: number) => Promise<void>;
}

export type MirrorCollectionConfig<TTable extends AnyMirrorTable> = Omit<
  BaseCollectionConfig<MirrorRowOf<TTable>, MirrorKeyOf<TTable>, never, MirrorCollectionUtils>,
  "getKey" | "onInsert" | "onUpdate" | "onDelete" | "syncMode" | "schema" | "utils"
> & {
  readonly client: MirrorClient;
  readonly table: TTable;
};

export type MirrorCollectionOptions<TTable extends AnyMirrorTable> = CollectionConfig<MirrorRowOf<TTable>, MirrorKeyOf<TTable>, never, MirrorCollectionUtils> & {
  id: string;
  utils: MirrorCollectionUtils;
};

/**
 * Collection options for a TanStack DB collection that mirrors a SQLite table owned by a
 * `MirrorServer`. Loads the whole table, then applies the server's change stream. Mutations are
 * written to SQLite and resolve once their changes come back through the stream.
 */
export function mirrorCollectionOptions<TTable extends AnyMirrorTable>(config: MirrorCollectionConfig<TTable>): MirrorCollectionOptions<TTable> {
  type Row = MirrorRowOf<TTable>;
  type Key = MirrorKeyOf<TTable>;

  const { client, table, ...collectionConfig } = config;
  const info = describeTable(table);
  const primaryKey = info.primaryKey.key;
  const id = config.id ?? `mirror:${info.name}`;
  const tracker = new PositionTracker();

  const sync: SyncConfig<Row, Key> = {
    rowUpdateMode: "full",
    sync: ({ begin, write, commit, markReady, markError }) => {
      let active = true;
      // Keys this sync has written and not deleted, so a reload can diff instead of truncating.
      const syncedKeys = new Set<Key>();
      let loading = true;
      let loaded = false;
      let loadGeneration = 0;
      let failures = 0;
      let buffered: Array<MirrorChangeBatch> = [];
      tracker.invalidate();

      const applyBatch = (batch: MirrorChangeBatch) => {
        const position = tracker.current;
        if (!position || batch.epoch !== position.epoch) return;
        const changes = batch.changes.filter((change) => change.table === info.name && change.seq > position.seq);
        try {
          if (changes.length === 0) return;
          begin();
          for (const change of changes) {
            // Upserts are written as full-row updates: `update` on a missing key inserts it, which
            // also covers a delete and re-insert whose delete is still queued behind a user transaction.
            if (change.type === "delete") {
              write({ type: "delete", key: change.key as Key });
              syncedKeys.delete(change.key as Key);
            } else {
              write({ type: "update", value: change.value as Row });
              syncedKeys.add(change.key as Key);
            }
          }
          commit();
        } finally {
          // Even if a change listener throws inside commit(), the changes are staged.
          tracker.advance(batch.toSeq);
        }
      };

      const load = async () => {
        const generation = ++loadGeneration;
        const isCurrent = () => active && generation === loadGeneration;
        loading = true;
        buffered = [];
        tracker.invalidate();
        try {
          // Subscribed already, so every batch delivered after this point is buffered below.
          await client.ensureConnected();
          if (!isCurrent()) return;
          const snapshot = await client.request("snapshot", { table: info.name });
          if (!isCurrent()) return;
          if (snapshot.epoch !== client.epoch) {
            // A newer epoch resets the client, which starts another load; an older one came from a
            // server that has been replaced.
            client.observeEpoch(snapshot.epoch);
            if (isCurrent()) void load();
            return;
          }

          // A reload is written as a diff against what was synced before. TanStack DB's truncate()
          // restores optimistic state captured when it is called, which can outlive the
          // transactions that produced it.
          const keys = new Set<Key>();
          begin();
          for (const row of snapshot.rows) {
            const value = row as Row;
            const key = getKey(value);
            keys.add(key);
            // Full-row updates upsert, so a retry after a failed commit cannot hit duplicate keys.
            write({ type: "update", value });
          }
          for (const key of syncedKeys) {
            if (!keys.has(key)) write({ type: "delete", key });
          }
          commit();
          syncedKeys.clear();
          for (const key of keys) syncedKeys.add(key);
          loaded = true;

          tracker.loaded({ epoch: snapshot.epoch, seq: snapshot.seq });
          const pending = buffered;
          buffered = [];
          loading = false;
          for (const batch of pending) applyBatch(batch);
          markReady();
        } catch (error) {
          if (!isCurrent()) return;
          if (error instanceof MirrorClientDisposedError) {
            if (!loaded) markError(error);
            return;
          }
          // Before the first load the collection reports the error; afterwards stale data stays visible.
          if (!loaded) markError(error);
          else console.error(`[tanstack-db-sqlite-mirror] failed to reload "${id}"`, error);
          const delay = Math.min(RETRY_MAX_DELAY_MS, RETRY_BASE_DELAY_MS * 2 ** failures++);
          setTimeout(() => {
            if (isCurrent()) void load();
          }, delay);
          return;
        }
        failures = 0;
      };

      const unsubscribe = client.subscribe((event) => {
        if (!active) return;
        if (event.type === "reset") {
          void load();
        } else if (loading) {
          buffered.push(event.batch);
        } else {
          applyBatch(event.batch);
        }
      });
      void load();

      return () => {
        active = false;
        unsubscribe();
        tracker.invalidate();
        tracker.rejectAll(new MirrorClientDisposedError());
      };
    },
  };

  const getKey = (row: Row) => (row as Record<string, unknown>)[primaryKey] as Key;
  const persist = (params: { transaction: { mutations: ReadonlyArray<any> } }) => client.applyTransaction(params.transaction);
  const awaitPosition: MirrorCollectionUtils["awaitPosition"] = (position, timeoutMs) => tracker.waitFor(position, timeoutMs ?? client.mutationTimeoutMs);
  attachCollectionHandle(awaitPosition, { client, table: info.name, waitFor: (position, timeoutMs) => tracker.waitFor(position, timeoutMs) });

  return {
    ...collectionConfig,
    id,
    getKey,
    sync,
    startSync: collectionConfig.startSync ?? true,
    onInsert: persist,
    onUpdate: persist,
    onDelete: persist,
    utils: { awaitPosition },
  };
}

type Waiter = {
  readonly position: MirrorPosition;
  readonly resolve: () => void;
  readonly reject: (error: unknown) => void;
  readonly timer: ReturnType<typeof setTimeout>;
};

/** Tracks how far into the server stream a collection's synced state has advanced. */
class PositionTracker {
  current: MirrorPosition | null = null;
  private readonly waiters = new Set<Waiter>();

  loaded(position: MirrorPosition): void {
    this.current = position;
    this.settle();
  }

  advance(seq: number): void {
    if (this.current && seq > this.current.seq) {
      this.current = { epoch: this.current.epoch, seq };
      this.settle();
    }
  }

  invalidate(): void {
    this.current = null;
  }

  waitFor(position: MirrorPosition, timeoutMs: number): Promise<void> {
    if (this.reached(position)) return Promise.resolve();
    return new Promise<void>((resolve, reject) => {
      const waiter: Waiter = {
        position,
        resolve,
        reject,
        timer: setTimeout(() => {
          this.waiters.delete(waiter);
          reject(new MirrorTimeoutError(`Timed out after ${timeoutMs}ms waiting for change ${position.seq} to sync`));
        }, timeoutMs),
      };
      this.waiters.add(waiter);
    });
  }

  rejectAll(error: unknown): void {
    for (const waiter of this.waiters) {
      clearTimeout(waiter.timer);
      waiter.reject(error);
    }
    this.waiters.clear();
  }

  private reached(position: MirrorPosition): boolean {
    // A snapshot from a newer epoch was taken after every write of older epochs committed.
    const current = this.current;
    return current !== null && (current.epoch > position.epoch || (current.epoch === position.epoch && current.seq >= position.seq));
  }

  // Waiters resolve once the changes are committed to the collection, not once they are visible:
  // the sync transaction stays queued behind the user transaction that is waiting here.
  private settle(): void {
    for (const waiter of this.waiters) {
      if (!this.reached(waiter.position)) continue;
      clearTimeout(waiter.timer);
      this.waiters.delete(waiter);
      waiter.resolve();
    }
  }
}
