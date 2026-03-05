import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import BetterSqlite3 from "better-sqlite3";
import { GenericContainer, type StartedTestContainer, Wait } from "testcontainers";

import { SyncManager } from "@muswag/db";
import { withBetterSqlite } from "./bettersqliteadapter.js";
import { createDrizzleDb, type DrizzleDb } from "@muswag/db";
import type { AlbumFixture } from "./fixtures/library-sets.js";

export interface NavidromeConnection {
  baseUrl: string;
  username: string;
  password: string;
}

export interface NavidromeDependencyStatus {
  dockerAvailable: boolean;
  ffmpegAvailable: boolean;
  ready: boolean;
  missingDependencies: string[];
}

export interface NavidromeLibraryOptions {
  adminTimeoutMs?: number;
  scanTimeoutMs?: number;
}

const ADMIN_USERNAME = "admin";
const ADMIN_PASSWORD = "adminpass";

export function createInMemoryDrizzleDb(): DrizzleDb {
  const db = new BetterSqlite3(":memory:");
  return createDrizzleDb(withBetterSqlite(db));
}

export function checkNavidromeDependencies(): NavidromeDependencyStatus {
  const dockerAvailable = spawnSync("docker", ["info"], { stdio: "ignore" }).status === 0;
  const ffmpegAvailable = spawnSync("ffmpeg", ["-version"], { stdio: "ignore" }).status === 0;
  const missingDependencies = [
    ...(!dockerAvailable ? ["Docker"] : []),
    ...(!ffmpegAvailable ? ["ffmpeg"] : []),
  ];

  return {
    dockerAvailable,
    ffmpegAvailable,
    ready: missingDependencies.length === 0,
    missingDependencies,
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function sanitizePathPart(value: string): string {
  return value.replace(/[^a-zA-Z0-9._ -]/g, "_");
}

function serializeError(error: unknown): Record<string, unknown> {
  if (error instanceof Error) {
    return {
      errorName: error.name,
      errorMessage: error.message,
      errorStack: error.stack,
    };
  }

  return { errorMessage: String(error) };
}

function runFfmpeg(args: string[]): void {
  const outputPath = args.at(-1);
  const startedAt = Date.now();
  console.info("ffmpeg:start", { outputPath });

  const result = spawnSync("ffmpeg", args, {
    encoding: "utf8",
  });

  if (result.status !== 0) {
    console.error("ffmpeg:failed", {
      outputPath,
      durationMs: Date.now() - startedAt,
      status: result.status,
      stderr: result.stderr.trim(),
    });
    throw new Error(`ffmpeg failed with code ${result.status}: ${result.stderr}`);
  }

  console.info("ffmpeg:done", {
    outputPath,
    durationMs: Date.now() - startedAt,
  });
}

export async function generateFakeMp3Library(
  rootDir: string,
  albums: AlbumFixture[],
): Promise<void> {
  const generationStartedAt = Date.now();
  console.info("library:generate:start", {
    rootDir,
    albumCount: albums.length,
  });

  for (const album of albums) {
    const albumStartedAt = Date.now();
    const albumDir = path.join(
      rootDir,
      sanitizePathPart(album.artist),
      sanitizePathPart(album.album),
    );
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
        `musicbrainz_trackid=${song.musicBrainzTrackId}`,
      ];

      if (album.compilation) {
        args.push("-metadata", "compilation=1");
      }

      args.push(outputPath);
      runFfmpeg(args);
    }

    console.info("library:album:done", {
      album: album.album,
      artist: album.artist,
      trackCount: album.songs.length,
      durationMs: Date.now() - albumStartedAt,
    });
  }

  console.info("library:generate:done", {
    rootDir,
    albumCount: albums.length,
    durationMs: Date.now() - generationStartedAt,
  });
}

export async function createNavidromeAdmin(baseUrl: string, timeoutMs = 60_000): Promise<void> {
  const startedAt = Date.now();
  console.info("admin:create:start", { baseUrl, timeoutMs });
  const deadline = Date.now() + timeoutMs;
  let lastError: string | null = null;
  let attempts = 0;

  while (Date.now() < deadline) {
    attempts += 1;
    try {
      const response = await fetch(`${baseUrl}/auth/createAdmin`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify({
          username: ADMIN_USERNAME,
          password: ADMIN_PASSWORD,
        }),
      });

      if (response.ok || response.status === 403) {
        console.info("admin:create:ready", {
          baseUrl,
          attempts,
          status: response.status,
          durationMs: Date.now() - startedAt,
        });
        return;
      }

      lastError = `HTTP ${response.status}: ${await response.text()}`;
      console.warn("admin:create:retry", {
        baseUrl,
        attempts,
        status: response.status,
        lastError,
      });
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
      console.warn("admin:create:retry", {
        baseUrl,
        attempts,
        lastError,
      });
    }

    await sleep(1_000);
  }

  console.error("admin:create:timeout", {
    baseUrl,
    attempts,
    timeoutMs,
    lastError,
    durationMs: Date.now() - startedAt,
  });
  throw new Error(
    `Failed to create admin user within ${timeoutMs}ms${lastError ? `: ${lastError}` : ""}`,
  );
}

export async function waitForNavidromeScan(
  connection: NavidromeConnection,
  timeoutMs = 15_000,
): Promise<void> {
  const startedAt = Date.now();
  console.info("scan:wait:start", {
    baseUrl: connection.baseUrl,
    timeoutMs,
  });
  const deadline = Date.now() + timeoutMs;
  const probeDatabase = new SyncManager(createInMemoryDrizzleDb());
  const probeConnectStartedAt = Date.now();
  console.info("scan:probe-connect:start", { baseUrl: connection.baseUrl });
  await probeDatabase.connect({
    url: connection.baseUrl,
    username: connection.username,
    password: connection.password,
  });
  console.info("scan:probe-connect:done", {
    baseUrl: connection.baseUrl,
    durationMs: Date.now() - probeConnectStartedAt,
  });
  let attempts = 0;

  while (Date.now() < deadline) {
    attempts += 1;
    try {
      const result = await probeDatabase.sync();
      console.info("scan:probe-sync", {
        attempt: attempts,
        fetched: result.fetched,
        inserted: result.inserted,
        updated: result.updated,
        deleted: result.deleted,
      });
      if (result.fetched > 0) {
        console.info("scan:wait:ready", {
          baseUrl: connection.baseUrl,
          attempts,
          durationMs: Date.now() - startedAt,
        });
        return;
      }
    } catch (error) {
      // Navidrome may still be starting up.
      console.warn("scan:probe-sync:retry", {
        attempt: attempts,
        ...serializeError(error),
      });
    }

    await sleep(1_000);
  }

  console.error("scan:wait:timeout", {
    baseUrl: connection.baseUrl,
    attempts,
    timeoutMs,
    durationMs: Date.now() - startedAt,
  });
  throw new Error(`Timed out after ${timeoutMs}ms waiting for Navidrome to scan media`);
}

export async function withNavidromeLibrary(
  albums: AlbumFixture[],
  callback: (connection: NavidromeConnection) => Promise<void>,
  options: NavidromeLibraryOptions = {},
): Promise<void> {
  const { adminTimeoutMs, scanTimeoutMs } = options;

  const hostRoot = await mkdtemp(path.join(tmpdir(), "muswag-navidrome-"));
  const musicDir = path.join(hostRoot, "music");
  const dataDir = path.join(hostRoot, "data");
  console.info("tempdir:create", { hostRoot, musicDir, dataDir });

  await mkdir(musicDir, { recursive: true });
  await mkdir(dataDir, { recursive: true });
  console.info("filesystem:init", { musicDir, dataDir });
  await generateFakeMp3Library(musicDir, albums);

  let container: StartedTestContainer | undefined;

  try {
    console.info("container:start");
    container = await new GenericContainer("deluan/navidrome:latest")
      .withExposedPorts(4533)
      .withEnvironment({
        ND_MUSICFOLDER: "/music",
        ND_DATAFOLDER: "/data",
        ND_SCANNER_SCANONSTARTUP: "true",
        ND_SCANNER_SCHEDULE: "0",
        ND_LOGLEVEL: "info",
      })
      .withBindMounts([
        { source: musicDir, target: "/music", mode: "ro" },
        { source: dataDir, target: "/data", mode: "rw" },
      ])
      .withWaitStrategy(Wait.forListeningPorts())
      .start();

    const connection: NavidromeConnection = {
      baseUrl: `http://${container.getHost()}:${container.getMappedPort(4533)}`,
      username: ADMIN_USERNAME,
      password: ADMIN_PASSWORD,
    };
    console.info("container:ready", {
      baseUrl: connection.baseUrl,
      hostRoot,
      musicDir,
      dataDir,
    });

    await createNavidromeAdmin(connection.baseUrl, adminTimeoutMs);
    await waitForNavidromeScan(connection, scanTimeoutMs);
    console.info("test:callback:start", { baseUrl: connection.baseUrl });
    await callback(connection);
    console.info("test:callback:done", { baseUrl: connection.baseUrl });
  } finally {
    if (container) {
      const runningContainer = container;
      await runningContainer.stop();
      console.info("container:stop");
    }

    await rm(hostRoot, { recursive: true, force: true });
    console.info("tempdir:cleanup", { hostRoot });
  }
}
