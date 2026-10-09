import { randomBytes } from "node:crypto";

import { PlaylistCommands, PlaylistEdits, subsonicToken } from "@muswag/backend";
import { SubsonicAPILive, TestDatabase } from "@muswag/backend/testing";
import { Effect, Layer, ManagedRuntime } from "effect";
import { FetchHttpClient } from "effect/http";

export function subsonicLayerFor(connection: { baseUrl: string; username: string; password: string }) {
  const salt = randomBytes(16).toString("hex");
  return SubsonicAPILive({
    url: connection.baseUrl,
    auth: { username: connection.username, salt, token: subsonicToken(connection.password, salt) },
  }).pipe(Layer.provide(FetchHttpClient.layer));
}

const libraryLayer = () => PlaylistCommands.layer.pipe(Layer.provideMerge(PlaylistEdits.layer), Layer.provideMerge(TestDatabase()));

/** An in-memory library database with playlist commands, outliving any one server connection. */
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
