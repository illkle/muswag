import { albums, artists, type CoverTarget, type SubsonicHttpError } from "@muswag/model";
import type { SqlError } from "effect/sql/SqlError";
import type { EffectDrizzleQueryError } from "drizzle-orm/effect-core";
import { and, eq, isNotNull } from "drizzle-orm";
import { Cause, Context, Data, Deferred, Effect, Exit, Layer, Semaphore } from "effect";
import type { HttpClientError } from "effect/http/HttpClientError";
import { Path } from "effect/Path";

import { SubsonicAPI } from "../api/subsonic-api.js";
import { SqliteMirror } from "@muswag/tanstack-db-mirror/server/sqlite";

import { Db } from "../db/database.js";

export class FileSystemError extends Data.TaggedError("FileSystemError")<{
  readonly cause: string;
  readonly message: string;
}> {}

export interface MiniFsService {
  readonly writeFile: (path: string, data: Uint8Array) => Effect.Effect<void, FileSystemError>;
  /** Removes a cover file with what was made from it, or a directory with all it holds. Removing what is not there succeeds. */
  readonly remove: (path: string) => Effect.Effect<void, FileSystemError>;
  readonly exists: (path: string) => Effect.Effect<boolean>;
  /**
   * The names of the files in a directory, none when it is not there. Not of the directories in it:
   * `covers` holds the cover directories of development checkouts' libraries.
   */
  readonly list: (directory: string) => Effect.Effect<ReadonlyArray<string>, FileSystemError>;
}

/** File access for cover images, relative to the app data directory. */
export class MiniFs extends Context.Service<MiniFs, MiniFsService>()("@muswag/backend/covers/MiniFs") {}

/** The album or artist a cover belongs to. */
export type CoverOwner = Pick<CoverTarget, "type" | "id">;

export interface CoverManagerService {
  /**
   * Path of the owner's cover file, or null when it has no cover. The image is downloaded when the row
   * names no file yet or the file is gone.
   */
  readonly ensure: (owner: CoverOwner) => Effect.Effect<string | null, CoverManagerError>;
  /**
   * Removes every file of the cover directory that no album or artist names: the covers of rows a sync
   * took away or gave another cover, and what a crash or a failed removal left behind. Answers with how
   * many files it removed.
   */
  readonly sweep: Effect.Effect<number, FileSystemError | DatabaseError>;
}

export class CoverManager extends Context.Service<CoverManager, CoverManagerService>()("@muswag/backend/covers/CoverManager") {}

export const CoverManagerLive = (coverSaveLocation: string) => Layer.effect(CoverManager, make(coverSaveLocation));

class NotAnImage extends Data.TaggedError("NotAnImage")<{
  readonly id: string;
  readonly message: string;
}> {}

type DatabaseError = SqlError | EffectDrizzleQueryError;
type CoverManagerError = NotAnImage | FileSystemError | HttpClientError | SubsonicHttpError | DatabaseError;

/** How long a failed download answers for its cover before the server is asked again. */
const RETRY_FAILED_AFTER = "1 minute";
/**
 * The longer edge a cover is asked for at, which servers scale it down to: twice the largest it is
 * shown, an album's tile in the grid at up to about 350 px, for a display of twice the density. An
 * original is often thousands of pixels and several MB. Navidrome, gonic and LMS take the size.
 */
export const COVER_PIXELS = 720;
/** Downloads at a time. A grid asks for dozens of covers at once, and the server resizes each. */
const DOWNLOAD_CONCURRENCY = 6;

const make = (coverSaveLocation: string) =>
  Effect.gen(function* () {
    const db = yield* Db;
    const fs = yield* MiniFs;
    const path = yield* Path;
    const api = yield* SubsonicAPI;
    const mirror = yield* SqliteMirror;
    const scope = yield* Effect.scope;
    /** Downloads by owner: the ones running and, for a while, the ones that failed. */
    const downloads = new Map<string, Deferred.Deferred<string | null, CoverManagerError>>();
    const downloading = yield* Semaphore.make(DOWNLOAD_CONCURRENCY);

    // Albums and artists have the same cover columns, so the queries are typed by one of them.
    const tableOf = (owner: CoverOwner) => (owner.type === "album" ? albums : artists) as typeof albums;

    const rowOf = (owner: CoverOwner) => {
      const table = tableOf(owner);
      return db
        .select({ coverArt: table.coverArt, coverArtPath: table.coverArtPath })
        .from(table)
        .where(eq(table.id, owner.id))
        .pipe(Effect.map((rows) => rows[0]));
    };

    const download = (owner: CoverOwner): Effect.Effect<string | null, CoverManagerError> =>
      Effect.gen(function* () {
        const table = tableOf(owner);
        const coverPath = path.join(coverSaveLocation, coverFileName(owner));

        const row = yield* rowOf(owner);
        if (!row?.coverArt) {
          // Reached only when the row lost its cover, or went, during a download: that one's file has no row.
          yield* Effect.ignore(fs.remove(coverPath));
          return null;
        }

        const bytes = yield* api.getCoverArt({ id: row.coverArt, size: COVER_PIXELS }).pipe(
          Effect.flatMap((response) => response.arrayBuffer),
          Effect.map((buffer) => new Uint8Array(buffer)),
          downloading.withPermit,
        );
        // A server may answer a request it cannot serve with an error document and status 200.
        if (!coverMediaType(bytes)) return yield* new NotAnImage({ id: row.coverArt, message: `The server did not answer with an image for cover ${row.coverArt}` });

        yield* fs.writeFile(coverPath, bytes);
        const stored = yield* mirror.write(
          db
            .update(table)
            .set({ coverArtPath: coverPath })
            .where(and(eq(table.id, owner.id), eq(table.coverArt, row.coverArt)))
            .returning({ id: table.id }),
        );
        if (stored.length > 0) return coverPath;
        // A sync gave the row another cover while this one was on its way.
        return yield* download(owner);
      });

    const ensure = (owner: CoverOwner): Effect.Effect<string | null, CoverManagerError> =>
      Effect.gen(function* () {
        const row = yield* rowOf(owner);
        if (!row?.coverArt) return null;
        if (row.coverArtPath && (yield* fs.exists(row.coverArtPath))) return row.coverArtPath;

        const key = `${owner.type}:${owner.id}`;
        // Registered and started in one step that cannot be interrupted: a download registered but
        // never started would keep everyone who asks after waiting.
        const started = yield* Effect.uninterruptible(
          Effect.gen(function* () {
            const current = downloads.get(key);
            if (current) return current;

            const deferred = Deferred.makeUnsafe<string | null, CoverManagerError>();
            downloads.set(key, deferred);
            const forget = Effect.sync(() => {
              if (downloads.get(key) === deferred) downloads.delete(key);
            });
            const downloaded = download(owner).pipe(
              Effect.tapError((error) => Effect.logWarning(`Failed to download the cover of ${key}`, error)),
              // A failure stays and answers the requests that follow, so a list that keeps asking for its
              // covers does not start a download with each request.
              Effect.onExit((exit) => (Exit.isFailure(exit) && !Cause.hasInterruptsOnly(exit.cause) ? Effect.forkIn(Effect.delay(forget, RETRY_FAILED_AFTER), scope) : forget)),
            );
            // Downloads belong to the session, so logging out interrupts them before they can write.
            const fiber = yield* Effect.forkIn(downloaded, scope);
            // From outside the fiber: one forked into a session that has closed ends before it runs, and
            // whoever waits is answered all the same.
            fiber.addObserver((exit) => {
              Deferred.doneUnsafe(deferred, exit);
              if (Exit.isFailure(exit) && Cause.hasInterruptsOnly(exit.cause)) Effect.runSync(forget);
            });
            return deferred;
          }),
        );
        return yield* Deferred.await(started);
      });

    const sweep = Effect.gen(function* () {
      const files = yield* fs.list(coverSaveLocation);
      // Listed first: a download writes its file before its row names it, and is in `downloads` until
      // after. So a file listed here is named by its row by the time the rows are read, or its owner is
      // still downloading when `downloads` is read.
      const kept = new Set([...downloads.keys()].map(fileNameOf));
      for (const table of [albums, artists]) {
        const rows = yield* db.select({ path: table.coverArtPath }).from(table).where(isNotNull(table.coverArtPath));
        for (const { path: coverPath } of rows) kept.add(path.basename(coverPath!));
      }
      // A cover's thumbnails and the file it is written to first are named after it, with a suffix.
      // Names of covers have no `.`.
      const unused = files.filter((file) => !kept.has(file.split(".")[0]!));
      yield* Effect.forEach(unused, (file) => Effect.ignore(fs.remove(path.join(coverSaveLocation, file))), { concurrency: 8, discard: true });
      return unused.length;
    });

    return { ensure, sweep } satisfies CoverManagerService;
  });

/**
 * The file of an owner's cover: one name per owner, so a new image replaces the old one. The name
 * has to do on every platform and server ids may hold anything, so all but lower-case letters,
 * digits and `-` is spelled out by its code: Windows has no `:`, drops a trailing `.`, and like
 * macOS takes `A` and `a` for the same name. Two owners never share a name.
 */
export const coverFileName = (owner: CoverOwner) => fileNameOf(`${owner.type}:${owner.id}`);

const fileNameOf = (key: string) => key.replace(/[^a-z0-9-]/g, (character) => `_${character.codePointAt(0)!.toString(16)}_`);

/** The media type of an image by its first bytes, or null when it is none a cover may have. */
export function coverMediaType(bytes: Uint8Array): string | null {
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "image/jpeg";
  if (bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47 && bytes[4] === 0x0d && bytes[5] === 0x0a && bytes[6] === 0x1a && bytes[7] === 0x0a) {
    return "image/png";
  }
  const header = String.fromCharCode(...bytes.subarray(0, 32));
  if (header.startsWith("GIF87a") || header.startsWith("GIF89a")) return "image/gif";
  if (header.startsWith("RIFF") && header.slice(8, 12) === "WEBP") return "image/webp";
  if (header.slice(4, 8) === "ftyp" && (header.includes("avif", 8) || header.includes("avis", 8))) return "image/avif";
  return null;
}
