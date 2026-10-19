import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";

import { it } from "@effect/vitest";
import { Effect, Layer } from "effect";
import { HttpClient, HttpClientResponse } from "effect/http";
import { describe, expect } from "vitest";

import { SubsonicAPILive } from "../test/index.js";
import { SubsonicAPI, type SubsonicApiService } from "./subsonic-api.js";

/**
 * What real servers answered to muswag's requests, as `packages/tests` records them with
 * `MUSWAG_RECORD_RESPONSES=1 pnpm test:integration`. Every answer has to decode as the app receives it.
 */
const RECORDED = path.join(import.meta.dirname, "recorded");

interface Recorded {
  method: string;
  params: Record<string, unknown>;
  response: unknown;
}

/** The arguments of the API's method `M`, which a recording holds as it was sent. */
type Args<M extends keyof SubsonicApiService> = SubsonicApiService[M] extends (args: infer A) => unknown ? A : never;
const as = <M extends keyof SubsonicApiService>(params: Record<string, unknown>) => params as Args<M>;

const requests: Record<string, (api: SubsonicApiService, params: Record<string, unknown>) => Effect.Effect<unknown, unknown>> = {
  ping: (api) => api.ping,
  getScanStatus: (api) => api.getScanStatus,
  getArtists: (api, params) => api.getArtists(as<"getArtists">(params)),
  getAlbumList2: (api, params) => api.getAlbumList2(as<"getAlbumList2">(params)),
  getAlbum: (api, params) => api.getAlbum(as<"getAlbum">(params)),
  search3: (api, params) => api.search3(as<"search3">(params)),
  getPlaylists: (api) => api.getPlaylists,
  getPlaylist: (api, params) => api.getPlaylist(as<"getPlaylist">(params)),
  createPlaylist: (api, params) => api.createPlaylist(as<"createPlaylist">(params)),
  updatePlaylist: (api, params) => api.updatePlaylist(as<"updatePlaylist">(params)),
  deletePlaylist: (api, params) => api.deletePlaylist(as<"deletePlaylist">(params)),
};

const config = { url: "https://music.example", auth: { username: "admin", salt: "salt", token: "token" } };

describe.each(readdirSync(RECORDED).filter((file) => file.endsWith(".json")))("what %s answered", (file) => {
  const recorded: Recorded[] = JSON.parse(readFileSync(path.join(RECORDED, file), "utf8"));

  it.effect.each(recorded.map((entry, index) => ({ ...entry, name: `${entry.method} #${index}` })))("decodes $name", ({ method, params, response }) =>
    Effect.gen(function* () {
      const request = requests[method];
      if (!request) throw new Error(`No request for ${method}`);
      const client = HttpClient.make((sent) => Effect.succeed(HttpClientResponse.fromWeb(sent, new Response(JSON.stringify(response)))));
      const answer = yield* SubsonicAPI.use((api) => request(api, params)).pipe(Effect.provide(SubsonicAPILive(config).pipe(Layer.provide(Layer.succeed(HttpClient.HttpClient, client)))));
      expect(answer).toMatchObject({ status: "ok" });
    }),
  );
});
