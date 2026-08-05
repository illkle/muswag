export type MpvEvent =
  | { type: "pause-change"; paused: boolean }
  | { type: "time-pos-change"; positionSeconds: number }
  | { type: "duration-change"; durationSeconds: number | null }
  | { type: "volume-change"; volumePercent: number }
  | { type: "mute-change"; muted: boolean }
  | { type: "file-loaded" }
  | { type: "end-file"; reason: string | null };

export type MpvIncomingMessage = { kind: "response"; requestId: number; error: string | null; data: unknown } | { kind: "event"; event: MpvEvent };

export const OBSERVED_PROPERTIES: ReadonlyArray<readonly [id: number, name: string]> = [
  [1, "pause"],
  [2, "time-pos"],
  [3, "duration"],
  [4, "volume"],
  [5, "mute"],
];

export function encodeCommand(command: unknown[], requestId?: number): string {
  return `${JSON.stringify(requestId === undefined ? { command } : { command, request_id: requestId })}\n`;
}

export function parseMpvMessage(rawLine: string): MpvIncomingMessage | null {
  let payload: Record<string, unknown>;
  try {
    const parsed = JSON.parse(rawLine) as unknown;
    if (!parsed || typeof parsed !== "object") return null;
    payload = parsed as Record<string, unknown>;
  } catch {
    return null;
  }

  if (typeof payload.request_id === "number") {
    return {
      data: payload.data,
      error: typeof payload.error === "string" && payload.error !== "success" ? payload.error : null,
      kind: "response",
      requestId: payload.request_id,
    };
  }

  if (payload.event === "file-loaded") return { event: { type: "file-loaded" }, kind: "event" };
  if (payload.event === "end-file") {
    return {
      event: { reason: typeof payload.reason === "string" ? payload.reason : null, type: "end-file" },
      kind: "event",
    };
  }
  if (payload.event !== "property-change") return null;

  switch (payload.name) {
    case "pause":
      return { event: { paused: payload.data === true, type: "pause-change" }, kind: "event" };
    case "time-pos":
      return {
        event: { positionSeconds: typeof payload.data === "number" ? payload.data : 0, type: "time-pos-change" },
        kind: "event",
      };
    case "duration":
      return {
        event: { durationSeconds: typeof payload.data === "number" ? payload.data : null, type: "duration-change" },
        kind: "event",
      };
    case "volume":
      return {
        event: { type: "volume-change", volumePercent: typeof payload.data === "number" ? payload.data : 100 },
        kind: "event",
      };
    case "mute":
      return { event: { muted: payload.data === true, type: "mute-change" }, kind: "event" };
    default:
      return null;
  }
}
