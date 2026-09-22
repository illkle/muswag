import { describe, expect, it } from "vitest";
import { initialSnapshot } from "#shared/player-contract";
import { acceptSnapshot, runtimeView } from "./snapshot";

describe("player snapshots", () => {
  it("does not roll back an event with an older subscription reply or a foreign epoch", () => {
    const latest = { ...initialSnapshot("current"), stamp: { epoch: "current", revision: 10 } };
    expect(acceptSnapshot(latest, initialSnapshot("current"), "current")).toBe(latest);
    expect(acceptSnapshot(latest, { ...latest, stamp: { epoch: "previous", revision: 100 } }, "current")).toBe(latest);
    expect(acceptSnapshot(latest, initialSnapshot("new"), "new").stamp.epoch).toBe("new");
  });
  it("projects recovering as loading, never playing, and carries epoch for queue ordering", () => {
    const snapshot = {
      ...initialSnapshot("current"),
      playback: { _tag: "Recovering" as const, attempt: 1 as const, media: { item: { key: "a", track: { id: "a", title: "A", isDir: false } }, positionSeconds: 4, durationSeconds: null } },
    };
    expect(runtimeView(snapshot)).toMatchObject({ status: "loading", epoch: "current", positionSeconds: 4 });
  });
});
