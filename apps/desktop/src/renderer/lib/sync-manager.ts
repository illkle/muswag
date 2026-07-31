import { CoverArtIPC } from "#/lib/ipc";
import { db } from "#/lib/db-renderer";
import { abortSync, createCoverArtStore, createCoverManager, getUserInfo, login, logout, sync } from "@muswag/shared";
import type { CoverArtFileSystem, CoverManager, CoverTarget, SyncMode, SyncRecord, UserCredentialsToLogin, UserInfo } from "@muswag/shared";

const coverArtFileSystem: CoverArtFileSystem = {
  removeCoverFiles: (key) => CoverArtIPC.removeFiles(key),
  writeCoverFile: (key, extension, bytes) => CoverArtIPC.writeFile(key, extension, bytes),
  listCoverFiles: () => CoverArtIPC.listFiles(),
  removeCoverFile: (path) => CoverArtIPC.removeFile(path),
};

let syncInFlight: { mode: SyncMode; promise: Promise<SyncRecord> } | undefined;
let currentCovers: { credentialKey: string; manager: CoverManager } | undefined;

function getCoverManager(): CoverManager {
  const user = getUserInfo(db);
  if (!user) throw new Error("You need to log in before loading cover art.");
  const credentialKey = `${user.url}\n${user.username}\n${user.password}`;
  if (currentCovers?.credentialKey === credentialKey) return currentCovers.manager;
  const store = createCoverArtStore({ ...user, fileSystem: coverArtFileSystem });
  const manager = createCoverManager({ db, store });
  currentCovers = { credentialKey, manager };
  return manager;
}

export const CoverArt = {
  ensure: (target: CoverTarget) => getCoverManager().ensure(target),
};

export const SyncManager = {
  async login(credentials: UserCredentialsToLogin): Promise<UserInfo> {
    const user = await login(db, credentials);
    return user;
  },

  async logout(): Promise<null> {
    const result = await logout(db, currentCovers?.manager);
    currentCovers = undefined;
    return result;
  },

  async cancelSync(): Promise<void> {
    abortSync(db);
  },

  async sync(options: { mode?: SyncMode } = {}): Promise<SyncRecord> {
    const mode = options.mode ?? "quick";
    if (syncInFlight) {
      if (syncInFlight.mode === mode) return syncInFlight.promise;
      throw new Error(`A ${syncInFlight.mode} sync is already running; cannot start a ${mode} sync.`);
    }

    const user = getUserInfo(db);
    if (!user) {
      throw new Error("You need to log in before syncing.");
    }

    const promise = sync(db, getCoverManager(), { mode }).finally(() => {
      syncInFlight = undefined;
    });
    syncInFlight = { mode, promise };

    return promise;
  },
};
