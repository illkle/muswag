import { parseQueueManagerSnapshot, type QueueItemRow, type QueueManagerSnapshot, type QueueStateRow } from "@muswag/model";

import { queueItemRows, queueStateFromRows, queueStateRow, type QueueManagerState } from "#shared/queue-state";

export interface QueueStorage {
  load(): Promise<QueueManagerSnapshot | null>;
  /** Stores `state`. `resumePositionSeconds` replaces where playback resumes after a restart; `null` keeps it. */
  save(state: QueueManagerState, resumePositionSeconds: number | null): Promise<void>;
  clear(): Promise<void>;
}

/** The queue tables, as the backend reads and writes them. */
export interface QueueTables {
  load(): Promise<{ state: QueueStateRow | null; items: readonly QueueItemRow[] }>;
  write(change: { upsert: readonly QueueItemRow[]; remove: readonly string[]; state: QueueStateRow | null }): Promise<unknown>;
  clear(): Promise<unknown>;
}

/**
 * Stores the queue in the mirrored queue tables, which is also how renderers see it. Each save writes
 * only the rows that changed since the last one.
 */
export class DbQueueStorage implements QueueStorage {
  /** What the tables hold, as JSON by key, as last read or written; `null` until read. */
  private items: Map<string, string> | null = null;
  private state: QueueStateRow | null = null;

  constructor(private readonly tables: QueueTables) {}

  async load(): Promise<QueueManagerSnapshot | null> {
    const stored = await this.read();
    if (!stored.state) return null;
    const queue = queueStateFromRows(stored.state, stored.items);
    const snapshot = parseQueueManagerSnapshot({
      nowPlaying: queue.nowPlaying,
      userQueue: queue.userQueue,
      source: queue.source && stored.state.source ? { ref: queue.source.ref, cursor: stored.state.source.cursor } : null,
      playback: { positionSeconds: stored.state.resumePositionSeconds },
    });
    if (!snapshot) await this.clear();
    return snapshot;
  }

  async save(queue: QueueManagerState, resumePositionSeconds: number | null): Promise<void> {
    const items = this.items ?? new Map((await this.read()).items.map((row) => [row.key, JSON.stringify(row)]));
    const rows = queueItemRows(queue);
    const keys = new Set(rows.map(({ key }) => key));
    const upsert = rows.filter((row) => items.get(row.key) !== JSON.stringify(row));
    const remove = [...items.keys()].filter((key) => !keys.has(key));
    const state = queueStateRow(queue, resumePositionSeconds ?? this.state?.resumePositionSeconds ?? 0);
    const stateChanged = JSON.stringify(state) !== JSON.stringify(this.state);
    if (upsert.length === 0 && remove.length === 0 && !stateChanged) return;
    try {
      await this.tables.write({ upsert, remove, state: stateChanged ? state : null });
    } catch (cause) {
      // What was written is unknown; read the tables again before the next save.
      this.items = null;
      throw cause;
    }
    this.items = new Map(rows.map((row) => [row.key, JSON.stringify(row)]));
    this.state = state;
  }

  async clear(): Promise<void> {
    this.items = null;
    await this.tables.clear();
    this.items = new Map();
    this.state = null;
  }

  private async read() {
    const stored = await this.tables.load();
    this.items = new Map(stored.items.map((row) => [row.key, JSON.stringify(row)]));
    this.state = stored.state;
    return stored;
  }
}
