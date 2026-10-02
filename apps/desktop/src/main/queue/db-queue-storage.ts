import type { QueueManagerSnapshot, QueueStorage } from "@muswag/shared";
import { parseQueueManagerSnapshot } from "@muswag/shared";

/** The single persisted queue record. */
export interface QueueRecordStore {
  load(): Promise<unknown>;
  save(snapshot: QueueManagerSnapshot): Promise<void>;
  clear(): Promise<void>;
}

export class DbQueueStorage implements QueueStorage {
  constructor(private readonly store: QueueRecordStore) {}

  async load(): Promise<QueueManagerSnapshot | null> {
    const record = await this.store.load();
    const snapshot = parseQueueManagerSnapshot(record ?? null);
    if (record && !snapshot) await this.clear();
    return snapshot;
  }

  save(snapshot: QueueManagerSnapshot): Promise<void> {
    return this.store.save(structuredClone(snapshot));
  }

  clear(): Promise<void> {
    return this.store.clear();
  }
}
