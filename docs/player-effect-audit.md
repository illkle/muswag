# Player Effect audit

## Scope and version

Reviewed the rewritten main-process player, binary discovery/installation, settings,
mpv protocol/transport, and the Electron IPC runtime boundary. This project pins
Effect and `@effect/platform-node` to `4.0.0-rc.112`.

The v3 examples using `@effect/platform/Command` and `NodeContext` correspond to
`effect/unstable/process/ChildProcess`, `ChildProcessSpawner`, and
`@effect/platform-node/NodeServices` in this version. The installed platform source
was checked for process-group cleanup, Windows taskkill, termination escalation,
socket resource ownership, and environment inheritance.

## Changes

| Area          | Implementation after audit                                                                                                                                                                                            |
| ------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Binary probes | Scoped `ChildProcessSpawner.spawn`; concurrent stdout/stderr streams and exit status; bounded capture; Effect timeout and platform error mapping.                                                                     |
| Installer     | Injected `ChildProcessSpawner`; scoped process termination with `forceKillAfter`; concurrent output streams; `SubscriptionRef` state; `Semaphore` admission; interruption publishes Cancelled after resource release. |
| mpv process   | Scoped `ChildProcess` with output ignored, avoiding credential-bearing native output. Platform spawner owns process groups and termination.                                                                           |
| mpv socket    | `NodeSocket.makeNet`, scoped reader/writer, `Schedule` startup retry, `Deferred` readiness/failure, bounded `Queue`. No reconnect after an established connection fails.                                              |
| Filesystem    | Injected `FileSystem` for discovery and socket cleanup; existing Effect filesystem/path services for atomic settings writes. Existence checks nominate candidates; the version command verifies executability.        |
| Protocol      | `Schema.fromJsonString` and effectful schema decoders. Diagnostics identify the decoding stage or command without including payloads.                                                                                 |
| Stream URLs   | `Schema.URLFromString` and protocol refinement before shared URL construction.                                                                                                                                        |
| Commands      | Tagged schemas, typed failures, queue admission, deferred replies, scoped cancellation, complete revisioned snapshots.                                                                                                |
| Composition   | One `NodeServices.layer` at the player composition root. Tests replace platform services instead of monkeypatching native spawn.                                                                                      |

There are **no `Effect.try`, `Effect.tryPromise`, or `Effect.callback` calls** in the
production player directory after this audit, and no direct child-process,
filesystem, or socket imports. This is an audit result, not a ban on justified
foreign API adapters elsewhere.

## Deliberately retained boundaries

- Electron owns the application's event loop and shutdown. `ManagedRuntime` bridges
  its Promise-based IPC handlers to Effect. `NodeRuntime.runMain` belongs at a
  standalone executable entry point; putting it inside an Electron service would
  introduce a competing process lifecycle.
- Node crypto implements Subsonic's MD5 signing. OS/path/environment reads configure
  discovery; these synchronous operations are not asynchronous resources.
- Queue correlation, version parsing, and state projections remain ordinary pure
  TypeScript. Mutable session state has a single owner; wrapping every local value
  in a Ref would not add concurrency protection.
- The socket's synchronous handler preserves byte ordering and performs bounded
  newline framing. `Queue.offerUnsafe` is intentional at that foreign callback
  boundary so overflow fails the connection instead of spawning waiting producers.
- Session callbacks bridge into the player's bounded mailbox. Deferred completion
  and queue offers there are synchronous and bounded. Scoped effects own all work.
- Installer framing uses `Stream.mapAccum` instead of unbounded `splitLines`.
  It retains at most 8192 characters per unfinished line, redacts complete URLs
  across chunk boundaries, and flushes the final line before terminal status.

## Protocol regression

mpv omits `data` from unavailable `property-change` notifications, including
startup observations. Requiring that field caused an otherwise healthy session to
fail with `EngineError { reason: "protocol", operation: "decode" }`. The decoder
now accepts omitted data. Events are identified before response fields because
mpv events may also contain an `error` field. Malformed recognized messages still
fail, with bounded stage names such as `decode:property-change`.

See [mpv's event serializer](https://github.com/mpv-player/mpv/blob/master/player/client.c)
and the [Effect v4 migration guide](https://github.com/Effect-TS/effect-smol/blob/main/migration/v3-to-v4.md).

## Verification

Regression coverage includes unavailable initial observations, event/reply
classification, malformed-message diagnostics, concurrent request correlation,
request timeout, process spawn failure/timeout, real local socket framing/cleanup,
installer cancellation and job isolation, and bounded/redacted output.
Existing player runtime tests cover stop during pending work, stale events,
queue correlation, restore failure, and bounded playback retry.

The opt-in real-mpv smoke test still requires an installed mpv binary. Native
Windows behavior requires Windows CI/manual verification.
