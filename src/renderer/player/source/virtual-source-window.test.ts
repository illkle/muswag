import { describe, expect, it } from "vitest";

import type { Song } from "#core";
import type { QueueSource, SourceItem, SourcePage } from "./queue-source";
import { VirtualSourceWindow } from "./virtual-source-window";

const song = (id: string): Song => ({ id, isDir: false, title: id });

class FakeSource implements QueueSource {
  readonly ref = { type: "album" as const, albumId: "album" };
  revision = "r1";
  listeners = new Set<(revision: string) => void>();

  constructor(
    public items: SourceItem[],
    public rawLength = items.length,
  ) {}

  async read({ start, end, signal }: { start: number; end: number; signal: AbortSignal }): Promise<SourcePage> {
    signal.throwIfAborted();
    return {
      revision: this.revision,
      items: this.items.filter(({ offset }) => offset >= start && offset < end),
      nextOffset: Math.max(start, Math.min(end, this.rawLength)),
      isEnd: end >= this.rawLength,
    };
  }

  async locate({ key, signal }: { key: string; signal: AbortSignal }) {
    signal.throwIfAborted();
    const item = this.items.find((candidate) => candidate.key === key);
    return item ? { offset: item.offset, revision: this.revision } : null;
  }

  subscribe(listener: (revision: string) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  invalidate(items: SourceItem[], rawLength = this.rawLength): void {
    this.items = items;
    this.rawLength = rawLength;
    this.revision = `${this.revision}+`;
    for (const listener of this.listeners) listener(this.revision);
  }
}

function sourceItem(offset: number): SourceItem {
  return { key: `item:${offset}`, offset, track: song(String(offset)) };
}

async function flush(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
  await new Promise((resolve) => setTimeout(resolve, 0));
}

describe("VirtualSourceWindow", () => {
  it("fills playable limits while retaining absolute raw offsets", async () => {
    const items = Array.from({ length: 80 }, (_, offset) => offset)
      .filter((offset) => offset % 4 !== 0)
      .map(sourceItem);
    const source = new FakeSource(items, 80);
    const window = await VirtualSourceWindow.create({ source, start: { key: "item:41" } });

    expect(window.snapshot.previous).toHaveLength(10);
    expect(window.snapshot.next).toHaveLength(29);
    expect(window.snapshot.previous.at(-1)?.offset).toBe(39);
    expect(window.snapshot.current?.offset).toBe(41);
    expect(window.snapshot.next[0]?.offset).toBe(42);
    window.dispose();
  });

  it("relocates a moved cursor and restores a deleted cursor as a gap", async () => {
    const source = new FakeSource([sourceItem(0), sourceItem(1), sourceItem(2)], 3);
    const window = await VirtualSourceWindow.create({ source, start: { key: "item:1" }, behind: 10, ahead: 30 });

    source.invalidate(
      [
        { ...sourceItem(0), offset: 0 },
        { ...sourceItem(2), offset: 1 },
        { ...sourceItem(1), offset: 2 },
      ],
      3,
    );
    await flush();
    expect(window.snapshot.cursor).toEqual({ type: "item", key: "item:1", offset: 2 });

    source.invalidate([sourceItem(0), { ...sourceItem(2), offset: 1 }], 2);
    await flush();
    expect(window.snapshot.cursor).toEqual({ type: "gap", offset: 2 });
    expect(window.snapshot.previous.map(({ key }) => key)).toEqual(["item:0", "item:2"]);
    expect(window.snapshot.current).toBeNull();
    window.dispose();
    expect(source.listeners.size).toBe(0);
  });

  it("rejects malformed adapter pages", async () => {
    const source = new FakeSource([sourceItem(0), sourceItem(1)], 2);
    source.read = async ({ start }) => ({ revision: "r1", items: [sourceItem(1), sourceItem(0)], nextOffset: start + 2, isEnd: true });
    await expect(VirtualSourceWindow.create({ source, start: { key: "item:1" } })).rejects.toThrow(/ordered|outside|advance/);
  });
});
