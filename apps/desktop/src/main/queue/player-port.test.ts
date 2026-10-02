import { describe, expect, it } from "vitest";
import { songRow } from "@muswag/model";
import { initialSnapshot } from "#shared/commands/player";
import { runtimeView } from "./player-port";

describe("player runtime view", () => {
  it("projects recovering as loading, never playing, and carries epoch for queue ordering", () => {
    const snapshot = {
      ...initialSnapshot("current"),
      playback: { _tag: "Recovering" as const, attempt: 1 as const, media: { item: { key: "a", track: songRow({ id: "a", title: "A" }) }, positionSeconds: 4, durationSeconds: null } },
    };
    expect(runtimeView(snapshot)).toMatchObject({ status: "loading", epoch: "current", positionSeconds: 4 });
  });
});
