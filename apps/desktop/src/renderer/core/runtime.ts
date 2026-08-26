import { db } from "#/lib/db-renderer.ts";
import { CredentialsStore, CredentialsStoreError, FileSystemError, MiniFs, MuswagDatabase, SessionManagerLive, type SessionCredentials } from "@muswag/shared";
import { Effect, Layer, ManagedRuntime } from "effect";
import { BrowserCrypto } from "@effect/platform-browser";
import { FetchHttpClient } from "effect/unstable/http";
import { FilesystemIpc, PlayerIPC } from "#/lib/ipc.ts";
import { layer as PathLayer } from "effect/Path";
import { queryOnce } from "@tanstack/react-db";

const baseLayer = Layer.mergeAll(FetchHttpClient.layer, BrowserCrypto.layer);
const dbLayer = Layer.succeed(MuswagDatabase, db);
const miniFs = Layer.succeed(MiniFs, {
  writeFile: (path, data) =>
    Effect.tryPromise({
      try: () => FilesystemIpc.writeFile(path, data),
      catch: (cause) =>
        new FileSystemError({
          cause: String(cause),
          message: `Failed to write ${path}`,
        }),
    }),
  remove: (path) =>
    Effect.tryPromise({
      try: () => FilesystemIpc.remove(path),
      catch: (cause) =>
        new FileSystemError({
          cause: String(cause),
          message: `Failed to remove ${path}`,
        }),
    }),
});

const credentialsStore = Layer.succeed(CredentialsStore, {
  load: Effect.tryPromise({
    try: async (): Promise<SessionCredentials | null> => {
      const record = await queryOnce((query) => query.from({ credentials: db.userCredentials }).findOne());
      const credentials = record ? { url: record.url, username: record.username, password: record.password } : null;
      await PlayerIPC.setCredentials(credentials);
      return credentials;
    },
    catch: (cause) => new CredentialsStoreError({ operation: "load", message: "Failed to load stored credentials", cause }),
  }),
  save: (credentials) =>
    Effect.tryPromise({
      try: async () => {
        const existing = db.userCredentials.get(1);
        const transaction = existing
          ? db.userCredentials.update(1, (draft) => {
              draft.url = credentials.url;
              draft.username = credentials.username;
              draft.password = credentials.password;
            })
          : db.userCredentials.insert({ id: 1, ...credentials });
        await transaction.isPersisted.promise;
        await PlayerIPC.setCredentials(credentials);
      },
      catch: (cause) => new CredentialsStoreError({ operation: "save", message: "Failed to save credentials", cause }),
    }),
  clear: Effect.tryPromise({
    try: async () => {
      const existing = db.userCredentials.get(1);
      if (existing) await db.userCredentials.delete(1).isPersisted.promise;
      await PlayerIPC.setCredentials(null);
    },
    catch: (cause) => new CredentialsStoreError({ operation: "clear", message: "Failed to clear credentials", cause }),
  }),
});

const infrastructure = Layer.mergeAll(baseLayer, dbLayer, miniFs, credentialsStore, PathLayer);
const appLayer = SessionManagerLive({ coverSaveLocation: "covers" }).pipe(Layer.provideMerge(infrastructure));

export const runtime = ManagedRuntime.make(appLayer);
