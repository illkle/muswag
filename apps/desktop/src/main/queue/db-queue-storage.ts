import type { NowPlaying, PlaybackItem, QueueItemRow, QueueSourceRef, QueueStateRow, SourceCursor } from "@muswag/model";

import { queueItemRows, queueStateFromRows, queueStateRow, type QueueManagerState } from "#shared/queue-state";

/** What the queue restores from after a restart. Restores always start paused, so play state is not stored. */
export type StoredQueue = {
  nowPlaying: NowPlaying | null;
  userQueue: readonly PlaybackItem[];
  source: { ref: QueueSourceRef; cursor: SourceCursor } | null;
  resumePositionSeconds: number;
};

export interface QueueStorage {
  load(): Promise<StoredQueue | null>;
  /** Stores `state`. `resumePositionSeconds` replaces where playback resumes after a restart; `null` keeps it. */
  save(state: QueueManagerState, resumePositionSeconds: number | null): Promise<void>;
  clear(): Promise<void>;
}

/** The queue tables, as the backend reads and writes them. `null` in a change leaves that part as it is. */
export interface QueueTables {
  load(): Promise<{ state: QueueStateRow | null; items: readonly QueueItemRow[]; resumePositionSeconds: number }>;
  write(change: { upsert: readonly QueueItemRow[]; remove: readonly string[]; state: QueueStateRow | null; resumePositionSeconds: number | null }): Promise<unknown>;
  clear(): Promise<unknown>;
}

/**
 * Stores the queue in the mirrored queue tables, which is also how renderers see it, and the resume
 * position in a table of main's own. Each save writes only what changed since the last one, so saving
 * the position as a track plays sends renderers nothing.
 */
export class DbQueueStorage implements QueueStorage {
  /** What the tables hold, as JSON by key, as last read or written; `null` until read. */
  private items: Map<string, string> | null = null;
  private state: QueueStateRow | null = null;
  private resumePositionSeconds = 0;

  constructor(private readonly tables: QueueTables) {}

  async load(): Promise<StoredQueue | null> {
    const { state, items, resumePositionSeconds } = await this.read();
    if (!state) return null;
    const { nowPlaying, userQueue } = queueStateFromRows(state, items);
    return { nowPlaying, userQueue, source: state.source ? { ref: state.source.ref, cursor: state.source.cursor } : null, resumePositionSeconds };
  }

  async save(queue: QueueManagerState, resumePositionSeconds: number | null): Promise<void> {
    const items = this.items ?? new Map((await this.read()).items.map((row) => [row.key, JSON.stringify(row)]));
    const rows = queueItemRows(queue);
    const keys = new Set(rows.map(({ key }) => key));
    const upsert = rows.filter((row) => items.get(row.key) !== JSON.stringify(row));
    const remove = [...items.keys()].filter((key) => !keys.has(key));
    const state = queueStateRow(queue);
    const stateChanged = JSON.stringify(state) !== JSON.stringify(this.state);
    const position = resumePositionSeconds === this.resumePositionSeconds ? null : resumePositionSeconds;
    if (upsert.length === 0 && remove.length === 0 && !stateChanged && position === null) return;
    try {
      await this.tables.write({ upsert, remove, state: stateChanged ? state : null, resumePositionSeconds: position });
    } catch (cause) {
      // What was written is unknown; read the tables again before the next save.
      this.items = null;
      throw cause;
    }
    this.items = new Map(rows.map((row) => [row.key, JSON.stringify(row)]));
    this.state = state;
    this.resumePositionSeconds = position ?? this.resumePositionSeconds;
  }

  async clear(): Promise<void> {
    this.items = null;
    await this.tables.clear();
    this.items = new Map();
    this.state = null;
    this.resumePositionSeconds = 0;
  }

  private async read() {
    const stored = await this.tables.load();
    this.items = new Map(stored.items.map((row) => [row.key, JSON.stringify(row)]));
    this.state = stored.state;
    this.resumePositionSeconds = stored.resumePositionSeconds;
    return stored;
  }
}
