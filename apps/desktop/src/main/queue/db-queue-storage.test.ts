import { songRow, type QueueItemRow, type QueueStateRow } from "@muswag/model";
import { describe, expect, it } from "vitest";

import type { QueueManagerState } from "#shared/queue-state";
import { DbQueueStorage, type QueueTables } from "./db-queue-storage";

class FakeTables implements QueueTables {
  items = new Map<string, QueueItemRow>();
  state: QueueStateRow | null = null;
  resumePositionSeconds = 0;
  writes: Parameters<QueueTables["write"]>[0][] = [];
  async load() {
    return structuredClone({ state: this.state, items: [...this.items.values()], resumePositionSeconds: this.resumePositionSeconds });
  }
  async write(change: Parameters<QueueTables["write"]>[0]) {
    this.writes.push(structuredClone(change));
    for (const key of change.remove) this.items.delete(key);
    for (const row of change.upsert) this.items.set(row.key, structuredClone(row));
    if (change.state) this.state = structuredClone(change.state);
    this.resumePositionSeconds = change.resumePositionSeconds ?? this.resumePositionSeconds;
  }
  async clear() {
    this.items.clear();
    this.state = null;
    this.resumePositionSeconds = 0;
  }
}

const item = (key: string, title = key) => ({ key, track: songRow({ id: key, title }) });
const queued = (...keys: string[]): QueueManagerState => ({ nowPlaying: { ...item("now"), origin: "user" }, userQueue: keys.map((key) => item(key)), source: null });

describe("DbQueueStorage", () => {
  it("writes only the rows that changed, and keeps the resume position unless given one", async () => {
    const tables = new FakeTables();
    const storage = new DbQueueStorage(tables);
    await storage.save(queued("a", "b"), 12);
    expect(tables.writes.at(-1)).toMatchObject({ remove: [], state: { nowPlayingKey: "now" }, resumePositionSeconds: 12 });
    expect(tables.writes.at(-1)?.upsert.map(({ key }) => key)).toEqual(["a", "b", "now"]);

    await storage.save(queued("b", "c"), null);
    expect(tables.writes.at(-1)).toEqual({
      upsert: [
        { key: "b", list: "user", position: 0, track: item("b").track },
        { key: "c", list: "user", position: 1, track: item("c").track },
      ],
      remove: ["a"],
      state: null,
      resumePositionSeconds: null,
    });

    await storage.save(queued("b", "c"), null);
    await storage.save(queued("b", "c"), 12);
    expect(tables.writes).toHaveLength(2);
    expect(tables.resumePositionSeconds).toBe(12);
  });

  it("writes no mirrored row when only the resume position changed", async () => {
    const tables = new FakeTables();
    const storage = new DbQueueStorage(tables);
    await storage.save(queued("a"), 0);

    await storage.save(queued("a"), 5);
    expect(tables.writes.at(-1)).toEqual({ upsert: [], remove: [], state: null, resumePositionSeconds: 5 });

    // Another storage over the same tables, as after a restart, finds what the tables hold before it writes.
    await new DbQueueStorage(tables).save(queued("a"), 10);
    expect(tables.writes.at(-1)).toEqual({ upsert: [], remove: [], state: null, resumePositionSeconds: 10 });
  });

  it("loads what it saved as the queue to restore", async () => {
    const tables = new FakeTables();
    await new DbQueueStorage(tables).save(queued("a"), 30);
    expect(await new DbQueueStorage(tables).load()).toEqual({ nowPlaying: { ...item("now"), origin: "user" }, userQueue: [item("a")], source: null, resumePositionSeconds: 30 });
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
