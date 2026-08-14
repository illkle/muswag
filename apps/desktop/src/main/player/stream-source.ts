import { buildSubsonicStreamUrl } from "@muswag/shared";
import type { UserCredentialsToLogin } from "@muswag/shared";
import { createHash } from "node:crypto";

const md5 = (input: string) => createHash("md5").update(input).digest("hex");

export function resolveStreamUrl(credentials: UserCredentialsToLogin | null, songId: string): string {
  if (!credentials) {
    throw new Error("You need to log in before playback can start.");
  }
  return buildSubsonicStreamUrl(md5, credentials, songId);
}
