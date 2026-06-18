import { buildSubsonicStreamUrl } from "@muswag/shared";
import type { UserCredentialsToLogin } from "@muswag/shared";

export function createMpvStreamSource(getCredentials: () => UserCredentialsToLogin | null) {
  async function getStreamUrl(songId: string): Promise<string> {
    const credentials = getCredentials();
    if (!credentials) {
      throw new Error("You need to log in before playback can start.");
    }

    return buildSubsonicStreamUrl(credentials, songId);
  }

  return {
    getStreamUrl,
  };
}
