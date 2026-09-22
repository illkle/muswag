import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { NodeServices } from "@effect/platform-node";
import { Cause, Deferred, Effect, Exit, FileSystem, Queue } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";
import { build, createServer, type ViteDevServer } from "vite";

import { loadEnvironmentFile, signalExitCode, stopChildProcess, waitForTerminationSignal } from "./process-lifecycle.ts";
import { RunnerError } from "./runner-error.ts";

type BuildName = "main" | "preload";

interface BuildState {
  building: boolean;
  healthy: boolean;
  ready: boolean;
  succeeded: boolean;
}

type BuildWatcherEvent =
  | { readonly code: "START" }
  | { readonly code: "BUNDLE_END"; readonly result: { close(): Promise<void> } }
  | { readonly code: "END" }
  | { readonly code: "ERROR"; readonly error: unknown };

interface BuildWatcher {
  close(): Promise<void>;
  on(event: "event", listener: (event: BuildWatcherEvent) => void): void;
}

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const desktopDirectory = resolve(scriptDirectory, "..");
const environmentFile = resolve(desktopDirectory, "../../.env");
const outputDirectory = resolve(desktopDirectory, "out");
const rendererConfigPath = resolve(desktopDirectory, "vite.config.ts");
const mainConfigPath = resolve(desktopDirectory, "vite.main.config.ts");
const preloadConfigPath = resolve(desktopDirectory, "vite.preload.config.ts");
const electronModule: unknown = createRequire(import.meta.url)("electron");

if (typeof electronModule !== "string") throw new TypeError("Electron did not resolve to its executable path");

function effectFromPromise<A>(description: string, operation: () => PromiseLike<A>): Effect.Effect<A, RunnerError> {
  return Effect.tryPromise({
    try: operation,
    catch: (cause) => new RunnerError({ message: description, cause }),
  });
}

const supervisor = Effect.scoped(
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const context = yield* Effect.context<NodeServices.NodeServices>();
    const runFork = Effect.runForkWith(context);
    const completion = yield* Deferred.make<void>();
    const restartQueue = yield* Queue.sliding<number>(1);

    yield* loadEnvironmentFile(environmentFile);

    const buildStates: Record<BuildName, BuildState> = {
      main: { building: false, healthy: false, ready: false, succeeded: false },
      preload: { building: false, healthy: false, ready: false, succeeded: false },
    };

    let rendererUrl: string | undefined;
    let electronChild: ChildProcessSpawner.ChildProcessHandle | undefined;
    let electronStartedAt = 0;
    let crashCount = 0;
    let shuttingDown = false;
    const activeElectronHandles = new Set<ChildProcessSpawner.ChildProcessHandle>();
    const intentionalStops = new WeakSet<ChildProcessSpawner.ChildProcessHandle>();

    const isReady = (): boolean =>
      Boolean(
        rendererUrl && buildStates.main.ready && buildStates.main.healthy && !buildStates.main.building && buildStates.preload.ready && buildStates.preload.healthy && !buildStates.preload.building,
      );

    const requestRestart = (delay = 150): void => {
      if (isReady() && !shuttingDown) Queue.offerUnsafe(restartQueue, delay);
    };

    const stopElectron = Effect.gen(function* () {
      const handle = electronChild;
      if (!handle) return;

      intentionalStops.add(handle);
      yield* stopChildProcess(handle, "Electron");
    });

    const stopAllElectronProcesses = Effect.suspend(() => Effect.forEach(activeElectronHandles, (handle) => stopChildProcess(handle, "Electron"), { discard: true }));

    const runElectron = (): Effect.Effect<void, never, NodeServices.NodeServices> => {
      let handle: ChildProcessSpawner.ChildProcessHandle | undefined;
      const childEnvironment: Record<string, string | undefined> = {
        ...process.env,
        ELECTRON_RENDERER_URL: rendererUrl,
        NODE_ENV: "development",
      };
      delete childEnvironment.ELECTRON_RUN_AS_NODE;

      const command = ChildProcess.make(electronModule, [desktopDirectory], {
        cwd: desktopDirectory,
        detached: false,
        env: childEnvironment,
        stderr: "inherit",
        stdin: "inherit",
        stdout: "inherit",
      });

      const lifecycle = Effect.scoped(
        Effect.gen(function* () {
          handle = yield* command;
          electronChild = handle;
          activeElectronHandles.add(handle);
          electronStartedAt = Date.now();
          return yield* handle.exitCode;
        }),
      );

      return Effect.exit(lifecycle).pipe(
        Effect.flatMap((exit) =>
          Effect.sync(() => {
            const interrupted = Exit.isFailure(exit) && Cause.hasInterruptsOnly(exit.cause);
            if (handle && !interrupted) activeElectronHandles.delete(handle);
            if (handle && electronChild === handle) electronChild = undefined;
            if ((handle && intentionalStops.delete(handle)) || shuttingDown) return;

            if (Exit.isSuccess(exit) && exit.value === 0) {
              Deferred.doneUnsafe(completion, Effect.void);
              return;
            }

            const runtime = Date.now() - electronStartedAt;
            crashCount = runtime >= 10_000 ? 0 : crashCount + 1;
            const restartDelay = Math.min(500 * 2 ** crashCount, 5_000);
            const reason = Exit.isSuccess(exit) ? `code ${exit.value}` : Cause.pretty(exit.cause);
            console.error(`[desktop] Electron exited unexpectedly (${reason}); restarting in ${restartDelay}ms`);
            requestRestart(restartDelay);
          }),
        ),
      );
    };

    const restartElectron = Effect.gen(function* () {
      if (!isReady() || shuttingDown) return;
      yield* stopElectron;
      if (!shuttingDown) yield* runElectron().pipe(Effect.forkScoped);
    });

    const restartWorker = Effect.forever(
      Effect.gen(function* () {
        const delay = yield* Queue.take(restartQueue);
        yield* Effect.sleep(delay);
        yield* Queue.poll(restartQueue);
        yield* restartElectron;
      }).pipe(Effect.catchCause((cause) => Effect.logError("Electron restart failed", cause))),
    );
    yield* restartWorker.pipe(Effect.forkScoped);

    const handleBuildEvent = (name: BuildName, event: BuildWatcherEvent): void => {
      const state = buildStates[name];

      switch (event.code) {
        case "START":
          state.building = true;
          state.healthy = false;
          state.succeeded = false;
          break;
        case "BUNDLE_END":
          state.succeeded = true;
          runFork(effectFromPromise(`Failed to close the ${name} bundle result`, () => event.result.close()).pipe(Effect.catchCause((cause) => Effect.logWarning(cause))));
          break;
        case "END":
          state.building = false;
          if (state.succeeded) {
            state.healthy = true;
            state.ready = true;
            requestRestart();
          }
          break;
        case "ERROR":
          state.building = false;
          state.healthy = false;
          state.succeeded = false;
          runFork(Effect.logError(`[desktop] ${name} build failed; keeping the current Electron process`, event.error));
          break;
      }
    };

    const createBuildWatcher = (name: BuildName, configFile: string): Effect.Effect<BuildWatcher, RunnerError> =>
      effectFromPromise(`Failed to create the ${name} build watcher`, () =>
        build({
          build: {
            emptyOutDir: false,
            watch: {},
          },
          configFile,
          mode: "development",
        }),
      ).pipe(
        Effect.flatMap((watcher) => {
          if (!("on" in watcher)) {
            return new RunnerError({ message: `${name} build did not create a watcher`, cause: watcher });
          }

          const buildWatcher = watcher as BuildWatcher;
          buildWatcher.on("event", (event) => handleBuildEvent(name, event));
          return Effect.succeed(buildWatcher);
        }),
      );

    const acquireBuildWatcher = (name: BuildName, configFile: string) =>
      Effect.acquireRelease(createBuildWatcher(name, configFile), (watcher) =>
        effectFromPromise(`Failed to close the ${name} build watcher`, () => watcher.close()).pipe(Effect.catchCause((cause) => Effect.logWarning(cause))),
      );

    yield* fileSystem.remove(outputDirectory, { force: true, recursive: true });

    const rendererServer: ViteDevServer = yield* Effect.acquireRelease(
      effectFromPromise("Failed to create the renderer development server", () =>
        createServer({
          configFile: rendererConfigPath,
          mode: "development",
        }),
      ),
      (server) => effectFromPromise("Failed to close the renderer development server", () => server.close()).pipe(Effect.catchCause((cause) => Effect.logWarning(cause))),
    );
    yield* effectFromPromise("Failed to start the renderer development server", () => rendererServer.listen());

    rendererUrl = rendererServer.resolvedUrls?.local[0];
    if (!rendererUrl) {
      return yield* new RunnerError({ message: "Vite did not report a local renderer URL", cause: undefined });
    }
    yield* Effect.log(`[desktop] Renderer available at ${rendererUrl}`);

    yield* Effect.all([acquireBuildWatcher("main", mainConfigPath), acquireBuildWatcher("preload", preloadConfigPath)], { concurrency: "unbounded" });

    yield* Effect.addFinalizer(() =>
      Effect.gen(function* () {
        shuttingDown = true;
        yield* stopAllElectronProcesses;
      }),
    );

    const exitCode = yield* Effect.raceFirst(Deferred.await(completion).pipe(Effect.as(0)), waitForTerminationSignal.pipe(Effect.map(signalExitCode)));
    shuttingDown = true;
    yield* stopAllElectronProcesses;
    return exitCode;
  }),
);

process.exitCode = await Effect.runPromise(supervisor.pipe(Effect.provide(NodeServices.layer)));
