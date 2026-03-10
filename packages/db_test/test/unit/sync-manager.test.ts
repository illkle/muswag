import BetterSqlite3 from "better-sqlite3-test";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { pingMock, getAlbumList2Mock } = vi.hoisted(() => ({
  pingMock: vi.fn(async () => undefined),
  getAlbumList2Mock: vi.fn(
    async (_args: unknown) =>
      ({
        albumList2: { album: [] },
      }) as { albumList2: { album: unknown[] } },
  ),
}));

vi.mock("subsonic-api", () => ({
  default: class FakeSubsonicAPI {
    constructor(_config: { url: string; auth: { username: string; password: string } }) {}

    ping() {
      return pingMock();
    }

    getAlbumList2(args: unknown) {
      return getAlbumList2Mock(args);
    }
  },
}));

import {
  SyncManager,
  createDrizzleDb,
  migrateDb,
  syncStateTable,
  userCredentialsTable,
  type SyncCredentials,
  type SyncManagerEvent,
} from "@muswag/db";

function createInMemoryDrizzleDb() {
  const sqlite = new BetterSqlite3(":memory:");
  sqlite.pragma("foreign_keys = ON");

  const db = createDrizzleDb(sqlite);
  migrateDb(db);

  return { sqlite, db };
}

describe("SyncManager", () => {
  beforeEach(() => {
    pingMock.mockClear();
    pingMock.mockResolvedValue(undefined);
    getAlbumList2Mock.mockClear();
    getAlbumList2Mock.mockResolvedValue({ albumList2: { album: [] } });
  });

  it("persists login state in the database and emits user updates", async () => {
    const { sqlite, db } = createInMemoryDrizzleDb();
    const manager = new SyncManager(db);
    const events: SyncManagerEvent[] = [];
    const credentials: SyncCredentials = {
      url: "https://demo.navidrome.org",
      username: "alice",
      password: "secret",
    };

    try {
      manager.subscribe((event) => {
        events.push(event);
      });

      await expect(manager.getUserState()).resolves.toEqual({ status: "logged_out" });

      await expect(manager.login(credentials)).resolves.toEqual({
        status: "logged_in",
        url: credentials.url,
        username: credentials.username,
        lastSyncedAt: null,
      });

      await expect(manager.getUserState()).resolves.toEqual({
        status: "logged_in",
        url: credentials.url,
        username: credentials.username,
        lastSyncedAt: null,
      });

      const storedCredentials = await db.select().from(userCredentialsTable);
      expect(storedCredentials).toEqual([
        {
          id: 1,
          url: credentials.url,
          username: credentials.username,
          password: credentials.password,
        },
      ]);

      await expect(manager.logout()).resolves.toEqual({ status: "logged_out" });
      await expect(manager.getUserState()).resolves.toEqual({ status: "logged_out" });
      await expect(db.select().from(userCredentialsTable)).resolves.toEqual([]);

      expect(events).toEqual([
        {
          type: "user update",
          userState: {
            status: "logged_in",
            url: credentials.url,
            username: credentials.username,
            lastSyncedAt: null,
          },
        },
        {
          type: "user update",
          userState: { status: "logged_out" },
        },
      ]);
    } finally {
      sqlite.close();
    }
  });

  it("reads stored credentials from the database during sync and emits a sync event", async () => {
    const { sqlite, db } = createInMemoryDrizzleDb();
    const loginManager = new SyncManager(db);
    const syncManager = new SyncManager(db);
    const events: SyncManagerEvent[] = [];
    const credentials: SyncCredentials = {
      url: "https://demo.navidrome.org",
      username: "alice",
      password: "secret",
    };

    try {
      await loginManager.login(credentials);

      syncManager.subscribe((event) => {
        events.push(event);
      });

      const result = await syncManager.sync();

      expect(result).toMatchObject({
        fetched: 0,
        inserted: 0,
        updated: 0,
        deleted: 0,
        pages: 1,
      });
      expect(Number.isNaN(Date.parse(result.startedAt))).toBe(false);
      expect(Number.isNaN(Date.parse(result.finishedAt))).toBe(false);

      const syncState = await db.select().from(syncStateTable);
      expect(syncState).toEqual([
        {
          key: "albums_last_synced_at",
          value: result.finishedAt,
        },
      ]);

      expect(events).toEqual([
        {
          type: "db state synced",
          result,
        },
        {
          type: "user update",
          userState: {
            status: "logged_in",
            url: credentials.url,
            username: credentials.username,
            lastSyncedAt: result.finishedAt,
          },
        },
      ]);
    } finally {
      sqlite.close();
    }
  });

  it("rejects sync when no user is logged in", async () => {
    const { sqlite, db } = createInMemoryDrizzleDb();
    const manager = new SyncManager(db);

    try {
      await expect(manager.sync()).rejects.toThrow("SyncManager.login() must be called before sync()");
      expect(getAlbumList2Mock).not.toHaveBeenCalled();
    } finally {
      sqlite.close();
    }
  });
});
