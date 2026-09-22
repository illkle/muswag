# Player Effect rewrite plan

Status: accepted design, 2026-09-05; implementation is in the working tree. Scope: `apps/desktop/src/main/player`, plus the IPC and renderer changes necessary to consume its new contract. This document records the design; implementation details and validation are recorded in the accompanying notes.

Repository evidence and version-specific notes are in [player-effect-rewrite-notes.md](./player-effect-rewrite-notes.md). This proposal does not require preserving the current API.

## Decisions

- One scoped Effect subsystem in Electron main. One owner writes playback state; callbacks only deliver input.
- Keep logical queue/source selection and queue persistence in the renderer for this task. Main owns the accepted playback window, mpv occurrence correlations, and actual playback. Reuse shared `PlaybackItem`; do not create another queue manager or migrate the shared package again.
- Keep mpv's playlist and automatic advance for continuous playback. Start with straightforward rebuild-around-current reconciliation; defer the single-item replacement optimization until a measured need justifies it.
- Use a few capability services, ordinary pure functions for decisions, and explicit layers. No generic actor framework, event sourcing, plugin architecture, or service per helper.
- Expected failures have typed tags internally and safe structured DTOs externally. Playback, installation, and persistence failures have distinct consequences.
- Change main, preload/shared IPC declarations, and renderer consumers together. A temporary adapter is acceptable while developing, but is not the target architecture.

## Observable behavior and invariants

1. A command acknowledgment means its bounded operation has committed, not that media has started playing. Applying a selection acknowledges a verified playlist and a `Loading` state. Only correlated loading and property evidence can establish `Playing`/`Paused`.
2. Desired pause/seek/volume and observed values are separate while an operation is pending. A rejected pause or seek cannot silently leave a false successful state.
3. Every snapshot has one runtime epoch and monotonically increasing revision across playback, binary, installation, and warnings. Main is authoritative; renderer connection health is local and separate.
4. Duplicate tracks are legal; duplicate occurrence keys are not. Correlation uses `(sessionGeneration, playlistEntryId)`, never song ID or playlist index alone.
5. Old session events and superseded load completions cannot alter current playback. A stopped session cannot resurrect playback from queued events.
6. An ambiguous playlist mutation invalidates the session/correlation. Never apply another incremental edit against a guessed playlist.
7. No detached recovery promises. Every background fiber has a scope and an owner that handles its failure. Disposal settles pending callers and waits for bounded cleanup.
8. Idle volume/mute changes update preferences without spawning mpv. Missing mpv is an actionable availability state, not a layer-construction failure.

## Modules and dependency direction

```text
src/shared/player.ts            Wire schemas/types, commands, snapshots, results
src/main/player/
  errors.ts                    Internal tagged errors and safe DTO mapping
  model.ts                     Private machine state and pure transitions
  player.ts                    Player service; mailbox, recovery, publication
  queue.ts                     Pure plans and sequential execution; no own store
  stream-source.ts             Credential snapshot -> shared URL builder
  settings.ts                  Small typed persistence capability
  mpv/protocol.ts              Framing/envelope/response schemas and commands
  mpv/connection.ts            Scoped process + socket adapter
  mpv/session.ts               Startup, requests, observations, generation
  mpv/ipc-path.ts              Platform path helper
  binary/catalog.ts           Candidate ordering and installation recipes
  binary/binaries.ts          Discovery, validation and configured path policy
  binary/installer.ts         Independently cancellable installation job
  layer.ts                     Compose live dependencies once
  index.ts                     Narrow service/layer exports
src/main/player-ipc.ts          Effect <-> Electron boundary and subscriptions
```

IPC -> Player -> queue/session, binaries, installer, settings. Session -> connection/protocol. Binary services use platform filesystem/process capabilities. Pure modules import no Electron, Node implementations, TanStack stores, or live layers. Keep declaration and implementation together unless a file becomes hard to navigate.

The signatures below specify proposed domain contracts; related declarations are shown together for readability. `Effect`, `Stream`, `Scope`, `Layer`, `Context`, and `Data` refer to imports from the installed Effect 4 package. Schema declarations must implement these wire shapes, including finite numeric values and bounded arrays/strings; this is not a standalone compilable source listing.

## Public contract: `src/shared/player.ts`

```ts
type Stamp = Readonly<{ epoch: string; revision: number }>;
type Selection = Readonly<{ key: string; play: boolean; positionSeconds: number }>;
type PlayerCommand =
  | { readonly _tag: "ApplyQueue"; readonly items: readonly PlaybackItem[];
      readonly select: Selection | null }
  | { readonly _tag: "Play" | "Pause" | "Toggle" | "Restart" | "Stop" }
  | { readonly _tag: "Seek"; readonly seconds: number }
  | { readonly _tag: "SetVolume"; readonly percent: number }
  | { readonly _tag: "SetMuted"; readonly muted: boolean }
  | { readonly _tag: "RefreshBinary" }
  | { readonly _tag: "SetBinaryPath"; readonly path: string | null }
  | { readonly _tag: "StartInstall"; readonly method: MpvInstallMethod }
  | { readonly _tag: "CancelInstall"; readonly jobId: string }
  | { readonly _tag: "DismissIssue"; readonly issueId: string };

type PlayerIssue = Readonly<{
  id: string;
  code: "InvalidCommand" | "NotAuthenticated" | "BinaryUnavailable"
    | "EngineUnavailable" | "CommandRejected" | "PlaybackFailed"
    | "QueueOutOfSync" | "InstallFailed" | "SettingsFailed"
    | "Busy" | "ShuttingDown" | "InternalError";
  message: string;
  operation: string;
  occurrenceKey: string | null;
  actions: readonly ("retry" | "login" | "configureMpv" | "refreshMpv" | "dismiss")[];
}>;

type Media = Readonly<{
  item: PlaybackItem;
  positionSeconds: number;
  durationSeconds: number | null;
}>;
type Playback =
  | { readonly _tag: "Idle" }
  | { readonly _tag: "Loading"; readonly media: Media; readonly targetPaused: boolean }
  | { readonly _tag: "Playing" | "Paused" | "Ended"; readonly media: Media }
  | { readonly _tag: "Recovering"; readonly media: Media; readonly attempt: 1 }
  | { readonly _tag: "Failed"; readonly media: Media | null; readonly issue: PlayerIssue };

type BinaryState =
  | { readonly _tag: "Checking" }
  | { readonly _tag: "Ready"; readonly path: string; readonly version: string;
      readonly source: MpvSource }
  | { readonly _tag: "Unavailable"; readonly reason: "missing" | "invalid" | "probeFailed";
      readonly issue: PlayerIssue; readonly options: readonly MpvInstallOption[] };
type InstallState =
  | { readonly _tag: "Idle" }
  | { readonly _tag: "Running" | "Cancelling" | "Succeeded" | "Cancelled";
      readonly jobId: string; readonly method: MpvInstallMethod }
  | { readonly _tag: "Failed"; readonly jobId: string;
      readonly method: MpvInstallMethod; readonly issue: PlayerIssue };
type PlayerSnapshot = Readonly<{
  stamp: Stamp;
  lifecycle: "running" | "closing" | "closed";
  playback: Playback;
  queue: { readonly revision: number; readonly keys: readonly string[];
    readonly sync: "empty" | "applying" | "synced" | "unknown" };
  pending: { readonly commandId: string; readonly kind: PlayerCommand["_tag"] } | null;
  audio: { readonly volumePercent: number; readonly muted: boolean;
    readonly applied: boolean };
  binary: BinaryState;
  install: InstallState;
  issues: readonly PlayerIssue[];
}>;
type CommandAck = Readonly<{ commandId: string; stamp: Stamp; jobId: string | null }>;
type CommandResult =
  | { readonly ok: true; readonly ack: CommandAck; readonly snapshot: PlayerSnapshot }
  | { readonly ok: false; readonly commandId: string;
      readonly issue: PlayerIssue; readonly snapshot: PlayerSnapshot };
```

Commands carry a caller-generated ID in the IPC envelope; IDs correlate results, pending state, and issues. They do not promise durable exactly-once delivery. Never automatically resend an unacknowledged mutation after IPC loss; reconnect and inspect state first. Validate `ApplyQueue` completely before any engine side effect, including selection membership and a bounded window size. Reject nonfinite or out-of-range volume/seek input; clamp a valid seek to known duration. Reject play/seek without a playable selection with `InvalidCommand`; `Stop` is idempotent. Evaluate `Toggle` inside the command consumer.

`audio` is explicitly the requested preference; `applied=false` means engine confirmation is pending/unavailable. If an active engine rejects the change, restore the last confirmed preference and return an issue. `Ended` is not `Playing`, even if mpv's pause property is false. Unknown duration is `null`, not invented metadata precision.

Keep a small bounded issue list (e.g. 20, deduplicated by operation/occurrence). A failure associated with `Failed` stays in that variant until recovery or stop even if a notification is dismissed. Successful retry clears the matching active failure; unrelated actions do not clear all errors. Installation cancellation is a normal terminal state. Persistence errors are nonfatal warnings. Command-local failures do not stop healthy playback.

## `errors.ts`: typed failures, policy at the owning boundary

```ts
class EngineError extends Data.TaggedError("EngineError")<{
  readonly reason: "spawn" | "connect" | "closed" | "timeout" | "protocol" | "rejected";
  readonly operation: string;
  readonly generation: number;
  readonly uncertain: boolean;
  readonly cause?: unknown;
}> {}
class QueueError extends Data.TaggedError("QueueError")<{
  readonly reason: "invalid" | "anchorMissing" | "correlationLost";
}> {}
class BinaryError extends Data.TaggedError("BinaryError")<{
  readonly reason: "missing" | "invalid" | "probeFailed";
  readonly cause?: unknown;
}> {}
class SettingsError extends Data.TaggedError("SettingsError")<{
  readonly operation: "load" | "save";
  readonly cause?: unknown;
}> {}
class InstallError extends Data.TaggedError("InstallError")<{
  readonly reason: "unavailable" | "busy" | "failed";
  readonly cause?: unknown;
}> {}
class PlayerError extends Data.TaggedError("PlayerError")<{
  readonly issue: PlayerIssue;
}> {}
// mapIssue(error, context) maps recognized leaf errors to one safe PlayerIssue.
// Unknown defects are handled separately with Cause at the application boundary.
```

Use reason fields where policy is identical and tags where recovery differs; do not create dozens of nearly identical error classes. Never serialize `cause`, Error instances, stack traces, command argument arrays, stream URLs, or credentials. Preserve diagnostic causes internally, sanitize them before logging. Defects remain defects inside services; the supervised boundary logs a sanitized Cause, publishes `InternalError`, invalidates affected playback, and settles callers. Interruption during expected shutdown/cancellation is not a playback failure.

## `mpv/connection.ts` and `mpv/protocol.ts`: IO and decoding

```ts
interface Connection {
  readonly write: (line: string) => Effect.Effect<void, EngineError>;
  readonly lines: Stream.Stream<string, EngineError>;
  readonly exited: Effect.Effect<{ code: number | null; signal: string | null }, EngineError>;
}
interface MpvConnectionService {
  readonly open: (input: { binaryPath: string; ipcPath: string; generation: number }) =>
    Effect.Effect<Connection, EngineError, Scope.Scope>;
}
class MpvConnection extends Context.Service<MpvConnection, MpvConnectionService>()(
  "@muswag/desktop/MpvConnection"
) {}

type MpvCommand<A> = Readonly<{
  name: string;
  args: readonly unknown[];
  decode: (data: unknown) => Effect.Effect<A, EngineError>;
}>;
// protocol.ts: constructors hide wire details and select the response decoder.
declare const load: (url: string, mode: "replace" | "insert-at", index?: number) =>
  MpvCommand<{ readonly playlistEntryId: number }>;
declare const setPause: (paused: boolean) => MpvCommand<void>;
declare const getPlaylist: MpvCommand<readonly { id: number; current: boolean }[]>;
```

Use installed Node platform process/socket/filesystem primitives where their cancellation semantics fit. The connection adapter is the seam for local sockets/named pipes and child ownership, not a new generic filesystem/process framework. If native callbacks are needed, use `Effect.callback` and scoped listener cleanup. One consumer reads lines. Incremental UTF-8 framing must handle chunks, CRLF, truncated EOF, and a maximum line size. Unknown events are ignored; malformed recognized responses fail their request. If request identity cannot be decoded, fail the connection rather than strand all requests. Bound buffered output and drain child stderr.

## `mpv/session.ts`: a scoped engine session

```ts
type SessionEvent = Readonly<{
  generation: number;
  sequence: number;
  entryId: number | null;
  event: MpvEvent; // decoded lifecycle, property, or terminal connection event
}>;
interface SessionHandle {
  readonly generation: number;
  readonly execute: <A>(command: MpvCommand<A>) => Effect.Effect<A, EngineError>;
  readonly events: Stream.Stream<SessionEvent, EngineError>;
}
interface MpvSessionService {
  readonly open: (binaryPath: string) => Effect.Effect<SessionHandle, EngineError, Scope.Scope>;
}
```

Player lazily acquires one handle in a replaceable child scope; the service itself does not hide a second startup owner. Serialized player operations share that handle and startup attempt. Install/discovery never spawn a playback session. Register the event feed before enabling observations/loading media. Session owns process, socket, reader, request registry, and shutdown; Player owns when the session is replaced.

Each request registers a `Deferred` before writing and removes it in an `ensuring` cleanup on success, failure, timeout, or interruption. The reader completes responses directly, independently of the player mailbox. Use a bounded startup connection schedule (e.g. 5 seconds total), a request deadline (e.g. 5 seconds), and a total playlist-operation deadline (e.g. 15 seconds), all Effect-clock based. No retry of arbitrary mutating commands. A timed-out mutation may have executed: close the session and invalidate correlations. Unknown/late response IDs are ignored with sampled debug logging.

The reader preserves wire order and tags `file-loaded` and property samples with its current `start-file` identity because those messages do not carry sufficient identity themselves. Clear that identity on stop/end/session closure as appropriate. Do not label an event using whichever item the player happens to expose later. Query playlist/current identity after uncertain transitions; missing or ambiguous identity fails closed instead of falsely marking a new item loaded.

Terminal process/socket failure is reported once per generation. An exit is expected only when Muswag requested closure, not simply because its code is zero or it has a signal.

## `queue.ts`: simple planning, verified commit

```ts
type Correlation =
  | { readonly _tag: "Empty" }
  | { readonly _tag: "Unknown" }
  | { readonly _tag: "Known"; readonly generation: number;
      readonly entries: readonly (PlaybackItem & { readonly entryId: number })[];
      readonly currentId: number | null };
type QueuePlan =
  | { readonly _tag: "Clear" }
  | { readonly _tag: "Keep"; readonly selectKey: string | null }
  | { readonly _tag: "Rebuild"; readonly anchorKey: string;
      readonly replaceAnchor: boolean };
declare const planQueue: (current: Correlation, items: readonly PlaybackItem[],
  select: Selection | null) => Effect.Effect<QueuePlan, QueueError>;
declare const executePlan: (session: SessionHandle, plan: QueuePlan,
  items: readonly PlaybackItem[], urls: ReadonlyMap<string, string>, current: Correlation) =>
  Effect.Effect<Correlation, EngineError | QueueError>;
```

`planQueue` performs no IO (a synchronous tagged result instead of Effect is also fine). Empty queue means stop and clear. Nonempty queue without a verified anchor requires an explicit selection. Same keys allow metadata rebind and optional selection; other changes clear successors and rebuild around the verified current entry, or replace around an explicit selection. Resolve every required URL before mutation. Do not change the URL for an existing current entry while pretending only its metadata changed.

Commit after decoded command responses and a playlist/current query confirm entry IDs and order. Automatic advancement can invalidate an anchor during mutation: verification must detect that, and events already read are reconciled against the committed map. On any partial mutation failure, invalidate the map and close the session; publish `QueueOutOfSync`. A subsequent explicit selection rebuilds from scratch. This deliberately replaces today's multi-step compensation/retry machinery with a simpler safe failure policy. Never report that the old queue was restored unless actually verified.

## `player.ts` and `model.ts`: one writer

```ts
interface PlayerService {
  readonly execute: (commandId: string, command: PlayerCommand) =>
    Effect.Effect<CommandAck, PlayerError>;
  readonly setCredentials: (credentials: SessionCredentials | null) =>
    Effect.Effect<void, PlayerError>;
  readonly snapshot: Effect.Effect<PlayerSnapshot>;
  readonly changes: Stream.Stream<PlayerSnapshot>;
  readonly shutdown: Effect.Effect<void>;
}
class Player extends Context.Service<Player, PlayerService>()("@muswag/desktop/Player") {}
// Private messages: Command + Deferred reply, SessionEvent, installation/binary
// update, sampled telemetry, persistence result, and operation completion.
// model.ts keeps small pure helpers for legal playback transitions and stale IDs;
// avoid a general action interpreter unless actual duplication warrants it.
```

Use a bounded command mailbox with a single consumer, private machine state, and a `SubscriptionRef<PlayerSnapshot>` for publication. Never give other services its writable reference. Public producers get a bounded admission wait and `Busy` on overload. Credentials, accepted window, correlation, load token, recovery budget, and active operation live together privately.

The consumer may await bounded session requests and queue operations, but **must not await an event that only that same consumer can process**. Socket responses complete Deferreds in the independent reader. Lifecycle events accumulate during a queue transaction and are processed after commit; selected playback remains `Loading`. Restore seek/pause are sent after a matching `file-loaded` and only then finalize the phase after confirmation. A loading deadline is a scoped fiber that submits a token-tagged failure message.

Keep lifecycle input bounded separately from telemetry; Node callbacks cannot suspend for Queue backpressure. The adapter must pause reads safely or fail the session on overflow, never silently drop lifecycle/terminal messages or create one unbounded waiting fiber per event. Reserve terminal failure delivery outside the full queue (a terminal Deferred). While waiting for a request, a full lifecycle buffer must not block reading its response. Position samples use a latest-value slot plus at most one pending tick per active entry; the writer samples at about 500 ms. Reset the slot at each identity change. Semantic transitions publish immediately with the latest matching position. This prevents telemetry starvation without reordering start/end events.

Stop/logout/shutdown must be able to interrupt active work: a small out-of-band cancellation signal interrupts the current operation child fiber, then the writer settles it, invalidates uncertain effects, and handles stop. Stop bypasses normal queued commands and cancels older queued playback commands. Closing the runtime uses the same bounded cleanup path, not an item waiting behind a hung request. Do not implement a general priority scheduler.

For a correlated media error, allow one fresh-URL reload per explicit playback attempt, exposing `Recovering`. Ignore automatic advance away from the failed occurrence during that recovery; explicitly replace it. Preserve position and target pause where meaningful. A second failure becomes `Failed` and closes the session. A user retry/new selection gets a new attempt token; old failures cannot spend its budget. Do not retry authentication, invalid input, protocol incompatibility, or partial mutation errors.

Credentials stay behind the main-process service. The existing renderer authentication bridge calls `setCredentials`; do not try to inject its renderer-local `SessionManager` into main. Logout cancels playback, closes the old session, clears the accepted window and URL cache before acknowledgment. For changed non-null credentials, close the old session and rebuild around current selection/position with new credentials; expose loading, and fail visibly if that fails. Serialize credentials replacement with playback; use a credentials generation to discard older completions.

## Binary, installation, URL and settings services

```ts
interface BinariesService {
  readonly resolve: Effect.Effect<Extract<BinaryState, { _tag: "Ready" }>, BinaryError>;
  readonly setPath: (path: string | null) => Effect.Effect<void, SettingsError>;
  readonly invalidate: Effect.Effect<void>;
}
interface InstallerService {
  readonly start: (method: MpvInstallMethod) => Effect.Effect<string, InstallError>;
  readonly cancel: (jobId: string) => Effect.Effect<void>;
  readonly changes: Stream.Stream<InstallState>;
  readonly output: Stream.Stream<{
    readonly jobId: string; readonly sequence: number;
    readonly stream: "stdout" | "stderr"; readonly line: string;
  }>;
}
type Settings = Readonly<{
  volumePercent: number; muted: boolean; manualPath: string | null; cachedPath: string | null;
}>;
interface SettingsService {
  readonly load: Effect.Effect<Settings, SettingsError>;
  readonly save: (settings: Settings) => Effect.Effect<void, SettingsError>;
}
declare const resolveUrls: (credentials: SessionCredentials | null,
  items: readonly PlaybackItem[]) => Effect.Effect<ReadonlyMap<string, string>, PlayerError>;
```

Declare capability tags using the same `Context.Service` pattern as Player. Stream source remains a small function using shared `buildSubsonicStreamUrl`, not another service with mutable credentials.

Binary discovery retains explicit-path precedence and validation; an invalid explicit path is actionable, not silently bypassed. Serialize configuration and discovery, or use a configuration revision to discard stale probe results. Keep minimum supported mpv version in one place (initially 0.41.0, matching today's validator) and test required command behavior with the real binary. Changing configured path affects the next session; either explicitly restart current playback with visible loading or keep showing the active engine's old path separately. Prefer restarting for this rewrite.

Installer owns one job fiber under its service scope; it is not awaited in the playback command loop. `StartInstall` returns an accepted job ID, not successful installation. A semaphore protects single-job admission. Cancellation interrupts and awaits process cleanup, then publishes `Cancelled`; repeated cancellation is safe. Distinguish package-manager success from subsequent mpv discovery failure. Auto-refresh availability after completion. Keep a bounded output tail for settings UI reconnection, tagged by job/sequence; output truncation is explicit and cannot erase the terminal state. Preserve manual-only installation options; do not execute arbitrary renderer-supplied shell commands.

Settings use Effect FileSystem/Path, Schema decoding and temp-file/rename writes in the same directory. Missing file means defaults; malformed file means defaults plus warning; permission/IO failures remain distinguishable. Serialize and debounce writes (e.g. 250 ms), flush the latest desired settings during shutdown with a deadline, and report write failures as warnings. Explicit path save failure rejects that configuration change; incidental cache/volume persistence failure does not terminate playback. Do not retest shared URL signing.

## Composition, Electron and frontend

```ts
declare const PlayerLive: Layer.Layer<Player, never,
  MpvSession | Binaries | Installer | SettingsStore>;
// MpvSession/Binaries/Installer/SettingsStore are Context.Service tags for
// the interfaces above; lower live layers provide platform dependencies.
declare const makePlayerLayer: (options: {
  ipcPath: string; settingsPath: string;
}) => Layer.Layer<Player>;
// main owns ManagedRuntime.make(makePlayerLayer(options)).
// IPC dispatch: decode -> Player.execute -> read snapshot -> encode CommandResult.
```

Build scoped services with `Layer.effect`; acquire resources with `Effect.acquireRelease` and fork long-lived workers with `Effect.forkScoped`. Provide/reuse layer values once. Missing binary, corrupt preferences, and discovery failure must produce state rather than make every runtime invocation fail during initialization.

Move IPC registration to `player-ipc.ts`. The Promise boundary is the only place that uses runtime runners. Decode all inputs with Schema and return a plain `CommandResult` for expected errors; Electron exception serialization is not the domain protocol. Include a snapshot at or after the acknowledgment revision in results. Keep authentication credentials in a separate privileged IPC method rather than the public command union.

Use an explicit subscribe handshake: renderer attaches its event listener, invokes subscribe, and main establishes the scoped state feed before returning its initial snapshot and subscription ID. Both feed and reply carry full snapshots. Accept increasing revisions for that subscription/epoch and ignore older replies/events. A new subscription establishes a new epoch; do not switch epochs based on an arbitrary late event. Unsubscribe on window destruction. Since snapshots replace state, coalescing is safe; never depend on receiving every position update.

Use one prompt main-process drain of `SubscriptionRef.changes`, then bounded per-window latest-snapshot delivery. The installed SubscriptionRef is unbounded internally; do not leave slow subscriptions accumulating snapshots. Renderer timeout/window reconnection marks its view `disconnected` or `resyncing`, disables commands, and re-subscribes. A heartbeat or bounded periodic snapshot refresh detects a stalled feed even during steady playback. This is the limit of “always correct”: show unknown/disconnected when freshness cannot be established, rather than promise certainty across IPC failure.

Update `shared/ipc.ts`, renderer `lib/ipc.ts`, `player-provider.tsx`, `QueuePlayerPort`/`queue-manager.ts`, authentication bridge, playback controls, and mpv settings UI. QueueManager treats the acknowledged accepted window separately from confirmed current playback, and commits now-playing/source advancement only from correlated authoritative snapshots. Failed queue application keeps the previous logical selection recoverable and exposes the failure. Consume union phases and issue actions, not exception text or unrelated booleans. Deduplicate command-result and state notifications by issue ID.

On Electron `before-quit`, prevent the first quit, mark closing, reject new commands, interrupt active work, settle queued replies, stop installer and session, flush preferences, remove IPC subscriptions, and await runtime disposal. Then allow the second quit with a guard. Session cleanup attempts graceful quit, then bounded forced termination and reaping; clean only the socket path owned by this instance. Windows named pipes and package-manager child trees require platform-specific verification. Surface/log cleanup failure and use a total shutdown deadline so the app cannot hang indefinitely.

## Logging

Use built-in `Effect.logDebug`, `logInfo`, `logWarning`, `logError`, `annotateLogs`, and `withLogSpan`/`withSpan`. Configure one logger/minimum level at the main runtime; keep Electron console integration there. Existing services must not call `console.*` directly.

Annotate component, epoch, generation, command ID/name, occurrence key, installation job ID, attempt, duration and error code. Log lifecycle changes and user-operation outcomes at info, recovery/persistence degradation at warning, terminal failures/defects at error. Individual IPC frames/property ticks belong at debug or are omitted. Log failures once where a recovery decision is made. Never log raw URLs, passwords, signed query strings, mpv args, or unsanitized child/error output. A redaction test must cover both direct fields and nested causes; hashing a URL is unnecessary when request ID suffices.

## Tests: focused behavior, not implementation mirroring

Use existing pure test cases where valid. Add desktop `@effect/vitest` from the catalog; follow shared's `it.effect` style and use scoped tests/TestClock for lifetimes and timing. Use fake capability layers, scripted mpv replies/events and Deferred barriers, not real sleeps or mocks of Effect internals. Test meaningful failure boundaries instead of every setter or helper. The following are scenario groups, not a quota of individual tests.

| Suite | Required scenarios |
| --- | --- |
| Protocol/framing | Fragmented UTF-8/multiple lines; size limit; invalid known response vs ignored unknown event; typed load ID decode; missing response identity fails connection. Table-driven. |
| Session | Concurrent demand yields one startup; out-of-order responses; timeout/interruption removes pending request; late response ignored; startup failure/close releases process/socket/listeners; duplicate exit/close emits one terminal result. |
| Queue | Duplicate track IDs with unique keys; selected middle item order; same-key metadata update; invalid selection before IO; current auto-advances during rebuild; partial mutation/query mismatch invalidates map and closes session. |
| Player | Selection acknowledgment is Loading; restore seek failure does not report Playing; failed pause/seek leaves honest state; stale generation/load/property input ignored; end-of-queue and automatic advance correlate correctly; one media reload then terminal error. |
| Concurrency/lifetime | Lifecycle-before-command-response without deadlock; telemetry flood does not starve stop/errors; full lifecycle buffer fails visibly; stop/logout during startup/rebuild cancels work and settles queued callers; no post-disposal updates. |
| State/IPC/renderer | Event-before-initial-snapshot and old epoch replies; structured command rejection plus matching issue; reconnect while loading/failed/installing; pending acknowledgment never advances logical now-playing; disconnected controls; dismiss/retry clears only matching issue. |
| Binary/installer/settings | Existing candidate precedence/version table; stale refresh after path change; one install at a time; cancel then immediate new install cannot receive old job results; exit-zero but discovery fails; missing/corrupt/unwritable settings; atomic/debounced final write. |
| Logging | One representative failure produces structured annotations once; credentials/URL/nested cause output is redacted; expected cancellation is not logged as playback failure. |
| Real mpv smoke | Local generated audio with null audio output: load/entry IDs, exact 3-occurrence order including duplicate media, auto-advance, pause/seek and awaited shutdown. Gate explicitly on mpv availability; CI should include one job with the supported version. |

Keep OS package-manager execution out of tests. Use fake command runners for catalog/install behavior and one lightweight real local socket/process test for the adapter boundary. Verify Unix socket behavior in CI; add Windows named-pipe/termination smoke coverage when a Windows runner is available and record that gap until then. Avoid a broad coverage percentage target, exhaustive permutations, renderer pixel snapshots, and duplicate tests for shared queue parsing or stream signing.

## Implementation sequence and completion criteria

1. **Contract and baseline:** settle the union/schema and acknowledgment behavior; retain relevant existing tests as behavioral references. Add Effect test dependency. Create small typechecked signature scaffolds against rc.112 before porting internals.
2. **Protocol and session:** implement scoped connection, decoding, request deadlines, correlation and deterministic cleanup. Pass fake-session tests and the real mpv protocol smoke before relying on playlist behavior.
3. **Queue and player:** implement the simpler queue plan, writer loop, typed issues, playback evidence, recovery and cancellation. Test races through scripted barriers. Do not preserve mutable flag machinery under Effect wrappers.
4. **Binary/install/settings:** retain useful catalog data, replace manual lifetimes/persistence, expose terminal states and warnings. Installation must remain independent of playback cancellation.
5. **Boundary and renderer:** compose one main runtime, migrate all consumers and the authentication bridge, implement subscription handshake and quit handling. Remove old Player/MpvClient/MpvQueueMirror wrappers and now-unused player helpers. Keep SerialQueue elsewhere if still used by the renderer queue manager.
6. **Acceptance:** run shared build, desktop typecheck/lint and relevant desktop tests, then workspace typecheck/tests for affected integrations. Run the opt-in real mpv smoke and manually exercise missing binary, failed media, rapid selection/seek/stop, logout, install cancellation and quit during startup. Record skipped platform checks explicitly.

Done means no unowned player fibers/promises/timers, no pending command left hanging after failure/shutdown, snapshots that express loading/recovery/disconnection honestly, actionable errors without parsing text, scoped logs without secrets, and all renderer consumers on the new contract. See the accompanying notes for implementation differences and validation results.
