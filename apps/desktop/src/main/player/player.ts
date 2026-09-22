import { Cause, Context, Deferred, Effect, Exit, Fiber, FiberHandle, Layer, Queue, Redacted, Result, Scope, Stream, SubscriptionRef } from "effect";
import { clonePlaybackItem, type PlaybackItem } from "@muswag/shared";
import { initialSnapshot, type CommandAck, type Media, type PlayerCommand, type PlayerCredentials, type PlayerIssue, type PlayerSnapshot, type Selection } from "#shared/player-contract";
import { Binaries } from "./binary/binaries";
import { Installer, type InstallProgress } from "./binary/installer";
import {
  BinaryUnavailable,
  Busy,
  CommandFailed,
  CommandRejected,
  EngineError,
  InternalError,
  InvalidCommand,
  issue,
  SettingsFailed,
  ShuttingDown,
  safeCause,
  safeFailure,
  toIssue,
  type PlayerError,
} from "./errors";
import { currentMedia, isCurrentEvent, isFiniteNonNegative, isSettled, withDuration, withIssue, withPosition } from "./model";
import { applyQueue, retainsCurrent, type Correlation } from "./queue";
import { booleanProperty, command, numberProperty, type MpvCommand } from "./mpv/protocol";
import { MpvSession, type SessionEvent, type SessionHandle } from "./mpv/session";
import { defaultSettings, makeSettingsWriter, SettingsStore, type Settings } from "./settings";
import { resolveStreamUrls } from "./stream-source";

const MAILBOX_CAPACITY = 512;
const MAX_PENDING_COMMANDS = 32;
/** Stop and logout may exceed the command limit, so the user can always get out of a stuck state. */
const PREEMPTING_RESERVE = 2;
const LOAD_TIMEOUT = "20 seconds";
const QUEUE_TIMEOUT = "15 seconds";
const POSITION_INTERVAL = "500 millis";

export interface PlayerService {
  readonly execute: (commandId: string, command: PlayerCommand) => Effect.Effect<CommandAck, CommandFailed>;
  readonly setCredentials: (credentials: PlayerCredentials | null) => Effect.Effect<CommandAck, CommandFailed>;
  readonly snapshot: Effect.Effect<PlayerSnapshot>;
  readonly changes: Stream.Stream<PlayerSnapshot>;
  readonly shutdown: Effect.Effect<void>;
}
export class Player extends Context.Service<Player, PlayerService>()("@muswag/player/Player") {}

type Operation = PlayerCommand | { readonly _tag: "Credentials"; readonly credentials: PlayerCredentials | null };
/** Stop and logout cancel the in-flight operation and every command queued before them. */
const preempts = (operation: Operation) => operation._tag === "Stop" || operation._tag === "Credentials";
const sameCredentials = (a: PlayerCredentials | null, b: PlayerCredentials | null) =>
  a === b || (a !== null && b !== null && a.url === b.url && a.username === b.username && Redacted.value(a.password) === Redacted.value(b.password));
const reject = (error: PlayerError) => new CommandFailed({ issue: toIssue(error) });

type Request = { readonly id: string; readonly operation: Operation; readonly cancelEpoch: number; readonly reply: Deferred.Deferred<CommandAck, CommandFailed> };
/** Everything the worker fiber processes, one at a time, in arrival order. Sessions write their events here directly. */
type Message =
  | { readonly _tag: "Request"; readonly request: Request }
  | SessionEvent
  | { readonly _tag: "Position"; readonly event: SessionEvent }
  | { readonly _tag: "EngineFailed"; readonly error: EngineError; readonly generation: number }
  | { readonly _tag: "LoadTimeout"; readonly token: number }
  | { readonly _tag: "Install"; readonly progress: InstallProgress }
  | { readonly _tag: "SettingsWriteFailed" };

/** A running mpv session and the state that is only meaningful while it lives. */
interface Engine {
  readonly session: SessionHandle;
  readonly scope: Scope.Closeable;
  correlation: Correlation | null;
  /** Property observations up to this sequence predate a value we set and read back, so they are stale. */
  propertyFence: number;
}

/**
 * The player is an actor: commands, mpv events and timers are posted to one mailbox and handled
 * sequentially by a single worker fiber, which is the only writer of the state below.
 */
export const PlayerLive = Layer.effect(
  Player,
  Effect.gen(function* () {
    const sessions = yield* MpvSession;
    const binaries = yield* Binaries;
    const installer = yield* Installer;
    const store = yield* SettingsStore;
    const owner = yield* Effect.scope;

    const mailbox = yield* Queue.bounded<Message>(MAILBOX_CAPACITY);
    const post = (message: Message) => Queue.offerUnsafe(mailbox, message);
    /** Positions arrive many times per second: keep only the latest and publish it at a bounded rate. */
    const positions = yield* Queue.sliding<SessionEvent>(1);

    const initial = initialSnapshot(crypto.randomUUID());
    const published = yield* SubscriptionRef.make(initial);
    let state = initial;
    yield* Effect.annotateLogsScoped({ component: "player", epoch: initial.stamp.epoch });

    let settings: Settings = defaultSettings;
    const settingsWriter = yield* makeSettingsWriter(
      store,
      Effect.sync(() => {
        post({ _tag: "SettingsWriteFailed" });
      }),
    );
    let credentials: PlayerCredentials | null = null;
    /** The queue window mirrored into mpv. */
    let items: readonly PlaybackItem[] = [];
    /** The occurrence playback should settle on: whether it should play, and where it should start. */
    let target: Selection | null = null;
    /** Whether the current occurrence was already reloaded once after a playback error. */
    let retried = false;
    let engine: Engine | null = null;
    const loadDeadline = yield* FiberHandle.make<void>();
    /** Identifies the armed load deadline, so a timeout that was already posted can be recognised as stale. */
    let loadToken = 0;

    let closing = false;
    /** Bumped by preempting operations; requests submitted under an older epoch are rejected. */
    let cancelEpoch = 0;
    const replies = new Set<Deferred.Deferred<CommandAck, CommandFailed>>();
    let abortSignal: Deferred.Deferred<never, PlayerError | EngineError> | null = null;

    // ---- State publication ----

    const publish = (next: PlayerSnapshot) =>
      Effect.suspend(() => {
        state = { ...next, stamp: { ...state.stamp, revision: state.stamp.revision + 1 } };
        return SubscriptionRef.set(published, state);
      });
    const addIssue = (problem: PlayerIssue) =>
      publish({ ...state, issues: withIssue(state.issues, problem, (existing) => existing.operation === problem.operation && existing.occurrenceKey === problem.occurrenceKey) });
    const failPlayback = Effect.fn("Player.failPlayback")(function* (problem: PlayerIssue) {
      const media = currentMedia(state);
      yield* closeEngine();
      yield* publish({
        ...state,
        playback: { _tag: "Failed", media, issue: problem },
        queue: { ...state.queue, sync: "unknown" },
        audio: { ...state.audio, applied: false },
        issues: withIssue(state.issues, problem, (existing) => existing.id === problem.id),
      });
    });
    const updateSettings = (patch: Partial<Settings>) =>
      Effect.suspend(() => {
        settings = { ...settings, ...patch };
        return settingsWriter.schedule(settings);
      });
    const commitAudio = Effect.fn("Player.commitAudio")(function* (patch: Partial<Pick<Settings, "volumePercent" | "muted">>) {
      yield* updateSettings(patch);
      yield* publish({ ...state, audio: { volumePercent: settings.volumePercent, muted: settings.muted, applied: engine !== null } });
    });

    // ---- Cancellation ----

    /** Fails the in-flight worker step, if any, with `error`. */
    const abort = (error: PlayerError | EngineError) => {
      if (abortSignal) Deferred.doneUnsafe(abortSignal, Effect.fail(error));
    };
    const abortable = <A, E>(effect: Effect.Effect<A, E>) =>
      Effect.gen(function* () {
        const signal = yield* Deferred.make<never, PlayerError | EngineError>();
        abortSignal = signal;
        return yield* effect.pipe(
          Effect.raceFirst(Deferred.await(signal)),
          Effect.ensuring(
            Effect.sync(() => {
              abortSignal = null;
            }),
          ),
        );
      });

    // ---- Engine lifecycle ----

    const clearLoadDeadline = Effect.suspend(() => {
      loadToken++;
      return FiberHandle.clear(loadDeadline);
    });
    /** Fails playback if the current occurrence does not finish loading in time. */
    const armLoadDeadline = Effect.suspend(() => {
      const token = ++loadToken;
      return FiberHandle.run(
        loadDeadline,
        Effect.sleep(LOAD_TIMEOUT).pipe(
          Effect.andThen(
            Effect.sync(() => {
              post({ _tag: "LoadTimeout", token });
            }),
          ),
        ),
      );
    });
    const closeEngine = Effect.fn("Player.closeEngine")(function* () {
      yield* clearLoadDeadline;
      const closed = engine;
      engine = null;
      if (closed) yield* Scope.close(closed.scope, Exit.void);
    });
    const ensureEngine = Effect.fn("Player.ensureEngine")(function* () {
      if (engine) return engine;
      if (state.binary._tag !== "Ready") return yield* new BinaryUnavailable({ operation: "playback", message: "Install or configure mpv before playing." });
      const scope = yield* Scope.fork(owner, "sequential");
      const session = yield* sessions.open(state.binary.path, { events: mailbox, positions }).pipe(
        Scope.provide(scope),
        Effect.onError(() => Scope.close(scope, Exit.void)),
      );
      // Forked into the engine scope, so closing the engine deliberately never reports a failure.
      yield* session.failure.pipe(
        Effect.catch((error) =>
          Effect.sync(() => {
            abort(error);
            post({ _tag: "EngineFailed", error, generation: session.generation });
          }),
        ),
        Effect.forkIn(scope),
      );
      const opened: Engine = { session, scope, correlation: null, propertyFence: 0 };
      engine = opened;
      yield* session.execute(command("set_property", "volume", settings.volumePercent));
      yield* session.execute(command("set_property", "mute", settings.muted));
      yield* publish({ ...state, audio: { ...state.audio, applied: true } });
      return opened;
    });
    /** Performs `write`, then reads back what mpv actually applied; earlier property observations become stale. */
    const writeAndConfirm = Effect.fn("Player.writeAndConfirm")(function* <A>(active: Engine, write: MpvCommand<void>, read: MpvCommand<A>): Effect.fn.Return<A, EngineError> {
      yield* active.session.execute(write);
      const value = yield* active.session.execute(read);
      active.propertyFence = active.session.sequence();
      return value;
    });

    // ---- Queue and playback ----

    const stop = Effect.fn("Player.stop")(function* () {
      yield* closeEngine();
      items = [];
      target = null;
      retried = false;
      yield* publish({ ...state, playback: { _tag: "Idle" }, queue: { revision: state.queue.revision + 1, keys: [], sync: "empty" }, audio: { ...state.audio, applied: false } });
    });
    /**
     * Mirrors `next` into mpv. A selection loads that occurrence in a fresh session, so events from the old
     * session are unambiguous; without one, the currently playing occurrence must be retained and keeps playing.
     */
    const apply = Effect.fn("Player.apply")(function* (next: readonly PlaybackItem[], selection: Selection | null) {
      if (!next.length) return yield* stop();
      if (!selection) {
        if (!engine?.correlation) return yield* new InvalidCommand({ operation: "queue", message: "Select a track to start playback." });
        if (!retainsCurrent(engine.correlation, next)) return yield* new InvalidCommand({ operation: "queue", message: "Select a track when replacing the current occurrence." });
      }
      const urls = yield* resolveStreamUrls(credentials, next);
      items = next;
      yield* publish({ ...state, queue: { ...state.queue, sync: "applying" } });
      if (selection) {
        target = selection;
        const item = next.find((item) => item.key === selection.key)!;
        yield* publish({ ...state, playback: { _tag: "Loading", media: { item, positionSeconds: selection.positionSeconds, durationSeconds: null }, targetPaused: !selection.play } });
        yield* closeEngine();
      }
      const active = yield* ensureEngine();
      if (selection) yield* active.session.execute(command("set_property", "pause", !selection.play));
      active.correlation = yield* applyQueue(active.session, active.correlation, next, selection, urls).pipe(
        Effect.timeoutOrElse({ duration: QUEUE_TIMEOUT, orElse: () => Effect.fail(new EngineError({ reason: "timeout", operation: "queue", uncertain: true })) }),
      );
      yield* publish({ ...state, queue: { revision: state.queue.revision + 1, keys: next.map((item) => item.key), sync: "synced" } });
      if (selection) yield* armLoadDeadline;
    });
    const reload = (media: Media, positionSeconds: number, play: boolean) => apply(items, { key: media.item.key, positionSeconds, play });

    const pause = Effect.fn("Player.pause")(function* (paused: boolean) {
      const media = currentMedia(state);
      if (!engine || !media) return yield* new InvalidCommand({ operation: "pause", message: "Select a playable track first." });
      const confirmed = yield* writeAndConfirm(engine, command("set_property", "pause", paused), booleanProperty("pause"));
      if (target) target = { ...target, play: !confirmed };
      if (state.playback._tag === "Loading") yield* publish({ ...state, playback: { ...state.playback, targetPaused: confirmed } });
      else yield* publish({ ...state, playback: { _tag: confirmed ? "Paused" : "Playing", media } });
    });
    /** Play and Toggle start an ended or failed track over; otherwise they only change pause. */
    const playOrPause = Effect.fn("Player.playOrPause")(function* (paused: boolean) {
      if (state.playback._tag !== "Ended" && state.playback._tag !== "Failed") return yield* pause(paused);
      const media = currentMedia(state);
      if (!media) return yield* new InvalidCommand({ operation: "play", message: "Select a track first." });
      retried = false;
      yield* closeEngine();
      yield* reload(media, 0, true);
    });
    const restart = Effect.fn("Player.restart")(function* () {
      const media = currentMedia(state);
      if (!media) return yield* new InvalidCommand({ operation: "restart", message: "Select a track first." });
      retried = false;
      yield* reload(media, 0, state.playback._tag !== "Paused");
    });
    const seek = Effect.fn("Player.seek")(function* (seconds: number) {
      const media = currentMedia(state);
      if (!engine || !media || !isSettled(state.playback)) return yield* new InvalidCommand({ operation: "seek", message: "Wait until the track has loaded." });
      const position = yield* writeAndConfirm(engine, command("seek", Math.min(seconds, media.durationSeconds ?? Infinity), "absolute+exact"), numberProperty("time-pos"));
      yield* publish(withPosition(state, position));
    });
    const setVolume = Effect.fn("Player.setVolume")(function* (percent: number) {
      const volumePercent = engine ? yield* writeAndConfirm(engine, command("set_property", "volume", percent), numberProperty("volume")) : percent;
      yield* commitAudio({ volumePercent });
    });
    const setMuted = Effect.fn("Player.setMuted")(function* (muted: boolean) {
      const confirmed = engine ? yield* writeAndConfirm(engine, command("set_property", "mute", muted), booleanProperty("mute")) : muted;
      yield* commitAudio({ muted: confirmed });
    });

    // ---- Configuration ----

    const refreshBinary = Effect.fn("Player.refreshBinary")(function* () {
      yield* publish({ ...state, binary: { _tag: "Checking" } });
      const binary = yield* binaries.resolve(settings.manualPath, settings.cachedPath);
      yield* publish({ ...state, binary });
      yield* updateSettings({ cachedPath: binary._tag === "Ready" ? binary.path : null });
    });
    const setBinaryPath = Effect.fn("Player.setBinaryPath")(function* (path: string | null) {
      const next = { ...settings, manualPath: path, cachedPath: null };
      yield* settingsWriter.save(next).pipe(Effect.mapError(() => new SettingsFailed({ operation: "path", message: "Unable to save the mpv path." })));
      settings = next;
      const media = currentMedia(state);
      const play = state.playback._tag === "Playing";
      yield* closeEngine();
      yield* refreshBinary();
      if (media) yield* reload(media, media.positionSeconds, play);
    });
    const changeCredentials = Effect.fn("Player.changeCredentials")(function* (next: PlayerCredentials | null) {
      if (sameCredentials(credentials, next)) return;
      const media = currentMedia(state);
      const play = state.playback._tag === "Playing";
      credentials = next;
      // Stream URLs embed credentials, so a session built with the old ones must not survive.
      yield* closeEngine();
      if (!credentials) yield* stop();
      else if (media) yield* reload(media, media.positionSeconds, play);
    });

    /** Resolves to the install job id for StartInstall. */
    const handleCommand = (operation: Operation) =>
      Effect.suspend((): Effect.Effect<string | void, PlayerError | EngineError> => {
        switch (operation._tag) {
          case "ApplyQueue":
            retried = false;
            return apply(operation.items, operation.select);
          case "Stop":
            return stop();
          case "Credentials":
            return changeCredentials(operation.credentials);
          case "Play":
            return playOrPause(false);
          case "Toggle":
            return playOrPause(state.playback._tag === "Playing");
          case "Pause":
            return pause(true);
          case "Restart":
            return restart();
          case "Seek":
            return seek(operation.seconds);
          case "SetVolume":
            return setVolume(operation.percent);
          case "SetMuted":
            return setMuted(operation.muted);
          case "RefreshBinary":
            return refreshBinary();
          case "SetBinaryPath":
            return setBinaryPath(operation.path);
          case "StartInstall":
            return installer.start(operation.method);
          case "CancelInstall":
            return installer.cancel(operation.jobId);
          case "DismissIssue":
            return publish({ ...state, issues: state.issues.filter((issue) => issue.id !== operation.issueId) });
        }
      });

    // ---- mpv events ----

    const onStartFile = Effect.fn("Player.onStartFile")(function* (active: Engine, correlation: Correlation, entryId: number) {
      const entry = correlation.entries.find((entry) => entry.entryId === entryId);
      if (!entry) return;
      // While recovering, only the reloaded occurrence may start.
      if (state.playback._tag === "Recovering" && target?.key !== entry.key) return;
      active.correlation = { ...correlation, currentId: entry.entryId };
      if (currentMedia(state)?.item.key !== entry.key) {
        // mpv advanced by itself: follow it from the start, keeping the play/pause intent.
        retried = false;
        target = { key: entry.key, play: state.playback._tag !== "Paused", positionSeconds: 0 };
      }
      const positionSeconds = target?.key === entry.key ? target.positionSeconds : 0;
      yield* publish({ ...state, playback: { _tag: "Loading", media: { item: clonePlaybackItem(entry), positionSeconds, durationSeconds: null }, targetPaused: !(target?.play ?? true) } });
      yield* armLoadDeadline;
    });
    /** Restores the target position and pause state; only then is the track reported as playing or paused. */
    const onFileLoaded = Effect.fn("Player.onFileLoaded")(function* (active: Engine) {
      if (state.playback._tag !== "Loading") return;
      const { media, targetPaused } = state.playback;
      if (target && target.positionSeconds > 0) yield* active.session.execute(command("seek", target.positionSeconds, "absolute+exact"));
      const paused = yield* writeAndConfirm(active, command("set_property", "pause", targetPaused), booleanProperty("pause"));
      yield* clearLoadDeadline;
      if (target) target = { ...target, positionSeconds: 0 };
      yield* publish({ ...state, playback: { _tag: paused ? "Paused" : "Playing", media }, issues: state.issues.filter((issue) => issue.occurrenceKey !== media.item.key) });
    });
    const onEndFile = Effect.fn("Player.onEndFile")(function* (correlation: Correlation, entryId: number, reason: string) {
      const media = currentMedia(state);
      if (reason === "eof") {
        // Only the last entry ending exhausts the window; otherwise mpv advances by itself.
        if (media && correlation.entries.at(-1)?.entryId === entryId)
          yield* publish({ ...state, playback: { _tag: "Ended", media: { ...media, positionSeconds: media.durationSeconds ?? media.positionSeconds } } });
      } else if (reason === "error") {
        if (!media || retried) return yield* failPlayback(issue("PlaybackFailed", "playback", "The track could not be played after retrying.", media?.item.key));
        retried = true;
        const play = target?.play ?? true;
        yield* publish({ ...state, playback: { _tag: "Recovering", media, attempt: 1 } });
        yield* Effect.logWarning("Reloading failed media", { occurrenceKey: media.item.key, attempt: 1 });
        yield* closeEngine();
        yield* reload(media, media.positionSeconds, play);
      }
    });
    const onPropertyChange = (name: string, data: unknown, fresh: boolean) =>
      Effect.suspend(() => {
        const media = currentMedia(state);
        if (!media) return Effect.void;
        if (name === "duration" && isFiniteNonNegative(data)) return publish(withDuration(state, data));
        if (name === "pause" && fresh && typeof data === "boolean" && isSettled(state.playback)) return publish({ ...state, playback: { _tag: data ? "Paused" : "Playing", media } });
        return Effect.void;
      });
    const handleEvent = Effect.fn("Player.handleEvent")(function* (message: SessionEvent) {
      const active = engine;
      const correlation = active?.correlation;
      if (!active || !correlation || message.generation !== active.session.generation) return;
      const { event } = message;
      const fresh = message.sequence > active.propertyFence;
      if (event.type === "start-file") return yield* onStartFile(active, correlation, event.entryId);
      // Audio preferences belong to the session, not to the current entry.
      if (event.type === "property" && (event.name === "volume" || event.name === "mute")) {
        if (!fresh) return;
        if (event.name === "volume" && isFiniteNonNegative(event.data) && event.data <= 100) yield* commitAudio({ volumePercent: event.data });
        else if (event.name === "mute" && typeof event.data === "boolean") yield* commitAudio({ muted: event.data });
        return;
      }
      if (!isCurrentEvent(message, active.session.generation, correlation.currentId)) return;
      if (event.type === "file-loaded") yield* onFileLoaded(active);
      else if (event.type === "end-file") yield* onEndFile(correlation, event.entryId, event.reason);
      else if (event.type === "property") yield* onPropertyChange(event.name, event.data, fresh);
    });
    // Deliberately untraced: this runs twice a second.
    const publishPosition = (message: SessionEvent) =>
      Effect.suspend(() => {
        const { event } = message;
        const current = engine && message.sequence > engine.propertyFence && isCurrentEvent(message, engine.session.generation, engine.correlation?.currentId ?? null);
        if (!current || event.type !== "property" || typeof event.data !== "number" || !Number.isFinite(event.data) || !isSettled(state.playback)) return Effect.void;
        return publish(withPosition(state, event.data));
      });
    const applyInstallProgress = Effect.fn("Player.applyInstallProgress")(function* ({ state: install, output }: InstallProgress) {
      const previous = state.install;
      yield* publish({ ...state, install, installOutput: output });
      const newlySucceeded = install._tag === "Succeeded" && !(previous._tag === "Succeeded" && previous.jobId === install.jobId);
      if (newlySucceeded) yield* refreshBinary();
    });

    // ---- Failure reporting ----

    /** Whether a failure leaves playback in a state we cannot vouch for, so it must end rather than only add an issue. */
    const endsPlayback = (error: PlayerError | EngineError, operation: string): boolean => {
      if (state.queue.sync === "applying" || operation === "Credentials" || operation === "SetBinaryPath") return true;
      switch (error._tag) {
        case "EngineError":
          return error.uncertain || operation === "event";
        case "QueueOutOfSync":
          return true;
        default:
          return false;
      }
    };
    /** Records a failure as an issue and returns it. */
    const report = Effect.fn("Player.report")(function* (error: PlayerError | EngineError, operation: string) {
      const problem = toIssue(error, operation, currentMedia(state)?.item.key ?? null);
      yield* Effect.logWarning("Player operation failed", safeFailure(error));
      yield* endsPlayback(error, operation) ? failPlayback(problem) : addIssue(problem);
      if (error._tag === "EngineError" && error.reason === "spawn") {
        // The resolved binary no longer runs: forget it and search again.
        yield* updateSettings({ cachedPath: null });
        yield* refreshBinary();
      }
      return problem;
    });

    // ---- Worker ----

    const runRequest = Effect.fn("Player.command")(function* ({ id, operation, cancelEpoch: epoch }: Request): Effect.fn.Return<CommandAck, CommandFailed> {
      const tag = operation._tag;
      yield* Effect.annotateCurrentSpan({ commandId: id, command: tag });
      if (epoch !== cancelEpoch && !preempts(operation)) return yield* reject(new CommandRejected({ operation: tag, message: "The command was cancelled by stop or logout." }));
      yield* publish({ ...state, pending: { commandId: id, kind: tag } });
      const exit = yield* abortable(handleCommand(operation)).pipe(Effect.annotateLogs({ commandId: id, command: tag }), Effect.exit);
      yield* publish({ ...state, pending: null });
      if (Exit.isSuccess(exit)) {
        yield* Effect.logInfo("Player command completed").pipe(Effect.annotateLogs({ commandId: id, command: tag, revision: state.stamp.revision }));
        return { commandId: id, stamp: state.stamp, jobId: exit.value ?? null };
      }
      const failure = Cause.findError(exit.cause);
      if (Result.isSuccess(failure)) return yield* new CommandFailed({ issue: yield* report(failure.success, tag) });
      yield* Effect.logError("Player defect", { operation: tag, cause: safeCause(exit.cause) });
      const problem = issue("InternalError", tag, "An unexpected player error occurred.");
      yield* failPlayback(problem);
      return yield* new CommandFailed({ issue: problem });
    });
    const handleMessage = (message: Message): Effect.Effect<void> => {
      switch (message._tag) {
        case "Request":
          return runRequest(message.request).pipe(
            Effect.exit,
            Effect.flatMap((exit) => Deferred.done(message.request.reply, exit)),
            Effect.ensuring(Effect.sync(() => replies.delete(message.request.reply))),
          );
        case "SessionEvent":
          return abortable(handleEvent(message)).pipe(
            Effect.catch((error) => report(error, "event")),
            Effect.asVoid,
          );
        case "Position":
          return publishPosition(message.event);
        case "EngineFailed":
          return engine?.session.generation === message.generation ? Effect.asVoid(report(message.error, "engine")) : Effect.void;
        case "LoadTimeout":
          return message.token === loadToken && state.playback._tag === "Loading"
            ? failPlayback(issue("PlaybackFailed", "load", "The track did not finish loading.", currentMedia(state)?.item.key))
            : Effect.void;
        case "Install":
          return applyInstallProgress(message.progress);
        case "SettingsWriteFailed":
          return addIssue(issue("SettingsFailed", "settings", "Playback preferences could not be saved."));
      }
    };
    const failPendingReplies = (error: PlayerError) =>
      Effect.gen(function* () {
        for (const reply of replies) yield* Deferred.fail(reply, reject(error));
        replies.clear();
      });

    const initialize = Effect.fn("Player.initialize")(function* () {
      settings = yield* store.load.pipe(
        Effect.catch(() => addIssue(issue("SettingsFailed", "settings", "Stored preferences could not be read; defaults are in use.")).pipe(Effect.as(defaultSettings))),
      );
      yield* publish({ ...state, audio: { volumePercent: settings.volumePercent, muted: settings.muted, applied: false } });
      yield* refreshBinary();
    });
    const worker = yield* initialize().pipe(
      Effect.andThen(Effect.forever(Queue.take(mailbox).pipe(Effect.flatMap(handleMessage)))),
      Effect.catchCause((cause) =>
        Effect.gen(function* () {
          yield* Effect.logError("Player worker failed", { cause: safeCause(cause) });
          yield* failPlayback(issue("InternalError", "worker", "The player stopped unexpectedly. Restart the application."));
          closing = true;
          yield* failPendingReplies(new InternalError({ operation: "worker", message: "The player is unavailable." }));
        }),
      ),
      Effect.forkScoped,
    );
    yield* Queue.take(positions).pipe(
      Effect.flatMap((event) => Queue.offer(mailbox, { _tag: "Position", event })),
      Effect.andThen(Effect.sleep(POSITION_INTERVAL)),
      Effect.forever,
      Effect.forkScoped,
    );
    // Install output can be chatty; the worker only needs the latest progress.
    yield* installer.changes.pipe(
      Stream.buffer({ capacity: 1, strategy: "sliding" }),
      Stream.runForEach((progress) => Queue.offer(mailbox, { _tag: "Install", progress })),
      Effect.forkScoped,
    );

    // ---- Public API ----

    const submit = Effect.fn("Player.submit")(function* (id: string, operation: Operation) {
      if (closing) return yield* reject(new ShuttingDown({ operation: operation._tag, message: "The player is shutting down." }));
      if (replies.size >= MAX_PENDING_COMMANDS + (preempts(operation) ? PREEMPTING_RESERVE : 0))
        return yield* reject(new Busy({ operation: operation._tag, message: "The player is busy. Try again shortly." }));
      if (preempts(operation)) {
        cancelEpoch++;
        abort(new CommandRejected({ operation: "cancel", message: "Playback operation cancelled." }));
      }
      const reply = yield* Deferred.make<CommandAck, CommandFailed>();
      replies.add(reply);
      yield* Queue.offer(mailbox, { _tag: "Request", request: { id, operation, cancelEpoch, reply } });
      return yield* Deferred.await(reply);
    });
    const shutdown = Effect.gen(function* () {
      if (state.lifecycle === "closed") return;
      closing = true;
      yield* Fiber.interrupt(worker);
      yield* publish({ ...state, lifecycle: "closing", pending: null });
      yield* failPendingReplies(new ShuttingDown({ operation: "shutdown", message: "The player is shutting down." }));
      if (state.install._tag === "Running" || state.install._tag === "Cancelling") yield* installer.cancel(state.install.jobId);
      yield* closeEngine();
      yield* settingsWriter.flush;
      yield* publish({ ...state, lifecycle: "closed", playback: { _tag: "Idle" }, audio: { ...state.audio, applied: false } });
    }).pipe(Effect.withSpan("Player.shutdown"));
    yield* Effect.addFinalizer(() => shutdown);

    return {
      execute: submit,
      setCredentials: (next) => submit(crypto.randomUUID(), { _tag: "Credentials", credentials: next }),
      snapshot: SubscriptionRef.get(published),
      changes: SubscriptionRef.changes(published),
      shutdown,
    } satisfies PlayerService;
  }),
);
