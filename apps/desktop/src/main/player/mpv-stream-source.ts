import { buildSubsonicStreamUrl } from "@muswag/shared";
import { eq } from "drizzle-orm";

const USER_CREDENTIALS_ROW_ID = 1;

export function createMpvStreamSource(getDb: () => DB_E) {
  async function getStreamUrl(songId: string): Promise<string> {
    const rows = await getDb().select().from(userCredentialsTable).where(eq(userCredentialsTable.id, USER_CREDENTIALS_ROW_ID)).limit(1);

    const credentials = rows[0];
    if (!credentials) {
      throw new Error("You need to log in before playback can start.");
    }

    return buildSubsonicStreamUrl(credentials, songId);
  }

  return {
    getStreamUrl,
  };
}
