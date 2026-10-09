import { describe, expect, it } from "@effect/vitest";
import { playlists, type PlaylistRecord, type PlaylistState } from "@muswag/model";
import { Effect, Fiber, Layer, Stream } from "effect";

import { rowOf, seed, TestDatabase } from "../test/index.js";
import { PlaylistCommands, PlaylistEdits } from "./commands.js";

const layer = PlaylistCommands.layer.pipe(Layer.provideMerge(PlaylistEdits.layer), Layer.provideMerge(TestDatabase()));

const saved = (id: string) => rowOf(playlists, id).pipe(Effect.map((row) => row as PlaylistRecord));

const synced = (overrides: Partial<PlaylistState> = {}): PlaylistState => ({ name: "Synced", comment: "", public: false, readonly: false, entries: [], ...overrides });

describe("PlaylistCommands", () => {
  it.effect("applies ordered offline edits to the persisted playlist row", () =>
    Effect.gen(function* () {
      const commands = yield* PlaylistCommands;
      const playlist = yield* commands.create({ name: "Draft", songIds: ["song-a", "song-a"] });
      const [appended] = yield* commands.addEntries(playlist.id, ["song-b"]);

      yield* commands.addEntries(playlist.id, ["song-c"], appended!.id);
      yield* commands.removeEntry(playlist.id, playlist.local!.entries[1]!.id);
      yield* commands.rename(playlist.id, "Offline mix");
      yield* commands.setComment(playlist.id, "Train ride");
      yield* commands.setVisibility(playlist.id, true);

      const row = yield* saved(playlist.id);
      expect(row.local).toMatchObject({ name: "Offline mix", comment: "Train ride", public: true });
      expect(row.local?.entries.map(({ songId }) => songId)).toEqual(["song-a", "song-c", "song-b"]);
      expect(row.revision).toBe(6);
      expect(row.base).toBeNull();
    }).pipe(Effect.provide(layer)),
  );

  it.effect("preserves the synced snapshot", () =>
    Effect.gen(function* () {
      const state = synced({ entries: [{ id: "remote:server-1:0", songId: "song-a" }] });
      yield* seed({ playlists: [{ id: "server-1", serverId: "server-1", base: state, local: state, revision: 0 }] });
      const commands = yield* PlaylistCommands;

      yield* commands.rename("server-1", "Edited");
      yield* commands.addEntries("server-1", ["song-b"]);
      yield* commands.removeEntry("server-1", state.entries[0]!.id);

      const row = yield* saved("server-1");
      expect(row.base).toEqual(state);
      expect(row.local?.name).toBe("Edited");
      expect(row.local?.entries.map(({ songId }) => songId)).toEqual(["song-b"]);
      expect(row.revision).toBe(3);
    }).pipe(Effect.provide(layer)),
  );

  it.effect("keeps a tombstone for an unsynced create until sync can rule out an in-flight create", () =>
    Effect.gen(function* () {
      const commands = yield* PlaylistCommands;
      const playlist = yield* commands.create({ name: "Temporary" });

      yield* commands.delete(playlist.id);

      expect(yield* saved(playlist.id)).toMatchObject({ serverId: null, base: null, local: null, revision: 1 });
    }).pipe(Effect.provide(layer)),
  );

  it.effect("keeps a tombstone for a server playlist", () =>
    Effect.gen(function* () {
      yield* seed({ playlists: [{ id: "local-1", serverId: "server-1", base: synced(), local: synced(), revision: 0 }] });

      yield* (yield* PlaylistCommands).delete("local-1");

      expect(yield* saved("local-1")).toMatchObject({ serverId: "server-1", local: null, revision: 1 });
    }).pipe(Effect.provide(layer)),
  );

  it.effect("adds many songs as one revision with unique entry ids", () =>
    Effect.gen(function* () {
      const commands = yield* PlaylistCommands;
      const playlist = yield* commands.create({ name: "Album drop", songIds: ["song-a"] });

      const added = yield* commands.addEntries(playlist.id, ["song-b", "song-c", "song-b"]);

      const row = yield* saved(playlist.id);
      expect(row.revision).toBe(1);
      expect(row.local?.entries.map(({ songId }) => songId)).toEqual(["song-a", "song-b", "song-c", "song-b"]);
      expect(new Set(row.local!.entries.map(({ id }) => id)).size).toBe(4);
      expect(added.map(({ songId }) => songId)).toEqual(["song-b", "song-c", "song-b"]);
    }).pipe(Effect.provide(layer)),
  );

  it.effect("inserts bulk additions before the anchor entry", () =>
    Effect.gen(function* () {
      const commands = yield* PlaylistCommands;
      const playlist = yield* commands.create({ name: "Anchored", songIds: ["song-a", "song-b"] });

      yield* commands.addEntries(playlist.id, ["song-x", "song-y"], playlist.local!.entries[1]!.id);

      expect((yield* saved(playlist.id)).local?.entries.map(({ songId }) => songId)).toEqual(["song-a", "song-x", "song-y", "song-b"]);
    }).pipe(Effect.provide(layer)),
  );

  it.effect("does not mint entry ids that collide across revisions", () =>
    Effect.gen(function* () {
      const commands = yield* PlaylistCommands;
      const playlist = yield* commands.create({ name: "Repeated", songIds: ["song-a"] });

      yield* commands.addEntries(playlist.id, ["song-b", "song-c"]);
      yield* commands.addEntries(playlist.id, ["song-d"]);
      yield* commands.addEntries(playlist.id, ["song-e", "song-f"]);

      const ids = (yield* saved(playlist.id)).local!.entries.map(({ id }) => id);
      expect(new Set(ids).size).toBe(ids.length);
    }).pipe(Effect.provide(layer)),
  );

  it.effect("leaves the playlist untouched when an entry id is unknown", () =>
    Effect.gen(function* () {
      const commands = yield* PlaylistCommands;
      const playlist = yield* commands.create({ name: "Intact", songIds: ["song-a", "song-b"] });

      const errors = yield* Effect.all([Effect.flip(commands.removeEntry(playlist.id, "nope")), Effect.flip(commands.addEntries(playlist.id, ["song-c"], "nope"))]);

      expect(errors.map(({ message }) => message)).toEqual(Array(2).fill("Playlist entry not found: nope"));
      expect(yield* saved(playlist.id)).toEqual(playlist);
    }).pipe(Effect.provide(layer)),
  );

  it.effect("rejects edits to read-only playlists and empty names", () =>
    Effect.gen(function* () {
      yield* seed({ playlists: [{ id: "smart", serverId: "smart", base: synced({ readonly: true }), local: synced({ readonly: true }), revision: 0 }] });
      const commands = yield* PlaylistCommands;

      expect((yield* Effect.flip(commands.rename("smart", "Changed"))).message).toBe("Playlist is read-only: smart");
      expect((yield* Effect.flip(commands.rename("smart", "  "))).message).toBe("Playlist name cannot be empty");
      expect((yield* Effect.flip(commands.create({ name: "" }))).message).toBe("Playlist name cannot be empty");
      expect((yield* Effect.flip(commands.setComment("missing", "x"))).message).toBe("Playlist not found: missing");
    }).pipe(Effect.provide(layer)),
  );

  it.effect("announces every saved edit", () =>
    Effect.gen(function* () {
      const commands = yield* PlaylistCommands;
      const edits = yield* PlaylistEdits;
      const received = yield* edits.stream.pipe(Stream.take(3), Stream.runCollect, Effect.forkChild);
      yield* Effect.yieldNow;

      const playlist = yield* commands.create({ name: "Announced" });
      yield* Effect.flip(commands.rename(playlist.id, ""));
      yield* commands.addEntries(playlist.id, []);
      yield* commands.rename(playlist.id, "Renamed");
      yield* commands.delete(playlist.id);

      expect(yield* Fiber.join(received)).toHaveLength(3);
    }).pipe(Effect.provide(layer)),
  );
});
