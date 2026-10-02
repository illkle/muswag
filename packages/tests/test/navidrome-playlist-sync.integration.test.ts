import { describe, expect, it } from "vitest";
import { PlaylistCommands, PlaylistSyncManager, PlaylistSyncManagerLive, SubsonicAPI } from "@muswag/backend";
import { rowOf } from "@muswag/backend/testing";
import { playlists } from "@muswag/model";
import { Layer, ManagedRuntime } from "effect";

import { librarySetA } from "./fixtures/library-sets.js";
import { checkNavidromeDependencies, createNavidromeTestConnection } from "./navidrome-testkit.js";
import { createLibrary, subsonicLayerFor } from "./helpers/effect-runtime.js";

const dependencyStatus = checkNavidromeDependencies();
const describeIfReady = dependencyStatus.ready ? describe : describe.skip;

describeIfReady("Navidrome playlist sync", () => {
  it("round-trips offline writes, remote writes, ordering, duplicates, and deletion", async () => {
    const connection = await createNavidromeTestConnection(librarySetA, {
      generation: { mode: "tagged-template", logPerTrack: false, logPerAlbum: false },
    });
    const db = createLibrary();

    const apiLayer = subsonicLayerFor(connection);
    const dependencies = Layer.merge(db.layer, apiLayer);
    const runtime = ManagedRuntime.make(Layer.merge(dependencies, PlaylistSyncManagerLive({ intervalMs: 0, debounceMs: 10_000 }).pipe(Layer.provide(dependencies))));

    try {
      const api = runtime.runSync(SubsonicAPI);
      const manager = runtime.runSync(PlaylistSyncManager);
      const commands = runtime.runSync(PlaylistCommands);
      const localState = async (id: string) => (await db.run(rowOf(playlists, id)))?.local;
      const listedAlbum = (await runtime.runPromise(api.getAlbumList2({ type: "alphabeticalByArtist", size: 1 }))).albumList2.album?.[0];
      expect(listedAlbum).toBeDefined();
      const songs = (await runtime.runPromise(api.getAlbum({ id: listedAlbum!.id }))).album.song ?? [];
      expect(songs.length).toBeGreaterThanOrEqual(2);

      const local = await runtime.runPromise(commands.create({ name: "Offline playlist", songIds: [songs[0]!.id, songs[0]!.id] }));
      await runtime.runPromise(commands.addEntries(local.id, [songs[1]!.id], local.local!.entries[1]!.id));
      await runtime.runPromise(manager.sync);

      const created = (await runtime.runPromise(api.getPlaylists)).playlists.playlist?.find(({ name }) => name === "Offline playlist");
      expect(created).toBeDefined();
      expect((await runtime.runPromise(api.getPlaylist({ id: created!.id }))).playlist.entry?.map(({ id }) => id)).toEqual([songs[0]!.id, songs[1]!.id, songs[0]!.id]);

      await runtime.runPromise(api.updatePlaylist({ playlistId: created!.id, name: "Remote name" }));
      await runtime.runPromise(manager.sync);
      expect((await localState(local.id))?.name).toBe("Remote name");

      await runtime.runPromise(commands.rename(local.id, "Local name"));
      await runtime.runPromise(api.updatePlaylist({ playlistId: created!.id, songIdToAdd: [songs[1]!.id] }));
      await runtime.runPromise(manager.sync);

      const merged = await runtime.runPromise(api.getPlaylist({ id: created!.id }));
      expect(merged.playlist.name).toBe("Local name");
      expect(merged.playlist.entry?.map(({ id }) => id)).toEqual([songs[0]!.id, songs[1]!.id, songs[0]!.id, songs[1]!.id]);

      await runtime.runPromise(commands.delete(local.id));
      await runtime.runPromise(manager.sync);
      expect(((await runtime.runPromise(api.getPlaylists)).playlists.playlist ?? []).some(({ id }) => id === created!.id)).toBe(false);
    } finally {
      await runtime.dispose();
      await db.dispose();
      await connection.cleanup();
    }
  });
});
