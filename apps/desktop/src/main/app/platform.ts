import { mkdir, rm, writeFile } from "node:fs/promises";
import { dirname, resolve, sep } from "node:path";

import { FileSystemError, MiniFs, type CredentialsCipher } from "@muswag/backend";
import { Effect, Layer } from "effect";
import { safeStorage } from "electron";

import { thumbnailPathOf } from "../cover-thumbnails";

/** Where cover files are kept, relative to the app data directory. */
export const COVER_DIRECTORY = "covers";

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
          await writeFile(target, data);
        },
        catch: (cause) => new FileSystemError({ cause: String(cause), message: `Failed to write ${path}` }),
      }),
    remove: (path) =>
      Effect.tryPromise({
        try: async () => {
          const target = resolveInside(base, path);
          await Promise.all([rm(target, { force: true }), rm(thumbnailPathOf(target), { force: true })]);
        },
        catch: (cause) => new FileSystemError({ cause: String(cause), message: `Failed to remove ${path}` }),
      }),
  });

/** Encrypts the stored password with the OS keychain through Electron's `safeStorage`. */
export const safeStorageCipher: CredentialsCipher = {
  isAvailable: () => safeStorage.isEncryptionAvailable(),
  encrypt: (plain) => safeStorage.encryptString(plain).toString("base64"),
  decrypt: (encrypted) => safeStorage.decryptString(Buffer.from(encrypted, "base64")),
};
