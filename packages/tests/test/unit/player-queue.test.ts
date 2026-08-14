import { describe, expect, it } from "vitest";

import { logout, parseQueueManagerSnapshot, type QueueManagerSnapshot } from "@muswag/shared";
import { createInMemoryDb } from "../navidrome-testkit.js";

const valid: QueueManagerSnapshot = {
  version: 1,
  savedAt: "2026-08-13T00:00:00.000Z",
  nowPlaying: { key: "user:playing", origin: "user", track: { id: "deleted-song", isDir: false, title: "Preserved" } },
  userQueue: [{ key: "user:next", track: { id: "next", isDir: false, title: "Next" } }],
  source: { ref: { type: "playlist", playlistId: "playlist" }, cursor: { type: "gap", offset: 4 } },
  playback: { paused: true, positionSeconds: 12.5 },
};

describe("player queue persistence DTO", () => {
  it("keeps valid embedded track snapshots and drops only malformed user entries", () => {
    const parsed = parseQueueManagerSnapshot({ ...valid, userQueue: [...valid.userQueue, { key: "bad", track: null }] });
    expect(parsed).toEqual(valid);
  });

  it("carries track fields it does not validate through untouched", () => {
    const track = { ...valid.nowPlaying!.track, duration: 42, genres: [{ name: "jazz" }] };

    const parsed = parseQueueManagerSnapshot({ ...valid, nowPlaying: { ...valid.nowPlaying, track } });

    expect(parsed?.nowPlaying?.track).toEqual(track);
  });

  it("rejects malformed top-level records", () => {
    expect(parseQueueManagerSnapshot({ ...valid, playback: { paused: true, positionSeconds: -1 } })).toBeNull();
    expect(parseQueueManagerSnapshot({ ...valid, source: { ref: { type: "songs", queryId: "opaque" }, cursor: { type: "gap", offset: 0 } } })).toBeNull();
  });

  it("stores the singleton locally and removes it on logout", async () => {
    const db = createInMemoryDb();
    await db.playerQueue.insert({ id: 1, snapshot: valid }).isPersisted.promise;
    expect(db.playerQueue.get(1)?.snapshot.nowPlaying?.track.title).toBe("Preserved");
    await logout(db);
    expect(db.playerQueue.get(1)).toBeUndefined();
  });
});
