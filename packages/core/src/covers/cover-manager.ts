import { albums, artists, covers, type CoverTarget, type SubsonicHttpError } from "@muswag/shared";
import type { SqlError } from "effect/sql/SqlError";
import type { EffectDrizzleQueryError } from "drizzle-orm/effect-core";
import { and, eq, or, sql } from "drizzle-orm";
import { Context, Data, Deferred, Effect, Layer } from "effect";
import type { HttpClientError } from "effect/http/HttpClientError";
import { Path } from "effect/Path";
import type { PlatformError } from "effect/PlatformError";

import SubsonicAPI from "../api/subsonic-api.js";
import { MirrorServer } from "@muswag/tanstack-db-sqlite-mirror/server";

import { Db } from "../db/database.js";

export class FileSystemError extends Data.TaggedError("FileSystemError")<{
  readonly cause: string;
  readonly message: string;
}> {}

export interface MiniFsService {
  readonly writeFile: (path: string, data: Uint8Array) => Effect.Effect<void, FileSystemError>;
  readonly remove: (path: string) => Effect.Effect<void, FileSystemError>;
}

/** File access for cover images, relative to the app data directory. */
export class MiniFs extends Context.Service<MiniFs, MiniFsService>()("@muswag/core/covers/MiniFs") {}

export interface CoverManagerService {
  /** Path of the target's cover, downloading it when it is not cached yet. */
  readonly ensure: (target: CoverTarget) => Effect.Effect<string | null, CoverManagerError>;
  /** Forgets a cover file that failed to load and fetches it again. */
  readonly repair: (target: CoverTarget, failedPath: string) => Effect.Effect<string | null, CoverManagerError>;
}

export class CoverManager extends Context.Service<CoverManager, CoverManagerService>()("@muswag/core/covers/CoverManager") {}

export default CoverManager;

export const CoverManagerLive = (coverSaveLocation: string) => Layer.effect(CoverManager, make(coverSaveLocation));

class ErrorOnCoverFetch extends Data.TaggedError("ErrorOnCoverFetch")<{
  readonly id: string;
  readonly code: number;
  readonly body: string;
}> {}

class UnsupportedExtension extends Data.TaggedError("UnsupportedExtension")<{
  readonly id: string;
}> {}

type DatabaseError = SqlError | EffectDrizzleQueryError;
type CoverManagerError = ErrorOnCoverFetch | UnsupportedExtension | PlatformError | FileSystemError | HttpClientError | SubsonicHttpError | DatabaseError;

const make = (coverSaveLocation: string) =>
  Effect.gen(function* () {
    const db = yield* Db;
    const fs = yield* MiniFs;
    const path = yield* Path;
    const api = yield* SubsonicAPI;
    const mirror = yield* MirrorServer;
    const scope = yield* Effect.scope;
    const inFlight = new Map<string, Deferred.Deferred<string | null, CoverManagerError>>();

    const tableOf = (target: CoverTarget) => (target.type === "album" ? albums : artists);

    /** Points the album or artist at its cover. Unchanged rows are left alone, so no change is broadcast. */
    const setTargetPath = (target: CoverTarget, sourceId: string, coverPath: string) => {
      const table = tableOf(target);
      return mirror.write(
        db
          .update(table)
          .set({ coverArtPath: coverPath, coverArtSourceId: sourceId })
          .where(and(eq(table.id, target.id), or(sql`${table.coverArtPath} IS NOT ${coverPath}`, sql`${table.coverArtSourceId} IS NOT ${sourceId}`))),
      );
    };

    const cachedCover = (key: string) =>
      db
        .select()
        .from(covers)
        .where(eq(covers.key, key))
        .pipe(Effect.map((rows) => rows[0]));

    const fetchCover = (target: CoverTarget, id: string, key: string) =>
      Effect.gen(function* () {
        const cov = yield* api.getCoverArt({ id });
        if (cov.status != 200) {
          return yield* new ErrorOnCoverFetch({ id, code: cov.status, body: cov.toString() });
        }

        const bytes = new Uint8Array(yield* cov.arrayBuffer);
        const extension = detectCoverExtension(bytes);

        if (!extension) {
          return yield* new UnsupportedExtension({ id });
        }

        const fileName = key + extension;
        const writePath = path.join(coverSaveLocation, fileName);

        yield* fs.writeFile(writePath, bytes);
        yield* db.insert(covers).values({ key, fileName }).onConflictDoUpdate({ target: covers.key, set: { fileName } });
        yield* setTargetPath(target, id, writePath);
        return writePath;
      });

    const ensure = (target: CoverTarget): Effect.Effect<string | null, CoverManagerError> =>
      Effect.gen(function* () {
        const id = target.coverArtId;
        if (!id) return null;

        const key = getFileName(target);
        const cached = yield* cachedCover(key);
        if (cached) {
          const cachedPath = path.join(coverSaveLocation, cached.fileName);
          yield* setTargetPath(target, id, cachedPath);
          return cachedPath;
        }

        const current = inFlight.get(key);
        if (current) return yield* Deferred.await(current);

        const deferred = Deferred.makeUnsafe<string | null, CoverManagerError>();
        inFlight.set(key, deferred);
        // Downloads belong to the session, so logging out interrupts them before they can write.
        const forget = Effect.sync(() => {
          if (inFlight.get(key) === deferred) inFlight.delete(key);
        });
        // Forgotten before completing, so a repair right after this download starts a new one.
        yield* Effect.forkIn(Deferred.complete(deferred, fetchCover(target, id, key).pipe(Effect.ensuring(forget))).pipe(Effect.ensuring(Deferred.interrupt(deferred))), scope);
        return yield* Deferred.await(deferred);
      });

    return {
      ensure,
      repair: (target, failedPath) =>
        Effect.gen(function* () {
          const table = tableOf(target);
          yield* db.delete(covers).where(eq(covers.key, getFileName(target)));
          yield* mirror.write(
            db
              .update(table)
              .set({ coverArtPath: null, coverArtSourceId: null })
              .where(and(eq(table.id, target.id), eq(table.coverArtPath, failedPath))),
          );
          return yield* ensure(target);
        }),
    } satisfies CoverManagerService;
  });

const getFileName = (t: CoverTarget) => (t.type === "album" ? `album:${t.id}:${t.coverArtId}` : `artist:${t.id}`);

function detectCoverExtension(bytes: Uint8Array): string | null {
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return ".jpg";
  if (bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47 && bytes[4] === 0x0d && bytes[5] === 0x0a && bytes[6] === 0x1a && bytes[7] === 0x0a) {
    return ".png";
  }
  const header = String.fromCharCode(...bytes.subarray(0, 32));
  if (header.startsWith("GIF87a") || header.startsWith("GIF89a")) return ".gif";
  if (header.startsWith("RIFF") && header.slice(8, 12) === "WEBP") return ".webp";
  if (header.slice(4, 8) === "ftyp" && (header.includes("avif", 8) || header.includes("avis", 8))) return ".avif";
  return null;
}
