import { CoverArtIPC } from "#/lib/ipc";
import { db } from "#/lib/db-renderer";
import { abortSync, createCoverArtStore, getUserInfo, login, logout, sync } from "@muswag/shared";
import type { CoverArtFileSystem, SyncRecord, UserCredentialsToLogin, UserInfo } from "@muswag/shared";

const coverArtFileSystem: CoverArtFileSystem = {
  removeCoverFiles: (albumId) => CoverArtIPC.removeFiles(albumId),
  writeCoverFile: (albumId, extension, bytes) => CoverArtIPC.writeFile(albumId, extension, bytes),
};

let syncInFlight: Promise<SyncRecord> | undefined;

export const SyncManager = {
  async login(credentials: UserCredentialsToLogin): Promise<UserInfo> {
    const user = await login(db, credentials);
    return user;
  },

  async logout(): Promise<null> {
    const result = await logout(db);
    return result;
  },

  async cancelSync(): Promise<void> {
    abortSync(db);
  },

  async sync(): Promise<SyncRecord> {
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
    ).finally(() => {
      syncInFlight = undefined;
    });

    return syncInFlight;
  },
};
