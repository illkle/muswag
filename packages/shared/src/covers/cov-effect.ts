import { Context, Data, Effect, Layer } from "effect";
import { MuswagDatabase } from "../db/database.js";
import { Path } from "effect/Path";
import type { PlatformError } from "effect/PlatformError";
import SubsonicAPI from "../api/subsonic-api.js";
import type { HttpClientError } from "effect/unstable/http/HttpClientError";
import type { SubsonicHttpError } from "../api/subsonic-api-schema.js";

export interface MiniFsService {
  readonly writeFile: (path: string, data: Uint8Array) => Effect.Effect<void, PlatformError>;
  readonly remove: (path: string) => Effect.Effect<void, PlatformError>;
}

export class MiniFs extends Context.Service<MiniFs, MiniFsService>()("@muswag/shared/covers/MiniFs") {}

export type CoverTarget =
  | { type: "album"; id: string; coverArtId: string }
  | {
      type: "artist";
      id: string;
    };

export interface CoverManagerService {
  readonly ensure: (target: CoverTarget) => Effect.Effect<string, ErrorOnCoverFetch | UnsupportedExtension | PlatformError | HttpClientError | SubsonicHttpError>;
  readonly repair: (target: CoverTarget, failedPath: string) => Effect.Effect<string, ErrorOnCoverFetch | UnsupportedExtension | PlatformError | HttpClientError | SubsonicHttpError>;
  readonly remove: (t: CoverTarget) => Effect.Effect<void, PlatformError>;
}

export default class CoverManager extends Context.Service<CoverManager, CoverManagerService>()("@muswag/shared/covers/CoverManager") {}

export const CoverManagerLive = (coverSaveLocation: string) => Layer.effect(CoverManager, make(coverSaveLocation));

class ErrorOnCoverFetch extends Data.TaggedError("ErrorOnCoverFetch")<{
  readonly id: string;
  readonly code: number;
  readonly body: string;
}> {}

class UnsupportedExtension extends Data.TaggedError("UnsupportedExtension")<{
  readonly id: string;
}> {}

const make = (coverSaveLocation: string) =>
  Effect.gen(function* () {
    const db = yield* MuswagDatabase;
    const fs = yield* MiniFs;
    const path = yield* Path;
    const api = yield* SubsonicAPI;

    const ensure = (target: CoverTarget) =>
      Effect.gen(function* () {
        const id = target.type === "artist" ? target.id : target.coverArtId;
        const cov = yield* api.getCoverArt({ id });
        if (cov.status != 200) {
          return yield* new ErrorOnCoverFetch({ id, code: cov.status, body: cov.toString() });
        }

        const bytes = new Uint8Array(yield* cov.arrayBuffer);
        const extension = detectCoverExtension(bytes);

        if (!extension) {
          return yield* new UnsupportedExtension({ id });
        }

        const key = getFileName(target);
        const fileName = key + extension;
        const writePath = path.join(coverSaveLocation, fileName);

        yield* fs.writeFile(writePath, bytes);

        db.covers.insert({ key, fileName });

        return yield* Effect.succeed(fileName);
      });

    return {
      ensure,
      repair: (target) => {
        const id = getId(target);
        db.covers.delete(id);
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

const getId = (t: CoverTarget) => (t.type === "album" ? t.coverArtId : t.id);

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
