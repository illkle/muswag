import { describe, expect, it } from "vitest";

import {
  addPlaylistEntry,
  createPlaylist,
  deletePlaylist,
  movePlaylistEntry,
  removePlaylistEntry,
  renamePlaylist,
  setPlaylistComment,
  setPlaylistVisibility,
} from "@muswag/shared";
import { createInMemoryDb } from "../navidrome-testkit.js";

describe("playlist controls", () => {
  it("applies ordered offline edits to the persisted playlist row", () => {
    const db = createInMemoryDb();
    const playlist = createPlaylist(db, { name: "Draft", songIds: ["song-a", "song-a"] });
    const appended = addPlaylistEntry(db, playlist.id, "song-b");

    movePlaylistEntry(db, playlist.id, appended.id, playlist.local!.entries[0]!.id);
    removePlaylistEntry(db, playlist.id, playlist.local!.entries[1]!.id);
    renamePlaylist(db, playlist.id, "Offline mix");
    setPlaylistComment(db, playlist.id, "Train ride");
    setPlaylistVisibility(db, playlist.id, true);

    const saved = db.playlists.get(playlist.id)!;
    expect(saved.local).toMatchObject({
      name: "Offline mix",
      comment: "Train ride",
      public: true,
    });
    expect(saved.local?.entries.map(({ songId }) => songId)).toEqual(["song-b", "song-a"]);
    expect(saved.revision).toBe(6);
    expect(saved.base).toBeNull();
  });

  it("removes an unsynced create without leaving a tombstone", () => {
    const db = createInMemoryDb();
    const playlist = createPlaylist(db, { name: "Temporary" });

    deletePlaylist(db, playlist.id);

    expect(db.playlists.get(playlist.id)).toBeUndefined();
  });

  it("keeps a tombstone for a server playlist", () => {
    const db = createInMemoryDb();
    const state = {
      name: "Synced",
      comment: "",
      public: false,
      readonly: false,
      entries: [],
    };
    db.playlists.insert({ id: "local-1", serverId: "server-1", base: state, local: state, revision: 0 });

    deletePlaylist(db, "local-1");

    expect(db.playlists.get("local-1")).toMatchObject({
      serverId: "server-1",
      local: null,
      revision: 1,
    });
  });

  it("rejects edits to read-only playlists", () => {
    const db = createInMemoryDb();
    const state = {
      name: "Smart",
      comment: "",
      public: false,
      readonly: true,
      entries: [],
    };
    db.playlists.insert({ id: "smart", serverId: "smart", base: state, local: state, revision: 0 });

    expect(() => renamePlaylist(db, "smart", "Changed")).toThrow("Playlist is read-only");
  });
});
