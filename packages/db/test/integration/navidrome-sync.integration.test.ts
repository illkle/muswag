import { asc, eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";

import { SyncManager } from "../../src/database.js";
import {
  albumArtistRolesTable,
  albumArtistsTable,
  albumDiscTitlesTable,
  albumGenresTable,
  albumMoodsTable,
  albumRecordLabelsTable,
  albumsTable,
  albumReleaseTypesTable,
  DBZodValidators,
  type DrizzleDb,
  syncAlbumIdsTable,
  syncStateTable,
} from "../../src/drizzle/schema.js";
import { librarySetA, librarySetB } from "../fixtures/library-sets.js";
import { createIntegrationLogger, type LogFields } from "./helpers/integration-log.js";
import {
  checkNavidromeDependencies,
  createInMemoryDrizzleDb,
  withNavidromeLibrary,
} from "./helpers/navidrome-testkit.js";

const logger = createIntegrationLogger("navidrome-integration");
const { logInfo, timeStep } = logger;

const dependencies = checkNavidromeDependencies();
if (!dependencies.ready) {
  console.warn(
    `Skipping integration tests: ${dependencies.missingDependencies.join(" and ")} unavailable.`,
  );
}
logInfo("dependency-check", {
  dockerAvailable: dependencies.dockerAvailable,
  ffmpegAvailable: dependencies.ffmpegAvailable,
});

const describeIfReady = dependencies.ready ? describe : describe.skip;

async function readFullState(db: DrizzleDb) {
  const albums = DBZodValidators.albumsTable
    .array()
    .parse(await db.select().from(albumsTable).orderBy(asc(albumsTable.id)));
  const albumRecordLabels = DBZodValidators.albumRecordLabelsTable
    .array()
    .parse(
      await db
        .select()
        .from(albumRecordLabelsTable)
        .orderBy(asc(albumRecordLabelsTable.albumId), asc(albumRecordLabelsTable.position)),
    );
  const albumGenres = DBZodValidators.albumGenresTable
    .array()
    .parse(
      await db
        .select()
        .from(albumGenresTable)
        .orderBy(asc(albumGenresTable.albumId), asc(albumGenresTable.position)),
    );
  const albumArtists = DBZodValidators.albumArtistsTable
    .array()
    .parse(
      await db
        .select()
        .from(albumArtistsTable)
        .orderBy(asc(albumArtistsTable.albumId), asc(albumArtistsTable.position)),
    );
  const albumArtistRoles = DBZodValidators.albumArtistRolesTable
    .array()
    .parse(
      await db
        .select()
        .from(albumArtistRolesTable)
        .orderBy(
          asc(albumArtistRolesTable.albumId),
          asc(albumArtistRolesTable.artistPosition),
          asc(albumArtistRolesTable.position),
        ),
    );
  const albumReleaseTypes = DBZodValidators.albumReleaseTypesTable
    .array()
    .parse(
      await db
        .select()
        .from(albumReleaseTypesTable)
        .orderBy(asc(albumReleaseTypesTable.albumId), asc(albumReleaseTypesTable.position)),
    );
  const albumMoods = DBZodValidators.albumMoodsTable
    .array()
    .parse(
      await db
        .select()
        .from(albumMoodsTable)
        .orderBy(asc(albumMoodsTable.albumId), asc(albumMoodsTable.position)),
    );
  const albumDiscTitles = DBZodValidators.albumDiscTitlesTable
    .array()
    .parse(
      await db
        .select()
        .from(albumDiscTitlesTable)
        .orderBy(asc(albumDiscTitlesTable.albumId), asc(albumDiscTitlesTable.position)),
    );
  const syncState = DBZodValidators.syncStateTable
    .array()
    .parse(await db.select().from(syncStateTable).orderBy(asc(syncStateTable.key)));
  const syncAlbumIds = DBZodValidators.syncAlbumIdsTable
    .array()
    .parse(await db.select().from(syncAlbumIdsTable).orderBy(asc(syncAlbumIdsTable.id)));

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

function summarizeState(state: Awaited<ReturnType<typeof readFullState>>): LogFields {
  return {
    albums: state.albums.length,
    albumRecordLabels: state.albumRecordLabels.length,
    albumGenres: state.albumGenres.length,
    albumArtists: state.albumArtists.length,
    albumArtistRoles: state.albumArtistRoles.length,
    albumReleaseTypes: state.albumReleaseTypes.length,
    albumMoods: state.albumMoods.length,
    albumDiscTitles: state.albumDiscTitles.length,
    syncState: state.syncState.length,
    syncAlbumIds: state.syncAlbumIds.length,
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
    logInfo("test:start", {
      test: "syncs albums and remains idempotent across all album-related tables",
    });
    await withNavidromeLibrary(
      librarySetA,
      async (connection) => {
        const drizzleDb = createInMemoryDrizzleDb();
        const consumerDb = new SyncManager(drizzleDb);

        await timeStep("consumer:connect:first", () =>
          consumerDb.connect({
            url: connection.baseUrl,
            username: connection.username,
            password: connection.password,
          }),
        );

        const first = await timeStep("consumer:sync:first", () => consumerDb.sync());
        logInfo("consumer:sync:first:result", {
          fetched: first.fetched,
          inserted: first.inserted,
          updated: first.updated,
          deleted: first.deleted,
        });
        expect(first.fetched).toBe(5);
        expect(first.inserted).toBe(5);
        expect(first.updated).toBe(0);
        expect(first.deleted).toBe(0);

        const firstState = await timeStep("state:read:first", () => readFullState(drizzleDb));
        logInfo("state:first:summary", summarizeState(firstState));
        expect(firstState.albums).toHaveLength(5);
        expect(firstState.syncAlbumIds).toHaveLength(0);
        assertNoDanglingRelations(firstState);

        const firstSyncState = firstState.syncState.find(
          (row) => row.key === "albums_last_synced_at",
        );
        expect(firstSyncState).toBeDefined();
        expect(firstSyncState?.value.length).toBeGreaterThan(0);

        const second = await timeStep("consumer:sync:second", () => consumerDb.sync());
        logInfo("consumer:sync:second:result", {
          fetched: second.fetched,
          inserted: second.inserted,
          updated: second.updated,
          deleted: second.deleted,
        });
        expect(second.fetched).toBe(5);
        expect(second.inserted).toBe(0);
        expect(second.updated).toBe(5);
        expect(second.deleted).toBe(0);

        const secondState = await timeStep("state:read:second", () => readFullState(drizzleDb));
        logInfo("state:second:summary", summarizeState(secondState));
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
      },
      { logger },
    );
    logInfo("test:done", {
      test: "syncs albums and remains idempotent across all album-related tables",
    });
  });

  it("reconciles album deletions when server library changes", async () => {
    logInfo("test:start", {
      test: "reconciles album deletions when server library changes",
    });
    const drizzleDb = createInMemoryDrizzleDb();
    const consumerDb = new SyncManager(drizzleDb);

    await withNavidromeLibrary(
      librarySetA,
      async (connectionA) => {
        await timeStep("consumer:connect:library-a", () =>
          consumerDb.connect({
            url: connectionA.baseUrl,
            username: connectionA.username,
            password: connectionA.password,
          }),
        );
        const resultA = await timeStep("consumer:sync:library-a", () => consumerDb.sync());
        logInfo("consumer:sync:library-a:result", {
          fetched: resultA.fetched,
          inserted: resultA.inserted,
          updated: resultA.updated,
          deleted: resultA.deleted,
        });
        expect(resultA.fetched).toBe(5);
        expect(resultA.deleted).toBe(0);
      },
      { logger },
    );

    const beforeState = await timeStep("state:read:before", () => readFullState(drizzleDb));
    logInfo("state:before:summary", summarizeState(beforeState));
    const beforeIds = new Set(beforeState.albums.map((album) => album.id));

    await withNavidromeLibrary(
      librarySetB,
      async (connectionB) => {
        await timeStep("consumer:connect:library-b", () =>
          consumerDb.connect({
            url: connectionB.baseUrl,
            username: connectionB.username,
            password: connectionB.password,
          }),
        );
        const resultB = await timeStep("consumer:sync:library-b", () => consumerDb.sync());
        logInfo("consumer:sync:library-b:result", {
          fetched: resultB.fetched,
          inserted: resultB.inserted,
          updated: resultB.updated,
          deleted: resultB.deleted,
        });
        expect(resultB.fetched).toBe(5);
        expect(resultB.deleted).toBeGreaterThan(0);
      },
      { logger },
    );

    const afterState = await timeStep("state:read:after", () => readFullState(drizzleDb));
    logInfo("state:after:summary", summarizeState(afterState));
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
    logInfo("test:done", {
      test: "reconciles album deletions when server library changes",
    });
  });
});
