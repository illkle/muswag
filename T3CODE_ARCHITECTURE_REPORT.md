# T3 Code architecture report

## 1. Research snapshot

- **Repository:** [`pingdotgg/t3code`](https://github.com/pingdotgg/t3code)
- **Inspected commit:** [`e2d4d12a81516b55abbecdc64794971f781cacd8`](https://github.com/pingdotgg/t3code/commit/e2d4d12a81516b55abbecdc64794971f781cacd8)
- **Commit date:** 2026-08-27 12:58:21 -0700
- **Inspection date:** 2026-08-28

The report describes the repository at that commit, not the moving `main` branch. The source tree, package manifests, Vite/Vite+ and Metro configuration, development and release scripts, workflows, tests, internal documentation, and focused history were inspected locally. Official tool documentation is used only where configuration alone does not define a tool's behavior.

Evidence labels used below are:

- **Observed** — directly present in the pinned tree.
- **Supported conclusion** — follows from two or more observed facts.
- **Inference** — a likely runtime consequence that is not itself tested or documented by T3 Code.

No packaged applications were built or signed. Platform behavior is therefore established from configuration, scripts, tests, and workflows rather than a fresh end-to-end release run. GitHub issues and pull requests were used sparingly; the pinned tree and its commit history remain the primary evidence.

## 2. Executive summary

T3 Code is a pnpm workspace whose architectural center is a server execution boundary. Web, desktop, and mobile clients share contracts and a non-visual client runtime; agent processes, terminals, Git, and filesystem access stay behind the server. This division is stated in the [internal overview](https://github.com/pingdotgg/t3code/blob/e2d4d12a81516b55abbecdc64794971f781cacd8/docs/internals/overview.md) and is reflected in the package dependencies.

The desktop application is not a self-contained Electron renderer build. Electron main and four preloads are bundled by Vite+'s `pack` facility, while the renderer is the same `apps/web` Vite application used by the browser client. In development, a root runner assigns ports and environment, Vite+ starts the selected workspace tasks, a successful initial Electron bundle triggers a dedicated Electron supervisor, and that supervisor waits for the Electron files, server bundle, and renderer TCP port. Renderer edits use Vite HMR; emitted main, preload, or server-file changes cause a whole Electron restart. The relevant implementation is split across [`scripts/dev-runner.ts`](https://github.com/pingdotgg/t3code/blob/e2d4d12a81516b55abbecdc64794971f781cacd8/scripts/dev-runner.ts), [`apps/desktop/vite.config.ts`](https://github.com/pingdotgg/t3code/blob/e2d4d12a81516b55abbecdc64794971f781cacd8/apps/desktop/vite.config.ts), and [`apps/desktop/scripts/dev-electron.mjs`](https://github.com/pingdotgg/t3code/blob/e2d4d12a81516b55abbecdc64794971f781cacd8/apps/desktop/scripts/dev-electron.mjs).

Production packaging is substantially more specialized than the development loop. A custom artifact builder stages an application, synthesizes a production manifest, installs only selected runtime dependencies, checks bundle/external consistency, handles native-module closures and a Windows server sidecar, and invokes electron-builder. That machinery is product-specific and should not be mistaken for a baseline Electron/Vite setup. See [`scripts/build-desktop-artifact.ts`](https://github.com/pingdotgg/t3code/blob/e2d4d12a81516b55abbecdc64794971f781cacd8/scripts/build-desktop-artifact.ts) and the shared external list in [`scripts/lib/cli-external-packages.ts`](https://github.com/pingdotgg/t3code/blob/e2d4d12a81516b55abbecdc64794971f781cacd8/scripts/lib/cli-external-packages.ts).

Internal packages such as `contracts`, `shared`, and `client-runtime` export raw TypeScript source. Applications transpile that source themselves through Vite, Vite+ pack, Metro, or the server bundle. TypeScript follows the same workspace symlinks and package exports; there is no general internal-package path-alias layer and no prebuild requirement for these packages. This is convenient for live source consumption, but T3 Code does not preserve a separately emitted package boundary for those packages.

Mobile is an Expo application, not a plain bare React Native app. Its Metro configuration starts from Expo defaults, watches the workspace root, blocks per-worktree `.t3` state, and adds one Shiki-resolution override. It does not configure `enableGlobalPackages`, custom package-export conditions, `nodeModulesPaths`, or React deduplication. Raw TypeScript reaches Metro through normal workspace links and package exports.

Vite+ is more than a task runner in this repository: it supplies Vite/Vitest, pack, formatting, linting, and task execution. However, the most important desktop and server build tasks explicitly disable task caching, and the custom development runner owns the product-specific behavior. The June 2026 migration commit, [`b440dd1812a7fdc2cf569941328d2368ac0169b7`](https://github.com/pingdotgg/t3code/commit/b440dd1812a7fdc2cf569941328d2368ac0169b7), replaced Turbo, Bun-oriented commands, standalone tsdown configuration, and separate lint/format configuration in one broad tooling change. That history does not establish Vite+ as necessary for Electron orchestration.

## 3. Repository topology

The workspace roots are declared in [`pnpm-workspace.yaml`](https://github.com/pingdotgg/t3code/blob/e2d4d12a81516b55abbecdc64794971f781cacd8/pnpm-workspace.yaml#L1-L6): `apps/*`, `infra/*`, `packages/*`, the internal Oxlint plugin, and `scripts`.

```text
                         @t3tools/contracts
                         (RPC/data schemas; source exports)
                         ▲       ▲       ▲
                         │       │       │
                 @t3tools/shared │  @t3tools/client-runtime
               (utilities; source)│  (client state/RPC; source)
                         ▲        │       ▲
              ┌──────────┼────────┘       │
              │          │                │
        apps/server   apps/web ◄──────────┼──── apps/mobile (Expo/Metro)
        (`t3` CLI)      (React/Vite)       │
              ▲             ▲             │
              │ server      │ renderer    │
              └──── apps/desktop (Electron main/preloads)

Additional reusable edges:
desktop -> ssh, tailscale; server -> tailscale, web, effect adapters;
ssh -> contracts + shared; tailscale -> shared.
```

This is the dependency graph relevant to the client/server boundary, reconstructed from the pinned manifests for [`desktop`](https://github.com/pingdotgg/t3code/blob/e2d4d12a81516b55abbecdc64794971f781cacd8/apps/desktop/package.json), [`web`](https://github.com/pingdotgg/t3code/blob/e2d4d12a81516b55abbecdc64794971f781cacd8/apps/web/package.json), [`mobile`](https://github.com/pingdotgg/t3code/blob/e2d4d12a81516b55abbecdc64794971f781cacd8/apps/mobile/package.json), [`server`](https://github.com/pingdotgg/t3code/blob/e2d4d12a81516b55abbecdc64794971f781cacd8/apps/server/package.json), [`client-runtime`](https://github.com/pingdotgg/t3code/blob/e2d4d12a81516b55abbecdc64794971f781cacd8/packages/client-runtime/package.json), [`contracts`](https://github.com/pingdotgg/t3code/blob/e2d4d12a81516b55abbecdc64794971f781cacd8/packages/contracts/package.json), and [`shared`](https://github.com/pingdotgg/t3code/blob/e2d4d12a81516b55abbecdc64794971f781cacd8/packages/shared/package.json).

| Workspace | Runtime role | Relevant internal dependencies | Consumption/build mode |
| --- | --- | --- | --- |
| `apps/web` | React client and desktop renderer | contracts, shared, client-runtime | Vite bundles their source exports |
| `apps/mobile` | Expo/React Native client | contracts, shared, client-runtime | Metro transpiles their source exports |
| `apps/desktop` | Electron host and preloads | contracts, shared, client-runtime, ssh, tailscale | Vite+ pack bundles all `@t3tools/*`; uses web as renderer |
| `apps/server` (`t3`) | execution boundary and product server | contracts, shared, tailscale, web, agent adapters | Vite+ pack bundles most JS; web output is embedded |
| `packages/contracts` | Effect RPC/data contracts | Effect | source exports; no package build |
| `packages/shared` | cross-workspace utilities, including some Node-only subpaths | contracts | source subpath exports; no package build |
| `packages/client-runtime` | non-visual client connection/state runtime | contracts, shared | source subpath exports; no package build |

**Supported conclusion:** desktop, web, and mobile share client logic, but not an identical application shell. Desktop reuses the web build; mobile has a separate view tree and composes the same client-runtime contracts. This agrees with the [overview's client-runtime description](https://github.com/pingdotgg/t3code/blob/e2d4d12a81516b55abbecdc64794971f781cacd8/docs/internals/overview.md#L51-L57) and the [workspace-layout document](https://github.com/pingdotgg/t3code/blob/e2d4d12a81516b55abbecdc64794971f781cacd8/docs/internals/workspace-layout.md).

## 4. Root tooling and command model

The root [`package.json`](https://github.com/pingdotgg/t3code/blob/e2d4d12a81516b55abbecdc64794971f781cacd8/package.json#L5-L46) assigns four kinds of responsibility:

1. pnpm defines and installs the workspace, centralizes catalog versions, allows selected install scripts, applies patches, and links internal `workspace:*` dependencies.
2. Vite+ supplies `vp run`, `vp pack`, `vp test`, `vp lint`, `vp fmt`, and `vp check`. The root [`vite.config.ts`](https://github.com/pingdotgg/t3code/blob/e2d4d12a81516b55abbecdc64794971f781cacd8/vite.config.ts) centralizes test defaults, lint rules, formatting, and the web `~` alias.
3. Per-workspace `vite.config.ts` files define Vite+ run tasks and, where needed, bundling or dev-server configuration.
4. Root TypeScript scripts implement product workflows that are not generic task execution: development modes, deterministic per-worktree ports and state, shared access, artifact staging, release metadata, and smoke checks.

`vp run -r` is used for recursive typecheck and test. Typechecking caps concurrency at two. Build uses explicit app/package filters rather than an unqualified recursive call. Development modes pass `--parallel`, because the selected persistent servers must coexist rather than wait on a dependency graph. These command choices are visible in the [root scripts](https://github.com/pingdotgg/t3code/blob/e2d4d12a81516b55abbecdc64794971f781cacd8/package.json#L21-L34) and the runner's [mode definitions](https://github.com/pingdotgg/t3code/blob/e2d4d12a81516b55abbecdc64794971f781cacd8/scripts/dev-runner.ts).

According to the official [`vp run` documentation](https://viteplus.dev/guide/run), recursive execution follows workspace package relationships, filters use pnpm-like syntax, ordinary tasks honor dependencies, and `--parallel` ignores task dependencies. Vite+ defaults to limited concurrency and propagates task failures. T3 Code overrides those defaults only where its commands show it doing so.

## 5. Electron development lifecycle

### Build and watch ownership

**Observed:** Electron main and preload code are not started through Vite CLI subprocesses or electron-vite. The desktop [`vite.config.ts`](https://github.com/pingdotgg/t3code/blob/e2d4d12a81516b55abbecdc64794971f781cacd8/apps/desktop/vite.config.ts) defines four CommonJS `pack` outputs in `dist-electron`: main, the normal preload, an element-picker preload, and a picture-in-picture preload. All enable source-map emission. The main bundle's `deps.alwaysBundle` predicate includes every `@t3tools/*` import; the normal preload deliberately bundles Clerk's Electron package because its comment records sandbox/ASAR constraints.

No T3 Code desktop script imports Vite's JavaScript `createServer`/`build` API, and there is no custom Electron Vite plugin. The root runner spawns the Vite+ CLI once; Vite+ reads the desktop pack config, while the web package's [`dev` script](https://github.com/pingdotgg/t3code/blob/e2d4d12a81516b55abbecdc64794971f781cacd8/apps/web/package.json#L6-L12) is `vp dev`. Thus the actual mechanism is Vite+ CLI task/process orchestration plus Vite+ pack and a normal Vite dev server.

The same config declares:

- `build`: build desktop CSS, then `vp pack`, after `t3#build`;
- `dev`: build CSS, then `vp pack --watch`, after `t3#build`;
- `dev:bundle`: pack watch without the server prerequisite;
- `dev:electron`: run the Electron supervisor, also after `t3#build`.

The main pack's development-only `onSuccess` hook launches [`dev-electron.mjs`](https://github.com/pingdotgg/t3code/blob/e2d4d12a81516b55abbecdc64794971f781cacd8/apps/desktop/scripts/dev-electron.mjs). This gives the first successful main pack—not a timer—the authority to start the supervisor. Vite+ 0.2.2's pack implementation also aborts the previous `onSuccess` process when a watched main input changes and starts a new one after a successful rebuild; this makes the hook part of the later main-process lifecycle, not just initial readiness.

The renderer is [`apps/web`](https://github.com/pingdotgg/t3code/blob/e2d4d12a81516b55abbecdc64794971f781cacd8/apps/web/vite.config.ts), an ordinary Vite development server. Consequently, renderer edits receive Vite HMR; Electron main/preload edits do not.

### Startup, rebuild, and shutdown sequence

```text
developer
  │ pnpm dev:desktop
  ▼
scripts/dev-runner.ts
  │ choose worktree-stable server/web ports and T3CODE_HOME
  │ set VITE_DEV_SERVER_URL, VITE_HTTP_URL, VITE_WS_URL, T3CODE_PORT
  │ spawn one inherited-stdio `vp run ... --parallel dev` child
  ├─────────────────────────────┐
  ▼                             ▼
desktop `vp pack --watch`       web Vite dev server
  │ initial successful pack       │ renderer URL/HMR
  ▼                               │
dev-electron.mjs                  │
  │ wait for main.cjs, preload.cjs, server dist/bin.mjs,
  │ and a TCP connection to the web port
  ▼
Electron process ───────────────► custom t3code-dev:// URL proxies to Vite
  │
  ├─ renderer edit: Vite HMR; Electron remains alive
  ├─ main input edit: pack replaces its onSuccess supervisor after a successful rebuild
  ├─ preload/other watched output: supervisor debounces, stops process tree, restarts
  ├─ server dist/bin.mjs edit: same whole-app restart
  ├─ abnormal exit/spawn error: schedule restart
  └─ SIGINT/SIGTERM/SIGHUP: close watchers, TERM tree, then KILL after timeout
```

The root runner owns environment and topology, not bundling. It derives deterministic offsets from the worktree, avoids occupied and browser-blocked ports, isolates development home state, configures optional Tailscale sharing, removes stale inherited variables, and starts one Vite+ child with inherited stdio. Its process wrapper forwards shutdown and applies a 1.5-second forced-kill timeout; non-zero completion is surfaced as a structured runner failure. All of this is in [`scripts/dev-runner.ts`](https://github.com/pingdotgg/t3code/blob/e2d4d12a81516b55abbecdc64794971f781cacd8/scripts/dev-runner.ts) and covered by [`scripts/dev-runner.test.ts`](https://github.com/pingdotgg/t3code/blob/e2d4d12a81516b55abbecdc64794971f781cacd8/scripts/dev-runner.test.ts).

The Electron supervisor owns resource readiness, process restart, and watcher cleanup. [`wait-for-resources.mjs`](https://github.com/pingdotgg/t3code/blob/e2d4d12a81516b55abbecdc64794971f781cacd8/apps/desktop/scripts/wait-for-resources.mjs) polls required files and the renderer TCP port, normally every 100 ms, with a 120-second timeout. [`dev-electron.mjs`](https://github.com/pingdotgg/t3code/blob/e2d4d12a81516b55abbecdc64794971f781cacd8/apps/desktop/scripts/dev-electron.mjs) debounces watched-file changes for 120 ms and serializes restart requests. It terminates the direct child and descendants; on Windows, descendant discovery and the extra stale-process sweep are intentionally no-ops, so cleanup is less comprehensive there.

The actual spawn path has another T3-specific layer. [`ensure-electron-runtime.mjs`](https://github.com/pingdotgg/t3code/blob/e2d4d12a81516b55abbecdc64794971f781cacd8/apps/desktop/scripts/ensure-electron-runtime.mjs) verifies the installed Electron executable/framework, repairs `path.txt`, and downloads the exact Electron release archive if the runtime is missing or invalid. [`electron-launcher.mjs`](https://github.com/pingdotgg/t3code/blob/e2d4d12a81516b55abbecdc64794971f781cacd8/apps/desktop/scripts/electron-launcher.mjs) resolves that runtime, builds/registers a branded development `.app` and protocol client on macOS, and adds Linux `--no-sandbox` only when the local setuid sandbox is not correctly installed. [`start-electron.mjs`](https://github.com/pingdotgg/t3code/blob/e2d4d12a81516b55abbecdc64794971f781cacd8/apps/desktop/scripts/start-electron.mjs) is the simpler one-shot launcher used by the desktop `start` script after a build.

**Observed failure behavior:** a failed pack leaves the pack watcher running and prints its error, but behavior differs by entry. On a changed main input, Vite+ pack aborts the existing `onSuccess` command before rebuilding; that kills the supervisor/Electron tree, and a failed rebuild does not relaunch it until a later success. A failed preload/auxiliary-preload rebuild does not create a new emitted-file event, so the existing supervisor and Electron process normally remain alive with the previous output. Renderer errors stay in Vite's HMR/error path. An Electron spawn error, signal, or abnormal exit schedules another launch; a normal exit code zero does not. There is no exponential crash backoff beyond the restart debounce. The Electron-side choices are implemented in [`dev-electron.mjs`](https://github.com/pingdotgg/t3code/blob/e2d4d12a81516b55abbecdc64794971f781cacd8/apps/desktop/scripts/dev-electron.mjs); related launcher path and environment construction is tested separately in [`electron-launcher.test.mjs`](https://github.com/pingdotgg/t3code/blob/e2d4d12a81516b55abbecdc64794971f781cacd8/apps/desktop/scripts/electron-launcher.test.mjs). The pack-hook conclusion comes from the exact [`@voidzero-dev/vite-plus-core@0.2.2` implementation](https://unpkg.com/@voidzero-dev/vite-plus-core@0.2.2/dist/tsdown/build-B_nvJe4A-CcOht0gr.js) selected by [`pnpm-workspace.yaml`](https://github.com/pingdotgg/t3code/blob/e2d4d12a81516b55abbecdc64794971f781cacd8/pnpm-workspace.yaml#L47-L53), not from T3 Code application tests.

### URL selection and debugging

T3 Code does not select between Electron `loadURL` and `loadFile`. [`DesktopWindow.ts`](https://github.com/pingdotgg/t3code/blob/e2d4d12a81516b55abbecdc64794971f781cacd8/apps/desktop/src/window/DesktopWindow.ts) always loads a custom URL: `t3code-dev://app/` in development and `t3code://app/` in production. [`DesktopApp.ts`](https://github.com/pingdotgg/t3code/blob/e2d4d12a81516b55abbecdc64794971f781cacd8/apps/desktop/src/app/DesktopApp.ts) chooses the protocol's target origin: the Vite development URL in development and the local product server in production. [`ElectronProtocol.ts`](https://github.com/pingdotgg/t3code/blob/e2d4d12a81516b55abbecdc64794971f781cacd8/apps/desktop/src/electron/ElectronProtocol.ts) registers the privileged schemes, proxies requests with Electron `net.fetch`, and adds the CSP. Window load failures are retried with backoff, while renderer crashes and out-of-memory exits have bounded reload handling in [`DesktopWindow.ts`](https://github.com/pingdotgg/t3code/blob/e2d4d12a81516b55abbecdc64794971f781cacd8/apps/desktop/src/window/DesktopWindow.ts).

Development opens detached renderer DevTools. An optional environment variable enables Electron's remote-debugging port in the launcher. Main/preload pack and server pack all emit source maps; the web build emits source maps by default, with environment-controlled `false` or `hidden` modes in [`apps/web/vite.config.ts`](https://github.com/pingdotgg/t3code/blob/e2d4d12a81516b55abbecdc64794971f781cacd8/apps/web/vite.config.ts). **Limitation:** the launcher does not explicitly enable Node source-map stack processing, so the presence of `.map` files should not be read as proof that every main-process stack trace is mapped.

No Electron-specific Node or Chromium target is derived. Electron bundles use the packer's CommonJS/Node platform defaults, and the desktop package declares no `engines.node` target. The web renderer has no explicit Vite `build.target`, so it uses Vite's default browser target. The relevant general behavior is documented by [Vite's build target reference](https://v8.vite.dev/config/build-options), [tsdown's platform reference](https://tsdown.dev/options/platform), and [tsdown's target reference](https://tsdown.dev/options/target). This is a tool-default dependency, not an explicit T3 Code compatibility policy.

## 6. Electron production build and packaging

### Produced artifacts and bundle boundary

`vp run build:desktop` selects desktop and server. Desktop build emits Electron main/preloads; server build first depends on web build and then packs the server CLI. The server build script also embeds `apps/web/dist` under `apps/server/dist/client`, which is why production can serve the same web client through the local server. Evidence is in the desktop and server [`vite.config.ts`](https://github.com/pingdotgg/t3code/blob/e2d4d12a81516b55abbecdc64794971f781cacd8/apps/desktop/vite.config.ts) files and [`apps/server/scripts/cli.ts`](https://github.com/pingdotgg/t3code/blob/e2d4d12a81516b55abbecdc64794971f781cacd8/apps/server/scripts/cli.ts).

Desktop main explicitly bundles all internal `@t3tools/*` workspaces. Ordinary declared third-party dependencies remain external under the packer's policy, while the normal preload explicitly bundles `@clerk/electron`. The server takes the opposite, mostly self-contained approach: it bundles dependencies except Node built-ins, native/native-loader dependency closures, and Bun-only adapters. [`scripts/lib/cli-external-packages.ts`](https://github.com/pingdotgg/t3code/blob/e2d4d12a81516b55abbecdc64794971f781cacd8/scripts/lib/cli-external-packages.ts#L1-L101) is deliberately shared by the bundle config and artifact staging so an external cannot silently disappear from the packaged filesystem.

### Staging and guarantees

[`scripts/build-desktop-artifact.ts`](https://github.com/pingdotgg/t3code/blob/e2d4d12a81516b55abbecdc64794971f781cacd8/scripts/build-desktop-artifact.ts) is the packaging authority. It:

- runs the desktop/server build unless explicitly skipped;
- verifies expected Electron, server, renderer, and resource outputs;
- scans server chunks to detect forbidden inlining and also verifies a sentinel package was actually bundled;
- creates a temporary staging application and generated production `package.json`/workspace configuration;
- selects declared desktop runtime dependencies plus the server's external runtime closure;
- runs a production-only Vite+/pnpm install inside the stage;
- invokes electron-builder with publishing disabled, then copies validated artifacts to the release directory;
- packs into ASAR while allowing native modules to be smart-unpacked;
- applies extra Windows checks for server self-containment and native loading.

This is stronger than merely declaring electron-builder `files`: the build inspects emitted code and tests both sides of the bundled/external boundary. Electron is present as a staging development dependency for electron-builder but excluded from application runtime dependency selection. Node built-ins are never staged.

Windows receives special treatment. The server is a separate ASAR/native payload, and the build extracts a Linux server sidecar for WSL, including the appropriate `node-pty` prebuild. macOS and Linux place the built server with the application in the simpler path. These branches and their validation are specific to T3 Code's ability to run execution backends across Windows and WSL, not inherent Electron requirements.

### Platforms, signing, notarization, and updates

The generated electron-builder configuration inside [`scripts/build-desktop-artifact.ts`](https://github.com/pingdotgg/t3code/blob/e2d4d12a81516b55abbecdc64794971f781cacd8/scripts/build-desktop-artifact.ts) defines DMG/ZIP for macOS, AppImage for Linux, and NSIS for Windows, with architecture-dependent artifact names and GitHub update metadata. The artifact script understands macOS `arm64`, `x64`, and `universal`, Linux `x64`/`arm64`, and Windows `x64`/`arm64`, although the pinned release workflow does not enable every theoretical combination.

The [release workflow](https://github.com/pingdotgg/t3code/blob/e2d4d12a81516b55abbecdc64794971f781cacd8/.github/workflows/release.yml) runs quality gates, then builds macOS arm64/x64, Linux x64, and Windows x64 artifacts. Signing is conditional: macOS uses a custom batched signer in [`scripts/sign-macos.ts`](https://github.com/pingdotgg/t3code/blob/e2d4d12a81516b55abbecdc64794971f781cacd8/scripts/sign-macos.ts), electron-builder receives Apple notarization credentials when available, and Windows can use Azure Trusted Signing. Missing release credentials can produce explicitly unsigned artifacts rather than an automatic hard failure. Update manifests are collected and, where needed, merged across macOS architectures before GitHub publication.

[`apps/desktop/scripts/smoke-test.mjs`](https://github.com/pingdotgg/t3code/blob/e2d4d12a81516b55abbecdc64794971f781cacd8/apps/desktop/scripts/smoke-test.mjs) can launch the built main entry briefly and scan output for fatal patterns. **Observed limitation:** it is exposed as `test:desktop-smoke`, but the pinned CI/release workflows do not run a packaged-executable end-to-end smoke test. The release “smoke” command checks release/version/update-manifest logic in [`scripts/release-smoke.ts`](https://github.com/pingdotgg/t3code/blob/e2d4d12a81516b55abbecdc64794971f781cacd8/scripts/release-smoke.ts), which is a different scope.

Development and packaging resolve workspace source consistently at bundle time because the Electron and server bundlers inline internal packages from their raw exports. Runtime resolution differs: the packaged application loads emitted bundles plus the explicitly staged external dependency set; it does not resolve workspace symlinks.

## 7. Shared package and source-resolution model

### What exposes source

The key internal packages expose source rather than `dist`:

- [`packages/contracts/package.json`](https://github.com/pingdotgg/t3code/blob/e2d4d12a81516b55abbecdc64794971f781cacd8/packages/contracts/package.json) maps root and named subpaths to `src/*.ts`.
- [`packages/shared/package.json`](https://github.com/pingdotgg/t3code/blob/e2d4d12a81516b55abbecdc64794971f781cacd8/packages/shared/package.json) maps many explicit subpaths to `src/*.ts` and intentionally has no root export.
- [`packages/client-runtime/package.json`](https://github.com/pingdotgg/t3code/blob/e2d4d12a81516b55abbecdc64794971f781cacd8/packages/client-runtime/package.json) maps feature subpaths to source and has no root export.
- [`packages/ssh/package.json`](https://github.com/pingdotgg/t3code/blob/e2d4d12a81516b55abbecdc64794971f781cacd8/packages/ssh/package.json) and [`packages/tailscale/package.json`](https://github.com/pingdotgg/t3code/blob/e2d4d12a81516b55abbecdc64794971f781cacd8/packages/tailscale/package.json) likewise expose source.

Their manifests provide `typecheck` and `test`, but no `build` output. The [scripts documentation](https://github.com/pingdotgg/t3code/blob/e2d4d12a81516b55abbecdc64794971f781cacd8/docs/internals/scripts.md) explicitly says shared packages are consumed and bundled transitively rather than built separately.

### Resolution consistency

Applications import package names and explicit subpaths through pnpm workspace symlinks. Runtime-capable bundlers then follow the `exports` target to TypeScript source. TypeScript's NodeNext/bundler-compatible resolution follows the same package manifests; root configuration does not map internal package names through `paths`. The only broad root alias is `~` to web source, and web enables Vite's `resolve.tsconfigPaths`. See the [root Vite config](https://github.com/pingdotgg/t3code/blob/e2d4d12a81516b55abbecdc64794971f781cacd8/vite.config.ts#L5-L10), [base TypeScript config](https://github.com/pingdotgg/t3code/blob/e2d4d12a81516b55abbecdc64794971f781cacd8/tsconfig.base.json), and application TypeScript configs.

There are no custom source conditions and no internal `react-native` condition. The ordinary `import`/`default` target is raw TypeScript. Subpath exports serve as the encapsulation mechanism: clients cannot import undeclared paths, and the missing `shared`/`client-runtime` root barrels make dependency selection explicit. A root lint restriction further rejects the nonexistent client-runtime root import in [`vite.config.ts`](https://github.com/pingdotgg/t3code/blob/e2d4d12a81516b55abbecdc64794971f781cacd8/vite.config.ts#L102-L110).

Changes propagate through the consuming tool: Vite watches the linked source graph, Metro watches the workspace root, and Vite+ pack watches the desktop graph. There is no upstream `dist` watcher to coordinate.

### Boundaries and singleton dependencies

T3 Code's shared package is not uniformly platform-neutral. Its explicit exports include general data utilities alongside Node-oriented modules such as `Net`, `shell`, `hostProcess`, logging, and development helpers. Safety comes from narrow subpath imports and higher-level capability boundaries, not from the package name alone. The client-runtime defines platform contracts in its [`platform` subpath](https://github.com/pingdotgg/t3code/blob/e2d4d12a81516b55abbecdc64794971f781cacd8/packages/client-runtime/package.json#L38-L41); web and mobile provide different implementations in [`apps/web/src/connection/platform.ts`](https://github.com/pingdotgg/t3code/blob/e2d4d12a81516b55abbecdc64794971f781cacd8/apps/web/src/connection/platform.ts) and [`apps/mobile/src/connection/platform.ts`](https://github.com/pingdotgg/t3code/blob/e2d4d12a81516b55abbecdc64794971f781cacd8/apps/mobile/src/connection/platform.ts).

The source-consumed core packages do not declare React, so they cannot introduce a second React installation. Web additionally configures `resolve.dedupe` for `react` and `react-dom` in [`apps/web/vite.config.ts`](https://github.com/pingdotgg/t3code/blob/e2d4d12a81516b55abbecdc64794971f781cacd8/apps/web/vite.config.ts). Mobile has no matching Metro singleton override; the app owns React and the internal logic packages avoid depending on it. The shared client state is implemented in the non-React client-runtime on top of `effect`; React-facing atom bindings are application dependencies. There is no explicit resolver dedupe rule for Effect or those bindings. Instead, the pnpm catalog/lockfile pins a single version and all workspace imports normally resolve to the same installed package. **Inference:** that is adequate in the inspected graph, but it is weaker than a runtime singleton assertion if divergent versions are introduced later.

**Limitation:** T3 Code has no independent emitted build that proves those internal packages work as compiled packages. Typechecking validates source and public import paths, but not a `dist` contract. `contracts` even retains `"files": ["dist"]` while exporting source and defining no build script; that is a manifest inconsistency visible in [`packages/contracts/package.json`](https://github.com/pingdotgg/t3code/blob/e2d4d12a81516b55abbecdc64794971f781cacd8/packages/contracts/package.json), not a functioning distribution model.

## 8. React Native/Metro model

[`apps/mobile/package.json`](https://github.com/pingdotgg/t3code/blob/e2d4d12a81516b55abbecdc64794971f781cacd8/apps/mobile/package.json) identifies Expo SDK 56, React Native 0.85.3, and React 19.2.3. The standard development command is `expo start --clear`; additional scripts support a development client, EAS builds, `expo prebuild`, and local iOS/Android runs. It is therefore an Expo-managed/prebuild project with native directories available, not a minimal bare-RN CLI workspace.

[`apps/mobile/metro.config.js`](https://github.com/pingdotgg/t3code/blob/e2d4d12a81516b55abbecdc64794971f781cacd8/apps/mobile/metro.config.js) starts from Expo's default config with the mobile directory as the implicit project root. It adds the repository root to `watchFolders`, excludes `.t3` worktree state, resolves selected Shiki packages from the mobile installation through `extraNodeModules`, and applies Uniwind. It does **not** set:

- a custom `projectRoot`;
- `resolver.enableGlobalPackages`;
- `resolver.nodeModulesPaths` or `disableHierarchicalLookup`;
- custom export-condition names or package-export enablement;
- a broad workspace package alias.

Modern Expo documents automatic monorepo support for pnpm workspaces, and Metro documents package exports and symlink visibility through `watchFolders`: [Expo monorepos](https://docs.expo.dev/guides/monorepos/), [Metro configuration](https://metrobundler.dev/docs/configuration/), and [Metro package exports](https://metrobundler.dev/docs/package-exports/). **Inference:** the explicit root `watchFolders` is either retained for explicit source visibility/`.t3` exclusion or is partially redundant with current Expo defaults; the repository does not state which.

Mobile imports `@t3tools/*` normally. Metro follows the workspace links and raw `.ts` exports, so mobile transpiles shared source. [`apps/mobile/tsconfig.json`](https://github.com/pingdotgg/t3code/blob/e2d4d12a81516b55abbecdc64794971f781cacd8/apps/mobile/tsconfig.json) extends Expo's base config without internal-package paths, keeping TypeScript on the same package-export route.

Because the source directories are watched, edits enter Metro's graph without a package build. **Inference:** normal Fast Refresh applies when module shape permits; React Native documents that non-component exports or modules imported outside the React tree may cause dependent re-execution or a full reload rather than component-only refresh ([Fast Refresh](https://reactnative.dev/docs/fast-refresh)). T3 Code has no architecture test that promises a particular refresh mode for every shared module.

Platform-specific implementation files (`.ios`, `.android`, or `.native`) are primarily kept inside the mobile application. Internal package manifests do not advertise a `react-native` conditional export. Native modules, assets, Expo public environment variables, and platform-specific connection/background layers remain application-owned. This allows reuse of data/contracts/client state while keeping Electron and native capabilities at their edges.

## 9. TypeScript and package-boundary model

The root [`tsconfig.base.json`](https://github.com/pingdotgg/t3code/blob/e2d4d12a81516b55abbecdc64794971f781cacd8/tsconfig.base.json) uses strict checking, NodeNext semantics, no emit, explicit `.ts` import support, relative-extension rewriting, and the Effect language-service plugin. Workspaces run `tsgo --noEmit`; there is no TypeScript project-reference build chain for internal packages.

Package `exports` define the public source boundary. This gives one name-resolution surface to TypeScript and bundlers and supports precise subpaths. It does not create an independently consumable Node package: direct Node execution of a raw TypeScript export depends on a TypeScript-capable runtime or prior bundling. T3 Code's application paths satisfy that assumption through Vite/Vite+ pack/Metro or Node's current TypeScript support where intentionally used; package publication is not the purpose of the private source packages.

The server and desktop bundlers explicitly inline internal workspaces. This both removes raw TypeScript from packaged runtime resolution and makes shared-source changes part of the consuming artifact. The cost is that a consumer's bundler policy—not an upstream package build—decides syntax targets, externalization, and duplicate dependency behavior.

## 10. Testing and CI orchestration

The root `test` is `vp run -r test`, so only workspaces defining a `test` task participate. Tests live beside source across server, web, desktop, mobile, shared, contracts, and client-runtime. Root test defaults come from [`vite.config.ts`](https://github.com/pingdotgg/t3code/blob/e2d4d12a81516b55abbecdc64794971f781cacd8/vite.config.ts#L11-L22); web adds browser-oriented configurations in its own Vite config.

The main [CI workflow](https://github.com/pingdotgg/t3code/blob/e2d4d12a81516b55abbecdc64794971f781cacd8/.github/workflows/ci.yml) installs through the Vite+ setup action, then runs formatting/lint checks, typechecking, tests, builds, resource-monitor checks, mobile static checks where supported, and targeted validations. It uses Vite+ filters and parallelism deliberately; failure of any invoked task fails the job. The [release workflow](https://github.com/pingdotgg/t3code/blob/e2d4d12a81516b55abbecdc64794971f781cacd8/.github/workflows/release.yml) repeats quality gates before its platform matrix.

Expensive or special suites are explicit commands rather than hidden under ordinary `test`: desktop smoke, native Rust tests, isolated-app workflows, release smoke, and packaging validation each have their own entry points. This is a script-membership convention rather than a Vite+ feature.

Task ordering is mixed by intent. Configured `dependsOn` edges order build prerequisites such as web before server and server before desktop. Parallel development intentionally bypasses ordinary ordering after initial prerequisites. Source-consuming packages do not need upstream builds, so a shared edit is picked up by the consuming watcher rather than an invalidated package artifact.

## 11. Vite+ responsibilities

At the pinned commit Vite+ is version `0.2.2`; `vite` is catalog-aliased to `@voidzero-dev/vite-plus-core@0.2.2` in [`pnpm-workspace.yaml`](https://github.com/pingdotgg/t3code/blob/e2d4d12a81516b55abbecdc64794971f781cacd8/pnpm-workspace.yaml#L47-L53). Its actual responsibilities are:

| Responsibility | Evidence in T3 Code |
| --- | --- |
| Task discovery, filtering, dependency edges, concurrency, failure propagation | root scripts and per-workspace `run.tasks` |
| JS bundling for Electron and server | desktop/server `pack` configuration |
| Web dev/build | web Vite configuration |
| Unit/browser tests | root and workspace Vite test configuration |
| Formatting and linting | root Vite+ config |
| Tool/package cache setup in CI | Vite+ setup workflow action |

Vite+ task caching exists in the tool ([cache documentation](https://viteplus.dev/guide/cache)), but T3 Code's desktop and server custom build/dev tasks set `cache: false` in their Vite configs. Package-script tasks are not automatically equivalent to configured cached tasks. **Supported conclusion:** dependency ordering and unified commands matter here; reusable build caching is not demonstrated as a critical desktop/server property.

`scripts/dev-runner.ts` adds behavior Vite+ does not supply: worktree-stable ports, collision checks, development data isolation, share mode, environment normalization, mode validation, and parent process handling. Conversely, it delegates workspace selection, concurrent task startup, and failure reporting to `vp run`.

pnpm can perform recursive/filter selection and workspace concurrency, and ordinary scripts can encode topological dependencies. Removing Vite+ would additionally require replacements for `vp pack`, `vp test`, lint/format/check integration, task metadata, and its output/caching layer. Those are separate questions; `dev-runner.ts` alone is not a Vite+ replacement.

## 12. Quality signals

- **Active maintenance:** the inspected commit was one day old on the inspection date, and focused history shows frequent changes in development orchestration, desktop packaging, mobile, and release performance through July and August 2026. The broad Vite+/pnpm migration landed on 2026-06-03 in [`b440dd181`](https://github.com/pingdotgg/t3code/commit/b440dd1812a7fdc2cf569941328d2368ac0169b7).
- **Direct tests around fragile seams:** the tree contains tests for the development runner, Electron launcher, protocol/window behavior, bundle external selection and scanning, desktop artifact construction, native-resource logic, update metadata, and release smoke. Representative evidence includes [`scripts/dev-runner.test.ts`](https://github.com/pingdotgg/t3code/blob/e2d4d12a81516b55abbecdc64794971f781cacd8/scripts/dev-runner.test.ts), [`scripts/build-desktop-artifact.test.ts`](https://github.com/pingdotgg/t3code/blob/e2d4d12a81516b55abbecdc64794971f781cacd8/scripts/build-desktop-artifact.test.ts), and [`ElectronProtocol.test.ts`](https://github.com/pingdotgg/t3code/blob/e2d4d12a81516b55abbecdc64794971f781cacd8/apps/desktop/src/electron/ElectronProtocol.test.ts).
- **Cross-platform release coverage:** release jobs build macOS, Linux, and Windows; Windows packaging has extra self-containment checks. Mobile has Expo/EAS configuration and platform-specific static checks. Not every declared architecture is active in CI.
- **Operational hardening:** history includes explicit fixes to build web before packaging ([`e4643eccc`](https://github.com/pingdotgg/t3code/commit/e4643eccc7efa07a0129b7ed9765883cfc758c53)), reduce Windows ASAR unpacking ([`7e01d33f`](https://github.com/pingdotgg/t3code/commit/7e01d33f0eeb9435299791392d546756cc09c5d3)), improve release builds ([`25dcee00`](https://github.com/pingdotgg/t3code/commit/25dcee00a6e12db2781a17b326e6e34de0d4ced7)), and batch macOS signing ([`63eb0429`](https://github.com/pingdotgg/t3code/commit/63eb0429f49fad5f8722407ea971e3199e6c4514)). These are signals of real release pressure, but also of nontrivial product-specific complexity.

## 13. Architectural limitations and transitional areas

1. The product and package versions are still `0.0.x`, and desktop labels itself “Alpha” in [`apps/desktop/package.json`](https://github.com/pingdotgg/t3code/blob/e2d4d12a81516b55abbecdc64794971f781cacd8/apps/desktop/package.json). This is active, pre-1.0 architecture.
2. Vite+ `0.2.2`, the Vite+ core alias, TypeScript native-preview tooling, Expo 56, and Effect beta dependencies are rapidly changing or prerelease surfaces in the pinned catalog. Their configuration should be treated as date-specific.
3. The `contracts` manifest's `files: ["dist"]` disagrees with its source exports and absence of a build. Root `build:contracts` therefore suggests an older or anticipated boundary rather than a current emitted artifact.
4. The desktop supervisor watches the built server file, but `dev:desktop` establishes `t3#build` as a prerequisite rather than a server watch task. A server source change does not, by this command alone, guarantee a new server bundle; an independently regenerated `dist/bin.mjs` would trigger restart.
5. Electron/renderer syntax targets rely on tool defaults instead of the Electron version. Source maps are emitted, but main-process mapped stack traces are not explicitly enabled.
6. Crash restart has only a short debounce and no escalating backoff. Windows descendant cleanup is intentionally weaker than Unix cleanup.
7. The release workflow does not execute the available desktop launch smoke test against final installers. Signing may be skipped when credentials are incomplete. Windows arm64 support is represented in scripts but not active in the pinned release matrix.
8. Expo's current monorepo support makes some manual Metro setup potentially redundant; the repository gives no rationale for retaining the root watch folder.
9. The literal contributor rule against `pkill -f` in [`AGENTS.md`](https://github.com/pingdotgg/t3code/blob/e2d4d12a81516b55abbecdc64794971f781cacd8/AGENTS.md) differs from the supervisor's Unix stale-process sweep, which does use a narrowly scoped `pkill -f` marker. The implementation mitigates scope with an exact development-root argument, but documentation and code are not literally aligned.
10. Raw-source packages are excellent for bundled application consumption but provide no compiled-package validation. They should not be assumed usable by arbitrary Node consumers.

## 14. Portable patterns

These patterns are portable because they depend on ordinary process, package, or bundler boundaries rather than T3 Code's product domain:

- Separate renderer HMR from main/preload restart behavior.
- Start Electron only after an initial successful bundle and a positive renderer readiness check.
- Give one small supervisor clear ownership of the Electron child, watchers, debounce, crash policy, signals, and forced shutdown.
- Communicate the chosen dev-server URL/ports explicitly through validated environment rather than assuming a bundler default.
- Bundle internal raw-source workspaces in application artifacts; never require packaged Electron to resolve raw TypeScript.
- Keep a single declared source of truth for externals and packaged runtime dependency selection, then inspect emitted artifacts to detect drift.
- Make package subpaths narrow and put platform capability implementations at application edges.
- Keep ordinary tests defined by explicit task membership; expose costly/manual suites under distinct commands.
- Treat task selection, development supervision, and packaging as separate responsibilities even when one tool can invoke all three.

## 15. T3 Code-specific patterns

These mechanisms solve T3 Code product requirements and are not generic defaults:

- Sharing one web application between browser and desktop, with a local server rather than a packaged `loadFile` renderer.
- The `t3code://`/`t3code-dev://` proxy protocol and CSP rewriting.
- Deterministic worktree-derived ports, `.t3` state isolation, Tailscale share mode, and multiple backend modes.
- Bundling a full agent/server CLI into desktop and constructing a Windows/WSL server sidecar.
- Native closures for node-pty, FFI, passkeys, msgpackr, and their loaders.
- Generated staging manifests, production reinstall, updater-manifest merging, passkey entitlements, Azure signing, and batched macOS signing.
- Vite+'s combined role as task runner, bundler facade, test runner, linter, and formatter.
- Publishing every internal application package as raw source without retaining a compiled validation build.

## 16. Evidence index

| Subject | Pinned evidence | What it demonstrates |
| --- | --- | --- |
| Snapshot | [`e2d4d12`](https://github.com/pingdotgg/t3code/commit/e2d4d12a81516b55abbecdc64794971f781cacd8) | Exact inspected state and date |
| Architecture boundary | [`docs/internals/overview.md`](https://github.com/pingdotgg/t3code/blob/e2d4d12a81516b55abbecdc64794971f781cacd8/docs/internals/overview.md) | Server execution boundary, contracts, shared client runtime |
| Workspace roles | [`docs/internals/workspace-layout.md`](https://github.com/pingdotgg/t3code/blob/e2d4d12a81516b55abbecdc64794971f781cacd8/docs/internals/workspace-layout.md) | Intended app/package responsibilities |
| Root commands | [`package.json`](https://github.com/pingdotgg/t3code/blob/e2d4d12a81516b55abbecdc64794971f781cacd8/package.json) | Development modes, build/test/typecheck commands, artifact entry points |
| Workspace/tool versions | [`pnpm-workspace.yaml`](https://github.com/pingdotgg/t3code/blob/e2d4d12a81516b55abbecdc64794971f781cacd8/pnpm-workspace.yaml) | pnpm roots, Vite+ pin, patches, allowed builds |
| Root Vite+ policy | [`vite.config.ts`](https://github.com/pingdotgg/t3code/blob/e2d4d12a81516b55abbecdc64794971f781cacd8/vite.config.ts) | Shared test, format, lint, alias configuration |
| Development orchestration | [`scripts/dev-runner.ts`](https://github.com/pingdotgg/t3code/blob/e2d4d12a81516b55abbecdc64794971f781cacd8/scripts/dev-runner.ts), [tests](https://github.com/pingdotgg/t3code/blob/e2d4d12a81516b55abbecdc64794971f781cacd8/scripts/dev-runner.test.ts) | Mode selection, ports, environment, subprocess lifecycle |
| Electron bundles/tasks | [`apps/desktop/vite.config.ts`](https://github.com/pingdotgg/t3code/blob/e2d4d12a81516b55abbecdc64794971f781cacd8/apps/desktop/vite.config.ts) | Pack entries, bundling, source maps, task dependencies, watch hook |
| Electron supervision | [`dev-electron.mjs`](https://github.com/pingdotgg/t3code/blob/e2d4d12a81516b55abbecdc64794971f781cacd8/apps/desktop/scripts/dev-electron.mjs), [`wait-for-resources.mjs`](https://github.com/pingdotgg/t3code/blob/e2d4d12a81516b55abbecdc64794971f781cacd8/apps/desktop/scripts/wait-for-resources.mjs) | Readiness, restart, crash, child-tree and signal handling |
| Renderer/protocol | [`apps/web/vite.config.ts`](https://github.com/pingdotgg/t3code/blob/e2d4d12a81516b55abbecdc64794971f781cacd8/apps/web/vite.config.ts), [`DesktopApp.ts`](https://github.com/pingdotgg/t3code/blob/e2d4d12a81516b55abbecdc64794971f781cacd8/apps/desktop/src/app/DesktopApp.ts), [`ElectronProtocol.ts`](https://github.com/pingdotgg/t3code/blob/e2d4d12a81516b55abbecdc64794971f781cacd8/apps/desktop/src/electron/ElectronProtocol.ts), [`DesktopWindow.ts`](https://github.com/pingdotgg/t3code/blob/e2d4d12a81516b55abbecdc64794971f781cacd8/apps/desktop/src/window/DesktopWindow.ts) | Vite HMR, custom URL mapping, load/recovery behavior |
| Server production bundle | [`apps/server/vite.config.ts`](https://github.com/pingdotgg/t3code/blob/e2d4d12a81516b55abbecdc64794971f781cacd8/apps/server/vite.config.ts), [`apps/server/scripts/cli.ts`](https://github.com/pingdotgg/t3code/blob/e2d4d12a81516b55abbecdc64794971f781cacd8/apps/server/scripts/cli.ts) | Server pack and embedded web client |
| External dependency contract | [`scripts/lib/cli-external-packages.ts`](https://github.com/pingdotgg/t3code/blob/e2d4d12a81516b55abbecdc64794971f781cacd8/scripts/lib/cli-external-packages.ts) | Shared bundle/staging external list and emitted-code checks |
| Desktop packaging | [`scripts/build-desktop-artifact.ts`](https://github.com/pingdotgg/t3code/blob/e2d4d12a81516b55abbecdc64794971f781cacd8/scripts/build-desktop-artifact.ts), [tests](https://github.com/pingdotgg/t3code/blob/e2d4d12a81516b55abbecdc64794971f781cacd8/scripts/build-desktop-artifact.test.ts) | Staging, production install, native closure, platform branches, validation |
| Signing/release | [`scripts/build-desktop-artifact.ts`](https://github.com/pingdotgg/t3code/blob/e2d4d12a81516b55abbecdc64794971f781cacd8/scripts/build-desktop-artifact.ts), [`scripts/sign-macos.ts`](https://github.com/pingdotgg/t3code/blob/e2d4d12a81516b55abbecdc64794971f781cacd8/scripts/sign-macos.ts), [release workflow](https://github.com/pingdotgg/t3code/blob/e2d4d12a81516b55abbecdc64794971f781cacd8/.github/workflows/release.yml) | Targets, artifacts, signing, notarization inputs, publication |
| Source consumption | [`contracts`](https://github.com/pingdotgg/t3code/blob/e2d4d12a81516b55abbecdc64794971f781cacd8/packages/contracts/package.json), [`shared`](https://github.com/pingdotgg/t3code/blob/e2d4d12a81516b55abbecdc64794971f781cacd8/packages/shared/package.json), [`client-runtime`](https://github.com/pingdotgg/t3code/blob/e2d4d12a81516b55abbecdc64794971f781cacd8/packages/client-runtime/package.json) | Raw TS exports, subpath boundaries, no package build |
| Mobile/Metro | [`apps/mobile/package.json`](https://github.com/pingdotgg/t3code/blob/e2d4d12a81516b55abbecdc64794971f781cacd8/apps/mobile/package.json), [`metro.config.js`](https://github.com/pingdotgg/t3code/blob/e2d4d12a81516b55abbecdc64794971f781cacd8/apps/mobile/metro.config.js), [`tsconfig.json`](https://github.com/pingdotgg/t3code/blob/e2d4d12a81516b55abbecdc64794971f781cacd8/apps/mobile/tsconfig.json) | Expo commands, workspace watch, resolver and TS behavior |
| CI/testing | [CI workflow](https://github.com/pingdotgg/t3code/blob/e2d4d12a81516b55abbecdc64794971f781cacd8/.github/workflows/ci.yml), [`docs/internals/ci.md`](https://github.com/pingdotgg/t3code/blob/e2d4d12a81516b55abbecdc64794971f781cacd8/docs/internals/ci.md) | Quality gates and platform coverage |
| Tooling transition | [`b440dd181`](https://github.com/pingdotgg/t3code/commit/b440dd1812a7fdc2cf569941328d2368ac0169b7) | Turbo/Bun/tsdown-config to pnpm/Vite+ migration |
