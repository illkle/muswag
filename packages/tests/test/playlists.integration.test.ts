import { Db, PlaylistCommands, PlaylistSyncManager, PlaylistSyncManagerLive, SubsonicAPI } from "@muswag/backend";
import { rowOf } from "@muswag/backend/testing";
import { playlists } from "@muswag/model";
import { Effect, Layer, ManagedRuntime } from "effect";
import { afterEach, beforeAll, beforeEach, expect, it } from "vitest";

import { createLibrary, subsonicLayerFor } from "./helpers/effect-runtime.js";
import { librarySetA } from "./library/fixtures.js";
import { forEachServer, type TestServer } from "./servers/index.js";
import { listSongs, subsonic } from "./servers/subsonic.js";

/** muswag's playlists for the server's administrator: a library, the client, and the sync manager that never runs a pass on its own. */
function playlistSession(server: TestServer) {
  const library = createLibrary();
  const dependencies = Layer.merge(library.layer, subsonicLayerFor(server));
  const runtime = ManagedRuntime.make(Layer.merge(dependencies, PlaylistSyncManagerLive({ intervalMs: 0, debounceMs: 60_000 }).pipe(Layer.provide(dependencies))));
  const api = runtime.runSync(SubsonicAPI);
  const manager = runtime.runSync(PlaylistSyncManager);
  const commands = runtime.runSync(PlaylistCommands);
  return {
    api,
    commands,
    run: <A, E>(effect: Effect.Effect<A, E>) => runtime.runPromise(effect),
    sync: async () => {
      const status = await runtime.runPromise(manager.sync);
      expect(status.error).toBeNull();
    },
    record: (id: string) => library.run(rowOf(playlists, id)),
    records: () => library.run(Db.use((db) => db.select().from(playlists))),
    /** The playlist's songs as the server has them. */
    serverSongs: async (serverId: string) => ((await runtime.runPromise(api.getPlaylist({ id: serverId }))).playlist.entry ?? []).map(({ id }) => id),
    dispose: async () => {
      await runtime.dispose();
      await library.dispose();
    },
  };
}

forEachServer((server, traits) => {
  let songs: Record<"a" | "b" | "c", string>;
  let session: ReturnType<typeof playlistSession>;

  beforeAll(async () => {
    await server().setLibrary(librarySetA);
    const ids = new Map((await listSongs(server().url, server().admin)).map(({ title, id }) => [title, id]));
    songs = { a: ids.get("Morning Grid")!, b: ids.get("Cloud Cursor")!, c: ids.get("Late Bus")! };
  });
  beforeEach(async () => {
    await server().clearPlaylists();
    session = playlistSession(server());
  });
  afterEach(async () => {
    await session?.dispose();
  });

  it("round-trips offline writes, remote writes, ordering, duplicates, and deletion", async () => {
    const { api, commands, run, sync, record, serverSongs } = session;
    const local = await run(commands.create({ name: "Offline playlist", songIds: [songs.a, songs.a] }));
    await run(commands.addEntries(local.id, [songs.b], local.local!.entries[1]!.id));
    await sync();

    const serverId = (await record(local.id))!.serverId!;
    expect(await serverSongs(serverId)).toEqual([songs.a, songs.b, songs.a]);

    await run(api.updatePlaylist({ playlistId: serverId, name: "Remote name" }));
    await sync();
    expect((await record(local.id))?.local?.name).toBe("Remote name");

    // A change here and one on the server, made in the same second.
    await run(commands.rename(local.id, "Local name"));
    await run(api.updatePlaylist({ playlistId: serverId, songIdToAdd: [songs.b] }));
    await sync();

    expect((await run(api.getPlaylist({ id: serverId }))).playlist.name).toBe("Local name");
    expect(await serverSongs(serverId)).toEqual([songs.a, songs.b, songs.a, songs.b]);

    await run(commands.delete(local.id));
    await sync();
    expect(((await run(api.getPlaylists)).playlists.playlist ?? []).some(({ id }) => id === serverId)).toBe(false);
  });

  it("removes songs at several places and moves one, with songs in the playlist twice", async () => {
    const { commands, run, sync, record, serverSongs } = session;
    const created = await run(commands.create({ name: "Repeats", songIds: [songs.a, songs.b, songs.a, songs.b, songs.c] }));
    await sync();
    const serverId = (await record(created.id))!.serverId!;

    const [, second, , fourth, last] = created.local!.entries;
    await run(commands.removeEntries(created.id, [second!.id, fourth!.id]));
    await sync();
    expect(await serverSongs(serverId)).toEqual([songs.a, songs.a, songs.c]);

    await run(commands.moveEntries(created.id, [last!.id], created.local!.entries[0]!.id));
    await sync();
    expect(await serverSongs(serverId)).toEqual([songs.c, songs.a, songs.a]);
  });

  it("keeps a comment where the server does, and lets it go quietly where it does not", async () => {
    const { commands, run, sync, record } = session;
    const created = await run(commands.create({ name: "Commented", songIds: [songs.a] }));
    await run(commands.setComment(created.id, "for the road"));
    await sync();
    await sync();

    const synced = (await record(created.id))!;
    const { playlist } = await subsonic<{ playlist: { comment?: string } }>(server().url, server().admin, "getPlaylist", { id: synced.serverId! });
    const kept = traits.keepsPlaylistComments ? "for the road" : "";
    expect(playlist.comment ?? "").toBe(kept);
    // Nothing left to send: the playlist here is the one on the server.
    expect(synced.local).toEqual(synced.base);
    expect(synced.local?.comment).toBe(kept);
  });

  it("shows other users a public playlist and not a private one", async () => {
    const { commands, run, sync } = session;
    await run(commands.create({ name: "Private mix", songIds: [songs.a], public: false }));
    await run(commands.create({ name: "Shared mix", songIds: [songs.b], public: true }));
    await sync();

    const { playlists: seen } = await subsonic<{ playlists: { playlist?: { name: string }[] } }>(server().url, server().guest, "getPlaylists");
    const names = (seen.playlist ?? []).map(({ name }) => name);
    expect(names).toContain("Shared mix");
    expect(names).not.toContain("Private mix");
  });

  it("takes in another user's public playlist as one it may not change", async () => {
    const { commands, run, sync } = session;
    const { playlist } = await subsonic<{ playlist: { id: string } }>(server().url, server().guest, "createPlaylist", { name: "Guest picks", songId: [songs.a, songs.c] });
    await subsonic(server().url, server().guest, "updatePlaylist", { playlistId: playlist.id, public: true });
    await sync();

    const guestPicks = (await session.records()).find(({ local }) => local?.name === "Guest picks");
    expect(guestPicks?.local).toMatchObject({ readonly: true, entries: [{ songId: songs.a }, { songId: songs.c }] });
    await expect(run(commands.rename(guestPicks!.id, "Taken over"))).rejects.toThrow(/read-only/);

    await sync();
    const { playlist: after } = await subsonic<{ playlist: { name: string } }>(server().url, server().guest, "getPlaylist", { id: playlist.id });
    expect(after.name).toBe("Guest picks");
  });
});
