import { Schema } from "effect";
import { describe, expect, it } from "vitest";
import { PlayerRow, playerRow } from "#shared/state/player";
import { initialSnapshot, RendererCommand } from "./player";

const decode = Schema.decodeUnknownExit(RendererCommand);
const item = { key: "a", track: { id: "1", title: "A", isDir: false, album: "kept" } };

describe("player commands from a renderer", () => {
  it("are the transport and mpv controls", () => {
    for (const command of [
      { _tag: "Play" },
      { _tag: "Seek", seconds: 12 },
      { _tag: "SetVolume", percent: 40 },
      { _tag: "ClearBinaryPath" },
      { _tag: "DismissError" },
      { _tag: "StartInstall", method: "brew" },
    ])
      expect(decode(command)).toMatchObject({ _tag: "Success", value: command });
    expect(decode({ _tag: "Seek", seconds: -1 })._tag).toBe("Failure");
    expect(decode({ _tag: "SetVolume", percent: 140 })._tag).toBe("Failure");
  });
  it("cannot change the queue, stop playback or name a binary to run: those are main's", () => {
    expect(decode({ _tag: "ApplyQueue", items: [item], select: { key: "a", play: true, positionSeconds: 0 } })._tag).toBe("Failure");
    expect(decode({ _tag: "Stop" })._tag).toBe("Failure");
    expect(decode({ _tag: "Restart" })._tag).toBe("Failure");
    expect(decode({ _tag: "SetBinaryPath", path: "/tmp/anything" })._tag).toBe("Failure");
  });
});

describe("the player row renderers read", () => {
  const encode = Schema.encodeUnknownExit(PlayerRow);
  it("is what main makes of a snapshot, with the full track payload", () => {
    expect(encode(playerRow(initialSnapshot("epoch")))).toMatchObject({ _tag: "Success", value: { status: "idle", item: null, error: null } });
    const failed = playerRow({
      ...initialSnapshot("epoch"),
      playback: { _tag: "Failed", media: { item: item as never, positionSeconds: 3, durationSeconds: null }, reason: "track" },
      error: { message: "The track did not finish loading.", fix: "retry" },
    });
    expect(encode(failed)).toMatchObject({ _tag: "Success", value: { status: "error", item: { track: { album: "kept" } }, error: { fix: "retry" } } });
    expect(encode({ ...failed, item: { key: "a", track: { id: "" } } })._tag).toBe("Failure");
  });
});
