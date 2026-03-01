import { describe, expect, it } from "vitest";

import { SubsonicFailureError } from "../../src/errors.js";
import { fetchAlbumList2Page } from "../../src/navidrome/client.js";

describe("subsonic response failures", () => {
  it("throws typed error when status is failed", async () => {
    const fetchImpl: typeof fetch = async () =>
      new Response(
        JSON.stringify({
          "subsonic-response": {
            status: "failed",
            error: {
              code: 70,
              message: "Wrong username or password"
            }
          }
        }),
        {
          status: 200,
          headers: {
            "content-type": "application/json"
          }
        }
      );

    await expect(
      fetchAlbumList2Page({
        connection: {
          baseUrl: "http://127.0.0.1:4533",
          username: "admin",
          password: "password",
          clientName: "muswag-test"
        },
        offset: 0,
        size: 10,
        fetchImpl
      })
    ).rejects.toEqual(
      expect.objectContaining<Partial<SubsonicFailureError>>({
        name: "SubsonicFailureError",
        code: 70
      })
    );
  });
});
