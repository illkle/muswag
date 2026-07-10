import { describe, expect, it } from "vitest";

import SubsonicAPI from "@muswag/subsonic-api";
import { addPlaylistEntry, createPlaylist, createPlaylistSyncManager, deletePlaylist, login, renamePlaylist } from "@muswag/shared";
import { librarySetA } from "./fixtures/library-sets.js";
import { checkNavidromeDependencies, createInMemoryDb, createNavidromeTestConnection } from "./navidrome-testkit.js";

const dependencyStatus = checkNavidromeDependencies();
const describeIfReady = dependencyStatus.ready ? describe : describe.skip;

describeIfReady("Navidrome playlist sync", () => {
  it("round-trips offline writes, remote writes, ordering, duplicates, and deletion", async () => {
    const connection = await createNavidromeTestConnection(librarySetA, {
      generation: { mode: "tagged-template", logPerTrack: false, logPerAlbum: false },
    });
    const db = createInMemoryDb();
    let manager: ReturnType<typeof createPlaylistSyncManager> | undefined;

    try {
      await login(db, {
        url: connection.baseUrl,
        username: connection.username,
        password: connection.password,
      });
      const api = new SubsonicAPI({
        url: connection.baseUrl,
        auth: { username: connection.username, password: connection.password },
        post: true,
      });
      const listedAlbum = (await api.getAlbumList2({ type: "alphabeticalByArtist", size: 1 })).albumList2.album?.[0];
      expect(listedAlbum).toBeDefined();
      const songs = (await api.getAlbum({ id: listedAlbum!.id })).album.song ?? [];
      expect(songs.length).toBeGreaterThanOrEqual(2);

      const local = createPlaylist(db, {
        name: "Offline playlist",
        songIds: [songs[0]!.id, songs[0]!.id],
      });
      addPlaylistEntry(db, local.id, songs[1]!.id, local.local!.entries[1]!.id);
      manager = createPlaylistSyncManager(db, { intervalMs: 0, debounceMs: 10_000 });

      await manager.sync();

      const created = (await api.getPlaylists()).playlists.playlist?.find(({ name }) => name === "Offline playlist");
      expect(created).toBeDefined();
      expect((await api.getPlaylist({ id: created!.id })).playlist.entry?.map(({ id }) => id)).toEqual([
        songs[0]!.id,
        songs[1]!.id,
        songs[0]!.id,
      ]);

      await api.updatePlaylist({ playlistId: created!.id, name: "Remote name" });
      await manager.sync();
      expect(db.playlists.get(local.id)?.local?.name).toBe("Remote name");

      renamePlaylist(db, local.id, "Local name");
      await api.updatePlaylist({ playlistId: created!.id, songIdToAdd: [songs[1]!.id] });
      await manager.sync();

      const merged = await api.getPlaylist({ id: created!.id });
      expect(merged.playlist.name).toBe("Local name");
      expect(merged.playlist.entry?.map(({ id }) => id)).toEqual([songs[0]!.id, songs[1]!.id, songs[0]!.id, songs[1]!.id]);

      deletePlaylist(db, local.id);
      await manager.sync();
      expect((await api.getPlaylists()).playlists.playlist?.some(({ id }) => id === created!.id)).toBe(false);
    } finally {
      manager?.destroy();
      await connection.cleanup();
    }
  });
});
