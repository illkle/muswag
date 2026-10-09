import { buildSubsonicStreamUrl, type PlaybackItem } from "@muswag/model";
import { createHash, randomBytes } from "node:crypto";
import { Effect, Redacted, Schema } from "effect";
import type { PlayerCredentials } from "#shared/commands/player";
import { InvalidCommand, NotAuthenticated } from "./errors";

const md5 = (input: string) => createHash("md5").update(input).digest("hex");
const HttpUrl = Schema.URLFromString.check(Schema.makeFilter((url) => url.protocol === "http:" || url.protocol === "https:"));

/**
 * A salt to sign stream URLs with. mpv recognises the track it prefetched by its URL, so a track must keep
 * its URL every time the queue is mirrored: sign with one salt for as long as the credentials last.
 */
export const makeStreamSalt = () => randomBytes(16).toString("hex");

/** Signed stream URLs by occurrence key. They embed credentials, so they stay redacted until written to mpv. */
export const resolveStreamUrls = Effect.fn("resolveStreamUrls")(function* (credentials: PlayerCredentials | null, salt: string, items: readonly PlaybackItem[]) {
  if (!credentials) return yield* new NotAuthenticated({ operation: "playback", message: "Log in before starting playback." });
  yield* Schema.decodeEffect(HttpUrl)(credentials.url).pipe(Effect.mapError(() => new InvalidCommand({ operation: "stream", message: "The music server URL is invalid." })));
  const signing = { ...credentials, password: Redacted.value(credentials.password) };
  return new Map(items.map((item) => [item.key, Redacted.make(buildSubsonicStreamUrl(md5, signing, item.track.id, salt), { label: "stream-url" })])) as ReadonlyMap<string, Redacted.Redacted<string>>;
});
