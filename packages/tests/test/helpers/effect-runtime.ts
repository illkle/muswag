import { createHash, randomBytes } from "node:crypto";
import { Effect, Layer } from "effect";
import { FetchHttpClient } from "effect/unstable/http";

import { SubsonicAPILive, SubsonicCrypto } from "@muswag/shared";

export function subsonicLayerFor(connection: { baseUrl: string; username: string; password: string }) {
  return SubsonicAPILive({
    url: connection.baseUrl,
    auth: { username: connection.username, password: connection.password },
  }).pipe(
    Layer.provide(
      Layer.mergeAll(
        FetchHttpClient.layer,
        Layer.succeed(
          SubsonicCrypto,
          SubsonicCrypto.of({
            md5: (input) => Effect.sync(() => createHash("md5").update(input).digest("hex")),
            cachedSaltGenerator: () => randomBytes(16).toString("hex"),
          }),
        ),
      ),
    ),
  );
}
