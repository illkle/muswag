import { buildSubsonicStreamUrl, type PlaybackItem, type SessionCredentials } from "@muswag/shared";
import { createHash } from "node:crypto";
import { Effect } from "effect";
import { playerError, type PlayerError } from "./errors";

const md5 = (input: string) => createHash("md5").update(input).digest("hex");
export function resolveStreamUrls(credentials: SessionCredentials | null, items: readonly PlaybackItem[]): Effect.Effect<ReadonlyMap<string, string>, PlayerError> {
  if (!credentials) return Effect.fail(playerError("NotAuthenticated", "playback", "Log in before starting playback."));
  return Effect.try({
    try: () => {
      const url = new URL(credentials.url);
      if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error("Invalid server URL");
      return new Map(items.map((item) => [item.key, buildSubsonicStreamUrl(md5, credentials, item.track.id)]));
    },
    catch: () => playerError("InvalidCommand", "stream", "The music server URL is invalid."),
  });
}
