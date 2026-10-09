import { describe, expect, it } from "vitest";
import { songRow } from "@muswag/model";
import { initialSnapshot, type Playback } from "#shared/commands/player";
import { runtimeView } from "./player-port";

const media = { item: { key: "a", track: songRow({ id: "a", title: "A" }) }, positionSeconds: 4, durationSeconds: null };
const view = (playback: Playback) => runtimeView({ ...initialSnapshot("current"), playback });

describe("player runtime view", () => {
  it("projects recovering as loading, never playing, and carries epoch for queue ordering", () => {
    expect(view({ _tag: "Recovering", media })).toMatchObject({ status: "loading", epoch: "current", positionSeconds: 4, trackFailed: false });
  });

  it("says the track failed only when the track is why playback broke off", () => {
    expect(view({ _tag: "Failed", media, reason: "track" })).toMatchObject({ status: "error", current: { key: "a" }, trackFailed: true });
    expect(view({ _tag: "Failed", media, reason: "player" })).toMatchObject({ status: "error", current: { key: "a" }, trackFailed: false });
  });
});
