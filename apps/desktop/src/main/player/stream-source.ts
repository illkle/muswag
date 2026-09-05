import { buildSubsonicStreamUrl, type PlaybackItem, type SessionCredentials } from "@muswag/shared";
import { createHash } from "node:crypto";
import { Effect, Schema } from "effect";
import { playerError, type PlayerError } from "./errors";

const md5 = (input: string) => createHash("md5").update(input).digest("hex");
export function resolveStreamUrls(credentials: SessionCredentials | null, items: readonly PlaybackItem[]): Effect.Effect<ReadonlyMap<string, string>, PlayerError> {
  if (!credentials) return Effect.fail(playerError("NotAuthenticated", "playback", "Log in before starting playback."));
  return Effect.gen(function* () {
    yield* Schema.decodeEffect(Schema.URLFromString.check(Schema.makeFilter((url) => url.protocol === "http:" || url.protocol === "https:")))(credentials.url).pipe(
      Effect.mapError(() => playerError("InvalidCommand", "stream", "The music server URL is invalid.")),
    );
    return new Map(items.map((item) => [item.key, buildSubsonicStreamUrl(md5, credentials, item.track.id)]));
  });
}
