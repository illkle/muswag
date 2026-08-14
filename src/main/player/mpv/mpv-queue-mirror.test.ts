import { describe, expect, it, vi } from "vitest";

import type { PlaybackItem, Song } from "#core";
import { MpvClient } from "./mpv-client";
import { MpvQueueMirror } from "./mpv-queue-mirror";

const song = (id: string): Song => ({ id, isDir: false, title: id });
const item = (key: string): PlaybackItem => ({ key, track: song(key) });

function setup() {
  let nextId = 1;
  const calls: string[] = [];
  const client = {
    clearPlaylistExceptCurrent: vi.fn(async () => calls.push("clear")),
    insertFile: vi.fn(async (url: string, index: number) => {
      calls.push(`insert:${url}:${index}`);
      return nextId++;
    }),
    loadFile: vi.fn(async (url: string) => {
      calls.push(`load:${url}`);
      return nextId++;
    }),
    playPlaylistIndex: vi.fn(async (index: number) => calls.push(`play:${index}`)),
    removePlaylistEntry: vi.fn(async (index: number) => calls.push(`remove:${index}`)),
  };
  return { calls, client, mirror: new MpvQueueMirror({ client: client as unknown as MpvClient, resolveUrl: (id) => `url:${id}` }) };
}

describe("MpvQueueMirror", () => {
  it("builds exact order around a selected middle item and correlates duplicate media by entry id", async () => {
    const { calls, mirror } = setup();
    const desired = [item("first"), { key: "duplicate-a", track: song("same") }, { key: "duplicate-b", track: song("same") }];
    await mirror.apply({ snapshot: { items: desired }, select: { key: "duplicate-a", play: true } });

    expect(calls).toEqual(["load:url:same", "insert:url:first:0", "insert:url:same:2"]);
    expect(mirror.snapshot.map(({ key }) => key)).toEqual(desired.map(({ key }) => key));
    expect(mirror.entryForId(1)?.key).toBe("duplicate-a");
    expect(mirror.entryForId(3)?.key).toBe("duplicate-b");
  });

  it("uses one removal and exact-index insertion for a one-item slide", async () => {
    const { calls, mirror } = setup();
    await mirror.apply({ snapshot: { items: [item("a"), item("b"), item("c")] }, select: { key: "b", play: true } });
    calls.length = 0;
    await mirror.apply({ snapshot: { items: [item("b"), item("c"), item("d")] } });
    expect(calls).toEqual(["remove:0", "insert:url:d:2"]);
  });

  it("rejects removing the current entry without an explicit selection", async () => {
    const { mirror } = setup();
    await mirror.apply({ snapshot: { items: [item("a"), item("b")] }, select: { key: "a", play: true } });
    await expect(mirror.apply({ snapshot: { items: [item("b")] } })).rejects.toThrow(/removed the current/);
  });

  it("rebuilds around an explicit mirrored selection when the desired window drops the old current", async () => {
    const { calls, mirror } = setup();
    await mirror.apply({ snapshot: { items: [item("a"), item("b"), item("c")] }, select: { key: "a", play: true } });
    calls.length = 0;

    await mirror.apply({ snapshot: { items: [item("b"), item("c")] }, select: { key: "c", play: true } });

    expect(calls).toEqual(["load:url:c", "insert:url:b:0"]);
    expect(mirror.snapshot.map(({ key }) => key)).toEqual(["b", "c"]);
  });

  it("clears in-memory correlations even when clearing mpv fails", async () => {
    const { client, mirror } = setup();
    await mirror.apply({ snapshot: { items: [item("a"), item("b")] }, select: { key: "a", play: true } });
    client.clearPlaylistExceptCurrent.mockRejectedValueOnce(new Error("mpv unavailable"));

    await expect(mirror.clear()).rejects.toThrow("mpv unavailable");

    expect(mirror.snapshot).toEqual([]);
    expect(mirror.currentEntry).toBeNull();
    expect(mirror.entryForId(1)).toBeNull();
  });

  it("removes partial full-rebuild inserts before retaining the current correlation", async () => {
    const { calls, client, mirror } = setup();
    await mirror.apply({ snapshot: { items: [item("a"), item("b"), item("c")] }, select: { key: "b", play: true } });
    calls.length = 0;
    client.insertFile
      .mockImplementationOnce(async (url: string, index: number) => {
        calls.push(`insert:${url}:${index}`);
        return 4;
      })
      .mockRejectedValueOnce(new Error("insert failed"));

    await expect(mirror.apply({ snapshot: { items: [item("d"), item("b"), item("e")] } })).rejects.toThrow("insert failed");

    expect(calls).toEqual(["clear", "insert:url:d:0", "clear"]);
    expect(mirror.currentEntry?.key).toBe("b");
    expect(mirror.entryForId(4)).toBeNull();
  });
});
