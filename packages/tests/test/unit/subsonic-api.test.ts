import { describe, expect, it } from "vitest";

import SubsonicAPI, { SubsonicApiError } from "@muswag/subsonic-api";

function jsonResponse(payload: unknown): Response {
  return new Response(JSON.stringify(payload), {
    status: 200,
    headers: {
      "Content-Type": "application/json",
    },
  });
}

function createApi(payload: unknown, urls: string[] = []): SubsonicAPI {
  return new SubsonicAPI({
    url: "https://music.example",
    salt: "fixed-salt",
    reuseSalt: true,
    auth: {
      username: "alice",
      password: "secret",
    },
    fetch: async (url) => {
      urls.push(url.toString());
      return jsonResponse(payload);
    },
  });
}

describe("SubsonicAPI", () => {
  it("parses and returns verified album list responses", async () => {
    const urls: string[] = [];
    const api = createApi(
      {
        "subsonic-response": {
          status: "ok",
          version: "1.16.1",
          albumList2: {
            album: [
              {
                id: "album-1",
                name: "First Album",
                created: "2026-01-01T00:00:00Z",
                duration: 120,
                songCount: 1,
                genres: [{ name: "Synthpop" }],
              },
            ],
          },
        },
      },
      urls,
    );

    const payload = await api.getAlbumList2({
      type: "alphabeticalByArtist",
      size: 500,
      offset: 0,
    });

    expect(payload.albumList2.album?.[0]).toMatchObject({
      id: "album-1",
      name: "First Album",
      genres: [{ name: "Synthpop" }],
    });
    expect(urls[0]).toContain("/rest/getAlbumList2.view?");
    expect(urls[0]).toContain("u=alice");
    expect(urls[0]).toContain("s=fixed-salt");
  });

  it("rejects malformed endpoint payloads", async () => {
    const api = createApi({
      "subsonic-response": {
        status: "ok",
        version: "1.16.1",
        albumList2: {
          album: [
            {
              id: "album-1",
              name: "First Album",
              created: "2026-01-01T00:00:00Z",
              duration: 120,
            },
          ],
        },
      },
    });

    await expect(
      api.getAlbumList2({
        type: "alphabeticalByArtist",
      }),
    ).rejects.toMatchObject({
      name: "ZodError",
    });
  });

  it("throws typed errors for failed Subsonic responses", async () => {
    const api = createApi({
      "subsonic-response": {
        status: "failed",
        version: "1.16.1",
        error: {
          code: 40,
          message: "Wrong username or password.",
        },
      },
    });

    await expect(api.ping()).rejects.toBeInstanceOf(SubsonicApiError);
    await expect(api.ping()).rejects.toMatchObject({
      code: 40,
      message: "Wrong username or password.",
    });
  });

  it("parses full playlist responses", async () => {
    const api = createApi({
      "subsonic-response": {
        status: "ok",
        version: "1.16.1",
        playlist: {
          id: "playlist-1",
          name: "Offline mix",
          comment: "For the train",
          public: false,
          readonly: false,
          songCount: 2,
          duration: 240,
          created: "2026-07-10T10:00:00Z",
          changed: "2026-07-10T11:00:00Z",
          entry: [
            { id: "song-1", title: "One", isDir: false },
            { id: "song-1", title: "One again", isDir: false },
          ],
        },
      },
    });

    const result = await api.getPlaylist({ id: "playlist-1" });

    expect(result.playlist).toMatchObject({
      id: "playlist-1",
      name: "Offline mix",
      readonly: false,
    });
    expect(result.playlist.entry?.map(({ id }) => id)).toEqual(["song-1", "song-1"]);
  });

  it("encodes repeated playlist update parameters", async () => {
    const urls: string[] = [];
    const api = createApi(
      {
        "subsonic-response": {
          status: "ok",
          version: "1.16.1",
        },
      },
      urls,
    );

    await api.updatePlaylist({
      playlistId: "playlist-1",
      songIndexToRemove: [2, 1, 0],
      songIdToAdd: ["song-a", "song-b"],
    });

    const url = new URL(urls[0]!);
    expect(url.pathname).toBe("/rest/updatePlaylist.view");
    expect(url.searchParams.getAll("songIndexToRemove")).toEqual(["2", "1", "0"]);
    expect(url.searchParams.getAll("songIdToAdd")).toEqual(["song-a", "song-b"]);
  });
});
