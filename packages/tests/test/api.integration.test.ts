import { randomBytes } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

import { CoverManager, CoverManagerLive, Db, MiniFs, SubsonicAPI, subsonicToken, type SubsonicApiService } from "@muswag/backend";
import { albums, buildSubsonicStreamUrl } from "@muswag/model";
import { Effect, Exit, Layer, ManagedRuntime } from "effect";
import { layer as PathLayer } from "effect/Path";
import { afterAll, beforeAll, expect, it } from "vitest";

import { createLibrary, type Library, subsonicLayerFor, syncLibrary } from "./helpers/effect-runtime.js";
import { songCount, variedLibrary } from "./library/fixtures.js";
import { forEachServer, type TestServer } from "./servers/index.js";

/** Where `MUSWAG_RECORD_RESPONSES=1` writes what each server answered, for the client's unit tests to decode without Docker. */
const RECORDED = path.resolve(import.meta.dirname, "../../backend/src/api/recorded");
const recording = process.env["MUSWAG_RECORD_RESPONSES"] === "1";

/** Whether `bytes` start as a JPEG, PNG, GIF or WebP image does. */
function isImage(bytes: Uint8Array): boolean {
  const start = Buffer.from(bytes.subarray(0, 12)).toString("latin1");
  return start.startsWith("\xff\xd8\xff") || start.startsWith("\x89PNG") || start.startsWith("GIF8") || (start.startsWith("RIFF") && start.slice(8) === "WEBP");
}

/**
 * The varied library with one cover larger than any size muswag asks for, so that a server scaling it
 * down shows. Only here: Navidrome took minutes to scan a library after one with it, in the sync tests.
 */
const library = variedLibrary.map((album) => (album.title === "Ágætis byrjun" ? { ...album, coverPixels: 1000 } : album));

forEachServer((server, traits) => {
  let runtime: ManagedRuntime.ManagedRuntime<SubsonicAPI, unknown>;
  let api: SubsonicApiService;
  const run = <A, E>(effect: Effect.Effect<A, E>) => runtime.runPromise(effect);

  beforeAll(async () => {
    await server().setLibrary(library);
    runtime = ManagedRuntime.make(subsonicLayerFor(server()));
    api = await runtime.runPromise(SubsonicAPI);
  });
  afterAll(async () => {
    await runtime?.dispose();
  });

  it("answers ping and getScanStatus", async () => {
    const ping = await run(api.ping);
    expect(ping.status).toBe("ok");
    expect((await run(api.getScanStatus)).scanStatus.scanning).toBe(false);
  });

  it("lists artists, albums and every song", async () => {
    const { artists } = await run(api.getArtists());
    const artistNames = (artists.index ?? []).flatMap(({ artist }) => artist ?? []).map(({ name }) => name);
    expect(artistNames).toEqual(expect.arrayContaining(variedLibrary.map(({ albumArtist }) => albumArtist)));

    const listed = (await run(api.getAlbumList2({ type: "alphabeticalByArtist", size: 500 }))).albumList2.album ?? [];
    expect(listed.map(({ name }) => name).sort()).toEqual(variedLibrary.map(({ title }) => title).sort());
    for (const album of listed) {
      const { album: full } = await run(api.getAlbum({ id: album.id }));
      expect(full.song ?? []).toHaveLength(album.songCount);
    }

    const { searchResult3 } = await run(api.search3({ query: "", artistCount: 0, albumCount: 0, songCount: 500, songOffset: 0 }));
    expect(searchResult3.song ?? []).toHaveLength(songCount(variedLibrary));
  });

  it("creates, changes, lists and deletes a playlist", async () => {
    const { searchResult3 } = await run(api.search3({ query: "", artistCount: 0, albumCount: 0, songCount: 500, songOffset: 0 }));
    const [first, second] = searchResult3.song!;
    const { playlist } = await run(api.createPlaylist({ name: "Contract", songId: [first!.id, second!.id, first!.id] }));
    try {
      expect(playlist.name).toBe("Contract");

      await run(api.updatePlaylist({ playlistId: playlist.id, name: "Contract renamed", comment: "a comment", public: true, songIndexToRemove: [2, 0], songIdToAdd: [second!.id] }));
      const { playlist: changed } = await run(api.getPlaylist({ id: playlist.id }));
      expect(changed).toMatchObject({ name: "Contract renamed", songCount: 2 });
      expect(changed.comment).toBe(traits.keepsPlaylistComments ? "a comment" : undefined);
      expect((changed.entry ?? []).map(({ id }) => id)).toEqual([second!.id, second!.id]);
      expect((await run(api.getPlaylists)).playlists.playlist?.some(({ id }) => id === playlist.id)).toBe(true);

      await run(api.deletePlaylist({ id: playlist.id }));
      expect((await run(api.getPlaylists)).playlists.playlist?.some(({ id }) => id === playlist.id) ?? false).toBe(false);
    } finally {
      // Left behind by a failure, it would show up in what the next tests list.
      await server().clearPlaylists();
    }
  });

  it("stores only images as covers", async () => {
    const library = createLibrary();
    const files = new Map<string, Uint8Array>();
    const fs = Layer.succeed(MiniFs, {
      writeFile: (file, data) => Effect.sync(() => void files.set(file, data)),
      remove: (file) => Effect.sync(() => void files.delete(file)),
      exists: (file) => Effect.sync(() => files.has(file)),
      list: () => Effect.succeed([]),
    });
    const covers = ManagedRuntime.make(CoverManagerLive("covers").pipe(Layer.provide(Layer.mergeAll(library.layer, subsonicLayerFor(server()), fs, PathLayer))));
    try {
      expect(await syncLibrary(library, server())).toBeNull();
      /** What came of asking for the album's cover. */
      const outcome = async (id: string) => {
        const exit = await covers.runPromiseExit(CoverManager.use((manager) => manager.ensure({ type: "album", id })));
        if (Exit.isFailure(exit)) return String(exit.cause).includes("NotAnImage") ? "refused, not an image" : `failed: ${String(exit.cause)}`;
        if (exit.value === null) return "none";
        return isImage(files.get(exit.value)!) ? "image" : "stored something else";
      };
      const outcomes = new Map<string, string>();
      for (const { id, name } of await readAlbums(library)) outcomes.set(name, await outcome(id));

      for (const album of variedLibrary.filter(({ cover }) => cover !== false)) expect(outcomes.get(album.title)).toBe("image");
      // A server may make a cover up, have none, or answer with something that is not an image, which is left out.
      for (const album of variedLibrary.filter(({ cover }) => cover === false)) expect(["image", "none", "refused, not an image"]).toContain(outcomes.get(album.title));
    } finally {
      await covers.dispose();
      await library.dispose();
    }
  });

  it("scales a cover down to the size asked for", async () => {
    const { albumList2 } = await run(api.getAlbumList2({ type: "alphabeticalByArtist", size: 500 }));
    const album = albumList2.album!.find(({ name }) => name === "Ágætis byrjun")!;
    // The sizes muswag asks for, of a cover larger than each: the one it keeps and the two it makes from that.
    for (const size of [720, 400, 96]) {
      const response = await run(api.getCoverArt({ id: album.coverArt!, size }));
      expect(longerEdge(new Uint8Array(await run(response.arrayBuffer)))).toBe(size);
    }
  });

  it("streams a song as it is stored, from any byte on", async () => {
    const { searchResult3 } = await run(api.search3({ query: "", artistCount: 0, albumCount: 0, songCount: 500, songOffset: 0 }));
    const song = searchResult3.song!.find(({ title }) => title === "Svefn-g-englar")!;
    const salt = randomBytes(16).toString("hex");
    const url = buildSubsonicStreamUrl({ url: server().url, username: server().admin.username, salt, token: subsonicToken(server().admin.password, salt) }, song.id);

    const whole = await fetch(url);
    expect(whole.status).toBe(200);
    expect(whole.headers.get("content-type")).toMatch(/^audio\/(mpeg|mp3)/);
    const bytes = new Uint8Array(await whole.arrayBuffer());
    expect(String.fromCharCode(...bytes.subarray(0, 3))).toBe("ID3");
    expect(bytes.length).toBe(song.size);

    // mpv seeks by asking for the rest of the file from a byte on.
    const rest = await fetch(url, { headers: { range: "bytes=1000-" } });
    expect(rest.status).toBe(206);
    expect(new Uint8Array(await rest.arrayBuffer())).toEqual(bytes.subarray(1000));
  });

  it.runIf(recording)("records what the server answers, for the client's unit tests", async () => {
    await server().clearPlaylists();
    const recorded = await recordResponses(server());
    expect(recorded.map(({ method, response }) => [method, (response as { "subsonic-response": { status: string } })["subsonic-response"].status])).toEqual(
      recorded.map(({ method }) => [method, "ok"]),
    );
  });
});

/** The longer edge in pixels of a PNG, JPEG or WebP image. */
function longerEdge(bytes: Uint8Array): number {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const start = Buffer.from(bytes.subarray(0, 16)).toString("latin1");
  if (start.startsWith("\x89PNG")) return Math.max(view.getUint32(16), view.getUint32(20));
  if (start.startsWith("RIFF") && start.slice(8, 12) === "WEBP") {
    const chunk = start.slice(12, 16);
    if (chunk === "VP8X") return Math.max(1 + (view.getUint32(24, true) & 0xffffff), 1 + (view.getUint32(27, true) & 0xffffff));
    if (chunk === "VP8L") {
      const bits = view.getUint32(21, true);
      return Math.max((bits & 0x3fff) + 1, ((bits >> 14) & 0x3fff) + 1);
    }
    return Math.max(view.getUint16(26, true) & 0x3fff, view.getUint16(28, true) & 0x3fff);
  }
  // A JPEG names its size in the frame header, the first SOF segment.
  for (let offset = 2; offset < bytes.length;) {
    const marker = view.getUint16(offset);
    if (marker >= 0xffc0 && marker <= 0xffcf && marker !== 0xffc4 && marker !== 0xffc8 && marker !== 0xffcc) return Math.max(view.getUint16(offset + 5), view.getUint16(offset + 7));
    offset += 2 + view.getUint16(offset + 2);
  }
  throw new Error(`Not an image muswag knows: ${start}`);
}

function readAlbums(library: Library) {
  return library.run(Db.use((db) => db.select().from(albums)));
}

/** A request muswag makes, and what the server answered to it. */
interface Recorded {
  method: string;
  params: Record<string, unknown>;
  response: unknown;
}

async function recordResponses(server: TestServer): Promise<Recorded[]> {
  const recorded: Recorded[] = [];
  const ask = async (method: string, params: Record<string, string | number | boolean | string[] | number[]> = {}) => {
    const salt = randomBytes(8).toString("hex");
    const body = new URLSearchParams({ u: server.admin.username, t: subsonicToken(server.admin.password, salt), s: salt, v: "1.16.1", c: "muswag", f: "json" });
    for (const [key, value] of Object.entries(params)) for (const item of Array.isArray(value) ? value : [value]) body.append(key, String(item));
    const response = JSON.parse(await (await fetch(`${server.url}/rest/${method}.view`, { method: "POST", body })).text());
    recorded.push({ method, params, response });
    return response["subsonic-response"];
  };

  await ask("ping");
  await ask("getScanStatus");
  await ask("getArtists");
  const { albumList2 } = await ask("getAlbumList2", { type: "alphabeticalByArtist", size: 500, offset: 0 });
  for (const { id } of albumList2.album) await ask("getAlbum", { id });
  const { searchResult3 } = await ask("search3", { query: "", artistCount: 0, albumCount: 0, songCount: 500, songOffset: 0 });
  const songIds: string[] = searchResult3.song.slice(0, 2).map(({ id }: { id: string }) => id);
  const { playlist } = await ask("createPlaylist", { name: "Recorded", songId: songIds });
  await ask("updatePlaylist", { playlistId: playlist.id, comment: "recorded", public: false, songIndexToRemove: [0], songIdToAdd: [songIds[0]!] });
  await ask("getPlaylists");
  await ask("getPlaylist", { id: playlist.id });
  await ask("deletePlaylist", { id: playlist.id });

  await mkdir(RECORDED, { recursive: true });
  await writeFile(path.join(RECORDED, `${server.name}.json`), `${JSON.stringify(recorded, null, 2)}\n`);
  return recorded;
}
