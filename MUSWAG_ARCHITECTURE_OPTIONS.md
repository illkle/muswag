# Muswag architecture options

## Research snapshot

- **T3 Code repository:** [`pingdotgg/t3code`](https://github.com/pingdotgg/t3code)
- **Inspected T3 Code commit:** [`e2d4d12a81516b55abbecdc64794971f781cacd8`](https://github.com/pingdotgg/t3code/commit/e2d4d12a81516b55abbecdc64794971f781cacd8)
- **T3 Code commit date:** 2026-08-27 12:58:21 -0700
- **Inspection date:** 2026-08-28
- **Inspected Muswag commit:** `40f7d42b78ddd61da5d283443cdc18a7d12f0913` (2026-08-28)

This document applies the factual findings in [T3CODE_ARCHITECTURE_REPORT.md](T3CODE_ARCHITECTURE_REPORT.md) to the current Muswag tree. It compares end-state architecture options. It intentionally does not prescribe migration phases, ordered implementation work, or file-by-file changes.

## 1. Decision context and constraints

Muswag wants to remove electron-vite and Turbo while retaining a deliberately small pnpm monorepo. Desktop must bundle `packages/shared/src` directly for development and production, while `@muswag/shared` must keep an independent `dist` build for boundary validation and compiled-output consumers. Ordinary tests must continue to mean desktop plus shared tests; integration and synchronization benchmarks must remain manual. A later Expo/React Native client must be able to reuse platform-neutral source without reaching Electron or Node implementations.

These constraints rule out two superficially simple designs:

- Making every `@muswag/shared` export point unconditionally at raw TypeScript would break ordinary Node consumers unless they also transpile TypeScript and would erase the requested compiled-output boundary.
- Replacing Turbo with another general task runner solely to retain recursive commands would add a tool without a demonstrated scheduling or cache requirement.

The central architectural decisions are therefore narrower: which tool bundles Electron main/preload, what process supervises development, how application bundlers opt into shared source, how package/public boundaries are represented, and which dependencies remain external at package time.

## 2. Current Muswag architecture

### Electron main, preload, and renderer

The desktop manifest's [`dev`, `build`, and `start` scripts](apps/desktop/package.json) delegate all three Electron contexts to electron-vite. [`electron.vite.config.ts`](apps/desktop/electron.vite.config.ts) externalizes dependencies for main and preload and imports the renderer config from [`vite.config.ts`](apps/desktop/vite.config.ts). The renderer config owns React, Tailwind, TanStack Router/devtools, the React compiler, a strict fixed port `5173`, and an Electron-derived Chromium build target.

Electron's entry is `out/main/index.js`. In development [`src/main/index.ts`](apps/desktop/src/main/index.ts) uses electron-vite's `is.dev` and `ELECTRON_RENDERER_URL` to call `loadURL`; production calls `loadFile` for `out/renderer/index.html`. It opens detached DevTools in development. The preload path is relative to the emitted main entry, and current security settings keep `contextIsolation` enabled and `nodeIntegration` disabled, while the preload is not sandboxed.

The practical effect is an opaque orchestration boundary: electron-vite chooses the output conventions, creates the renderer server, watches main/preload, injects the renderer URL, and launches/restarts Electron. Removing it requires explicit ownership of each behavior, not merely replacing its build command.

### Shared package resolution

[`packages/shared/package.json`](packages/shared/package.json) points root, `./db`, and `./player-queue` exports exclusively at `dist`. Its build is a clean TypeScript emit through [`tsconfig.build.json`](packages/shared/tsconfig.build.json). Desktop declares `@muswag/shared` as a workspace development dependency and imports both its root and `./db`; with no desktop alias or source export condition, both TypeScript and electron-vite resolve the compiled package surface.

Turbo's `dependsOn: ["^build"]` in [`turbo.json`](turbo.json) makes shared `dist` exist before desktop build, typecheck, and tests. That ordering, rather than pnpm linking itself, is why a clean checkout can resolve current shared declarations/output.

One existing exception proves source consumption is already technically useful. The benchmark config [`packages/tests/vitest.sync-benchmark.config.ts`](packages/tests/vitest.sync-benchmark.config.ts) aliases `@muswag/shared` directly to `packages/shared/src/index.ts`. The integration config [`vitest.integration.config.ts`](packages/tests/vitest.integration.config.ts) does not, so integration tests use compiled exports. The inconsistency is acceptable for their different purposes but should be explicit in the future resolution policy.

### Turbo responsibilities

The root [`package.json`](package.json) uses Turbo for development, build, lint, typecheck, ordinary tests, coverage, integration, the benchmark, and the local macOS build. [`turbo.json`](turbo.json) provides:

- recursive script discovery;
- upstream build ordering for build/typecheck/test-related tasks;
- persistent development-task handling;
- cached `dist`/coverage output declarations;
- command filtering and a TUI.

[`apps/desktop/turbo.json`](apps/desktop/turbo.json) changes the desktop build output to `out/**` and marks development interactive. There is no custom Turbo plugin, remote-cache configuration, environment model, or complex cross-application graph in the repository.

### Test-package behavior

[`packages/tests/package.json`](packages/tests/package.json) intentionally has no `test`, `build`, `main`, or `exports`. It defines only typecheck/lint plus the explicitly named integration and benchmark scripts. Consequently, root `turbo run test` selects desktop and shared tests but not the manual harness. CI invokes only lint, typecheck, and ordinary test in [`.github/workflows/ci.yml`](.github/workflows/ci.yml); manual suites are not silently added to CI.

The release workflow [`.github/workflows/release.yml`](.github/workflows/release.yml) uses Turbo's desktop filter with dependencies, then electron-builder on Linux, macOS, and Windows. [`apps/desktop/electron-builder.yml`](apps/desktop/electron-builder.yml) packages `out/**`, includes the application manifest, unpacks the `better-sqlite3` native binary, disables npm rebuild, and produces DMG/ZIP, NSIS, AppImage, and DEB targets. Therefore, any new bundle/external policy must still guarantee that external `better-sqlite3` and its native binary reach the application.

### Current platform boundary

The shared package is mostly domain logic and capability interfaces, but its root barrel exports database construction, playlist/sync services, credential/session services, cover management, API code, and player-queue code together in [`src/index.ts`](packages/shared/src/index.ts). `createMuswagDb` imports `@tanstack/react-db`; filesystem, path, HTTP, crypto, credentials, and persistence are supplied as interfaces/Effect services rather than imported Electron modules. This is a promising abstraction boundary, but the broad root export makes it easy for a future mobile bundle to traverse code or dependencies it does not need. Mobile suitability of `@tanstack/react-db`, SQLite persistence abstractions, and every root export has not yet been proven.

## 3. Relevant lessons from T3 Code

The following lessons are transferable; each refers to the factual report rather than treating T3 Code's choices as recommendations by authority.

- Separate the renderer's HMR lifecycle from Electron main/preload restart behavior. T3 Code does this explicitly; see [Electron development lifecycle](T3CODE_ARCHITECTURE_REPORT.md#5-electron-development-lifecycle).
- Establish readiness from successful artifacts and a reachable renderer port before the first Electron launch. A child process existing is not sufficient evidence that its output is usable; see the [startup sequence](T3CODE_ARCHITECTURE_REPORT.md#startup-rebuild-and-shutdown-sequence).
- Give a small supervisor complete ownership of Electron restarts, debounce, crash policy, signals, watcher disposal, and forced child cleanup. Split ownership is where leaked processes and restart races emerge.
- Bundle workspace source into application artifacts. T3 Code's packaged runtime never resolves linked raw TypeScript, even though development starts from raw exports; see [Shared package and source-resolution model](T3CODE_ARCHITECTURE_REPORT.md#7-shared-package-and-source-resolution-model).
- Define external dependencies and packaged runtime dependencies as one contract, then validate emitted output. This is especially relevant to Muswag's native `better-sqlite3`; see [Electron production build and packaging](T3CODE_ARCHITECTURE_REPORT.md#6-electron-production-build-and-packaging).
- Use narrow subpath exports and application-provided capability implementations to keep mobile from importing desktop/Node code; see [Boundaries and singleton dependencies](T3CODE_ARCHITECTURE_REPORT.md#boundaries-and-singleton-dependencies) and [React Native/Metro model](T3CODE_ARCHITECTURE_REPORT.md#8-react-nativemetro-model).
- Keep manual suites out of ordinary tests by script membership. This behavior does not require Vite+; see [Testing and CI orchestration](T3CODE_ARCHITECTURE_REPORT.md#10-testing-and-ci-orchestration).
- Treat Vite+ as a bundle of tooling responsibilities, not as a transparent Turbo substitute; see [Vite+ responsibilities](T3CODE_ARCHITECTURE_REPORT.md#11-vite-responsibilities).

Patterns that do **not** transfer directly include T3 Code's custom protocol proxy, embedded product server, web/desktop shared renderer application, worktree port derivation, Tailscale sharing, Windows/WSL sidecar, native FFI closure, and custom signing/update staging. They solve a materially larger product; see [T3 Code-specific patterns](T3CODE_ARCHITECTURE_REPORT.md#15-t3-code-specific-patterns).

## 4. Gap analysis

| Concern | Current Muswag | Pinned T3 Code | Gap that matters |
| --- | --- | --- | --- |
| Electron bundling | electron-vite owns main/preload/renderer | Vite+ pack owns main/preloads; web Vite owns renderer | Muswag needs an explicit bundler contract and supervisor after removing electron-vite |
| Renderer URL | electron-vite sets `ELECTRON_RENDERER_URL` | root runner sets a chosen URL/ports | Muswag must choose/validate a port and communicate it explicitly |
| Production renderer | `loadFile(out/renderer/index.html)` | custom protocol proxies to embedded server | Muswag should retain `loadFile`; T3's proxy/server is unnecessary |
| Main/preload reload | electron-vite implementation detail | emitted-file watcher restarts Electron | Muswag needs an explicit restart/error policy |
| Targets | renderer derives Electron Chromium; main/preload wrapper defaults | all contexts rely mainly on tool defaults | New explicit builds should record Chromium and embedded-Node targets |
| Shared resolution | all normal imports use `dist`; benchmark aliases source | internal packages export raw source to every consumer | Muswag needs selective source consumption while keeping default compiled exports |
| Shared build | independent `tsc` emit | no independent builds for key internal packages | Muswag should intentionally retain its stronger package-boundary validation |
| Package surface | broad root plus two subpaths | many narrow subpaths; shared/client-runtime have no root | Muswag's future mobile safety benefits from smaller, platform-labelled subpaths |
| Metro | no mobile app yet | Expo defaults plus root watch folder; raw source exports | Muswag needs a future-compatible export/adapter policy, not current Metro configuration |
| React singleton | one desktop app; shared depends on React-oriented TanStack package | core source packages avoid React; web dedupes React | Mobile compatibility and peer/singleton behavior of shared dependencies need validation |
| Task runner | Turbo does recursion, ordering, cache metadata, persistence | Vite+ does broad tooling; custom scripts do product work | pnpm covers current selection; only desktop supervision is genuinely custom |
| Packaging | electron-builder includes `out`, external native DB | custom staged installation and bundle/external checks | Muswag needs a small external/dependency assertion, not T3's staging system |
| Tests | desktop/shared ordinary; integration/benchmark manual | workspace tests plus separately named special suites | Existing Muswag semantics can be preserved through package-script membership |
| Platform matrix | CI Linux; release Linux/macOS/Windows | extensive CI/release and native checks | New desktop build should be verified on all release runners before planning is complete |

## 5. Option A: minimal pnpm and Vite architecture

### Shape

This option keeps Vite as the only JavaScript application bundler. The renderer remains a normal Vite application. Explicit Vite build configurations produce main and preload artifacts, with Electron/Node built-ins and selected runtime/native dependencies externalized. A small desktop-only supervisor uses Vite's programmatic server/build interfaces (or their watchers), waits for the first successful main/preload output and the renderer's actual listening address, starts Electron, and restarts it only after successful main/preload emissions.

The supervisor is not a general task runner. Its domain is one desktop development session: renderer server lifetime, build watchers, Electron child lifetime, readiness, restart debounce, crash behavior, logging, and signal cleanup. Root commands use pnpm filters/recursive execution for all workspace-wide work.

Production remains straightforward: Vite builds main, preload, and renderer into the current `out` layout; Electron continues to select `loadURL` only in development and `loadFile` in production. electron-builder continues to package that output and the declared runtime dependency/native payload.

### Shared-source policy

The strongest form of this option uses an **application-only package export condition** rather than an unconditional raw-source export. Each public `@muswag/shared` subpath would have a `source` branch pointing to `src` and a default/types branch pointing to `dist`. Desktop Vite resolution opts into `source`; desktop TypeScript opts into the matching custom condition. Node processes or package consumers that do not opt in continue to resolve compiled JavaScript and declarations.

That policy has four advantages over a broad alias:

- runtime and TypeScript traverse the same package subpaths;
- undeclared internal files remain private;
- independent `dist` remains the default package contract;
- source consumption is explicitly limited to tools that transpile and bundle TypeScript.

The condition must cover main, preload, renderer, and their tests consistently. It must not leak into electron-builder runtime. Internal imports from shared source should remain relative, while external consumers use only exported subpaths.

### Task model

pnpm's `--filter`, recursive `--if-present`, and workspace concurrency are sufficient for the current graph. Root build can retain an explicit independent shared build and desktop build. Lint/typecheck/ordinary-test commands can recursively run scripts that exist. Manual integration and benchmark commands remain explicit filters. No shared watch build is needed for desktop development because the desktop bundler watches source directly.

### Assessment

This is the smallest architecture that meets every stated outcome. It adds one narrow supervisor but removes two abstraction layers. Its main risk is getting Vite's main/preload externalization and watch-success signals correct across platforms. That risk is testable and bounded. The option should copy T3 Code's lifecycle invariants, not its runner size or product server.

## 6. Option B: T3 Code-inspired orchestration

### Shape

This option separates orchestration more aggressively:

- a root development runner selects mode, port, environment, and workspace tasks;
- the renderer runs as its own Vite process;
- a desktop bundle task watches main/preload;
- a second Electron supervisor waits for resources and owns restarts;
- task metadata expresses desktop build prerequisites.

That is structurally close to T3 Code's boundary between `dev-runner.ts`, workspace Vite config, and `dev-electron.mjs`. It is credible if Muswag expects several concurrent application modes, dynamic ports, multiple renderer/server combinations, or worktree-isolated state. None of those requirements exists today, so the extra root-runner/process boundary would mostly be anticipatory.

### Is Vite+ necessary?

No. The portable pattern is the separation of task selection, bundle watching, and process supervision. It can be implemented with pnpm scripts, Vite, and a desktop supervisor. Vite+ would be necessary only if Muswag deliberately wanted its larger combined surface: `vp pack`, task metadata and filtering, unified Vite/Vitest config, formatting/linting, cache/output UI, and its beta toolchain.

Actual adoption of Vite+ would replace more than Turbo. It would also reshape existing Vite/Vitest/lint/format configuration and couple Muswag to the pinned T3 Code reference's prerelease Vite+ core. T3 Code disables caching on its important custom desktop/server tasks, so its codebase provides no evidence that Vite+ build caching is needed here. Adopting Vite+ solely for `vp run` is not justified.

### Assessment

The patterns-only variant is robust but more complex than Option A. Full Vite+ adoption has the highest tooling churn and maintenance risk without a current Muswag requirement that pnpm cannot reasonably satisfy. This option becomes attractive only if the prerequisites reveal multiple development services or process modes that deserve a root orchestration layer.

## 7. Additional credible options

### Option C: Vite renderer plus a focused Node bundler

This option keeps normal Vite for the renderer and uses a focused library/application bundler such as tsdown for Electron main and preload. A small desktop supervisor still owns readiness and Electron restarts. T3 Code used standalone tsdown configuration immediately before its June 2026 Vite+ migration; the earlier config had the same basic CommonJS outputs, source maps, and internal-package bundling predicate now represented by `vp pack` ([tooling-transition commit](https://github.com/pingdotgg/t3code/commit/b440dd1812a7fdc2cf569941328d2368ac0169b7)).

This is genuinely distinct from Option A because renderer and Electron code use different bundler front ends. It can make Node/Electron platform targets, CommonJS output, externals, and successful watch callbacks more direct, while leaving browser Vite configuration uncluttered. The costs are another focused development dependency, two configuration models, and a need to verify that aliases/export conditions and source maps resolve identically across both.

No other option is sufficiently distinct and supported to include. Generic concurrency wrappers would duplicate the supervisor without solving readiness; Metro is not relevant until a mobile app exists; and a new general task runner has no unmet requirement to address.

## 8. Shared-source design options

| Mechanism | Runtime/TS consistency | Preserves compiled default | Encapsulation | Metro prospects | Assessment |
| --- | --- | --- | --- | --- | --- |
| Desktop aliases to `packages/shared/src` plus matching TS paths | Only if every Vite/Vitest/TS context repeats the alias | Yes | Weak if root aliases bypass subpath exports | Requires a separate Metro alias/watch policy | Simple proof of concept; configuration drift and boundary bypass make it a weaker long-term choice |
| Custom `source` export condition, opted into by desktop bundlers and TS | Strong when bundler conditions and `customConditions` match | Yes | Strong; declared subpaths remain authoritative | Modern Metro supports package exports, but custom condition behavior must be verified for the chosen Expo version | **Preferred** for selective application-source consumption |
| `react-native` conditional exports for mobile-safe entries | Strong for Metro when supported and mirrored by TS | Yes | Strong if subpaths are explicit | Native-standard intent; can map mobile entries/adapters independently | Useful later, after actual mobile entrypoints and Metro behavior are known |
| Unconditional raw TypeScript exports, as in T3 Code | Strong for bundling consumers | No practical compiled default | Strong only through subpaths | Works naturally for Metro | Reject for Muswag: conflicts with independent compiled consumers and ordinary Node runtime safety |
| Separate source-only package name | Strong but explicit | Yes | Strongest physical boundary | Straightforward if Metro watches it | Credible only if platform-neutral code must be split substantially; otherwise package proliferation |

The package-condition design must account for the `types` condition as well as runtime conditions. If TypeScript selects `dist` declarations before the source condition, clean development still requires `dist`; nested or ordered conditions must make source-aware TypeScript resolve the source file. Conversely, default Node resolution must never select `.ts` unless that runtime is intentionally TypeScript-capable.

Subpath design is at least as important as the mechanism. A future surface might distinguish domain/schema/player-queue interfaces from persistence or platform adapters. The precise subpaths are an open design decision, not a migration instruction. T3 Code's useful lesson is the absence of a broad client-runtime barrel, not the exact names of its many exports.

## 9. Future React Native compatibility

### Option A

The `source`-condition model gives a future Expo/Metro app a controlled route to raw source. The mobile application could opt into the source condition or use an explicit `react-native` condition for mobile-safe entrypoints, while default consumers retain `dist`. Because Metro must see files outside the app directory, the selected Expo version's automatic monorepo support and any necessary `watchFolders` must be verified rather than copied from T3 Code blindly.

Shared edits should enter Metro's watched dependency graph and normally participate in Fast Refresh, but refresh quality depends on module shape; domain modules with non-component exports may re-execute dependents or cause a full reload. That is acceptable for domain logic and should not be marketed as component-only refresh.

The key compatibility requirement is architectural: shared source may define filesystem, crypto, credentials, database-persistence, and media capabilities, but application packages must provide Electron/Node and React Native implementations. Mobile-facing subpaths must not import desktop main code, `better-sqlite3`, Electron APIs, Node built-ins, or a root barrel that transitively exposes them.

React must remain a singleton. Today shared imports `@tanstack/react-db`, so its peer/dependency behavior under pnpm and Metro needs validation. Prefer React-bearing UI bindings in the application layer or a package with React as a peer, and ensure renderer/Metro resolvers point React to the owning application's installation. Option A's use of one source graph makes duplicate-React failures easier to trigger, but also easier to detect before publication.

### Option B

The patterns-only variant has the same package/Metro properties as Option A. A root runner could later start Expo alongside other services and allocate environment, but that is not required for Metro source consumption or Fast Refresh. Full Vite+ adoption provides no Metro bundling advantage; Expo/Metro remains an independent toolchain.

### Option C

The separate Electron bundler does not affect Metro directly. It does increase the number of resolvers that must honor the same package conditions: Vite, the Node-focused bundler, Vitest, TypeScript, and Metro. That is manageable if package exports are authoritative and tool aliases are minimal.

### Safe domain reuse

Across all viable options, the safe transferable T3 Code pattern is capability injection plus explicit subpaths. Muswag already uses Effect services for `MiniFs`, `CredentialsStore`, database persistence, `Path`, HTTP, and crypto; that is a stronger starting point than importing Electron directly into shared. The missing proof is that the selected mobile subgraph and its third-party dependencies are React Native-compatible.

## 10. Removing Turbo

| Current Turbo responsibility | Destination without Turbo | Notes |
| --- | --- | --- |
| Discover scripts across workspaces | pnpm recursive `--if-present` commands | Packages lacking a script remain excluded, preserving ordinary-test semantics |
| Workspace filtering | pnpm `--filter` | Already used alongside Turbo in current commands |
| Upstream shared build before desktop | Root build command/CI with an explicit shared compiled-boundary build | Desktop source bundling itself no longer needs `dist`; the independent build remains a validation product |
| Development persistence/interactivity | Desktop supervisor | Only the desktop's related Vite watchers/server/Electron child need shared lifecycle ownership |
| Shared `dev` watch | Deletion from ordinary desktop development | The consuming bundler watches `shared/src`; a standalone shared emit watch remains optional only for compiled-output consumers |
| Build/test/typecheck failure propagation | pnpm exit status and CI job status | No special graph behavior is required |
| Parallel lint/typecheck/test execution | pnpm workspace concurrency | Concurrency can be bounded explicitly if CI resource use requires it |
| Build outputs/cache metadata | Deletion, or tool-local caches | No remote Turbo cache is configured; Vite/TypeScript/Vitest retain their own behavior |
| Desktop `out/**` output declaration | Deletion | The explicit build and electron-builder configuration already name the artifact directory |
| Coverage output declaration | Deletion | Coverage is an artifact of the coverage command, not a scheduling dependency |
| Manual integration ordering on shared build | Explicit manual command contract | Integration uses compiled shared exports today, so it must continue to require/verify shared `dist` unless intentionally changed |
| Benchmark task | Explicit filtered pnpm command | Its Vitest config already consumes shared source directly |
| Local macOS build filtering | Direct shared/desktop build command plus electron-builder | No general scheduler is needed for two known products |
| Turbo TUI | Deletion | A supervisor should prefix desktop process logs; no workspace dashboard requirement is stated |

The subtle point is typechecking. Current Turbo builds dependencies before every workspace typecheck because desktop declarations resolve shared `dist`. Once desktop TypeScript follows the source condition, ordinary desktop typecheck no longer requires emitted shared declarations. Root typecheck should still include shared's own typecheck, while the independent shared build remains a separate package-boundary check.

## 11. Tradeoff matrix

Scores are relative: 1 is least/favorable burden or risk; 5 is greatest burden or strongest readiness, as named by the column.

| Option | Architecture complexity | Correctness potential | Dev experience | Packaging risk | Mobile readiness | Maintenance burden | Migration cost |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| A. pnpm + Vite + one desktop supervisor | 2 | 4 | 4 | 3 | 5 | 2 | 3 |
| B1. T3-style split orchestration, patterns only | 4 | 5 | 4 | 3 | 5 | 4 | 4 |
| B2. Full Vite+ adoption | 5 | 4 | 4 | 4 | 4 | 5 | 5 |
| C. Vite renderer + focused Node bundler + supervisor | 3 | 4 | 4 | 3 | 5 | 3 | 3 |

“Correctness potential” reflects how clearly lifecycle and artifact invariants can be encoded, not a claim that a tool makes the result correct automatically. Packaging risk is initially moderate for A/C because the current electron-vite defaults become explicit; it falls only after cross-platform artifact and native-module verification. B2 scores worse because it changes both orchestration and bundling/tooling surfaces at once.

## 12. Recommended option

**Recommend Option A: pnpm + explicit Vite builds + one desktop-specific supervisor, with a selective package `source` condition and retained shared `dist` build.**

It directly satisfies the desired outcomes with the fewest new concepts. Vite is already required for the renderer and Vitest; pnpm already owns the workspace. The only new code is behavior electron-vite currently hides and that no workspace task runner should own: readiness and Electron process lifecycle. Keeping all three JavaScript contexts on Vite also reduces resolver divergence compared with Option C.

Copy from T3 Code:

- readiness based on successful outputs plus a reachable renderer;
- explicit renderer URL communication;
- renderer HMR versus whole-Electron main/preload restart;
- serialized/debounced restarts and comprehensive signal cleanup;
- application bundling of internal source;
- one external/runtime-dependency contract with artifact assertions;
- narrow source subpaths and application-owned platform adapters;
- manual-suite exclusion by script membership.

Adapt from T3 Code:

- use a much smaller supervisor because Muswag has no product server, share mode, worktree port scheme, or custom protocol;
- retain `loadFile` production behavior rather than introducing a protocol proxy;
- retain the independent shared package build instead of copying unconditional raw-source exports;
- retain Muswag's Electron-derived renderer target and add an explicit main/preload target policy;
- validate `better-sqlite3` packaging without adopting T3 Code's generated staging workspace or Windows/WSL sidecar.

Reject for current Muswag:

- Vite+ as a Turbo replacement;
- a second root development runner separate from the desktop supervisor;
- unconditional source exports;
- T3 Code's embedded server, custom protocol, deterministic worktree ports, native dependency closure machinery, and release/signing system;
- a premature mobile package implementation before platform-neutral entrypoints are proven.

Option C is the fallback if a short technical spike shows that Vite's build-watch API cannot provide reliable successful-write signals or clean Electron-oriented externals/targets. That would be a concrete need for a focused bundler, not a preference for more tooling.

## 13. Risks and open decisions

- **Externalization:** which desktop dependencies are bundled versus loaded from packaged `node_modules`, especially `better-sqlite3`, Effect platform packages, electron-updater, and preload dependencies.
- **Native ABI:** electron-builder currently disables npm rebuild. The lockfile/install path must demonstrably provide a `better-sqlite3` binary compatible with Electron 43 on each target.
- **Watch success semantics:** restarts must follow successful main/preload emission, not every source event, or syntax errors will replace a working process with a broken one.
- **Crash policy:** whether normal user quit should terminate the supervisor, whether abnormal exits restart, and what backoff prevents a crash loop.
- **Port policy:** fixed `5173` is simple but can collide; a dynamic port improves parallel work but requires using Vite's resolved address rather than preselecting an unreliable number.
- **Source condition name and structure:** nested `types`/runtime conditions and ordering must work in TypeScript 7, Vite 8, Vitest, and any chosen main/preload build mode.
- **Subpath boundaries:** the broad shared root currently mixes mobile-safe domain code with persistence/session/capability code. The safe mobile surface is not yet declared.
- **Third-party mobile compatibility:** `@tanstack/react-db`, database persistence packages, Effect modules, URL/crypto behavior, and asset/filesystem assumptions require an actual Metro compatibility audit.
- **React ownership:** peer dependency and resolver behavior must prevent duplicate React across desktop renderer, future mobile, and React-oriented shared dependencies.
- **Production URL/security:** dev URL injection must be validated and development-only; production must remain local `loadFile` with current CSP/protocol behavior reviewed independently.
- **Source maps and targets:** the Electron 43 embedded Node/Chromium versions, CJS/ESM output expectations, preload sandbox constraints, and Node source-map handling need explicit choices.
- **CI resource use:** pnpm recursive typechecking/testing may need a concurrency limit comparable to T3 Code's, but this should be based on measured CI memory rather than copied configuration.
- **Packaging validation:** current release jobs package three operating systems but do not assert application launch. The desired smoke-test depth is unresolved.

## 14. Prerequisites for planning

The following facts should be verified before a migration plan is drafted:

- the exact files and external dependencies emitted today for electron-vite main, preload, and renderer production builds;
- electron-vite's current restart behavior on successful builds, failed builds, normal Electron exit, crashes, and signals, so intentional behavior is distinguished from incidental behavior;
- the Electron 43 embedded Node and Chromium targets and the output-module format required by current main/preload imports;
- whether Vite 8's programmatic build/watch result exposes a dependable successful-write event for both main and preload on macOS, Linux, and Windows;
- the renderer server's resolved-address API and whether a fixed port is a product requirement;
- the complete third-party dependency set that must remain external and the electron-builder path by which each enters the packaged ASAR/unpacked tree;
- a clean-install native ABI test for `better-sqlite3` on each release runner with `npmRebuild: false`;
- TypeScript 7, Vite 8, and Vitest resolution of the proposed nested `source` condition with no pre-existing shared `dist`;
- default Node resolution of the same package after a shared build, proving compiled consumers never select raw TypeScript;
- whether integration tests intentionally validate compiled shared output and whether the benchmark intentionally validates source behavior;
- which existing shared exports are platform-neutral, browser-only, Node/Electron-only, or dependent on React-oriented packages;
- Metro/Expo support for the chosen source or `react-native` condition at the version likely to be adopted, including workspace watching and Fast Refresh from linked source;
- the intended React peer/dependency ownership for `@tanstack/react-db` and any future shared UI bindings;
- expected root-command concurrency and whether loss of Turbo caching has a measurable local or CI cost;
- required packaged-app smoke coverage, signing/notarization expectations, and updater metadata behavior on all current release targets.

These are verification inputs to a later plan, not ordered implementation work.

