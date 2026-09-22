import { Context, Data, Deferred, Effect, Layer } from "effect";
import { MuswagDatabase } from "./db/database.js";
import { Path } from "effect/Path";
import type { PlatformError } from "effect/PlatformError";
import SubsonicAPI from "./api/subsonic-api.js";
import type { HttpClientError } from "effect/unstable/http/HttpClientError";
import type { SubsonicHttpError } from "./api/subsonic-api-schema.js";

export class FileSystemError extends Data.TaggedError("FileSystemError")<{
  readonly cause: string;
  readonly message: string;
}> {}

export interface MiniFsService {
  readonly writeFile: (path: string, data: Uint8Array) => Effect.Effect<void, FileSystemError>;
  readonly remove: (path: string) => Effect.Effect<void, FileSystemError>;
}

export class MiniFs extends Context.Service<MiniFs, MiniFsService>()("@muswag/shared/covers/MiniFs") {}

export type CoverTarget = { type: "album"; id: string; coverArtId: string | null } | { type: "artist"; id: string; coverArtId: string | null };

export interface CoverManagerService {
  readonly ensure: (target: CoverTarget) => Effect.Effect<string | null, ErrorOnCoverFetch | UnsupportedExtension | PlatformError | FileSystemError | HttpClientError | SubsonicHttpError>;
  readonly repair: (
    target: CoverTarget,
    failedPath: string,
  ) => Effect.Effect<string | null, ErrorOnCoverFetch | UnsupportedExtension | FileSystemError | PlatformError | HttpClientError | SubsonicHttpError>;
  readonly remove: (t: CoverTarget) => Effect.Effect<void, FileSystemError>;
}

export class CoverManager extends Context.Service<CoverManager, CoverManagerService>()("@muswag/shared/covers/CoverManager") {}

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

type CoverManagerError = ErrorOnCoverFetch | UnsupportedExtension | PlatformError | FileSystemError | HttpClientError | SubsonicHttpError;

const make = (coverSaveLocation: string) =>
  Effect.gen(function* () {
    const db = yield* MuswagDatabase;
    const fs = yield* MiniFs;
    const path = yield* Path;
    const api = yield* SubsonicAPI;
    const inFlight = new Map<string, Deferred.Deferred<string | null, CoverManagerError>>();

    const setTargetPath = (target: CoverTarget, sourceId: string, coverPath: string) => {
      if (target.type === "album" && db.albums.get(target.id)) {
        db.albums.update(target.id, (draft) => {
          draft.coverArtPath = coverPath;
          draft.coverArtSourceId = sourceId;
        });
      } else if (target.type === "artist" && db.artists.get(target.id)) {
        db.artists.update(target.id, (draft) => {
          draft.coverArtPath = coverPath;
          draft.coverArtSourceId = sourceId;
        });
      }
    };

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

        const existing = db.covers.get(key);
        if (existing) {
          if (existing.fileName !== fileName) {
            db.covers.update(key, (draft) => {
              draft.fileName = fileName;
            });
          }
        } else {
          db.covers.insert({ key, fileName });
        }

        setTargetPath(target, id, writePath);
        return writePath;
      });

    const ensure = (target: CoverTarget): Effect.Effect<string | null, CoverManagerError> =>
      Effect.suspend(() => {
        const id = target.coverArtId;
        if (!id) return Effect.succeed(null);

        const key = getFileName(target);
        const cached = db.covers.get(key);
        if (cached) {
          const cachedPath = path.join(coverSaveLocation, cached.fileName);
          setTargetPath(target, id, cachedPath);
          return Effect.succeed(cachedPath);
        }

        const current = inFlight.get(key);
        if (current) return Deferred.await(current);

        const deferred = Deferred.makeUnsafe<string | null, CoverManagerError>();
        inFlight.set(key, deferred);
        return Deferred.complete(
          deferred,
          fetchCover(target, id, key).pipe(
            Effect.ensuring(
              Effect.sync(() => {
                inFlight.delete(key);
              }),
            ),
          ),
        ).pipe(Effect.andThen(Deferred.await(deferred)));
      });

    return {
      ensure,
      repair: (target, failedPath) => {
        const key = getFileName(target);
        if (db.covers.get(key)) db.covers.delete(key);
        if (target.type === "album" && db.albums.get(target.id)) {
          db.albums.update(target.id, (draft) => {
            if (draft.coverArtPath === failedPath) {
              delete draft.coverArtPath;
              delete draft.coverArtSourceId;
            }
          });
        } else if (target.type === "artist" && db.artists.get(target.id)) {
          db.artists.update(target.id, (draft) => {
            if (draft.coverArtPath === failedPath) {
              delete draft.coverArtPath;
              delete draft.coverArtSourceId;
            }
          });
        }
        return ensure(target);
      },
      remove: (target: CoverTarget) => {
        const key = getFileName(target);
        const res = db.covers.get(key);

        if (!res) {
          return Effect.succeedNone;
        }

        return fs.remove(path.join(coverSaveLocation, res.fileName));
      },
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
