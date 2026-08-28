import { spawn, spawnSync } from "node:child_process";
import { rm } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import electronPath from "electron";
import { build, createServer } from "vite";

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const desktopDirectory = resolve(scriptDirectory, "..");
const outputDirectory = resolve(desktopDirectory, "out");
const rendererConfigPath = resolve(desktopDirectory, "vite.config.ts");
const mainConfigPath = resolve(desktopDirectory, "vite.main.config.ts");
const preloadConfigPath = resolve(desktopDirectory, "vite.preload.config.ts");

const buildStates = {
  main: { building: false, healthy: false, ready: false, succeeded: false },
  preload: { building: false, healthy: false, ready: false, succeeded: false },
};

let rendererServer;
let rendererUrl;
let mainWatcher;
let preloadWatcher;
let electronChild;
let electronStartedAt = 0;
let crashCount = 0;
let restartTimer;
let restartChain = Promise.resolve();
let shutdownPromise;
const intentionalStops = new WeakSet();

function isReady() {
  return Boolean(
    rendererUrl && buildStates.main.ready && buildStates.main.healthy && !buildStates.main.building && buildStates.preload.ready && buildStates.preload.healthy && !buildStates.preload.building,
  );
}

function signalElectron(child, signal) {
  if (!child.pid) return;

  try {
    child.kill(signal);
  } catch (error) {
    if (error?.code !== "ESRCH") throw error;
  }
}

async function stopElectron() {
  const child = electronChild;
  if (!child || child.exitCode !== null || child.signalCode !== null) return;

  intentionalStops.add(child);
  signalElectron(child, "SIGTERM");

  const exited = await new Promise((resolveExit) => {
    const timeout = setTimeout(() => resolveExit(false), 1_500);
    child.once("exit", () => {
      clearTimeout(timeout);
      resolveExit(true);
    });
  });

  if (exited) return;

  if (process.platform === "win32" && child.pid) {
    spawnSync("taskkill", ["/pid", String(child.pid), "/t", "/f"], { stdio: "ignore" });
  } else {
    signalElectron(child, "SIGKILL");
  }
}

function startElectron() {
  if (!rendererUrl) throw new Error("Renderer URL is unavailable");

  const childEnvironment = {
    ...process.env,
    ELECTRON_RENDERER_URL: rendererUrl,
    NODE_ENV: "development",
  };
  delete childEnvironment.ELECTRON_RUN_AS_NODE;

  const child = spawn(electronPath, [desktopDirectory], {
    cwd: desktopDirectory,
    env: childEnvironment,
    stdio: "inherit",
  });

  electronChild = child;
  electronStartedAt = Date.now();
  child.once("error", (error) => {
    console.error("[desktop] Electron failed to start", error);
  });
  child.once("exit", (code, signal) => {
    if (electronChild === child) electronChild = undefined;
    if (intentionalStops.delete(child) || shutdownPromise) return;

    if (code === 0 && signal === null) {
      void shutdown(0);
      return;
    }

    const runtime = Date.now() - electronStartedAt;
    crashCount = runtime >= 10_000 ? 0 : crashCount + 1;
    const restartDelay = Math.min(500 * 2 ** crashCount, 5_000);
    console.error(`[desktop] Electron exited unexpectedly (${signal ?? `code ${String(code)}`}); restarting in ${restartDelay}ms`);
    requestRestart(restartDelay);
  });
}

async function restartElectron() {
  if (!isReady() || shutdownPromise) return;
  await stopElectron();
  if (!shutdownPromise) startElectron();
}

function requestRestart(delay = 150) {
  if (!isReady() || shutdownPromise) return;
  if (restartTimer) clearTimeout(restartTimer);

  restartTimer = setTimeout(() => {
    restartTimer = undefined;
    restartChain = restartChain.then(restartElectron).catch((error) => {
      console.error("[desktop] Electron restart failed", error);
    });
  }, delay);
}

function handleBuildEvent(name, event) {
  const state = buildStates[name];

  switch (event.code) {
    case "START":
      state.building = true;
      state.healthy = false;
      state.succeeded = false;
      break;
    case "BUNDLE_END":
      state.succeeded = true;
      void event.result.close();
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
      console.error(`[desktop] ${name} build failed; keeping the current Electron process`, event.error);
      break;
  }
}

async function createBuildWatcher(name, configFile) {
  const watcher = await build({
    build: {
      emptyOutDir: false,
      watch: {},
    },
    configFile,
    mode: "development",
  });

  if (!("on" in watcher)) {
    throw new TypeError(`${name} build did not create a watcher`);
  }

  watcher.on("event", (event) => handleBuildEvent(name, event));
  return watcher;
}

async function shutdown(exitCode) {
  if (shutdownPromise) return shutdownPromise;

  shutdownPromise = (async () => {
    if (restartTimer) clearTimeout(restartTimer);
    await stopElectron();
    await Promise.allSettled([mainWatcher?.close(), preloadWatcher?.close(), rendererServer?.close()]);
    process.exitCode = exitCode;
  })();

  return shutdownPromise;
}

async function main() {
  await rm(outputDirectory, { force: true, recursive: true });

  rendererServer = await createServer({
    configFile: rendererConfigPath,
    mode: "development",
  });
  await rendererServer.listen();

  rendererUrl = rendererServer.resolvedUrls?.local[0];
  if (!rendererUrl) {
    throw new Error("Vite did not report a local renderer URL");
  }

  console.log(`[desktop] Renderer available at ${rendererUrl}`);
  [mainWatcher, preloadWatcher] = await Promise.all([createBuildWatcher("main", mainConfigPath), createBuildWatcher("preload", preloadConfigPath)]);
}

process.once("SIGINT", () => void shutdown(130));
process.once("SIGTERM", () => void shutdown(143));
process.once("SIGHUP", () => void shutdown(129));

main().catch(async (error) => {
  console.error("[desktop] Development startup failed", error);
  await shutdown(1);
});
