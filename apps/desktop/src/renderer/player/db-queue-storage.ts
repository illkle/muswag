import { db as rendererDb } from "#/lib/db-renderer";
import type { MuswagDb, QueueManagerSnapshot, QueueStorage } from "@muswag/shared";
import { parseQueueManagerSnapshot } from "@muswag/shared";
import { eq, queryOnce } from "@tanstack/react-db";

export class DbQueueStorage implements QueueStorage {
  constructor(private readonly db: Pick<MuswagDb, "playerQueue"> = rendererDb) {}

  async load(): Promise<QueueManagerSnapshot | null> {
    const record = await queryOnce((q) =>
      q
        .from({ record: this.db.playerQueue })
        .where(({ record }) => eq(record.id, 1))
        .findOne(),
    );
    const snapshot = parseQueueManagerSnapshot(record?.snapshot ?? null);
    if (record && !snapshot) await this.clear();
    return snapshot;
  }

  async save(snapshot: QueueManagerSnapshot): Promise<void> {
    const copy = structuredClone(snapshot);
    const existing = this.db.playerQueue.get(1);
    const transaction = existing
      ? this.db.playerQueue.update(1, (draft) => {
          draft.snapshot = copy as never;
        })
      : this.db.playerQueue.insert({ id: 1, snapshot: copy });
    await transaction.isPersisted.promise;
  }

  async clear(): Promise<void> {
    if (!this.db.playerQueue.has(1)) return;
    await this.db.playerQueue.delete(1).isPersisted.promise;
  }
}
