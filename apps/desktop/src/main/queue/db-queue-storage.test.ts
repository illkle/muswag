import { songRow, type QueueItemRow, type QueueStateRow } from "@muswag/model";
import { describe, expect, it } from "vitest";

import type { QueueManagerState } from "#shared/queue-state";
import { DbQueueStorage, type QueueTables } from "./db-queue-storage";

class FakeTables implements QueueTables {
  items = new Map<string, QueueItemRow>();
  state: QueueStateRow | null = null;
  writes: Parameters<QueueTables["write"]>[0][] = [];
  async load() {
    return structuredClone({ state: this.state, items: [...this.items.values()] });
  }
  async write(change: Parameters<QueueTables["write"]>[0]) {
    this.writes.push(structuredClone(change));
    for (const key of change.remove) this.items.delete(key);
    for (const row of change.upsert) this.items.set(row.key, structuredClone(row));
    if (change.state) this.state = structuredClone(change.state);
  }
  async clear() {
    this.items.clear();
    this.state = null;
  }
}

const item = (key: string, title = key) => ({ key, track: songRow({ id: key, title }) });
const queued = (...keys: string[]): QueueManagerState => ({ nowPlaying: { ...item("now"), origin: "user" }, userQueue: keys.map((key) => item(key)), source: null });

describe("DbQueueStorage", () => {
  it("writes only the rows that changed, and keeps the resume position unless given one", async () => {
    const tables = new FakeTables();
    const storage = new DbQueueStorage(tables);
    await storage.save(queued("a", "b"), 12);
    expect(tables.writes.at(-1)).toMatchObject({ remove: [], state: { nowPlayingKey: "now", resumePositionSeconds: 12 } });
    expect(tables.writes.at(-1)?.upsert.map(({ key }) => key)).toEqual(["a", "b", "now"]);

    await storage.save(queued("b", "c"), null);
    expect(tables.writes.at(-1)).toEqual({
      upsert: [
        { key: "b", list: "user", position: 0, track: item("b").track },
        { key: "c", list: "user", position: 1, track: item("c").track },
      ],
      remove: ["a"],
      state: null,
    });

    await storage.save(queued("b", "c"), null);
    expect(tables.writes).toHaveLength(2);
    expect(tables.state?.resumePositionSeconds).toBe(12);
  });

  it("loads what it saved as a snapshot to restore from", async () => {
    const tables = new FakeTables();
    await new DbQueueStorage(tables).save(queued("a"), 30);
    expect(await new DbQueueStorage(tables).load()).toEqual({ nowPlaying: { ...item("now"), origin: "user" }, userQueue: [item("a")], source: null, playback: { positionSeconds: 30 } });
  });

  it("reads the tables again after a write fails", async () => {
    const tables = new FakeTables();
    const storage = new DbQueueStorage(tables);
    await storage.save(queued("a"), 0);
    const write = tables.write.bind(tables);
    tables.write = async () => {
      throw new Error("disk full");
    };
    await expect(storage.save(queued("a", "b"), null)).rejects.toThrow("disk full");
    tables.write = write;
    await storage.save(queued("a", "b"), null);
    expect([...tables.items.keys()].sort()).toEqual(["a", "b", "now"]);
  });
});
