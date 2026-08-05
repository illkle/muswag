import { describe, expect, it } from "vitest";

import { encodeCommand, parseMpvMessage } from "./mpv-protocol";

describe("mpv protocol", () => {
  it("encodes commands with optional request ids", () => {
    expect(encodeCommand(["stop"])).toBe('{"command":["stop"]}\n');
    expect(encodeCommand(["stop"], 4)).toBe('{"command":["stop"],"request_id":4}\n');
  });

  it("parses responses and observed events", () => {
    expect(parseMpvMessage('{"request_id":1,"error":"success","data":3}')).toEqual({ data: 3, error: null, kind: "response", requestId: 1 });
    expect(parseMpvMessage('{"request_id":2,"error":"bad"}')).toEqual({ data: undefined, error: "bad", kind: "response", requestId: 2 });
    expect(parseMpvMessage('{"event":"property-change","name":"pause","data":true}')).toEqual({ event: { paused: true, type: "pause-change" }, kind: "event" });
    expect(parseMpvMessage('{"event":"property-change","name":"time-pos","data":null}')).toEqual({ event: { positionSeconds: 0, type: "time-pos-change" }, kind: "event" });
    expect(parseMpvMessage('{"event":"property-change","name":"duration"}')).toEqual({ event: { durationSeconds: null, type: "duration-change" }, kind: "event" });
    expect(parseMpvMessage('{"event":"property-change","name":"volume"}')).toEqual({ event: { type: "volume-change", volumePercent: 100 }, kind: "event" });
    expect(parseMpvMessage('{"event":"property-change","name":"mute","data":false}')).toEqual({ event: { muted: false, type: "mute-change" }, kind: "event" });
    expect(parseMpvMessage('{"event":"file-loaded"}')).toEqual({ event: { type: "file-loaded" }, kind: "event" });
    expect(parseMpvMessage('{"event":"end-file","reason":"eof"}')).toEqual({ event: { reason: "eof", type: "end-file" }, kind: "event" });
  });

  it("ignores garbage and irrelevant messages", () => {
    expect(parseMpvMessage("nope")).toBeNull();
    expect(parseMpvMessage('{"event":"property-change","name":"speed"}')).toBeNull();
    expect(parseMpvMessage('{"event":"log-message"}')).toBeNull();
  });
});
