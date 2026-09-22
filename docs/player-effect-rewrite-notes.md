# Player rewrite: implementation findings and Effect notes

Inspected 2026-09-05. These are source-reading findings, not reproduced runtime bugs. Relative links point to repository sources. The proposed design is in [player-effect-rewrite-plan.md](./player-effect-rewrite-plan.md).

## Existing material and scope

The earlier uncommitted combined draft was removed after this plan was accepted. The new plan allows API changes, prefers fewer modules, and checks API names against installed packages.

No repository AGENTS.md files were found outside dependencies in the inspected workspace. The findings below were collected before implementation. The implementation follow-up at the end records subsequent code changes and validation.

## Current boundaries worth retaining

- [shared/player-queue.ts](../packages/shared/src/player-queue.ts) defines occurrence-keyed `PlaybackItem`, logical queue snapshot types and parsing. Track IDs are not occurrence identity. It still contains plain functions, Promise storage ports and Zod parsing; “shared completed” does not require converting these unrelated contracts again.
- [credentialsManager.ts](../packages/shared/src/credentialsManager.ts) demonstrates `Context.Service`, explicit `Layer.effect`, `Data.TaggedError`, `ScopedRef`, `SubscriptionRef`, and capability interfaces. This is the closest local service-style reference.
- [renderer/core/runtime.ts](../apps/desktop/src/renderer/core/runtime.ts) owns a renderer-local ManagedRuntime and SessionManager. Its CredentialsStore bridge sends credentials to main via PlayerIPC on load/save/clear. Main cannot directly access that Effect context.
- [renderer/player/queue-manager.ts](../apps/desktop/src/renderer/player/queue-manager.ts) owns source windows, user queue, persistence, selection generations and next/previous policy. Main receives an mpv window, not the entire logical library queue. Rewriting this manager's internals would expand the task; updating its player boundary is necessary.
- `apps/desktop/src/main/player/mpv/mpv-queue-mirror.ts` (pre-rewrite) contains valuable occurrence-ID correlation and queue order behavior. Preserve those outcomes even if reconciliation is simplified.

## Source findings and implications

| Source | Observed implementation | Rewrite implication |
| --- | --- | --- |
| [player.ts](../apps/desktop/src/main/player/player.ts) | SerialQueue serializes operations, but client callbacks directly mutate runtime. Several mutable restore/recovery/deferral flags encode transitions. | A single writer needs command and event ordering, including a specific plan for events arriving before command responses. |
| Same | `handleFileLoaded` publishes playing/paused before queued seek/pause finishes; that queued Promise is not caught there. `applyQueue` catches failures, while many other methods do not use equivalent state/error policy. | Acknowledgment, observed state and failures need one consistent contract. |
| Same | `setVolume` invokes client even while idle; client commands lazily start mpv. Volume persistence runs synchronously from a store subscription. | Preference changes should work without mpv; write outside the playback path. |
| Same | Only runtime has a sequence; meta/runtime broadcast separately. Public errors are strings. | One revisioned snapshot and issue DTO avoid torn state and message parsing. |
| Same | Credential refresh calls `rebuildUrls`, whose full rebuild retains the current entry. | Replacing credentials does not replace the current entry URL through this path. Explicitly define replacement/reload behavior. |
| `apps/desktop/src/main/player/mpv/mpv-client.ts` (pre-rewrite) | Pending requests have no deadline. Connect retries use timers; startup races connection against process events. Disposal calls kill but does not await reaping. | Effect scope, deadline and interruption cleanup must own every attempt and pending reply. |
| Same | An exit is classified expected if code is zero or a signal is present. | External termination can be misclassified; expectedness should track explicit local shutdown intent. |
| `apps/desktop/src/main/player/mpv/mpv-protocol.ts` (pre-rewrite) | Malformed JSON is ignored; a response lacking a string error field is considered successful. Several invalid properties become false/100. `file-loaded` has no entry identity. | Schema decoding should distinguish unknown messages from malformed recognized ones, and event identity must be assigned at read time. |
| `apps/desktop/src/main/player/mpv/mpv-queue-mirror.ts` (pre-rewrite) | Single replacement, rebuild and compensation paths commit maps at different points. Some compensation failures clear local correlation. | Explicit known/unknown correlation and a single conservative failure policy simplify reasoning. |
| `apps/desktop/src/main/player/binary/mpv-binary-manager.ts` (pre-rewrite) | Concurrent refresh shares a Promise; path configuration may change while that Promise runs. Discovery failure collapses to missing. Persistence failure only logs. | Configuration generation/serialization and distinguish missing/probe failure/save failure. |
| [mpv-validator.ts](../apps/desktop/src/main/player/binary/mpv-validator.ts), [errors.ts](../apps/desktop/src/main/player/errors.ts) | Validator minimum is 0.41.0; missing-entry-ID message says 0.33.0. | Centralize minimum and compatibility messaging; the old message is not a trustworthy requirement. |
| `apps/desktop/src/main/player/binary/mpv-installer.ts` (pre-rewrite) | Manual child ownership; cancel sends SIGTERM; cancellation is reported as failed. | Scoped job with a normal Cancelled state and bounded child cleanup. |
| [support/exec.ts](../apps/desktop/src/main/player/support/exec.ts), `apps/desktop/src/main/player/support/json-file-store.ts` (pre-rewrite) | Command output accumulates without an explicit cap. JSON reads swallow all failures; writes are synchronous and direct. | Bound output; distinguish missing/corrupt/IO errors; serialize atomic writes. |
| [main/index.ts](../apps/desktop/src/main/index.ts), [shared/ipc.ts](../apps/desktop/src/shared/ipc.ts) | Optional global Player, per-method IPC handlers, synchronous disposal path. | One runtime boundary and awaited Electron quit guard. |
| [player-provider.tsx](../apps/desktop/src/renderer/components/player-provider.tsx) | Runtime subscribes before fetching snapshot and rejects older sequence values; meta uses a separate mirror. | Retain ordering defense, extend it to epoch/subscription identity and full state. |

## Effect version and concrete API checks

[pnpm-workspace.yaml](../pnpm-workspace.yaml) pins `effect` and `@effect/platform-node` to **4.0.0-rc.112**, and `@effect/vitest` to **4.0.0-rc.109**. Desktop already depends on Effect and has platform-node in devDependencies; Effect Vitest is currently declared by shared, not desktop. Add it to desktop when implementing Effect tests. Do not silently upgrade dependencies as part of the player rewrite.

Inspected the installed source under `apps/desktop/node_modules/effect/src`:

| File/API | Verified relevance |
| --- | --- |
| `Layer.ts`: `Layer.effect` | Runs construction in the layer scope and excludes `Scope` from the resulting layer's requirements. `Layer.scoped` is not exported in this installation. |
| `Effect.ts`: `callback`, `acquireRelease`, `scoped`, `forkScoped`, `forkChild` | Native async bridging and structured lifetimes; child vs service scope must match ownership. |
| `ManagedRuntime.ts`: `make` | Available composition boundary; existing renderer runtime already uses it. |
| `SubscriptionRef.ts`: `make`, `changes` | Uses an unbounded PubSub with replay 1. Changes emits current value and future changes; it is not automatically bounded/latest-only for a slow subscriber. |
| `Queue.ts`: `bounded`, `sliding`, `offerUnsafe` | Queue has Effect 4 APIs; direct callback admission must check failure. Bounded queues do not make synchronous Node callbacks backpressure-aware. |
| `Semaphore.ts`: `make` | Available separate module for small exclusive regions (e.g. install admission). |
| `Effect.ts`: `timeoutOrElse`, `annotateLogs`, `withLogSpan` | Available timing and built-in logging primitives. |
| `@effect/platform-node/src` | Includes NodeSocket, NodeChildProcessSpawner, NodeFileSystem and NodePath. Inspect their specific guarantees before replacing adapters; merely wrapping a Promise does not cancel its underlying resource. |

The repository's shared tests use `it.effect` from `@effect/vitest`, small fake layers, and ordinary Vitest assertions; see [coverManager.test.ts](../packages/shared/src/coverManager.test.ts). Follow this style rather than inventing a test harness framework.

External primary references, consulted for version and protocol context:

- [Effect v4 migration guide](https://github.com/Effect-TS/effect/blob/main/MIGRATION.md) and [services migration](https://github.com/Effect-TS/effect/blob/main/migration/services.md): v4 uses Context.Service and explicit layers. These are moving main-branch documents; installed rc.112 source is the authority for implementation signatures.
- [Effect SubscriptionRef source](https://github.com/Effect-TS/effect/blob/main/packages/effect/src/SubscriptionRef.ts): useful reference for state-stream semantics, likewise moving. Local source was checked for the behavior above.
- [mpv stable manual](https://mpv.io/manual/stable/): `loadfile` acknowledgment precedes actual loading; `insert-at` uses the third insertion-index argument added in 0.38. This supports separating playlist acknowledgment from confirmed playback, but does not by itself prove every required feature exists in every older binary. Keep the current 0.41 minimum initially and verify actual ID/event behavior in a smoke test.

Do not copy v3 names (`Effect.Service`, automatic `.Default`, `Layer.scoped`, `Effect.async`, or `catchAll`) into this v4 design by habit. Match the installed APIs and shared conventions; the plan deliberately does not provide a large speculative layer implementation.

## Existing test investment

Existing suites cover protocol decoding, fake client lifecycle/request behavior, exact queue ordering with duplicate media, one-item slide, queue compensation, three player lifecycle/retry/reset scenarios, binary candidates/version checks, installer output/cancellation, and support helpers. The real mpv integration test exercises a three-occurrence queue. Renderer settings and queue suites are also relevant after contract changes.

Reuse scenario intent and fixtures. The highest-value additions are timeout/interruption and finalization, lifecycle-before-response ordering, stale-generation/property handling, stop/logout during mutation, partial mutation uncertainty, frontend subscribe/result races, and typed errors. The plan lists focused scenario groups instead of a numerical coverage target.


## Implementation follow-up

Implemented in the working tree on 2026-09-05. The older uncommitted combined plan has been deleted.

- Main now composes one ManagedRuntime through [layer.ts](../apps/desktop/src/main/player/layer.ts). [player.ts](../apps/desktop/src/main/player/player.ts) owns playback state and serialized commands/events; [session.ts](../apps/desktop/src/main/player/mpv/session.ts) owns requests and event identity; [connection.ts](../apps/desktop/src/main/player/mpv/connection.ts) owns the process and socket.
- Queue updates validate before IO, correlate occurrences, verify the engine playlist and fail closed on uncertain mutations. A load acknowledgment stays `Loading` until matching load/restore confirmation. Timeout, cancellation, stale generations and stale property observations have explicit handling.
- Binary probing/catalog control flow, installation and preferences now use Effect. Installation runs independently, retains a bounded output tail, exposes cancellation, and terminates its process tree. Preferences use a new `player-settings.json` with atomic writes; no old-settings migration is attempted for this development app.
- The [wire contract](../apps/desktop/src/shared/player-contract.ts) exposes structured results, issues, pending operations and full revisioned snapshots. [player-ipc.ts](../apps/desktop/src/main/player-ipc.ts) limits each window to one unacknowledged snapshot plus its latest replacement. The renderer establishes subscription/epoch identity, rejects older snapshots, checks connection health and exposes errors/actions.
- Existing renderer queue/source policy remains in place. Small renderer projections adapt the authoritative union to existing display and queue view types; main no longer maintains the old split stores or class API. Loading/error snapshots do not advance the logical queue.
- Main awaits bounded cleanup before allowing quit. Logs use Effect annotations and spans, with safe structured failure/cause information instead of raw URLs, command arguments or credentials.

Deliberate implementation choices relative to the proposal:

- Explicit selections/restarts use a fresh scoped mpv process. This makes old load events unambiguous at the cost of process startup latency. Continuous automatic advancement and queue updates around the current item retain the session.
- The session delivers events through a checked callback into the player's bounded mailbox, rather than exposing a second public event stream. Its independent reader completes request Deferreds; it never waits for the player to consume lifecycle events. Telemetry is coalesced separately.
- Binary/catalog helpers retain their useful existing filenames and candidate data, with Effect return types. Scoop is manual-only because its `.cmd` shim is not directly executable with the shell-free process adapter; WinGet and Homebrew remain automatic when detected.
- mpv discovery still uses the existing minimum 0.41.0. The smoke test permits an explicitly selected playlist to have no current marker yet: command acknowledgment can precede `start-file`, while the public phase remains `Loading`.

Validation uses Node 26.8.1. Workspace typecheck/lint/tests and the main/renderer production builds are the completion checks. The focused tests cover state/command ordering, cancellation, retry limits, stale identity, timeout cleanup, exact occurrence order, partial mutations, persistence, installer isolation, snapshot ordering and safe logging. A real local child/socket test exercises UTF-8 framing and cleanup.

The opt-in real-mpv test was not run locally because `mpv` is not on PATH. A macOS CI smoke job now installs mpv and runs it with null audio output; that new CI job has not been executed from this working tree. Windows named pipes/process-tree termination and interactive Electron playback remain unverified locally. These are validation gaps, not claims of tested cross-platform playback.
