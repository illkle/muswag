import { spawnSync } from "node:child_process";
import { cp, mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { GenericContainer, type StartedTestContainer, Wait } from "testcontainers";
import { describe, expect, it } from "vitest";

import { createBetterSqliteAdapter } from "../../src/adapters/better-sqlite3.js";
import { fetchAlbumList2Page } from "../../src/navidrome/client.js";
import type { NavidromeConnection } from "../../src/public-api.js";
import { syncAlbums } from "../../src/sync-albums.js";

const dockerProbe = spawnSync("docker", ["info"], {
  stdio: "ignore"
});
const dockerAvailable = dockerProbe.status === 0;

if (!dockerAvailable) {
  console.warn("Skipping integration tests: Docker daemon unavailable.");
}

const describeIfDocker = dockerAvailable ? describe : describe.skip;

const currentDir = path.dirname(fileURLToPath(import.meta.url));
const fixtureSetA = path.resolve(currentDir, "../fixtures/music_set_a");
const fixtureSetB = path.resolve(currentDir, "../fixtures/music_set_b");

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForAlbums(connection: NavidromeConnection, timeoutMs = 90_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    try {
      const page = await fetchAlbumList2Page({
        connection,
        offset: 0,
        size: 5
      });
      if (page.albums.length > 0) {
        return;
      }
    } catch {
      // Navidrome may still be starting up/scanning.
    }

    await sleep(1_000);
  }

  throw new Error(`Timed out after ${timeoutMs}ms waiting for Navidrome scan results`);
}

async function createAdmin(baseUrl: string, timeoutMs = 60_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastError: string | null = null;

  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${baseUrl}/auth/createAdmin`, {
        method: "POST",
        headers: {
          "content-type": "application/json"
        },
        body: JSON.stringify({
          username: "admin",
          password: "adminpass"
        })
      });

      if (response.ok || response.status === 403) {
        return;
      }

      lastError = `HTTP ${response.status} ${await response.text()}`;
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }

    await sleep(1_000);
  }

  throw new Error(
    `Failed to create admin user within ${timeoutMs}ms${lastError ? `: ${lastError}` : ""}`
  );
}

async function withNavidromeFixture(
  fixturePath: string,
  callback: (connection: NavidromeConnection) => Promise<void>
): Promise<void> {
  const hostRoot = await mkdtemp(path.join(tmpdir(), "muswag-navidrome-"));
  const musicDir = path.join(hostRoot, "music");
  const dataDir = path.join(hostRoot, "data");

  await cp(fixturePath, musicDir, { recursive: true });
  await mkdir(dataDir, { recursive: true });

  let container: StartedTestContainer | undefined;

  try {
    container = await new GenericContainer("deluan/navidrome:latest")
      .withExposedPorts(4533)
      .withEnvironment({
        ND_MUSICFOLDER: "/music",
        ND_DATAFOLDER: "/data",
        ND_SCANNER_SCANONSTARTUP: "true",
        ND_SCANNER_SCHEDULE: "0",
        ND_LOGLEVEL: "info"
      })
      .withBindMounts([
        { source: musicDir, target: "/music", mode: "ro" },
        { source: dataDir, target: "/data", mode: "rw" }
      ])
      .withWaitStrategy(Wait.forListeningPorts())
      .start();

    const baseUrl = `http://${container.getHost()}:${container.getMappedPort(4533)}`;

    await createAdmin(baseUrl);

    const connection: NavidromeConnection = {
      baseUrl,
      username: "admin",
      password: "adminpass",
      clientName: "muswag-integration",
      protocolVersion: "1.16.1"
    };

    await waitForAlbums(connection);
    await callback(connection);
  } finally {
    if (container) {
      await container.stop();
    }

    await rm(hostRoot, { recursive: true, force: true });
  }
}

describeIfDocker("navidrome sync integration", () => {
  it("syncs albums from Navidrome and is idempotent", async () => {
    const db = createBetterSqliteAdapter(":memory:");

    await withNavidromeFixture(fixtureSetA, async (connection) => {
      const first = await syncAlbums({ db, connection });
      expect(first.fetched).toBeGreaterThan(0);
      expect(first.inserted).toBeGreaterThan(0);

      const second = await syncAlbums({ db, connection });
      expect(second.inserted).toBe(0);
      expect(second.deleted).toBe(0);

      const countRow = await db.queryOne<{ count: number }>("SELECT COUNT(*) AS count FROM albums");
      expect(Number(countRow?.count ?? 0)).toBeGreaterThan(0);
    });
  });

  it("reconciles deletions when remote album set changes", async () => {
    const db = createBetterSqliteAdapter(":memory:");

    await withNavidromeFixture(fixtureSetA, async (connectionA) => {
      const first = await syncAlbums({ db, connection: connectionA });
      expect(first.fetched).toBeGreaterThan(0);
    });

    const beforeIds = (await db.query<{ id: string }>("SELECT id FROM albums ORDER BY id")).map((row) => row.id);
    expect(beforeIds.length).toBeGreaterThan(0);

    await withNavidromeFixture(fixtureSetB, async (connectionB) => {
      const second = await syncAlbums({ db, connection: connectionB });
      expect(second.deleted).toBeGreaterThan(0);
      expect(second.fetched).toBeGreaterThan(0);
    });

    const afterIds = (await db.query<{ id: string }>("SELECT id FROM albums ORDER BY id")).map((row) => row.id);
    expect(afterIds.length).toBeGreaterThan(0);
    expect(afterIds).not.toEqual(beforeIds);
  });
});
