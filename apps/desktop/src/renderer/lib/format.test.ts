import { describe, expect, it } from "vitest";

import { formatAgo, formatDuration, formatReleaseDate } from "#/lib/format";

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

describe("formatAgo", () => {
  const now = Date.parse("2026-10-26T12:00:00Z");

  it("says how long ago in the largest unit that fits", () => {
    expect(formatAgo("2026-10-26T11:59:40Z", now)).toBe("just now");
    expect(formatAgo("2026-10-26T11:55:00Z", now)).toBe("5 minutes ago");
    expect(formatAgo("2026-10-26T09:00:00Z", now)).toBe("3 hours ago");
    expect(formatAgo("2026-10-25T12:00:00Z", now)).toBe("yesterday");
  });
});

describe("formatReleaseDate", () => {
  it("preserves date precision and falls back past empty date objects", () => {
    const album = { year: 1990, originalReleaseDate: { year: 2000 }, releaseDate: { year: 2020, month: 5, day: 2 } };
    expect(formatReleaseDate({ ...album, releaseDate: { year: 2026, month: 11, day: 13 } })).toBe("2026 November 13");
    expect(formatReleaseDate(album)).toBe("2020 May 2");
    expect(formatReleaseDate({ ...album, releaseDate: { year: 2020, month: 5 } })).toBe("2020 May");
    expect(formatReleaseDate({ ...album, releaseDate: {} })).toBe("2000");
    expect(formatReleaseDate({ year: 1990, releaseDate: {}, originalReleaseDate: {} })).toBe("1990");
    expect(formatReleaseDate({ year: null, releaseDate: null, originalReleaseDate: null })).toBeNull();
  });
});
