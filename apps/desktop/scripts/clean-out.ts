import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { NodeFileSystem, NodeRuntime } from "@effect/platform-node";
import { Effect, FileSystem } from "effect";

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const outputDirectory = resolve(scriptDirectory, "../out");

const cleanOutput = Effect.gen(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  yield* fileSystem.remove(outputDirectory, { force: true, recursive: true });
}).pipe(Effect.provide(NodeFileSystem.layer));

NodeRuntime.runMain(cleanOutput);
