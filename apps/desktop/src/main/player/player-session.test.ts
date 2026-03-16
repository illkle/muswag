import { beforeEach, describe, expect, it } from "vitest";

import type { PlayQueueInput } from "../../shared/player";
import {
  advanceToNextTrack,
  getState,
  handleFileLoaded,
  handlePauseChanged,
  handlePlaybackEnded,
  handleSeekApplied,
  loadQueue,
  resetPlayerSession,
  setPauseRequested,
  updateDuration,
} from "./player-session";

const queue: PlayQueueInput["queue"] = [
  {
    id: "track-1",
    title: "Track 1",
    albumId: "album-1",
    album: "Album 1",
    artist: "Artist 1",
    displayArtist: "Artist 1",
    duration: 180,
    discNumber: 1,
    track: 1,
  },
  {
    id: "track-2",
    title: "Track 2",
    albumId: "album-1",
    album: "Album 1",
    artist: "Artist 1",
    displayArtist: "Artist 1",
    duration: 200,
    discNumber: 1,
    track: 2,
  },
];

describe("PlayerSession", () => {
  beforeEach(() => {
    resetPlayerSession();
  });

  it("initializes a loaded queue into split loading state", () => {
    loadQueue({ queue, startIndex: 1 });

    expect(getState()).toMatchObject({
      meta: {
        mpvAvailable: true,
      },
      queue: {
        currentIndex: 1,
        currentTrackId: "track-2",
        queue: ["track-1", "track-2"],
      },
      nowPlaying: {
        durationSeconds: 200,
        error: null,
        positionSeconds: 0,
        status: "loading",
      },
    });
  });

  it("preserves paused intent across track changes and file-loaded events", () => {
    loadQueue({ queue, startIndex: 0 });
    handleFileLoaded();
    setPauseRequested(true);

    expect(advanceToNextTrack({ resumePlayback: false })).toBe(true);
    expect(getState().nowPlaying.status).toBe("loading");

    handleFileLoaded();

    expect(getState()).toMatchObject({
      nowPlaying: {
        status: "paused",
      },
      queue: {
        currentIndex: 1,
        currentTrackId: "track-2",
      },
    });
  });

  it("keeps loading status when the pause property changes mid-load", () => {
    loadQueue({ queue, startIndex: 0 });
    handlePauseChanged(true);

    expect(getState().nowPlaying.status).toBe("loading");
  });

  it("restores playback state when seeking after the queue has ended", () => {
    loadQueue({ queue, startIndex: 0 });
    handleFileLoaded();
    updateDuration(180);
    handlePlaybackEnded();

    handleSeekApplied(12);

    expect(getState()).toMatchObject({
      nowPlaying: {
        positionSeconds: 12,
        status: "playing",
      },
    });
  });
});
