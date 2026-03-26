import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import BetterSqlite3 from "better-sqlite3-test"; // eslint-disable-line
import { GenericContainer, type StartedTestContainer, Wait } from "testcontainers";

import { createMuswagDb, type MuswagDb } from "@muswag/shared";
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
  generation?: GenerateFakeMp3LibraryOptions;
}

export interface GenerateFakeMp3LibraryOptions {
  mode?: "ffmpeg" | "tagged-template";
  logPerTrack?: boolean;
  logPerAlbum?: boolean;
}

const ADMIN_USERNAME = "admin";
const ADMIN_PASSWORD = "adminpass";

export function createInMemoryDb(): MuswagDb {
  const sqlite = new BetterSqlite3(":memory:");
  return createMuswagDb(sqlite);
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

function runFfmpeg(args: string[], options: { log?: boolean } = {}): void {
  const { log = true } = options;
  const outputPath = args.at(-1);
  const startedAt = Date.now();
  if (log) {
    console.info("ffmpeg:start", { outputPath });
  }

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

  if (log) {
    console.info("ffmpeg:done", {
      outputPath,
      durationMs: Date.now() - startedAt,
    });
  }
}

function decodeSynchsafeInteger(buffer: Buffer): number {
  const byte0 = buffer[0] ?? 0;
  const byte1 = buffer[1] ?? 0;
  const byte2 = buffer[2] ?? 0;
  const byte3 = buffer[3] ?? 0;
  return (byte0 << 21) | (byte1 << 14) | (byte2 << 7) | byte3;
}

function encodeSynchsafeInteger(value: number): Buffer {
  return Buffer.from([
    (value >> 21) & 0x7f,
    (value >> 14) & 0x7f,
    (value >> 7) & 0x7f,
    value & 0x7f,
  ]);
}

function stripId3Tags(buffer: Buffer): Buffer {
  let start = 0;
  let end = buffer.length;

  if (buffer.length >= 10 && buffer.subarray(0, 3).toString("ascii") === "ID3") {
    start = 10 + decodeSynchsafeInteger(buffer.subarray(6, 10));
  }

  if (end >= 128 && buffer.subarray(end - 128, end - 125).toString("ascii") === "TAG") {
    end -= 128;
  }

  return buffer.subarray(start, end);
}

function encodeUtf16Text(value: string): Buffer {
  return Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(value, "utf16le")]);
}

function createTextFrame(frameId: string, value: string): Buffer {
  const payload = Buffer.concat([Buffer.from([1]), encodeUtf16Text(value)]);
  const header = Buffer.alloc(10);
  header.write(frameId, 0, 4, "ascii");
  header.writeUInt32BE(payload.length, 4);
  return Buffer.concat([header, payload]);
}

function buildId3v23Tag(album: AlbumFixture, song: AlbumFixture["songs"][number]): Buffer {
  const frames = [
    createTextFrame("TIT2", song.title),
    createTextFrame("TPE1", song.artist ?? album.artist),
    createTextFrame("TALB", album.album),
    createTextFrame("TPE2", album.albumArtist),
    createTextFrame("TRCK", `${song.track}/${album.songs.length}`),
    createTextFrame("TPOS", `${album.disc}/1`),
    createTextFrame("TYER", String(album.year)),
    createTextFrame("TCON", album.genre),
    createTextFrame("TCOM", album.composer),
  ];

  if (album.compilation) {
    frames.push(createTextFrame("TCMP", "1"));
  }

  const payload = Buffer.concat(frames);
  const header = Buffer.alloc(10);
  header.write("ID3", 0, 3, "ascii");
  header[3] = 3;
  header[4] = 0;
  header[5] = 0;
  encodeSynchsafeInteger(payload.length).copy(header, 6);
  return Buffer.concat([header, payload]);
}

function logAlbumCompletion(
  album: AlbumFixture,
  albumStartedAt: number,
  logPerAlbum: boolean,
): void {
  if (!logPerAlbum) {
    return;
  }

  console.info("library:album:done", {
    album: album.album,
    artist: album.artist,
    trackCount: album.songs.length,
    durationMs: Date.now() - albumStartedAt,
  });
}

async function createTaggedTemplateMp3Library(
  rootDir: string,
  albums: AlbumFixture[],
  logPerAlbum: boolean,
  artworkBuffer: Buffer,
): Promise<void> {
  const templatePath = path.join(rootDir, ".template.mp3");
  runFfmpeg(
    [
      "-loglevel",
      "error",
      "-y",
      "-f",
      "lavfi",
      "-i",
      "anullsrc=r=44100:cl=stereo",
      "-t",
      "1",
      "-ac",
      "2",
      "-ar",
      "44100",
      "-codec:a",
      "libmp3lame",
      "-q:a",
      "4",
      "-map_metadata",
      "-1",
      templatePath,
    ],
    { log: false },
  );

  const templateBuffer = stripId3Tags(await readFile(templatePath));
  await rm(templatePath, { force: true });

  for (const album of albums) {
    const albumStartedAt = Date.now();
    const albumDir = path.join(
      rootDir,
      sanitizePathPart(album.artist),
      sanitizePathPart(album.album),
    );
    await mkdir(albumDir, { recursive: true });
    await writeAlbumArtwork(albumDir, artworkBuffer);

    for (const song of album.songs) {
      const filename = `${String(song.track).padStart(2, "0")} - ${sanitizePathPart(song.title)}.mp3`;
      const outputPath = path.join(albumDir, filename);
      const taggedMp3 = Buffer.concat([buildId3v23Tag(album, song), templateBuffer]);
      await writeFile(outputPath, taggedMp3);
    }

    logAlbumCompletion(album, albumStartedAt, logPerAlbum);
  }
}

async function createAlbumArtworkTemplate(rootDir: string): Promise<Buffer> {
  const artworkPath = path.join(rootDir, ".cover-template.jpg");
  runFfmpeg(
    [
      "-loglevel",
      "error",
      "-y",
      "-f",
      "lavfi",
      "-i",
      "color=c=0xc7673c:s=1200x1200",
      "-frames:v",
      "1",
      artworkPath,
    ],
    { log: false },
  );

  const artworkBuffer = await readFile(artworkPath);
  await rm(artworkPath, { force: true });
  return artworkBuffer;
}

async function writeAlbumArtwork(albumDir: string, artworkBuffer: Buffer): Promise<void> {
  await writeFile(path.join(albumDir, "cover.jpg"), artworkBuffer);
  await writeFile(path.join(albumDir, "folder.jpg"), artworkBuffer);
}

interface SubsonicAlbumListResponse {
  "subsonic-response"?: {
    status?: string;
    error?: {
      code?: number;
      message?: string;
    };
    albumList2?: {
      album?: unknown[] | unknown;
    };
  };
}

async function fetchSubsonicAlbumList(
  connection: NavidromeConnection,
  size: number,
  offset = 0,
): Promise<unknown[] | unknown | undefined> {
  const params = new URLSearchParams({
    u: connection.username,
    p: `enc:${Buffer.from(connection.password, "utf8").toString("hex")}`,
    v: "1.16.1",
    c: "muswag-db-test",
    f: "json",
    type: "alphabeticalByArtist",
    size: String(size),
    offset: String(offset),
  });
  const response = await fetch(`${connection.baseUrl}/rest/getAlbumList2.view?${params}`);

  if (!response.ok) {
    throw new Error(`HTTP ${response.status}: ${await response.text()}`);
  }

  const payload = (await response.json()) as SubsonicAlbumListResponse;
  const subsonicResponse = payload["subsonic-response"];
  if (subsonicResponse?.status !== "ok") {
    throw new Error(subsonicResponse?.error?.message ?? "Unknown Subsonic API error");
  }

  return subsonicResponse.albumList2?.album;
}

async function countScannedAlbums(connection: NavidromeConnection): Promise<number> {
  const pageSize = 500;
  let count = 0;

  for (let offset = 0; ; offset += pageSize) {
    const albums = await fetchSubsonicAlbumList(connection, pageSize, offset);
    const pageCount = Array.isArray(albums) ? albums.length : albums ? 1 : 0;
    count += pageCount;

    if (pageCount < pageSize) {
      return count;
    }
  }
}

export async function generateFakeMp3Library(
  rootDir: string,
  albums: AlbumFixture[],
  options: GenerateFakeMp3LibraryOptions = {},
): Promise<void> {
  const { mode = "ffmpeg", logPerTrack = true, logPerAlbum = true } = options;
  const generationStartedAt = Date.now();
  const artworkBuffer = await createAlbumArtworkTemplate(rootDir);
  console.info("library:generate:start", {
    rootDir,
    albumCount: albums.length,
    mode,
  });

  if (mode === "tagged-template") {
    await createTaggedTemplateMp3Library(rootDir, albums, logPerAlbum, artworkBuffer);
    console.info("library:generate:done", {
      rootDir,
      albumCount: albums.length,
      durationMs: Date.now() - generationStartedAt,
    });
    return;
  }

  for (const album of albums) {
    const albumStartedAt = Date.now();
    const albumDir = path.join(
      rootDir,
      sanitizePathPart(album.artist),
      sanitizePathPart(album.album),
    );
    await mkdir(albumDir, { recursive: true });
    await writeAlbumArtwork(albumDir, artworkBuffer);

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
      runFfmpeg(args, { log: logPerTrack });
    }

    logAlbumCompletion(album, albumStartedAt, logPerAlbum);
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
  expectedAlbumCount = 1,
  timeoutMs = 15_000,
): Promise<void> {
  const startedAt = Date.now();
  console.info("scan:wait:start", {
    baseUrl: connection.baseUrl,
    expectedAlbumCount,
    timeoutMs,
  });
  const deadline = Date.now() + timeoutMs;
  let attempts = 0;

  while (Date.now() < deadline) {
    attempts += 1;
    try {
      const albumCount = await countScannedAlbums(connection);
      console.info("scan:probe-album-list", {
        attempt: attempts,
        albumCount,
      });
      if (albumCount >= expectedAlbumCount) {
        console.info("scan:wait:ready", {
          baseUrl: connection.baseUrl,
          attempts,
          durationMs: Date.now() - startedAt,
        });
        return;
      }
    } catch (error) {
      // Navidrome may still be starting up.
      console.warn("scan:probe-album-list:retry", {
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

export interface TempDir {
  path: string;
  cleanup(): Promise<void>;
}

export async function createTempCoverArtDir(): Promise<TempDir> {
  const coverArtDir = await mkdtemp(path.join(tmpdir(), "muswag-cover-cache-"));
  return {
    path: coverArtDir,
    cleanup: () => rm(coverArtDir, { recursive: true, force: true }),
  };
}

export interface NavidromeTestConnection extends NavidromeConnection {
  replaceLibrary(albums: AlbumFixture[], options?: NavidromeLibraryOptions): Promise<void>;
  cleanup(): Promise<void>;
}

export async function createNavidromeTestConnection(
  albums: AlbumFixture[],
  options: NavidromeLibraryOptions = {},
): Promise<NavidromeTestConnection> {
  let container: StartedTestContainer | undefined;
  let hostRoot: string | undefined;

  async function startWithLibrary(libraryAlbums: AlbumFixture[], startOptions: NavidromeLibraryOptions = options): Promise<void> {
    if (container) {
      await container.stop();
      console.info("container:stop");
      container = undefined;
    }
    if (hostRoot) {
      await rm(hostRoot, { recursive: true, force: true });
      console.info("tempdir:cleanup", { hostRoot });
    }

    hostRoot = await mkdtemp(path.join(tmpdir(), "muswag-navidrome-"));
    const musicDir = path.join(hostRoot, "music");
    const dataDir = path.join(hostRoot, "data");
    console.info("tempdir:create", { hostRoot, musicDir, dataDir });

    await mkdir(musicDir, { recursive: true });
    await mkdir(dataDir, { recursive: true });
    console.info("filesystem:init", { musicDir, dataDir });
    await generateFakeMp3Library(musicDir, libraryAlbums, startOptions.generation);

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

    conn.baseUrl = `http://${container.getHost()}:${container.getMappedPort(4533)}`;
    console.info("container:ready", {
      baseUrl: conn.baseUrl,
      hostRoot,
      musicDir,
      dataDir,
    });

    await createNavidromeAdmin(conn.baseUrl, startOptions.adminTimeoutMs);
    await waitForNavidromeScan(conn, libraryAlbums.length, startOptions.scanTimeoutMs);
  }

  const conn: NavidromeTestConnection = {
    baseUrl: "",
    username: ADMIN_USERNAME,
    password: ADMIN_PASSWORD,

    async replaceLibrary(newAlbums, replaceOptions) {
      await startWithLibrary(newAlbums, replaceOptions ? { ...options, ...replaceOptions } : options);
    },

    async cleanup() {
      if (container) {
        await container.stop();
        console.info("container:stop");
        container = undefined;
      }
      if (hostRoot) {
        await rm(hostRoot, { recursive: true, force: true });
        console.info("tempdir:cleanup", { hostRoot });
        hostRoot = undefined;
      }
    },
  };

  await startWithLibrary(albums);
  return conn;
}
