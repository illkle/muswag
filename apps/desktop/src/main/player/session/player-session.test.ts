import { describe, expect, it } from "vitest";
import type { PlayQueueInput } from "../../../shared/player";
import { PlayerSession } from "./player-session";

const tracks: PlayQueueInput["queue"] = [
  { id: "one", isDir: false, title: "One", albumId: "a", album: "A", artist: "Artist", displayArtist: "Artist", duration: 180, discNumber: 1, track: 1 },
  { id: "two", isDir: false, title: "Two", albumId: "a", album: "A", artist: "Artist", displayArtist: "Artist", duration: 200, discNumber: 1, track: 2 },
];

describe("PlayerSession", () => {
  it("snapshots a clamped queue selection and clears empty queues", () => {
    const session = new PlayerSession();
    const input: PlayQueueInput = { queue: tracks.map((track) => ({ ...track })), startIndex: 99, context: { type: "playlist", playlistId: "p", entryIds: ["e1", "e2"] } };
    expect(session.loadQueue(input)).toMatchObject({ resume: true, track: { id: "two" } });
    input.queue[1]!.title = "changed";
    (input.context as { entryIds: string[] }).entryIds.push("changed");
    expect(session.currentTrack?.title).toBe("Two");
    expect(session.getState()).toMatchObject({ queue: { currentIndex: 1, currentTrackId: "two", context: { entryIds: ["e1", "e2"] } }, nowPlaying: { durationSeconds: 200, status: "loading" } });
    expect(session.loadQueue({ queue: [], startIndex: 0 })).toBeNull();
    expect(session.status).toBe("idle");
  });

  it("navigates, restarts previous after five seconds, and observes edges", () => {
    const session = new PlayerSession();
    session.loadQueue({ queue: tracks, startIndex: 0 });
    expect(session.previous({ resume: true })).toBe("restart");
    expect(session.next({ resume: false })).toMatchObject({ resume: false, track: { id: "two" } });
    session.fileLoaded();
    expect(session.status).toBe("paused");
    expect(session.next({ resume: true })).toBeNull();
    session.positionChanged(6);
    expect(session.previous({ resume: false })).toBe("restart");
    session.positionChanged(2);
    expect(session.previous({ resume: true })).toMatchObject({ track: { id: "one" } });
  });

  it("preserves pause intent throughout loading and ended transitions", () => {
    const session = new PlayerSession();
    session.loadQueue({ queue: tracks, startIndex: 0 });
    session.pauseChanged(true);
    expect(session.status).toBe("loading");
    session.fileLoaded();
    expect(session.status).toBe("playing");
    session.pauseRequested(true);
    expect(session.status).toBe("paused");
    session.durationChanged(180);
    session.playbackEnded();
    expect(session.getState().nowPlaying).toMatchObject({ positionSeconds: 180, status: "ended" });
    session.pauseChanged(true);
    expect(session.status).toBe("ended");
    session.seekApplied(12);
    expect(session.status).toBe("paused");
  });

  it("falls back duration, clamps volume, clears errors on selection, and resets", () => {
    const session = new PlayerSession();
    session.loadQueue({ queue: tracks, startIndex: 0 });
    session.durationChanged(null);
    expect(session.getState().nowPlaying.durationSeconds).toBe(180);
    session.volumeChanged(44.6);
    session.volumeChanged(Number.NaN);
    expect(session.getState().volume.volumePercent).toBe(45);
    session.fail("broken");
    expect(session.status).toBe("error");
    session.next({ resume: true });
    expect(session.getState().nowPlaying.error).toBeNull();
    session.reset();
    expect(session.getState().volume).toEqual({ muted: false, volumePercent: 100 });
  });
});
