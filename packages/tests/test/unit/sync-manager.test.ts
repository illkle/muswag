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

import {
  createCoverArtStore,
  getUserInfo,
  getSyncInfo,
  login,
  logout,
  sync,
} from "@muswag/shared";
import type { CoverArtStore } from "@muswag/shared";
import { createInMemoryDb } from "test/navidrome-testkit";

const TEST_COVER_ART_DIR = path.join(tmpdir(), "muswag-sync-manager-test-covers");

const noopCoverArt: CoverArtStore = {
  async fetch() {
    return null;
  },
  async remove() {},
};

describe("sync hooks", () => {
  beforeEach(() => {
    pingMock.mockClear();
    pingMock.mockResolvedValue(undefined);
    getAlbumList2Mock.mockClear();
    getAlbumList2Mock.mockResolvedValue({ albumList2: { album: [] } });
  });

  it("persists login state in the database", async () => {
    const db = createInMemoryDb();
    const credentials = {
      url: "https://demo.navidrome.org",
      username: "alice",
      password: "secret",
    };

    expect(getUserInfo(db)).toBeNull();

    await expect(login(db, credentials)).resolves.toEqual({
      url: credentials.url,
      username: credentials.username,
      password: credentials.password,
    });

    expect(getUserInfo(db)).toEqual({
      url: credentials.url,
      username: credentials.username,
      password: credentials.password,
    });

    const storedCredentials = db.userCredentials.get(1);
    expect(storedCredentials).toMatchObject({
      id: 1,
      url: credentials.url,
      username: credentials.username,
      password: credentials.password,
    });

    await expect(logout(db)).resolves.toBeNull();
    expect(getUserInfo(db)).toBeNull();
    expect(db.userCredentials.has(1)).toBe(false);
  });

  it("syncs after login and records sync in db", async () => {
    const db = createInMemoryDb();
    const credentials = {
      url: "https://demo.navidrome.org",
      username: "alice",
      password: "secret",
    };

    await login(db, credentials);

    const result = await sync(db, noopCoverArt);

    expect(result).toMatchObject({
      lastStatus: "completed",
    });
    expect(result.timeStarted).toBeTruthy();
    expect(result.timeEnded).toBeTruthy();
    expect(result.error).toBeNull();
    expect(Number.isNaN(Date.parse(result.timeStarted))).toBe(false);
    expect(Number.isNaN(Date.parse(result.timeEnded!))).toBe(false);

    const syncInfo = getSyncInfo(db);
    expect(syncInfo).toBeTruthy();
    expect(syncInfo!.lastStatus).toBe("completed");
    expect(syncInfo!.timeStarted).toBe(result.timeStarted);
  });

  it("rejects sync when no user is logged in", async () => {
    const db = createInMemoryDb();

    await expect(sync(db, noopCoverArt)).rejects.toThrow(
      "login() must be called before sync()",
    );
    expect(getAlbumList2Mock).not.toHaveBeenCalled();
  });
});
