import { describe, expect, it } from "vitest";

import { getLatestSync, getSyncProgressPercent, getSyncSummaryLine } from "./sync-status";
import type { SyncProgress, SyncRecord } from "@muswag/shared";

const emptyProgress: SyncProgress = {
  artistsFetched: 0,
  artistsInserted: 0,
  artistsDeleted: 0,
  pagesFetched: 0,
  albumsFetched: 0,
  currentPage: 0,
  currentPageSize: 0,
  currentPageAlbumDetailsFetched: 0,
  currentPageAlbumDetailsTotal: 0,
  albumsInserted: 0,
  albumsUpdated: 0,
  albumsDeleted: 0,
  songsDeleted: 0,
  coverArtDeleted: 0,
  coverArtFetched: 0,
  coverArtTotal: 0,
};

function makeSync(overrides: Partial<SyncRecord>): SyncRecord {
  return {
    id: "sync-1",
    timeStarted: "2026-08-02T12:00:00.000Z",
    timeEnded: null,
    lastStatus: "running",
    error: null,
    mode: "quick",
    ...overrides,
  };
}

describe("getLatestSync", () => {
  it("picks the most recently started record regardless of list order", () => {
    const older = makeSync({ id: "older", timeStarted: "2026-08-01T09:00:00.000Z" });
    const newer = makeSync({ id: "newer", timeStarted: "2026-08-02T09:00:00.000Z" });

    expect(getLatestSync([newer, older])?.id).toBe("newer");
    expect(getLatestSync([older, newer])?.id).toBe("newer");
  });

  it("returns null when nothing has synced", () => {
    expect(getLatestSync([])).toBeNull();
    expect(getLatestSync(undefined)).toBeNull();
  });
});

describe("getSyncProgressPercent", () => {
  it("reports album detail progress while a page is being read", () => {
    const percent = getSyncProgressPercent({
      ...emptyProgress,
      currentPageAlbumDetailsFetched: 3,
      currentPageAlbumDetailsTotal: 4,
      coverArtFetched: 0,
      coverArtTotal: 200,
    });

    expect(percent).toBe(75);
  });

  it("falls back to cover art once album details are done", () => {
    const percent = getSyncProgressPercent({ ...emptyProgress, coverArtFetched: 25, coverArtTotal: 100 });

    expect(percent).toBe(25);
  });

  it("returns null when the step has no countable work", () => {
    expect(getSyncProgressPercent(emptyProgress)).toBeNull();
    expect(getSyncProgressPercent(undefined)).toBeNull();
  });
});

describe("getSyncSummaryLine", () => {
  const now = new Date("2026-08-02T12:30:00.000Z");

  it("names the running step and its progress", () => {
    const line = getSyncSummaryLine(
      makeSync({
        currentStep: "fetching-album-details",
        progress: { ...emptyProgress, currentPageAlbumDetailsFetched: 1, currentPageAlbumDetailsTotal: 2 },
      }),
      now,
    );

    expect(line).toBe("Fetching album details · 50%");
  });

  it("drops the percentage for steps that report no countable work", () => {
    expect(getSyncSummaryLine(makeSync({ currentStep: "fetching-artists" }), now)).toBe("Fetching artists");
  });

  it("reports how long ago a finished sync ended", () => {
    const line = getSyncSummaryLine(
      makeSync({ lastStatus: "completed", timeEnded: "2026-08-02T12:00:00.000Z", currentStep: "completed" }),
      now,
    );

    expect(line).toBe("Synced 30 minutes ago");
  });

  it("calls out failed and cancelled syncs", () => {
    expect(getSyncSummaryLine(makeSync({ lastStatus: "failed", error: "boom" }), now)).toBe("Last sync failed");
    expect(getSyncSummaryLine(makeSync({ lastStatus: "aborted" }), now)).toBe("Last sync cancelled");
  });

  it("says so when there is nothing to report", () => {
    expect(getSyncSummaryLine(null, now)).toBe("Never synced");
  });
});
