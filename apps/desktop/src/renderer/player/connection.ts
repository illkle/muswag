import { createStore } from "@tanstack/react-store";
import type { SessionCredentials } from "@muswag/shared";
import { Context, Data, type Duration, Effect, Layer, ManagedRuntime, Queue, Schedule, Schema } from "effect";
import type { ApplyMpvQueueInput, MpvInstallMethod, PlayerRuntimeState } from "#shared/player";
import { CommandResult, initialSnapshot, PlayerSnapshot, type InstallOutput, type PlayerCommand, type PlayerIssue } from "#shared/player-contract";
import { mainIpc, rendererIpc } from "#/lib/ipc";
import { acceptSnapshot, binaryView, runtimeView } from "./snapshot";

const REQUEST_TIMEOUT = "5 seconds";
const COMMAND_TIMEOUT = "45 seconds";
const HEALTH_CHECK_INTERVAL = "3 seconds";

/** Main did not answer, answered with something undecodable, or the connection is known to be down. */
export class Disconnected extends Data.TaggedError("Disconnected")<{ readonly message: string }> {}
/** Main rejected a command; `issue` is also recorded in the snapshot. */
export class CommandFailed extends Data.TaggedError("CommandFailed")<{ readonly issue: PlayerIssue; readonly message: string }> {}

/** React-facing state: the latest authoritative snapshot from main, connection health, and the most recent command failure. */
export const PlayerConnectionStore = createStore({ snapshot: initialSnapshot("unconnected"), connected: false, issue: null as PlayerIssue | null });

/** Sends a request to main and decodes the reply. Any failure along the way means the connection is unhealthy. */
const request = <A, I>(schema: Schema.Codec<A, I>, send: () => Promise<unknown>, timeout: Duration.Input | null = REQUEST_TIMEOUT) => {
  const sent = Effect.tryPromise({ try: send, catch: () => new Disconnected({ message: "Playback connection failed." }) });
  return (timeout === null ? sent : sent.pipe(Effect.timeoutOrElse({ duration: timeout, orElse: () => Effect.fail(new Disconnected({ message: "Playback connection timed out." })) }))).pipe(
    Effect.flatMap((reply) => Schema.decodeUnknownEffect(schema)(reply)),
    Effect.mapError((error) => (error instanceof Disconnected ? error : new Disconnected({ message: "Playback sent an unexpected reply." }))),
  );
};

export class PlayerConnection extends Context.Service<
  PlayerConnection,
  {
    readonly dispatch: (command: PlayerCommand) => Effect.Effect<PlayerSnapshot, CommandFailed | Disconnected>;
    /** Resends the command behind `issueId` if it was the latest failure, otherwise just plays. */
    readonly retry: (issueId: string) => Effect.Effect<PlayerSnapshot, CommandFailed | Disconnected>;
    readonly setCredentials: (credentials: SessionCredentials | null) => Effect.Effect<PlayerSnapshot, CommandFailed | Disconnected>;
    /** Lets the user pick an mpv binary; resolves with the current snapshot when they cancel. */
    readonly locate: Effect.Effect<PlayerSnapshot, CommandFailed | Disconnected>;
    readonly fetchSnapshot: Effect.Effect<PlayerSnapshot, Disconnected>;
  }
>()("@muswag/renderer/PlayerConnection") {}

/**
 * Keeps `PlayerConnectionStore` in sync with main. A subscription establishes the player's epoch; pushes are
 * acknowledged one at a time; a periodic health check re-subscribes when main restarted or stopped answering.
 */
export const PlayerConnectionLive = Layer.effect(
  PlayerConnection,
  Effect.gen(function* () {
    /** Pushes for any other (older) subscription are ignored. */
    let subscriptionId = "";
    /** Epoch of the main-process player this subscription is bound to; empty until `subscribe` resolves. */
    let epoch = "";
    /** A push that arrived before `subscribe` resolved and established the epoch. */
    let earlyPush: PlayerSnapshot | null = null;
    let failedCommand: { command: PlayerCommand; issueId: string } | null = null;

    const accept = (incoming: PlayerSnapshot) =>
      Effect.sync(() => {
        PlayerConnectionStore.setState((state) => ({ ...state, snapshot: acceptSnapshot(state.snapshot, incoming, epoch), connected: true }));
      });
    const markDisconnected = Effect.sync(() => {
      PlayerConnectionStore.setState((state) => ({ ...state, connected: false }));
    });

    const subscribe = Effect.gen(function* () {
      const id = crypto.randomUUID();
      subscriptionId = id;
      epoch = "";
      earlyPush = null;
      const snapshot = yield* request(PlayerSnapshot, () => mainIpc.invoke("player:subscribe", id));
      if (id !== subscriptionId) return;
      epoch = snapshot.stamp.epoch;
      yield* accept(snapshot);
      if (earlyPush) yield* accept(earlyPush);
    });
    const checkHealth = Effect.gen(function* () {
      if (!PlayerConnectionStore.state.connected) return yield* subscribe;
      const snapshot = yield* request(PlayerSnapshot, () => mainIpc.invoke("player:getSnapshot"));
      if (snapshot.stamp.epoch === epoch) yield* accept(snapshot);
      else yield* subscribe;
    }).pipe(Effect.catch(() => markDisconnected));

    const onPush = Effect.fnUntraced(function* ({ subscriptionId: id, snapshot }: { subscriptionId: string; snapshot: unknown }) {
      if (id !== subscriptionId) return;
      yield* Schema.decodeUnknownEffect(PlayerSnapshot)(snapshot).pipe(
        Effect.flatMap((decoded) =>
          epoch
            ? accept(decoded)
            : Effect.sync(() => {
                earlyPush = decoded;
              }),
        ),
        Effect.catch(() => markDisconnected),
      );
      // Main sends the next snapshot only after this acknowledgement.
      yield* request(Schema.Unknown, () => mainIpc.invoke("player:ackSnapshot", id)).pipe(Effect.catch(() => markDisconnected));
    });
    // Registered before the first subscribe, so no push can arrive unobserved (and unacknowledged).
    const inbox = yield* Queue.unbounded<{ subscriptionId: string; snapshot: unknown }>();
    yield* Effect.acquireRelease(
      Effect.sync(() =>
        rendererIpc.on("player:snapshot", (_event, message) => {
          Queue.offerUnsafe(inbox, message);
        }),
      ),
      (unlisten) => Effect.sync(unlisten),
    );
    yield* Queue.take(inbox).pipe(Effect.flatMap(onPush), Effect.forever, Effect.forkScoped);
    yield* checkHealth.pipe(Effect.repeat(Schedule.spaced(HEALTH_CHECK_INTERVAL)), Effect.forkScoped);

    const unsubscribe = () => void mainIpc.invoke("player:unsubscribe", subscriptionId).catch(() => {});
    yield* Effect.acquireRelease(
      Effect.sync(() => window.addEventListener("beforeunload", unsubscribe)),
      () =>
        Effect.sync(() => {
          window.removeEventListener("beforeunload", unsubscribe);
          unsubscribe();
        }),
    );

    /** Applies a command result's snapshot; a rejected command fails with its issue. */
    const acceptResult = Effect.fnUntraced(function* (result: CommandResult) {
      if (epoch) yield* accept(result.snapshot);
      PlayerConnectionStore.setState((state) => ({ ...state, issue: result.ok ? null : result.issue }));
      if (!result.ok) return yield* new CommandFailed({ issue: result.issue, message: result.issue.message });
      return result.snapshot;
    });
    const dispatch = Effect.fn("PlayerConnection.dispatch")(function* (command: PlayerCommand) {
      if (!PlayerConnectionStore.state.connected) return yield* new Disconnected({ message: "Playback is disconnected. Reconnecting…" });
      const result = yield* request(CommandResult, () => mainIpc.invoke("player:command", crypto.randomUUID(), command), COMMAND_TIMEOUT).pipe(Effect.tapError(() => markDisconnected));
      if (!result.ok) failedCommand = { command, issueId: result.issue.id };
      return yield* acceptResult(result);
    });

    return {
      dispatch,
      retry: (issueId) => dispatch(failedCommand?.issueId === issueId ? failedCommand.command : { _tag: "Play" }),
      setCredentials: Effect.fn("PlayerConnection.setCredentials")(function* (credentials: SessionCredentials | null) {
        return yield* acceptResult(yield* request(CommandResult, () => mainIpc.invoke("player:setCredentials", credentials), COMMAND_TIMEOUT));
      }),
      // No timeout: this waits on a file dialog.
      locate: Effect.gen(function* () {
        const result = yield* request(Schema.NullOr(CommandResult), () => mainIpc.invoke("player:locate"), null);
        return result ? yield* acceptResult(result) : PlayerConnectionStore.state.snapshot;
      }),
      fetchSnapshot: request(PlayerSnapshot, () => mainIpc.invoke("player:getSnapshot")),
    };
  }),
);

// ---- Promise facades for React components and the queue manager ----

const runtime = ManagedRuntime.make(PlayerConnectionLive);
const run = <A, E>(use: (connection: typeof PlayerConnection.Service) => Effect.Effect<A, E>) => runtime.runPromise(PlayerConnection.use(use));
const execute = (command: PlayerCommand) => run((connection) => Effect.asVoid(connection.dispatch(command)));

/** Starts the connection (idempotent). */
export function initializePlayerConnection() {
  void run(() => Effect.void);
}

export const MpvIPC = {
  cancelInstall: async () => {
    const install = PlayerConnectionStore.state.snapshot.install;
    if (install._tag !== "Idle") await execute({ _tag: "CancelInstall", jobId: install.jobId });
  },
  clearManualPath: async () => binaryView(await run((connection) => connection.dispatch({ _tag: "SetBinaryPath", path: null }))),
  install: async (method: MpvInstallMethod) => binaryView(await run((connection) => connection.dispatch({ _tag: "StartInstall", method }))),
  locate: async () => binaryView(await run((connection) => connection.locate)),
  recheck: async () => binaryView(await run((connection) => connection.dispatch({ _tag: "RefreshBinary" }))),
  /** Calls `listener` once for every install output line not yet seen, across snapshots. */
  subscribeInstallOutput: (listener: (output: InstallOutput) => void) => {
    let job = "";
    let sequence = 0;
    const notify = () => {
      for (const output of PlayerConnectionStore.state.snapshot.installOutput) {
        if (output.jobId !== job) {
          job = output.jobId;
          sequence = 0;
        }
        if (output.sequence > sequence) {
          sequence = output.sequence;
          listener(output);
        }
      }
    };
    const subscription = PlayerConnectionStore.subscribe(notify);
    notify();
    return () => subscription.unsubscribe();
  },
};

export const PlayerIPC = {
  applyQueue: ({ snapshot, select }: ApplyMpvQueueInput) => execute({ _tag: "ApplyQueue", items: snapshot.items, select: select ? { ...select, positionSeconds: select.positionSeconds ?? 0 } : null }),
  getRuntimeState: async () => runtimeView(await run((connection) => connection.fetchSnapshot)),
  pause: () => execute({ _tag: "Pause" }),
  play: () => execute({ _tag: "Play" }),
  restartCurrent: () => execute({ _tag: "Restart" }),
  stop: () => execute({ _tag: "Stop" }),
  toggle: () => execute({ _tag: "Toggle" }),
  seek: (seconds: number) => execute({ _tag: "Seek", seconds }),
  setVolume: (percent: number) => execute({ _tag: "SetVolume", percent }),
  setMuted: (muted: boolean) => execute({ _tag: "SetMuted", muted }),
  setCredentials: (credentials: SessionCredentials | null) => run((connection) => Effect.asVoid(connection.setCredentials(credentials))),
  retryIssue: (issueId: string) => run((connection) => Effect.asVoid(connection.retry(issueId))),
  dismissIssue: async (issueId: string) => {
    await execute({ _tag: "DismissIssue", issueId });
    PlayerConnectionStore.setState((state) => ({ ...state, issue: state.issue?.id === issueId ? null : state.issue }));
  },
  /** Notifies `listener` whenever the authoritative snapshot changes. */
  subscribeRuntime: (listener: (state: PlayerRuntimeState) => void) => {
    let previous = PlayerConnectionStore.state.snapshot;
    const subscription = PlayerConnectionStore.subscribe(() => {
      const { snapshot } = PlayerConnectionStore.state;
      if (snapshot === previous) return;
      previous = snapshot;
      listener(runtimeView(snapshot));
    });
    return () => subscription.unsubscribe();
  },
};
