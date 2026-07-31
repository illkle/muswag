import { describe, expect, it } from "vitest";

import {
  addPlaylistEntries,
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

  it("keeps a tombstone for an unsynced create until sync can rule out an in-flight create", () => {
    const db = createInMemoryDb();
    const playlist = createPlaylist(db, { name: "Temporary" });

    deletePlaylist(db, playlist.id);

    expect(db.playlists.get(playlist.id)).toMatchObject({
      serverId: null,
      base: null,
      local: null,
      revision: 1,
    });
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

  it("adds many songs as one revision with unique entry ids", () => {
    const db = createInMemoryDb();
    const playlist = createPlaylist(db, { name: "Album drop", songIds: ["song-a"] });

    const added = addPlaylistEntries(db, playlist.id, ["song-b", "song-c", "song-b"]);

    const saved = db.playlists.get(playlist.id)!;
    expect(saved.revision).toBe(1);
    expect(saved.local?.entries.map(({ songId }) => songId)).toEqual(["song-a", "song-b", "song-c", "song-b"]);
    expect(new Set(saved.local!.entries.map(({ id }) => id)).size).toBe(4);
    expect(added.map(({ songId }) => songId)).toEqual(["song-b", "song-c", "song-b"]);
  });

  it("inserts bulk additions before the anchor entry", () => {
    const db = createInMemoryDb();
    const playlist = createPlaylist(db, { name: "Anchored", songIds: ["song-a", "song-b"] });

    addPlaylistEntries(db, playlist.id, ["song-x", "song-y"], playlist.local!.entries[1]!.id);

    expect(db.playlists.get(playlist.id)?.local?.entries.map(({ songId }) => songId)).toEqual(["song-a", "song-x", "song-y", "song-b"]);
  });

  it("does not mint entry ids that collide across revisions", () => {
    const db = createInMemoryDb();
    const playlist = createPlaylist(db, { name: "Repeated", songIds: ["song-a"] });

    addPlaylistEntries(db, playlist.id, ["song-b", "song-c"]);
    addPlaylistEntry(db, playlist.id, "song-d");
    addPlaylistEntries(db, playlist.id, ["song-e", "song-f"]);

    const ids = db.playlists.get(playlist.id)!.local!.entries.map(({ id }) => id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("leaves the playlist untouched when an entry id is unknown", () => {
    const db = createInMemoryDb();
    const playlist = createPlaylist(db, { name: "Intact", songIds: ["song-a", "song-b"] });
    const before = db.playlists.get(playlist.id)!;

    expect(() => removePlaylistEntry(db, playlist.id, "nope")).toThrow("Playlist entry not found");
    expect(() => movePlaylistEntry(db, playlist.id, "nope", null)).toThrow("Playlist entry not found");
    expect(() => movePlaylistEntry(db, playlist.id, before.local!.entries[0]!.id, "nope")).toThrow("Playlist entry not found");
    expect(() => addPlaylistEntries(db, playlist.id, ["song-c"], "nope")).toThrow("Playlist entry not found");

    const after = db.playlists.get(playlist.id)!;
    expect(after.revision).toBe(0);
    expect(after.local?.entries).toEqual(before.local?.entries);
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
