import { CoverArtIPC, PlayerIPC } from "#/lib/ipc";
import { db, dbReady } from "#/lib/db-renderer";
import { createCoverArtStore, getUserInfo, login, logout, sync } from "@muswag/shared";
import type { CoverArtFileSystem, SyncRecord, UserCredentialsToLogin, UserInfo } from "@muswag/shared";

const coverArtFileSystem: CoverArtFileSystem = {
  removeCoverFiles: (albumId) => CoverArtIPC.removeFiles(albumId),
  writeCoverFile: (albumId, extension, bytes) => CoverArtIPC.writeFile(albumId, extension, bytes),
};

let syncInFlight: Promise<SyncRecord> | undefined;

export async function syncPlayerCredentials(): Promise<void> {
  await dbReady;
  await PlayerIPC.setCredentials(getUserInfo(db));
}

export const SyncManager = {
  async login(credentials: UserCredentialsToLogin): Promise<UserInfo> {
    await dbReady;
    const user = await login(db, credentials);
    await PlayerIPC.setCredentials(user);
    return user;
  },

  async logout(): Promise<null> {
    await dbReady;
    const result = await logout(db);
    await PlayerIPC.setCredentials(null);
    return result;
  },

  async sync(): Promise<SyncRecord> {
    await dbReady;

    if (syncInFlight) {
      return syncInFlight;
    }

    const user = getUserInfo(db);
    if (!user) {
      throw new Error("You need to log in before syncing.");
    }

    syncInFlight = sync(
      db,
      createCoverArtStore({
        ...user,
        fileSystem: coverArtFileSystem,
      }),
    )
      .finally(() => {
        syncInFlight = undefined;
      });

    return syncInFlight;
  },
};
