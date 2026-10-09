import { describe, expect, it } from "vitest";

import { formatDuration } from "#/lib/format";

describe("formatDuration", () => {
  it("writes minutes and seconds, and hours once there are any", () => {
    expect(formatDuration(0)).toBe("0:00");
    expect(formatDuration(185)).toBe("3:05");
    expect(formatDuration(3725)).toBe("1:02:05");
  });

  it("drops the part of a second a playback position has", () => {
    expect(formatDuration(59.94)).toBe("0:59");
    expect(formatDuration(185.5)).toBe("3:05");
  });

  it("says nothing of a length it does not know", () => {
    expect(formatDuration(null)).toBe("-");
    expect(formatDuration(undefined)).toBe("-");
    expect(formatDuration(Number.NaN)).toBe("-");
  });
});
