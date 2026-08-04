import { buildSubsonicStreamUrl } from "@muswag/shared";
import type { UserCredentialsToLogin } from "@muswag/shared";

export function resolveStreamUrl(credentials: UserCredentialsToLogin | null, songId: string): string {
  if (!credentials) {
    throw new Error("You need to log in before playback can start.");
  }
  return buildSubsonicStreamUrl(credentials, songId);
}
