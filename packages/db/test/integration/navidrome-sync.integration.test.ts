import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { GenericContainer, type StartedTestContainer, Wait } from "testcontainers";
import { describe, expect, it } from "vitest";

import { AlbumSchema, Database, createBetterSqliteAdapter, type NavidromeConnection } from "../../src/index.js";
import { librarySetA, librarySetB, type AlbumFixture } from "../fixtures/library-sets.js";

const dockerAvailable = spawnSync("docker", ["info"], { stdio: "ignore" }).status === 0;
const ffmpegAvailable = spawnSync("ffmpeg", ["-version"], { stdio: "ignore" }).status === 0;

if (!dockerAvailable || !ffmpegAvailable) {
  console.warn(
    `Skipping integration tests: ${!dockerAvailable ? "Docker" : "ffmpeg"} unavailable.`
  );
}

const describeIfReady = dockerAvailable && ffmpegAvailable ? describe : describe.skip;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function sanitizePathPart(value: string): string {
  return value.replace(/[^a-zA-Z0-9._ -]/g, "_");
}

function runFfmpeg(args: string[]): void {
  const result = spawnSync("ffmpeg", args, {
    encoding: "utf8"
  });

  if (result.status !== 0) {
    throw new Error(`ffmpeg failed with code ${result.status}: ${result.stderr}`);
  }
}

async function generateLibrary(rootDir: string, albums: AlbumFixture[]): Promise<void> {
  for (const album of albums) {
    const albumDir = path.join(rootDir, sanitizePathPart(album.artist), sanitizePathPart(album.album));
    await mkdir(albumDir, { recursive: true });

    for (const song of album.songs) {
      const filename = `${String(song.track).padStart(2, "0")} - ${sanitizePathPart(song.title)}.mp3`;
      const outputPath = path.join(albumDir, filename);

      const args = [
        "-loglevel",
        "error",
        "-y",
        "-f",
        "lavfi",
        "-i",
        `sine=frequency=${400 + song.track * 30}:duration=${song.durationSec}`,
        "-ac",
        "2",
        "-ar",
        "44100",
        "-codec:a",
        "libmp3lame",
        "-q:a",
        "4",
        "-id3v2_version",
        "3",
        "-write_id3v1",
        "1",
        "-metadata",
        `title=${song.title}`,
        "-metadata",
        `artist=${song.artist ?? album.artist}`,
        "-metadata",
        `album=${album.album}`,
        "-metadata",
        `album_artist=${album.albumArtist}`,
        "-metadata",
        `track=${song.track}/${album.songs.length}`,
        "-metadata",
        `disc=${album.disc}/1`,
        "-metadata",
        `date=${album.year}`,
        "-metadata",
        `genre=${album.genre}`,
        "-metadata",
        `composer=${album.composer}`,
        "-metadata",
        `comment=${album.comment}`,
        "-metadata",
        `musicbrainz_albumid=${album.musicBrainzAlbumId}`,
        "-metadata",
        `musicbrainz_artistid=${album.musicBrainzArtistId}`,
        "-metadata",
        `musicbrainz_releasegroupid=${album.musicBrainzReleaseGroupId}`,
        "-metadata",
        `musicbrainz_trackid=${song.musicBrainzTrackId}`
      ];

      if (album.compilation) {
        args.push("-metadata", "compilation=1");
      }

      args.push(outputPath);
      runFfmpeg(args);
    }
  }
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

      lastError = `HTTP ${response.status}: ${await response.text()}`;
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }

    await sleep(1_000);
  }

  throw new Error(
    `Failed to create admin user within ${timeoutMs}ms${lastError ? `: ${lastError}` : ""}`
  );
}

async function waitForServerScan(connection: NavidromeConnection, timeoutMs = 120_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  const probeDatabase = new Database(createBetterSqliteAdapter(":memory:"));

  while (Date.now() < deadline) {
    try {
      const result = await probeDatabase.sync({ connection });
      if (result.fetched > 0) {
        return;
      }
    } catch {
      // Navidrome may still be starting up.
    }

    await sleep(1_000);
  }

  throw new Error(`Timed out after ${timeoutMs}ms waiting for Navidrome to scan media`);
}

async function withNavidromeLibrary(
  albums: AlbumFixture[],
  callback: (connection: NavidromeConnection) => Promise<void>
): Promise<void> {
  const hostRoot = await mkdtemp(path.join(tmpdir(), "muswag-navidrome-"));
  const musicDir = path.join(hostRoot, "music");
  const dataDir = path.join(hostRoot, "data");

  await mkdir(musicDir, { recursive: true });
  await mkdir(dataDir, { recursive: true });
  await generateLibrary(musicDir, albums);

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

    const connection: NavidromeConnection = {
      baseUrl: `http://${container.getHost()}:${container.getMappedPort(4533)}`,
      username: "admin",
      password: "adminpass",
      clientName: "muswag-integration",
      protocolVersion: "1.16.1"
    };

    await createAdmin(connection.baseUrl);
    await waitForServerScan(connection);

    await callback(connection);
  } finally {
    if (container) {
      await container.stop();
    }

    await rm(hostRoot, { recursive: true, force: true });
  }
}

describeIfReady("navidrome sync integration", () => {
  it("syncs 5 albums with rich ID3 tags and remains idempotent", async () => {
    const consumerDb = new Database(createBetterSqliteAdapter(":memory:"));

    await withNavidromeLibrary(librarySetA, async (connection) => {
      const first = await consumerDb.sync({ connection });
      expect(first.fetched).toBe(5);
      expect(first.inserted).toBe(5);

      const albums = await consumerDb.getAlbumList();
      const parsedAlbums = AlbumSchema.array().parse(albums);

      expect(parsedAlbums).toHaveLength(5);

      for (const album of parsedAlbums) {
        expect(album.songCount).toBeGreaterThanOrEqual(1);
        expect(album.songCount).toBeLessThanOrEqual(3);
        expect(album.artist).not.toBeNull();
        expect(album.genre).not.toBeNull();
        expect(album.year).not.toBeNull();
        expect(album.duration).toBeGreaterThan(0);
      }

      const oneAlbum = await consumerDb.getAlbumById(parsedAlbums[0]!.id);
      expect(oneAlbum).not.toBeNull();
      expect(oneAlbum?.songCount).toBeGreaterThanOrEqual(1);
      expect(oneAlbum?.songCount).toBeLessThanOrEqual(3);

      const second = await consumerDb.sync({ connection });
      expect(second.inserted).toBe(0);
      expect(second.deleted).toBe(0);
      expect(second.fetched).toBe(5);
    });
  });

  it("reconciles album deletions when server library changes", async () => {
    const consumerDb = new Database(createBetterSqliteAdapter(":memory:"));

    await withNavidromeLibrary(librarySetA, async (connectionA) => {
      const resultA = await consumerDb.sync({ connection: connectionA });
      expect(resultA.fetched).toBe(5);
    });

    const beforeIds = new Set((await consumerDb.getAlbumList()).map((album) => album.id));

    await withNavidromeLibrary(librarySetB, async (connectionB) => {
      const resultB = await consumerDb.sync({ connection: connectionB });
      expect(resultB.fetched).toBe(5);
      expect(resultB.deleted).toBeGreaterThan(0);
    });

    const afterAlbums = AlbumSchema.array().parse(await consumerDb.getAlbumList());
    expect(afterAlbums).toHaveLength(5);

    const afterIds = new Set(afterAlbums.map((album) => album.id));
    const hasNewAlbumIds = [...afterIds].some((id) => !beforeIds.has(id));

    expect(hasNewAlbumIds).toBe(true);

    for (const album of afterAlbums) {
      expect(album.songCount).toBeGreaterThanOrEqual(1);
      expect(album.songCount).toBeLessThanOrEqual(3);
      expect(album.artist).not.toBeNull();
      expect(album.genre).not.toBeNull();
    }
  });
});
