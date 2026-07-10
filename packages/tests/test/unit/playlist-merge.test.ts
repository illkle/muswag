import { describe, expect, it } from "vitest";

import { mergePlaylists } from "@muswag/shared";
import type { PlaylistEntry, PlaylistRecord, PlaylistState, RemotePlaylist } from "@muswag/shared";

function entries(...songIds: string[]): PlaylistEntry[] {
  return songIds.map((songId, index) => ({ id: `entry-${index}`, songId }));
}

function state(overrides: Partial<PlaylistState> = {}): PlaylistState {
  return {
    name: "Mix",
    comment: "",
    public: false,
    readonly: false,
    entries: entries("song-a", "song-b"),
    ...overrides,
  };
}

function local(base: PlaylistState, current: PlaylistState = base): PlaylistRecord {
  return { id: "local-1", serverId: "server-1", base, local: current, revision: 0 };
}

function remote(overrides: Partial<RemotePlaylist> = {}): RemotePlaylist {
  return {
    id: "server-1",
    name: "Mix",
    comment: "",
    public: false,
    readonly: false,
    songIds: ["song-a", "song-b"],
    ...overrides,
  };
}

describe("mergePlaylists", () => {
  it("pulls new remote playlists into clean local state", () => {
    const result = mergePlaylists([], [remote()]);

    expect(result.remote).toEqual([]);
    expect(result.local).toHaveLength(1);
    expect(result.local[0]).toMatchObject({ id: "server-1", serverId: "server-1", revision: 0 });
    expect(result.local[0]?.base).toEqual(result.local[0]?.local);
  });

  it("pushes offline creates", () => {
    const draft = state();
    const result = mergePlaylists([{ id: "draft", serverId: null, base: null, local: draft, revision: 2 }], []);

    expect(result.remote).toEqual([{ type: "create", localId: "draft", state: draft }]);
    expect(result.local[0]?.revision).toBe(2);
  });

  it("pulls remote-only changes", () => {
    const base = state();
    const result = mergePlaylists([local(base)], [remote({ name: "Renamed remotely", songIds: ["song-b", "song-a"] })]);

    expect(result.remote).toEqual([]);
    expect(result.local[0]?.local?.name).toBe("Renamed remotely");
    expect(result.local[0]?.local?.entries.map(({ songId }) => songId)).toEqual(["song-b", "song-a"]);
    expect(result.local[0]?.base).toEqual(result.local[0]?.local);
  });

  it("pushes local-only changes as a complete replacement", () => {
    const base = state();
    const current = state({ name: "Renamed locally", entries: [...base.entries].reverse() });
    const result = mergePlaylists([local(base, current)], [remote()]);

    expect(result.remote).toEqual([
      {
        type: "replace",
        localId: "local-1",
        serverId: "server-1",
        previousSongCount: 2,
        state: expect.objectContaining({ name: "Renamed locally" }),
      },
    ]);
    expect(result.local[0]?.local?.entries.map(({ songId }) => songId)).toEqual(["song-b", "song-a"]);
  });

  it("merges concurrent additions and lets local metadata win", () => {
    const base = state();
    const current = state({
      name: "Local name",
      entries: [...base.entries, { id: "local-added", songId: "song-local" }],
    });
    const result = mergePlaylists([local(base, current)], [remote({ name: "Remote name", songIds: ["song-a", "song-b", "song-remote"] })]);

    expect(result.local[0]?.local?.name).toBe("Local name");
    expect(result.local[0]?.local?.entries.map(({ songId }) => songId)).toEqual(["song-a", "song-b", "song-remote", "song-local"]);
    expect(result.remote).toHaveLength(1);
  });

  it("uses removal-wins semantics for concurrent entry changes", () => {
    const base = state({ entries: entries("song-a", "song-a", "song-b") });
    const current = state({ entries: [base.entries[1]!, base.entries[2]!] });
    const result = mergePlaylists([local(base, current)], [remote({ songIds: ["song-a", "song-b"] })]);

    expect(result.local[0]?.local?.entries.map(({ songId }) => songId)).toEqual(["song-b"]);
  });

  it("recreates a remotely deleted playlist only when it has local changes", () => {
    const base = state();
    const current = state({ comment: "Keep this" });

    const dirty = mergePlaylists([local(base, current)], []);
    const clean = mergePlaylists([local(base)], []);

    expect(dirty.local[0]).toMatchObject({ serverId: null, base: null });
    expect(dirty.remote[0]).toMatchObject({ type: "create", localId: "local-1" });
    expect(clean).toEqual({ local: [], remote: [] });
  });

  it("uses at-least-once create semantics after a lost response", () => {
    const draft = state();
    const result = mergePlaylists(
      [{ id: "draft", serverId: null, base: null, local: draft, revision: 0 }],
      [remote({ id: "possibly-created", songIds: ["song-a", "song-b"] })],
    );

    expect(result.local.map(({ id }) => id)).toEqual(["draft", "possibly-created"]);
    expect(result.remote).toEqual([{ type: "create", localId: "draft", state: draft }]);
  });
});
