import { describe, expect, it } from "vitest";

import { Database, createBetterSqliteAdapter } from "../../src/index.js";

describe("Database sync failures", () => {
  it("throws on failed Subsonic envelope", async () => {
    const database = new Database(createBetterSqliteAdapter(":memory:"));

    const failedFetch: typeof fetch = async () =>
      new Response(
        JSON.stringify({
          "subsonic-response": {
            status: "failed",
            error: {
              code: 70,
              message: "Wrong username or password",
            },
          },
        }),
        {
          status: 200,
          headers: {
            "content-type": "application/json",
          },
        },
      );

    await expect(
      database.sync({
        connection: {
          baseUrl: "http://127.0.0.1:4533",
          username: "admin",
          password: "password",
          clientName: "muswag-test",
        },
        fetchImpl: failedFetch,
      }),
    ).rejects.toThrow("Wrong username or password");
  });
});
