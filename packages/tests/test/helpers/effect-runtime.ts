import { randomBytes } from "node:crypto";

import { LibrarySync, PlaylistCommands, PlaylistEdits, subsonicToken } from "@muswag/backend";
import { NoCoverFiles, SubsonicAPILive, TestDatabase } from "@muswag/backend/testing";
import { Effect, Layer, ManagedRuntime } from "effect";
import { FetchHttpClient } from "effect/http";

import type { Account, TestServer } from "../servers/index.js";

/** muswag's Subsonic client, signed in to `server` as `account` the way the app signs in. */
export function subsonicLayerFor(server: TestServer, account: Account = server.admin) {
  const salt = randomBytes(16).toString("hex");
  return SubsonicAPILive({
    url: server.url,
    auth: { username: account.username, salt, token: subsonicToken(account.password, salt) },
  }).pipe(Layer.provide(FetchHttpClient.layer));
}

const libraryLayer = () => PlaylistCommands.layer.pipe(Layer.provideMerge(PlaylistEdits.layer), Layer.provideMerge(TestDatabase()));

/** An in-memory library database with playlist commands. */
export function createLibrary() {
  const runtime = ManagedRuntime.make(libraryLayer());
  return {
    runtime,
    run: <A, E>(effect: Effect.Effect<A, E, Layer.Success<ReturnType<typeof libraryLayer>>>) => runtime.runPromise(effect),
    /** The library's services, for layers that run against it. */
    layer: Layer.effectContext(runtime.contextEffect),
    dispose: () => runtime.dispose(),
  };
}

export type Library = ReturnType<typeof createLibrary>;

/** The library sync of `library` against `server`, as the app runs it. */
const librarySyncOf = (library: Library, server: TestServer) => ManagedRuntime.make(LibrarySync.layer.pipe(Layer.provide(Layer.mergeAll(library.layer, subsonicLayerFor(server), NoCoverFiles))));

/** Syncs `library` with `server` as the app does, and answers with the problem the sync reports. */
export async function syncLibrary(library: Library, server: TestServer): Promise<string | null> {
  const runtime = librarySyncOf(library, server);
  try {
    return await runtime.runPromise(
      LibrarySync.use((sync) =>
        sync.sync.pipe(
          Effect.andThen(sync.status),
          Effect.map(({ error }) => error),
        ),
      ),
    );
  } finally {
    await runtime.dispose();
  }
}

/** When `server` says it last scanned its files, as the sync settings ask it; `null` when it does not say. */
export async function lastScan(library: Library, server: TestServer): Promise<string | null> {
  const runtime = librarySyncOf(library, server);
  try {
    return await runtime.runPromise(LibrarySync.use((sync) => sync.lastScan));
  } finally {
    await runtime.dispose();
  }
}
