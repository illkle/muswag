import { createHash } from "node:crypto";
import { access, mkdir, readdir, rename, rm, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

import { FileSystemError, MiniFs } from "@muswag/backend";
import { Effect, Layer } from "effect";

import { thumbnailPathsOf } from "../cover-thumbnails";

/** Where cover files are kept, relative to the app data directory. */
export const COVER_DIRECTORY = "covers";

/**
 * The cover directory of the library at `databasePath`, relative to the app data directory. The app's
 * own library, inside that directory, has `COVER_DIRECTORY`. A development checkout keeps its library
 * in the checkout but shares the app data directory, and a sync sweeps away the covers its library does
 * not name, so each such library has a directory of its own inside `COVER_DIRECTORY`.
 */
export function coverDirectoryOf(databasePath: string, userDataPath: string): string {
  const inside = relative(resolve(userDataPath), resolve(databasePath));
  if (!inside.startsWith("..") && !isAbsolute(inside)) return COVER_DIRECTORY;
  return join(COVER_DIRECTORY, `library-${createHash("sha256").update(resolve(databasePath)).digest("hex").slice(0, 12)}`);
}

/** Resolves `requested` inside `base`, refusing paths that escape it. */
export function resolveInside(base: string, requested: string): string {
  const absoluteBase = resolve(base);
  const target = resolve(absoluteBase, requested);
  if (!target.startsWith(`${absoluteBase}${sep}`) && target !== absoluteBase) {
    throw new Error("Path escapes the application data directory");
  }
  return target;
}

/** Cover files, relative to the app data directory. */
export const MiniFsLive = (base: string) =>
  Layer.succeed(MiniFs, {
    writeFile: (path, data) =>
      Effect.tryPromise({
        try: async () => {
          const target = resolveInside(base, path);
          await mkdir(dirname(target), { recursive: true });
          // Renamed into place, so neither a crash nor a request served meanwhile sees half a cover.
          const temporary = `${target}.tmp`;
          await writeFile(temporary, data);
          await rename(temporary, target);
        },
        catch: (cause) => new FileSystemError({ cause: String(cause), message: `Failed to write ${path}` }),
      }),
    remove: (path) =>
      Effect.tryPromise({
        try: async () => {
          const target = resolveInside(base, path);
          await Promise.all([rm(target, { recursive: true, force: true }), ...thumbnailPathsOf(target).map((path) => rm(path, { force: true }))]);
        },
        catch: (cause) => new FileSystemError({ cause: String(cause), message: `Failed to remove ${path}` }),
      }),
    list: (directory) =>
      Effect.tryPromise({
        try: async () => {
          try {
            const entries = await readdir(resolveInside(base, directory), { withFileTypes: true });
            return entries.filter((entry) => entry.isFile()).map((entry) => entry.name);
          } catch (error) {
            // No cover has been downloaded yet, or the session that had some logged out.
            if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
            throw error;
          }
        },
        catch: (cause) => new FileSystemError({ cause: String(cause), message: `Failed to list ${directory}` }),
      }),
    exists: (path) =>
      Effect.promise(async () => {
        try {
          await access(resolveInside(base, path));
          return true;
        } catch {
          return false;
        }
      }),
  });
