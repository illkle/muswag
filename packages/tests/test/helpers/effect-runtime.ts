import { NodeCrypto } from "@effect/platform-node";
import { PlaylistCommands, PlaylistEdits, SubsonicAPILive } from "@muswag/backend";
import { TestDatabase } from "@muswag/backend/testing";
import { Effect, Layer, ManagedRuntime } from "effect";
import { FetchHttpClient } from "effect/http";

export function subsonicLayerFor(connection: { baseUrl: string; username: string; password: string }) {
  return SubsonicAPILive({
    url: connection.baseUrl,
    auth: { username: connection.username, password: connection.password },
  }).pipe(Layer.provide(Layer.mergeAll(FetchHttpClient.layer, NodeCrypto.layer)));
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
