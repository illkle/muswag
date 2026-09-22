import { Redacted, Schema } from "effect";
import { describe, expect, it } from "vitest";
import { initialSnapshot, PlayerCommand, PlayerCredentials, PlayerSnapshot } from "./player-contract";

const decode = Schema.decodeUnknownExit(PlayerCommand);
const track = (id: string) => ({ id, title: id, isDir: false, album: "kept" });

describe("player command contract", () => {
  it("rejects duplicate occurrences, invalid tracks and selections outside the queue", () => {
    const item = { key: "a", track: track("1") };
    expect(decode({ _tag: "ApplyQueue", items: [item, item], select: null })._tag).toBe("Failure");
    expect(decode({ _tag: "ApplyQueue", items: [{ key: "a", track: { id: "" } }], select: null })._tag).toBe("Failure");
    expect(decode({ _tag: "ApplyQueue", items: [item], select: { key: "b", play: true, positionSeconds: 0 } })._tag).toBe("Failure");
  });
  it("preserves the full track payload", () => {
    const decoded = decode({ _tag: "ApplyQueue", items: [{ key: "a", track: track("1") }], select: { key: "a", play: true, positionSeconds: 0 } });
    expect(decoded).toMatchObject({ _tag: "Success", value: { items: [{ track: { album: "kept" } }] } });
  });
  it("redacts the password as soon as credentials are decoded", () => {
    const credentials = Schema.decodeSync(PlayerCredentials)({ url: "https://music.test", username: "me", password: "hunter2" });
    expect(Redacted.value(credentials.password)).toBe("hunter2");
    expect(JSON.stringify(credentials)).not.toContain("hunter2");
  });
  it("accepts the snapshots main produces and rejects malformed ones", () => {
    expect(Schema.decodeExit(PlayerSnapshot)(initialSnapshot("epoch"))._tag).toBe("Success");
    expect(Schema.decodeUnknownExit(PlayerSnapshot)({ ...initialSnapshot("epoch"), playback: { _tag: "Playing" } })._tag).toBe("Failure");
  });
});
