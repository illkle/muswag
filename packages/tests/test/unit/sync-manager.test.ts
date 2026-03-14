import { tmpdir } from "node:os";
import path from "node:path";
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

import { SyncEvent, SyncManager, userCredentialsTable } from "@muswag/shared";
import { createInMemoryDrizzleDb } from "test/navidrome-testkit";

const TEST_COVER_ART_DIR = path.join(tmpdir(), "muswag-sync-manager-test-covers");

describe("SyncManager", () => {
  beforeEach(() => {
    pingMock.mockClear();
    pingMock.mockResolvedValue(undefined);
    getAlbumList2Mock.mockClear();
    getAlbumList2Mock.mockResolvedValue({ albumList2: { album: [] } });
  });

  it("persists login state in the database and emits user updates", async () => {
    const db = createInMemoryDrizzleDb();
    const manager = new SyncManager(db, { coverArtDir: TEST_COVER_ART_DIR });
    const events: SyncEvent[] = [];
    const credentials = {
      url: "https://demo.navidrome.org",
      username: "alice",
      password: "secret",
    };

    manager.subscribe((event) => {
      events.push(event);
    });

    await expect(manager.getUserState()).resolves.toBeNull();

    await expect(manager.login(credentials)).resolves.toEqual({
      url: credentials.url,
      username: credentials.username,
      password: credentials.password,
      lastSync: null,
    });

    await expect(manager.getUserState()).resolves.toEqual({
      url: credentials.url,
      username: credentials.username,
      password: credentials.password,
      lastSync: null,
    });

    const storedCredentials = await db.select().from(userCredentialsTable);
    expect(storedCredentials).toEqual([
      {
        id: 1,
        lastSync: null,
        url: credentials.url,
        username: credentials.username,
        password: credentials.password,
      },
    ]);

    await expect(manager.logout()).resolves.toBeNull();
    await expect(manager.getUserState()).resolves.toBeNull();
    await expect(db.select().from(userCredentialsTable)).resolves.toEqual([]);

    expect(events).toEqual([]);
  });

  it("syncs after login and emits a sync progress event", async () => {
    const db = createInMemoryDrizzleDb();
    const manager = new SyncManager(db, { coverArtDir: TEST_COVER_ART_DIR });
    const events: SyncEvent[] = [];
    const credentials = {
      url: "https://demo.navidrome.org",
      username: "alice",
      password: "secret",
    };

    await manager.login(credentials);

    manager.subscribe((event) => {
      events.push(event);
    });

    const result = await manager.sync();

    expect(result).toMatchObject({
      fetched: 0,
      inserted: 0,
      updated: 0,
      deleted: 0,
      pages: 1,
    });
    expect(Number.isNaN(Date.parse(result.startedAt))).toBe(false);
    expect(Number.isNaN(Date.parse(result.finishedAt))).toBe(false);

    expect(events).toEqual([{ process: "Albums", count: 0 }]);

    const u = await manager.getUserState();
    expect(u?.lastSync).toEqual(result.startedAt);
  });

  it("rejects sync when no user is logged in", async () => {
    const db = createInMemoryDrizzleDb();
    const manager = new SyncManager(db, { coverArtDir: TEST_COVER_ART_DIR });

    await expect(manager.sync()).rejects.toThrow(
      "SyncManager.login() must be called before sync()",
    );
    expect(getAlbumList2Mock).not.toHaveBeenCalled();
  });
});
