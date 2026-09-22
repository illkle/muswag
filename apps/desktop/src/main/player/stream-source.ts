import { buildSubsonicStreamUrl, type PlaybackItem } from "@muswag/shared";
import { createHash } from "node:crypto";
import { Effect, Redacted, Schema } from "effect";
import type { PlayerCredentials } from "#shared/player-contract";
import { InvalidCommand, NotAuthenticated } from "./errors";

const md5 = (input: string) => createHash("md5").update(input).digest("hex");
const HttpUrl = Schema.URLFromString.check(Schema.makeFilter((url) => url.protocol === "http:" || url.protocol === "https:"));

/** Signed stream URLs by occurrence key. They embed credentials, so they stay redacted until written to mpv. */
export const resolveStreamUrls = Effect.fn("resolveStreamUrls")(function* (credentials: PlayerCredentials | null, items: readonly PlaybackItem[]) {
  if (!credentials) return yield* new NotAuthenticated({ operation: "playback", message: "Log in before starting playback." });
  yield* Schema.decodeEffect(HttpUrl)(credentials.url).pipe(Effect.mapError(() => new InvalidCommand({ operation: "stream", message: "The music server URL is invalid." })));
  const signing = { ...credentials, password: Redacted.value(credentials.password) };
  return new Map(items.map((item) => [item.key, Redacted.make(buildSubsonicStreamUrl(md5, signing, item.track.id), { label: "stream-url" })])) as ReadonlyMap<string, Redacted.Redacted<string>>;
});
