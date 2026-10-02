import { describe, expect, it } from "vitest";

import { songRow } from "./db/rows.js";
import { parseQueueManagerSnapshot, type QueueManagerSnapshot } from "./player-queue.js";

const valid: QueueManagerSnapshot = {
  version: 1,
  savedAt: "2026-08-13T00:00:00.000Z",
  nowPlaying: { key: "user:playing", origin: "user", track: songRow({ id: "deleted-song", title: "Preserved" }) },
  userQueue: [{ key: "user:next", track: songRow({ id: "next", title: "Next" }) }],
  source: { ref: { type: "playlist", playlistId: "playlist" }, cursor: { type: "gap", offset: 4 } },
  playback: { positionSeconds: 12.5 },
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

  it("accepts records from builds that persisted play state, dropping it", () => {
    expect(parseQueueManagerSnapshot({ ...valid, playback: { paused: false, positionSeconds: 12.5 } })).toEqual(valid);
  });

  it("rejects malformed top-level records", () => {
    expect(parseQueueManagerSnapshot({ ...valid, playback: { positionSeconds: -1 } })).toBeNull();
    expect(parseQueueManagerSnapshot({ ...valid, source: { ref: { type: "songs", queryId: "opaque" }, cursor: { type: "gap", offset: 0 } } })).toBeNull();
  });
});
