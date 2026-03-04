import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import BetterSqlite3 from "better-sqlite3";
import { asc, eq } from "drizzle-orm";
import { GenericContainer, type StartedTestContainer, Wait } from "testcontainers";
import { describe, expect, it } from "vitest";

import { SyncManager } from "../../src/database.js";
import { withBetterSqlite } from "../../src/drizzle/bettersqliteadapter.js";
import {
  albumArtistRolesTable,
  albumArtistsTable,
  albumDiscTitlesTable,
  albumGenresTable,
  albumMoodsTable,
  albumRecordLabelsTable,
  albumsTable,
  albumReleaseTypesTable,
  createDrizzleDb,
  DBZodValidators,
  type DrizzleDb,
  syncAlbumIdsTable,
  syncStateTable,
} from "../../src/drizzle/schema.js";
import { librarySetA, librarySetB, type AlbumFixture } from "../fixtures/library-sets.js";

interface NavidromeConnection {
  baseUrl: string;
  username: string;
  password: string;
}

function createBetterSqliteAdapter() {
  const db = new BetterSqlite3(":memory:");
  return createDrizzleDb(withBetterSqlite(db));
}

const dockerAvailable = spawnSync("docker", ["info"], { stdio: "ignore" }).status === 0;
const ffmpegAvailable = spawnSync("ffmpeg", ["-version"], { stdio: "ignore" }).status === 0;

if (!dockerAvailable || !ffmpegAvailable) {
  console.warn(
    `Skipping integration tests: ${!dockerAvailable ? "Docker" : "ffmpeg"} unavailable.`,
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
    encoding: "utf8",
  });

  if (result.status !== 0) {
    throw new Error(`ffmpeg failed with code ${result.status}: ${result.stderr}`);
  }
}

async function generateLibrary(rootDir: string, albums: AlbumFixture[]): Promise<void> {
  for (const album of albums) {
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
          "content-type": "application/json",
        },
        body: JSON.stringify({
          username: "admin",
          password: "adminpass",
        }),
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
    `Failed to create admin user within ${timeoutMs}ms${lastError ? `: ${lastError}` : ""}`,
  );
}

async function waitForServerScan(connection: NavidromeConnection, timeoutMs = 120_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  const probeDatabase = new SyncManager(createBetterSqliteAdapter());
  await probeDatabase.connect({
    url: connection.baseUrl,
    username: connection.username,
    password: connection.password,
  });

  while (Date.now() < deadline) {
    try {
      const result = await probeDatabase.sync();
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
  callback: (connection: NavidromeConnection) => Promise<void>,
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
      username: "admin",
      password: "adminpass",
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

async function readFullState(db: DrizzleDb) {
  const albums = DBZodValidators.albumsTable.array().parse(
    await db.select().from(albumsTable).orderBy(asc(albumsTable.id)),
  );
  const albumRecordLabels = DBZodValidators.albumRecordLabelsTable.array().parse(
    await db
      .select()
      .from(albumRecordLabelsTable)
      .orderBy(asc(albumRecordLabelsTable.albumId), asc(albumRecordLabelsTable.position)),
  );
  const albumGenres = DBZodValidators.albumGenresTable.array().parse(
    await db
      .select()
      .from(albumGenresTable)
      .orderBy(asc(albumGenresTable.albumId), asc(albumGenresTable.position)),
  );
  const albumArtists = DBZodValidators.albumArtistsTable.array().parse(
    await db
      .select()
      .from(albumArtistsTable)
      .orderBy(asc(albumArtistsTable.albumId), asc(albumArtistsTable.position)),
  );
  const albumArtistRoles = DBZodValidators.albumArtistRolesTable.array().parse(
    await db
      .select()
      .from(albumArtistRolesTable)
      .orderBy(
        asc(albumArtistRolesTable.albumId),
        asc(albumArtistRolesTable.artistPosition),
        asc(albumArtistRolesTable.position),
      ),
  );
  const albumReleaseTypes = DBZodValidators.albumReleaseTypesTable.array().parse(
    await db
      .select()
      .from(albumReleaseTypesTable)
      .orderBy(asc(albumReleaseTypesTable.albumId), asc(albumReleaseTypesTable.position)),
  );
  const albumMoods = DBZodValidators.albumMoodsTable.array().parse(
    await db
      .select()
      .from(albumMoodsTable)
      .orderBy(asc(albumMoodsTable.albumId), asc(albumMoodsTable.position)),
  );
  const albumDiscTitles = DBZodValidators.albumDiscTitlesTable.array().parse(
    await db
      .select()
      .from(albumDiscTitlesTable)
      .orderBy(asc(albumDiscTitlesTable.albumId), asc(albumDiscTitlesTable.position)),
  );
  const syncState = DBZodValidators.syncStateTable.array().parse(
    await db.select().from(syncStateTable).orderBy(asc(syncStateTable.key)),
  );
  const syncAlbumIds = DBZodValidators.syncAlbumIdsTable.array().parse(
    await db.select().from(syncAlbumIdsTable).orderBy(asc(syncAlbumIdsTable.id)),
  );

  return {
    albums,
    albumRecordLabels,
    albumGenres,
    albumArtists,
    albumArtistRoles,
    albumReleaseTypes,
    albumMoods,
    albumDiscTitles,
    syncState,
    syncAlbumIds,
  };
}

function assertNoDanglingRelations(state: Awaited<ReturnType<typeof readFullState>>): void {
  const albumIds = new Set(state.albums.map((row) => row.id));
  const artistKeys = new Set(state.albumArtists.map((row) => `${row.albumId}:${row.position}`));

  for (const row of state.albumRecordLabels) {
    expect(albumIds.has(row.albumId)).toBe(true);
  }
  for (const row of state.albumGenres) {
    expect(albumIds.has(row.albumId)).toBe(true);
  }
  for (const row of state.albumArtists) {
    expect(albumIds.has(row.albumId)).toBe(true);
  }
  for (const row of state.albumReleaseTypes) {
    expect(albumIds.has(row.albumId)).toBe(true);
  }
  for (const row of state.albumMoods) {
    expect(albumIds.has(row.albumId)).toBe(true);
  }
  for (const row of state.albumDiscTitles) {
    expect(albumIds.has(row.albumId)).toBe(true);
  }
  for (const row of state.albumArtistRoles) {
    expect(artistKeys.has(`${row.albumId}:${row.artistPosition}`)).toBe(true);
  }
}

describeIfReady("navidrome sync integration", () => {
  it("syncs albums and remains idempotent across all album-related tables", async () => {
    await withNavidromeLibrary(librarySetA, async (connection) => {
      const drizzleDb = createBetterSqliteAdapter();
      const consumerDb = new SyncManager(drizzleDb);

      await consumerDb.connect({
        url: connection.baseUrl,
        username: connection.username,
        password: connection.password,
      });

      const first = await consumerDb.sync();
      expect(first.fetched).toBe(5);
      expect(first.inserted).toBe(5);
      expect(first.updated).toBe(0);
      expect(first.deleted).toBe(0);

      const firstState = await readFullState(drizzleDb);
      expect(firstState.albums).toHaveLength(5);
      expect(firstState.syncAlbumIds).toHaveLength(0);
      assertNoDanglingRelations(firstState);

      const firstSyncState = firstState.syncState.find((row) => row.key === "albums_last_synced_at");
      expect(firstSyncState).toBeDefined();
      expect(firstSyncState?.value.length).toBeGreaterThan(0);

      const second = await consumerDb.sync();
      expect(second.fetched).toBe(5);
      expect(second.inserted).toBe(0);
      expect(second.updated).toBe(5);
      expect(second.deleted).toBe(0);

      const secondState = await readFullState(drizzleDb);
      expect(secondState.syncAlbumIds).toHaveLength(0);
      assertNoDanglingRelations(secondState);

      expect(secondState.albums).toEqual(firstState.albums);
      expect(secondState.albumRecordLabels).toEqual(firstState.albumRecordLabels);
      expect(secondState.albumGenres).toEqual(firstState.albumGenres);
      expect(secondState.albumArtists).toEqual(firstState.albumArtists);
      expect(secondState.albumArtistRoles).toEqual(firstState.albumArtistRoles);
      expect(secondState.albumReleaseTypes).toEqual(firstState.albumReleaseTypes);
      expect(secondState.albumMoods).toEqual(firstState.albumMoods);
      expect(secondState.albumDiscTitles).toEqual(firstState.albumDiscTitles);

      const secondSyncState = secondState.syncState.find(
        (row) => row.key === "albums_last_synced_at",
      );
      expect(secondSyncState).toBeDefined();
      expect(secondSyncState?.value).not.toBe(firstSyncState?.value);
    });
  });

  it("reconciles album deletions when server library changes", async () => {
    const drizzleDb = createBetterSqliteAdapter();
    const consumerDb = new SyncManager(drizzleDb);

    await withNavidromeLibrary(librarySetA, async (connectionA) => {
      await consumerDb.connect({
        url: connectionA.baseUrl,
        username: connectionA.username,
        password: connectionA.password,
      });
      const resultA = await consumerDb.sync();
      expect(resultA.fetched).toBe(5);
      expect(resultA.deleted).toBe(0);
    });

    const beforeState = await readFullState(drizzleDb);
    const beforeIds = new Set(beforeState.albums.map((album) => album.id));

    await withNavidromeLibrary(librarySetB, async (connectionB) => {
      await consumerDb.connect({
        url: connectionB.baseUrl,
        username: connectionB.username,
        password: connectionB.password,
      });
      const resultB = await consumerDb.sync();
      expect(resultB.fetched).toBe(5);
      expect(resultB.deleted).toBeGreaterThan(0);
    });

    const afterState = await readFullState(drizzleDb);
    const afterIds = new Set(afterState.albums.map((album) => album.id));

    expect(afterState.albums).toHaveLength(5);
    expect(afterState.syncAlbumIds).toHaveLength(0);
    assertNoDanglingRelations(afterState);

    const hasNewAlbumIds = [...afterIds].some((id) => !beforeIds.has(id));
    expect(hasNewAlbumIds).toBe(true);

    for (const beforeAlbum of beforeState.albums) {
      const stillExists = afterState.albums.some((album) => album.id === beforeAlbum.id);
      if (stillExists) {
        continue;
      }

      const childLabels = afterState.albumRecordLabels.filter(
        (row) => row.albumId === beforeAlbum.id,
      );
      const childGenres = afterState.albumGenres.filter((row) => row.albumId === beforeAlbum.id);
      const childArtists = afterState.albumArtists.filter((row) => row.albumId === beforeAlbum.id);
      const childRoles = afterState.albumArtistRoles.filter(
        (row) => row.albumId === beforeAlbum.id,
      );
      const childReleaseTypes = afterState.albumReleaseTypes.filter(
        (row) => row.albumId === beforeAlbum.id,
      );
      const childMoods = afterState.albumMoods.filter((row) => row.albumId === beforeAlbum.id);
      const childDiscTitles = afterState.albumDiscTitles.filter(
        (row) => row.albumId === beforeAlbum.id,
      );

      expect(childLabels).toHaveLength(0);
      expect(childGenres).toHaveLength(0);
      expect(childArtists).toHaveLength(0);
      expect(childRoles).toHaveLength(0);
      expect(childReleaseTypes).toHaveLength(0);
      expect(childMoods).toHaveLength(0);
      expect(childDiscTitles).toHaveLength(0);
    }

    const syncStateRow = await drizzleDb
      .select()
      .from(syncStateTable)
      .where(eq(syncStateTable.key, "albums_last_synced_at"))
      .limit(1);
    expect(syncStateRow).toHaveLength(1);
  });
});
