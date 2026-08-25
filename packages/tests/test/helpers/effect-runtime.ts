import { NodeCrypto } from "@effect/platform-node";
import { Layer } from "effect";
import { FetchHttpClient } from "effect/unstable/http";

import { SubsonicAPILive } from "@muswag/shared";

export function subsonicLayerFor(connection: { baseUrl: string; username: string; password: string }) {
  return SubsonicAPILive({
    url: connection.baseUrl,
    auth: { username: connection.username, password: connection.password },
  }).pipe(Layer.provide(Layer.mergeAll(FetchHttpClient.layer, NodeCrypto.layer)));
}
