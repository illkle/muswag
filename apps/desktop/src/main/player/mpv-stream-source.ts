import { buildSubsonicStreamUrl } from "@muswag/shared";
import type { MuswagDb } from "@muswag/shared";

const USER_CREDENTIALS_ROW_ID = 1;

export function createMpvStreamSource(getDb: () => MuswagDb) {
  async function getStreamUrl(songId: string): Promise<string> {
    const credentials = getDb().userCredentials.get(USER_CREDENTIALS_ROW_ID);
    if (!credentials) {
      throw new Error("You need to log in before playback can start.");
    }

    return buildSubsonicStreamUrl(credentials, songId);
  }

  return {
    getStreamUrl,
  };
}
