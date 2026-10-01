import { describe, expect, it } from "@effect/vitest";
import { Effect } from "effect";

import { addSongsToPlaylist, createPlaylist, deletePlaylist, movePlaylistEntry, removePlaylistEntry, updatePlaylist } from "./controls.js";
import type { PlaylistState } from "./types.js";
import { MuswagDatabase, type MuswagDb } from "../db/database.js";
import { createInMemoryDb } from "../test/database.js";

function withDb<A, E>(test: (db: MuswagDb) => Effect.Effect<A, E, MuswagDatabase>) {
  const db = createInMemoryDb();
  return test(db).pipe(Effect.provideService(MuswagDatabase, db));
}

function syncedState(overrides: Partial<PlaylistState> = {}): PlaylistState {
  return { name: "Synced", comment: "", public: false, readonly: false, entries: [], ...overrides };
}

const songIdsOf = (db: MuswagDb, id: string) => db.playlists.get(id)?.local?.entries.map(({ songId }) => songId);

describe("playlist controls", () => {
  it.effect("applies ordered offline edits to the persisted playlist row", () =>
    withDb((db) =>
      Effect.gen(function* () {
        const playlist = yield* createPlaylist({ name: "Draft", songIds: ["song-a", "song-a"] });
        const [first, second] = playlist.local!.entries;
        const appended = (yield* addSongsToPlaylist(playlist.id, ["song-b"])).local!.entries.at(-1)!;

        yield* movePlaylistEntry(playlist.id, appended.id, first!.id);
        yield* removePlaylistEntry(playlist.id, second!.id);
        yield* updatePlaylist(playlist.id, { name: "Offline mix", comment: "Train ride", public: true });

        const saved = db.playlists.get(playlist.id)!;
        expect(saved.local).toMatchObject({ name: "Offline mix", comment: "Train ride", public: true });
        expect(songIdsOf(db, playlist.id)).toEqual(["song-b", "song-a"]);
        expect(saved.revision).toBe(4);
        expect(saved.base).toBeNull();
      }),
    ),
  );

  it.effect("creates a playlist with its details and songs in one revision", () =>
    withDb((db) =>
      Effect.gen(function* () {
        const playlist = yield* createPlaylist({ name: "  Trip  ", comment: "Road", public: true, songIds: ["song-a"] });

        expect(db.playlists.get(playlist.id)).toMatchObject({
          serverId: null,
          revision: 0,
          local: { name: "Trip", comment: "Road", public: true },
        });
      }),
    ),
  );

  it.effect("skips a write when an update changes nothing", () =>
    withDb((db) =>
      Effect.gen(function* () {
        const playlist = yield* createPlaylist({ name: "Same" });

        yield* updatePlaylist(playlist.id, { name: " Same ", comment: "", public: false });

        expect(db.playlists.get(playlist.id)?.revision).toBe(0);
      }),
    ),
  );

  it.effect("preserves the synced snapshot when local edits start from a shared object", () =>
    withDb((db) =>
      Effect.gen(function* () {
        const state = syncedState({ entries: [{ id: "remote:server-1:0", songId: "song-a" }] });
        const snapshot = structuredClone(state);
        db.playlists.insert({ id: "server-1", serverId: "server-1", base: state, local: state, revision: 0 });

        yield* updatePlaylist("server-1", { name: "Edited" });
        yield* addSongsToPlaylist("server-1", ["song-b"]);
        yield* removePlaylistEntry("server-1", state.entries[0]!.id);

        const saved = db.playlists.get("server-1")!;
        expect(saved.base).toEqual(snapshot);
        expect(saved.local?.name).toBe("Edited");
        expect(songIdsOf(db, "server-1")).toEqual(["song-b"]);
        expect(saved.revision).toBe(3);
      }),
    ),
  );

  it.effect("keeps a tombstone for an unsynced create until sync can rule out an in-flight create", () =>
    withDb((db) =>
      Effect.gen(function* () {
        const playlist = yield* createPlaylist({ name: "Temporary" });

        yield* deletePlaylist(playlist.id);

        expect(db.playlists.get(playlist.id)).toMatchObject({ serverId: null, base: null, local: null, revision: 1 });
      }),
    ),
  );

  it.effect("keeps a tombstone for a server playlist", () =>
    withDb((db) =>
      Effect.gen(function* () {
        const state = syncedState();
        db.playlists.insert({ id: "local-1", serverId: "server-1", base: state, local: state, revision: 0 });

        yield* deletePlaylist("local-1");

        expect(db.playlists.get("local-1")).toMatchObject({ serverId: "server-1", local: null, revision: 1 });
      }),
    ),
  );

  it.effect("adds many songs as one revision with unique entry ids", () =>
    withDb((db) =>
      Effect.gen(function* () {
        const playlist = yield* createPlaylist({ name: "Album drop", songIds: ["song-a"] });

        yield* addSongsToPlaylist(playlist.id, ["song-b", "song-c", "song-b"]);

        const saved = db.playlists.get(playlist.id)!;
        expect(saved.revision).toBe(1);
        expect(songIdsOf(db, playlist.id)).toEqual(["song-a", "song-b", "song-c", "song-b"]);
        expect(new Set(saved.local!.entries.map(({ id }) => id)).size).toBe(4);
      }),
    ),
  );

  it.effect("inserts bulk additions before the anchor entry", () =>
    withDb((db) =>
      Effect.gen(function* () {
        const playlist = yield* createPlaylist({ name: "Anchored", songIds: ["song-a", "song-b"] });

        yield* addSongsToPlaylist(playlist.id, ["song-x", "song-y"], playlist.local!.entries[1]!.id);

        expect(songIdsOf(db, playlist.id)).toEqual(["song-a", "song-x", "song-y", "song-b"]);
      }),
    ),
  );

  it.effect("does not mint entry ids that collide across revisions", () =>
    withDb((db) =>
      Effect.gen(function* () {
        const playlist = yield* createPlaylist({ name: "Repeated", songIds: ["song-a"] });

        yield* addSongsToPlaylist(playlist.id, ["song-b", "song-c"]);
        yield* addSongsToPlaylist(playlist.id, ["song-d"]);
        yield* addSongsToPlaylist(playlist.id, ["song-e", "song-f"]);

        const ids = db.playlists.get(playlist.id)!.local!.entries.map(({ id }) => id);
        expect(new Set(ids).size).toBe(ids.length);
      }),
    ),
  );

  it.effect("leaves the playlist untouched when an entry id is unknown", () =>
    withDb((db) =>
      Effect.gen(function* () {
        const playlist = yield* createPlaylist({ name: "Intact", songIds: ["song-a", "song-b"] });
        const first = playlist.local!.entries[0]!.id;

        const failures = yield* Effect.all(
          [
            removePlaylistEntry(playlist.id, "nope"),
            movePlaylistEntry(playlist.id, "nope", null),
            movePlaylistEntry(playlist.id, first, "nope"),
            addSongsToPlaylist(playlist.id, ["song-c"], "nope"),
          ].map(Effect.flip),
        );

        expect(failures.map(({ _tag }) => _tag)).toEqual(Array(4).fill("PlaylistEntryNotFound"));
        expect(db.playlists.get(playlist.id)).toMatchObject({ revision: 0, local: { entries: playlist.local!.entries } });
      }),
    ),
  );

  it.effect("rejects edits to read-only playlists", () =>
    withDb((db) =>
      Effect.gen(function* () {
        const state = syncedState({ readonly: true });
        db.playlists.insert({ id: "smart", serverId: "smart", base: state, local: state, revision: 0 });

        const error = yield* Effect.flip(updatePlaylist("smart", { name: "Changed" }));

        expect(error._tag).toBe("PlaylistReadOnly");
        expect(error.message).toBe("Playlist is read-only: smart");
      }),
    ),
  );

  it.effect("rejects an empty name", () =>
    withDb(() =>
      Effect.gen(function* () {
        const error = yield* Effect.flip(createPlaylist({ name: "   " }));

        expect(error.message).toBe("Playlist name cannot be empty");
      }),
    ),
  );
});
