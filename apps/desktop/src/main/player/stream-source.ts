import { buildSubsonicStreamUrl, type PlaybackItem } from "@muswag/model";
import { Effect, Redacted, Schema } from "effect";
import type { PlayerCredentials } from "#shared/commands/player";
import { InvalidCommand, NotAuthenticated } from "./errors";

const HttpUrl = Schema.URLFromString.check(Schema.makeFilter((url) => url.protocol === "http:" || url.protocol === "https:"));

/**
 * Signed stream URLs by occurrence key. They embed credentials, so they stay redacted until written to mpv.
 * mpv recognises the track it prefetched by its URL, which a track keeps for as long as the credentials last.
 */
export const resolveStreamUrls = Effect.fn("resolveStreamUrls")(function* (credentials: PlayerCredentials | null, items: readonly PlaybackItem[]) {
  if (!credentials) return yield* new NotAuthenticated({ operation: "playback", message: "Log in before starting playback." });
  yield* Schema.decodeEffect(HttpUrl)(credentials.url).pipe(Effect.mapError(() => new InvalidCommand({ operation: "stream", message: "The music server URL is invalid." })));
  const signing = { ...credentials, token: Redacted.value(credentials.token) };
  return new Map(items.map((item) => [item.key, Redacted.make(buildSubsonicStreamUrl(signing, item.track.id), { label: "stream-url" })])) as ReadonlyMap<string, Redacted.Redacted<string>>;
});
