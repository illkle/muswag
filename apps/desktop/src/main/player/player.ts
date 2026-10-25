import { Cause, Clock, Context, Deferred, Effect, Exit, Fiber, FiberHandle, Layer, Queue, Redacted, Result, Scope, Stream, SubscriptionRef } from "effect";
import { clonePlaybackItem, type PlaybackItem } from "@muswag/model";
import { MemoryMirror } from "@muswag/tanstack-db-mirror/server/memory";
import { initialSnapshot, type Media, type MpvInstallMethod, type Playback, type PlayerCommand, type PlayerCredentials, type PlayerSnapshot, type Selection } from "#shared/commands/player";
import { player as playerTable, playerPosition, playerPositionRow, playerRow, positionAt } from "#shared/state/player";
import { Binaries } from "./binary/binaries";
import { BinaryUnavailable, CommandFailed, describeFailure, EngineError, InternalError, InvalidCommand, PlaybackFailed, SettingsFailed, safeCause, safeFailure, type PlayerFailure } from "./errors";
import { currentMedia, isCurrentEvent, isFiniteNonNegative, isHeldPaused, isSettled, withDuration, withoutError, withPosition, withPositionAt } from "./model";
import { applyQueue, currentEntry, retainsCurrent, type Correlation } from "./queue";
import { booleanProperty, command, numberProperty, type MpvCommand } from "./mpv/protocol";
import { MpvSession, type SessionEvent, type SessionHandle } from "./mpv/session";
import { defaultSettings, makeSettingsWriter, SettingsStore, type Settings } from "./settings";
import { resolveStreamUrls } from "./stream-source";

/**
 * A backstop for loads that never finish. mpv itself gives up on a connection that stops sending data, so
 * this must outlast slow but progressing loads: a large tag at the start of a long file (embedded cover
 * art, say) can take a minute to download from a slow server before the first audio frame.
 */
const LOAD_TIMEOUT = "2 minutes";
const QUEUE_TIMEOUT = "15 seconds";
/** How long `position` waits for mpv before answering with where the state says playback is. Quitting gives saving it two seconds. */
const POSITION_READ_TIMEOUT = "1 second";

/** Where the player is in the occurrence `key`. */
export type PlayerPosition = { readonly key: string; readonly positionSeconds: number };

export interface PlayerService {
  /** Runs `command` after those sent before it. What it fails with is also the `error` of the state. */
  readonly execute: (command: PlayerCommand) => Effect.Effect<void, CommandFailed>;
  readonly setCredentials: (credentials: PlayerCredentials | null) => Effect.Effect<void, CommandFailed>;
  /**
   * Where the player is in the occurrence it holds, read from mpv while the track is loaded. The state
   * says where the track was at a moment, which is all renderers need; this is where it is now.
   */
  readonly position: Effect.Effect<PlayerPosition | null>;
  readonly snapshot: Effect.Effect<PlayerSnapshot>;
  readonly changes: Stream.Stream<PlayerSnapshot>;
  readonly shutdown: Effect.Effect<void>;
}
export class Player extends Context.Service<Player, PlayerService>()("@muswag/player/Player") {}

/** What the worker runs, one at a time. Opening a terminal is not among them: see `openInstallTerminal`. */
type Operation = Exclude<PlayerCommand, { readonly _tag: "OpenInstallTerminal" }> | { readonly _tag: "Credentials"; readonly credentials: PlayerCredentials | null };
const sameCredentials = (a: PlayerCredentials | null, b: PlayerCredentials | null) =>
  a === b || (a !== null && b !== null && a.url === b.url && a.username === b.username && a.salt === b.salt && Redacted.value(a.token) === Redacted.value(b.token));

type Request = { readonly operation: Operation; readonly reply: Deferred.Deferred<void, CommandFailed> };
/** Everything the worker fiber processes, one at a time, in arrival order. Sessions write their events here directly. */
type Message =
  | { readonly _tag: "Request"; readonly request: Request }
  | SessionEvent
  | { readonly _tag: "ReadPosition"; readonly reply: Deferred.Deferred<PlayerPosition | null> }
  | { readonly _tag: "EngineFailed"; readonly error: EngineError; readonly generation: number }
  | { readonly _tag: "LoadTimeout"; readonly token: number }
  | { readonly _tag: "SettingsWriteFailed" };

/** A running mpv session and the state that is only meaningful while it lives. */
interface Engine {
  readonly session: SessionHandle;
  readonly scope: Scope.Closeable;
  correlation: Correlation | null;
  /**
   * The entry a selection told mpv to start. Until its start-file arrives, what mpv reports about entries
   * is about the one it is leaving, so it is ignored.
   */
  awaiting: number | null;
  /** Property observations up to this sequence predate a value we set and read back, so they are stale. */
  propertyFence: number;
  /** mpv is restarting playback after a seek or load, or paused itself to refill its cache: unpaused, it is silent. */
  seeking: boolean;
  pausedForCache: boolean;
}

/**
 * The player is an actor: commands, mpv events and timers are posted to one mailbox and handled
 * sequentially by a single worker fiber, which is the only writer of the state below. Nothing cuts a
 * step short, so Stop and logout wait for the one in flight: milliseconds as a rule, and at most the
 * timeout of what mpv or the binary check was asked.
 */
export const PlayerLive = Layer.effect(
  Player,
  Effect.gen(function* () {
    const sessions = yield* MpvSession;
    const binaries = yield* Binaries;
    const store = yield* SettingsStore;
    const stateMirror = yield* MemoryMirror;
    const owner = yield* Effect.scope;

    // Unbounded: sessions offer their events without waiting, and one that could not be taken would be lost.
    const mailbox = yield* Queue.unbounded<Message>();
    const post = (message: Message) => Queue.offerUnsafe(mailbox, message);

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
    /** Whether mpv's playlist is being changed: a failure then leaves it in a state nobody knows. */
    let applying = false;
    /** Whether the current occurrence was already reloaded once after a playback error. */
    let retried = false;
    let engine: Engine | null = null;
    const loadDeadline = yield* FiberHandle.make<void>();
    /** Identifies the armed load deadline, so a timeout that was already posted can be recognised as stale. */
    let loadToken = 0;

    /** Set once the player takes no more commands: it is shutting down, or its worker failed. */
    let closing = false;
    let shutdownStarted = false;
    const replies = new Set<Deferred.Deferred<void, CommandFailed>>();
    const positionReplies = new Set<Deferred.Deferred<PlayerPosition | null>>();

    // ---- State publication ----

    /** Writes the rows of `next`. */
    const mirror = (next: PlayerSnapshot) =>
      stateMirror
        .write(
          Effect.gen(function* () {
            yield* stateMirror.upsert(playerTable, playerRow(next));
            yield* stateMirror.upsert(playerPosition, playerPositionRow(next));
          }),
        )
        .pipe(
          // Renderers would miss this state, but playback itself must not stop over it.
          Effect.catchCause((cause) => Effect.logError("Mirroring the player state failed", cause)),
        );
    yield* mirror(initial);

    const publish = (next: PlayerSnapshot) =>
      Effect.suspend(() => {
        state = { ...next, stamp: { ...state.stamp, revision: state.stamp.revision + 1 } };
        // Mirrored first, so whoever reacts to the change finds renderers' view up to date.
        return mirror(state).pipe(Effect.andThen(SubscriptionRef.set(published, state)));
      });
    /** `next` with the current track at `positionSeconds` as of now. */
    const positioned = (next: PlayerSnapshot, positionSeconds: number) => Effect.map(Clock.currentTimeMillis, (now) => withPosition(next, positionSeconds, now));
    /** The current media, at where it has got to by now: for a state in which it no longer moves on by itself. */
    const haltedMedia = Effect.map(Clock.currentTimeMillis, (now) => currentMedia(withPositionAt(state, now)));
    /** Ends playback of the current track over `failure`, which becomes the state's error. mpv is closed, so Play starts anew. */
    const failPlayback = Effect.fn("Player.failPlayback")(function* (failure: PlayerFailure | EngineError) {
      const media = yield* haltedMedia;
      const error = describeFailure(failure);
      yield* closeEngine();
      yield* publish({
        ...state,
        playback: media ? { _tag: "Failed", media, reason: failure._tag === "PlaybackFailed" ? "track" : "player" } : { _tag: "Idle" },
        // Playing the track again is what there is to try, unless the failure names something to put right first.
        error: media && !error.fix ? { ...error, fix: "retry" } : error,
      });
    });
    const updateSettings = (patch: Partial<Settings>) =>
      Effect.suspend(() => {
        settings = { ...settings, ...patch };
        return settingsWriter.schedule(settings);
      });
    const isBuffering = () => engine !== null && (engine.seeking || engine.pausedForCache);
    /** The playback state of a loaded track; playing reports whether mpv is actually producing audio. */
    const settled = (paused: boolean, media: Media): Playback => (paused ? { _tag: "Paused", media } : { _tag: "Playing", media, buffering: isBuffering() });
    /** Keeps the volume or the mute for the sessions to come. Nothing but the player changes them in mpv, so what it was told is what mpv has. */
    const commitAudio = Effect.fn("Player.commitAudio")(function* (patch: Partial<Pick<Settings, "volumePercent" | "muted">>) {
      yield* updateSettings(patch);
      yield* publish({ ...state, volumePercent: settings.volumePercent, muted: settings.muted });
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
      const { binary } = state;
      if (binary._tag !== "Ready") return yield* new BinaryUnavailable({ operation: "playback", message: binary._tag === "Unavailable" ? binary.message : "mpv is still being checked." });
      const scope = yield* Scope.fork(owner, "sequential");
      const session = yield* sessions.open(binary.path, mailbox).pipe(
        Scope.provide(scope),
        Effect.onError(() => Scope.close(scope, Exit.void)),
      );
      // Forked into the engine scope, so closing the engine deliberately never reports a failure.
      yield* session.failure.pipe(
        Effect.catch((error) =>
          Effect.sync(() => {
            post({ _tag: "EngineFailed", error, generation: session.generation });
          }),
        ),
        Effect.forkIn(scope),
      );
      const opened: Engine = { session, scope, correlation: null, awaiting: null, propertyFence: 0, seeking: false, pausedForCache: false };
      engine = opened;
      yield* session.execute(command("set_property", "volume", settings.volumePercent));
      yield* session.execute(command("set_property", "mute", settings.muted));
      return opened;
    });
    /** Performs `write`, then reads back what mpv actually applied; earlier property observations become stale. */
    const writeAndConfirm = Effect.fn("Player.writeAndConfirm")(function* <A>(active: Engine, write: MpvCommand<void>, read: MpvCommand<A>): Effect.fn.Return<A, EngineError> {
      yield* active.session.execute(write);
      const value = yield* active.session.execute(read);
      active.propertyFence = active.session.sequence();
      return value;
    });
    /** Where mpv is in the current track. Before playback starts it may not say, and then it is where the state says. */
    const readPosition = (active: Engine) =>
      Effect.gen(function* () {
        const estimate = positionAt(playerPositionRow(state), yield* Clock.currentTimeMillis);
        return yield* active.session.execute(numberProperty("time-pos")).pipe(
          Effect.catchIf(
            (error) => !error.uncertain,
            () => Effect.succeed(estimate),
          ),
        );
      });
    /** Publishes the loaded track as playing or paused, at where mpv is in it: from there renderers move it on with the clock. */
    const publishSettled = Effect.fn("Player.publishSettled")(function* (active: Engine, paused: boolean, media: Media, patch: Partial<PlayerSnapshot> = {}) {
      const position = yield* readPosition(active);
      yield* publish(yield* positioned({ ...state, ...patch, playback: settled(paused, media) }, position));
    });

    // ---- Queue and playback ----

    /** The media of occurrence `key` while mpv has it open, loading or loaded. */
    const openMedia = (key: string): Media | null => {
      const media = state.playback._tag === "Loading" || isSettled(state.playback) ? state.playback.media : null;
      return media?.item.key === key ? media : null;
    };
    const stop = Effect.fn("Player.stop")(function* () {
      yield* closeEngine();
      items = [];
      retried = false;
      // With nothing to play, nothing that went wrong while playing is left to act on.
      yield* publish({ ...state, playback: { _tag: "Idle" }, error: null });
    });
    /**
     * Mirrors `next` into mpv, in the session that is running. A selection has mpv start that occurrence,
     * unless mpv already has it open, in which case playback only moves within it. Without a selection the
     * current occurrence must be retained and keeps playing; when mpv holds no queue, after a failure
     * say, `next` is only kept for the selection that starts playback again.
     */
    const apply = Effect.fn("Player.apply")(function* (next: readonly PlaybackItem[], selection: Selection | null) {
      if (!next.length) return yield* stop();
      const correlation = engine?.correlation ?? null;
      const item = selection ? next.find((item) => item.key === selection.key) : undefined;
      if (selection && !item) return yield* new InvalidCommand({ operation: "queue", message: "The selected track is not in the queue." });
      if (!selection) {
        const held = currentMedia(state)?.item.key;
        const retained = correlation ? retainsCurrent(correlation, next) : held === undefined || next.some((item) => item.key === held);
        if (!retained) return yield* new InvalidCommand({ operation: "queue", message: "Select a track when replacing the current occurrence." });
        if (!correlation) {
          items = next;
          return;
        }
      }
      items = next;
      const current = selection && correlation && currentEntry(correlation)?.key === selection.key && retainsCurrent(correlation, next) ? openMedia(selection.key) : null;
      const loaded = current !== null && isSettled(state.playback);
      /**
       * The selected occurrence as mpv already has it open, loading or loaded; `null` when mpv has to start
       * it. A load cannot be moved, so one that would start elsewhere is started again.
       */
      const opened = loaded || current?.positionSeconds === selection?.positionSeconds ? current : null;
      if (selection && item && !loaded) {
        // From here the player holds the selected occurrence, also when it then fails to start it.
        applying = true;
        const media: Media = { item, positionSeconds: selection.positionSeconds, positionAt: yield* Clock.currentTimeMillis, durationSeconds: opened?.durationSeconds ?? null };
        // An error about the occurrence before is not about this one, and its Retry would not retry anything.
        const error = currentMedia(state)?.item.key === item.key ? state.error : null;
        yield* publish({ ...state, error, playback: { _tag: "Loading", media, targetPaused: !selection.play } });
      }
      const urls = yield* resolveStreamUrls(credentials, next);
      applying = true;
      const active = yield* ensureEngine();
      // A load starts where the selection asks (see `load`): it is only to be paused or not.
      if (selection && !loaded) yield* active.session.execute(command("set_property", "pause", !selection.play));
      active.correlation = yield* applyQueue(active.session, active.correlation, next, opened ? null : selection, urls).pipe(
        Effect.timeoutOrElse({ duration: QUEUE_TIMEOUT, orElse: () => Effect.fail(new EngineError({ reason: "timeout", operation: "queue", uncertain: true })) }),
      );
      applying = false;
      if (!selection || !item) return;
      if (!opened) {
        active.awaiting = active.correlation.currentId;
        yield* armLoadDeadline;
      } else if (loaded) {
        const position = yield* writeAndConfirm(active, command("seek", Math.min(selection.positionSeconds, opened.durationSeconds ?? Infinity), "absolute+exact"), numberProperty("time-pos"));
        const paused = yield* writeAndConfirm(active, command("set_property", "pause", !selection.play), booleanProperty("pause"));
        yield* publish(yield* positioned({ ...state, playback: settled(paused, { ...opened, item }) }, position));
      }
    });
    const reload = (media: Media, positionSeconds: number, play: boolean) => apply(items, { key: media.item.key, positionSeconds, play });

    const pause = Effect.fn("Player.pause")(function* (paused: boolean) {
      const { playback } = state;
      if (!engine || !currentMedia(state)) return yield* new InvalidCommand({ operation: "pause", message: "Select a playable track first." });
      // A track that has ended, stopped or failed is one mpv plays nothing of, so there is nothing to pause.
      // mpv would take the pause all the same, and Play would then resume nothing.
      if (playback._tag !== "Loading" && !isSettled(playback)) return;
      const confirmed = yield* writeAndConfirm(engine, command("set_property", "pause", paused), booleanProperty("pause"));
      if (playback._tag === "Loading") yield* publish({ ...state, playback: { ...playback, targetPaused: confirmed } });
      else yield* publishSettled(engine, confirmed, playback.media);
    });
    /**
     * Play resumes a track mpv holds. One it does not hold is loaded again: an ended track from its
     * start, a failed one from where it had got to.
     */
    const play = Effect.fn("Player.play")(function* () {
      const { playback } = state;
      if (playback._tag === "Loading" || isSettled(playback)) return yield* pause(false);
      const media = currentMedia(state);
      if (!media) return yield* new InvalidCommand({ operation: "play", message: "Select a track first." });
      retried = false;
      yield* reload(media, playback._tag === "Ended" ? 0 : media.positionSeconds, true);
    });
    const restart = Effect.fn("Player.restart")(function* () {
      const media = currentMedia(state);
      if (!media) return yield* new InvalidCommand({ operation: "restart", message: "Select a track first." });
      retried = false;
      yield* reload(media, 0, !isHeldPaused(state.playback));
    });
    const seek = Effect.fn("Player.seek")(function* (seconds: number) {
      const media = currentMedia(state);
      if (!engine || !media || !isSettled(state.playback)) return yield* new InvalidCommand({ operation: "seek", message: "Wait until the track has loaded." });
      const position = yield* writeAndConfirm(engine, command("seek", Math.min(seconds, media.durationSeconds ?? Infinity), "absolute+exact"), numberProperty("time-pos"));
      yield* publish(yield* positioned(state, position));
    });
    const setVolume = Effect.fn("Player.setVolume")(function* (percent: number) {
      if (engine) yield* engine.session.execute(command("set_property", "volume", percent));
      yield* commitAudio({ volumePercent: percent });
    });
    const setMuted = Effect.fn("Player.setMuted")(function* (muted: boolean) {
      if (engine) yield* engine.session.execute(command("set_property", "mute", muted));
      yield* commitAudio({ muted });
    });

    // ---- Configuration ----

    const refreshBinary = Effect.fn("Player.refreshBinary")(function* () {
      yield* publish({ ...state, binary: { _tag: "Checking" } });
      const binary = yield* binaries.resolve(settings.manualPath, settings.cachedPath);
      // An error that asked for mpv to be set up has been answered.
      yield* publish({ ...(binary._tag === "Ready" && state.error?.fix === "mpv" ? withoutError(state) : state), binary });
      yield* updateSettings({ cachedPath: binary._tag === "Ready" ? binary.path : null });
    });
    const setBinaryPath = Effect.fn("Player.setBinaryPath")(function* (path: string | null) {
      const next = { ...settings, manualPath: path, cachedPath: null };
      yield* settingsWriter.save(next).pipe(Effect.mapError(() => new SettingsFailed({ operation: "path", message: "Unable to save the mpv path." })));
      settings = next;
      const media = yield* haltedMedia;
      const play = state.playback._tag === "Playing";
      yield* closeEngine();
      yield* refreshBinary();
      if (media) yield* reload(media, media.positionSeconds, play);
    });
    const changeCredentials = Effect.fn("Player.changeCredentials")(function* (next: PlayerCredentials | null) {
      if (sameCredentials(credentials, next)) return;
      const media = yield* haltedMedia;
      const play = state.playback._tag === "Playing";
      credentials = next;
      if (credentials && state.error?.fix === "login") yield* publish(withoutError(state));
      // Stream URLs embed credentials, so a session built with the old ones must not survive.
      yield* closeEngine();
      if (!credentials) yield* stop();
      else if (media) yield* reload(media, media.positionSeconds, play);
    });

    const handleCommand = (operation: Operation) =>
      Effect.suspend((): Effect.Effect<void, PlayerFailure | EngineError> => {
        switch (operation._tag) {
          case "ApplyQueue":
            retried = false;
            return apply(operation.items, operation.select);
          case "Stop":
            return stop();
          case "Credentials":
            return changeCredentials(operation.credentials);
          case "Play":
            return play();
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
          case "ClearBinaryPath":
            return setBinaryPath(null);
          case "DismissError":
            return publish(withoutError(state));
        }
      });

    // ---- mpv events ----

    const onStartFile = Effect.fn("Player.onStartFile")(function* (active: Engine, correlation: Correlation, entryId: number) {
      const entry = correlation.entries.find((entry) => entry.entryId === entryId);
      if (!entry) return;
      active.correlation = { ...correlation, currentId: entry.entryId };
      const { playback } = state;
      /** The load the player asked for, which says where the track should start. */
      const selected = playback._tag === "Loading" && playback.media.item.key === entry.key ? playback.media : null;
      // Otherwise mpv advanced by itself: follow it from the start, keeping the play/pause intent.
      if (currentMedia(state)?.item.key !== entry.key) retried = false;
      const media: Media = { item: clonePlaybackItem(entry), positionSeconds: selected?.positionSeconds ?? 0, positionAt: yield* Clock.currentTimeMillis, durationSeconds: null };
      yield* publish({ ...state, playback: { _tag: "Loading", media, targetPaused: isHeldPaused(playback) } });
      yield* armLoadDeadline;
    });
    /** Reports the loaded track as playing or paused. mpv started it where the load asked, and paused or not as it was told. */
    const onFileLoaded = Effect.fn("Player.onFileLoaded")(function* (active: Engine) {
      if (state.playback._tag !== "Loading") return;
      const { media, targetPaused } = state.playback;
      yield* clearLoadDeadline;
      // A track that loads is the end of whatever went wrong before it.
      yield* publishSettled(active, targetPaused, media, { error: null });
    });
    const onEndFile = Effect.fn("Player.onEndFile")(function* (correlation: Correlation, entryId: number, reason: string) {
      const media = yield* haltedMedia;
      if (reason === "eof") {
        // Only the last entry ending exhausts the window; otherwise mpv advances by itself.
        if (media && correlation.entries.at(-1)?.entryId === entryId)
          yield* publish({ ...state, playback: { _tag: "Ended", media: { ...media, positionSeconds: media.durationSeconds ?? media.positionSeconds } } });
      } else if (reason === "error") {
        if (!media || retried) return yield* failPlayback(new PlaybackFailed({ operation: "playback", message: "The track could not be played after retrying." }));
        retried = true;
        const play = !isHeldPaused(state.playback);
        yield* publish({ ...state, playback: { _tag: "Recovering", media } });
        yield* Effect.logWarning("Reloading failed media", { occurrenceKey: media.item.key });
        yield* closeEngine();
        yield* reload(media, media.positionSeconds, play);
      }
    });
    const onPropertyChange = Effect.fn("Player.onPropertyChange")(function* (active: Engine, name: string, data: unknown, fresh: boolean) {
      const { playback } = state;
      if (playback._tag === "Idle") return;
      if (name === "duration" && isFiniteNonNegative(data)) return yield* publish(withDuration(state, data));
      // mpv also reports the pause it was told, which the state already has.
      if (name === "pause" && fresh && typeof data === "boolean" && isSettled(playback) && data !== (playback._tag === "Paused")) yield* publishSettled(active, data, playback.media);
    });
    const handleEvent = Effect.fn("Player.handleEvent")(function* (message: SessionEvent) {
      const active = engine;
      const correlation = active?.correlation;
      if (!active || !correlation || message.generation !== active.session.generation) return;
      const { event } = message;
      const fresh = message.sequence > active.propertyFence;
      if (event.type === "start-file") {
        if (active.awaiting !== null && active.awaiting !== event.entryId) return;
        active.awaiting = null;
        return yield* onStartFile(active, correlation, event.entryId);
      }
      // Whether mpv is stalled belongs to the session, not to the current entry. Nothing writes these, so no observation is stale; unavailable means not stalled.
      if (event.type === "property" && (event.name === "seeking" || event.name === "paused-for-cache")) {
        if (event.name === "seeking") active.seeking = event.data === true;
        else active.pausedForCache = event.data === true;
        // The position holds while mpv waits, and moves on from where mpv is once it plays again.
        if (state.playback._tag === "Playing" && state.playback.buffering !== isBuffering()) yield* publishSettled(active, false, state.playback.media);
        return;
      }
      if (active.awaiting !== null || !isCurrentEvent(message, active.session.generation, correlation.currentId)) return;
      if (event.type === "file-loaded") yield* onFileLoaded(active);
      else if (event.type === "end-file") yield* onEndFile(correlation, event.entryId, event.reason);
      else if (event.type === "property") yield* onPropertyChange(active, event.name, event.data, fresh);
    });
    const heldPosition = Effect.fn("Player.heldPosition")(function* () {
      const media = currentMedia(state);
      if (!media) return null;
      // Anything but a loaded track stands still where the state has it.
      return { key: media.item.key, positionSeconds: engine && isSettled(state.playback) ? yield* readPosition(engine) : media.positionSeconds };
    });

    // ---- Failure reporting ----

    /** Whether a failure leaves playback in a state we cannot vouch for, so it must end rather than only be told. */
    const endsPlayback = (error: PlayerFailure | EngineError, operation: string): boolean => {
      if (applying || operation === "Credentials" || operation === "SetBinaryPath") return true;
      switch (error._tag) {
        case "EngineError":
          return error.uncertain || operation === "event";
        case "QueueOutOfSync":
          return true;
        default:
          return false;
      }
    };
    /** Makes a failure the state's error, for the user to see. */
    const report = Effect.fn("Player.report")(function* (error: PlayerFailure | EngineError, operation: string) {
      yield* Effect.logWarning("Player operation failed", safeFailure(error));
      const ends = endsPlayback(error, operation);
      applying = false;
      const described = describeFailure(error);
      // A command that was only refused is told to its caller. It does not take the place of an error
      // the user can still do something about.
      yield* ends ? failPlayback(error) : publish({ ...state, error: state.error?.fix && !described.fix ? state.error : described });
      if (error._tag === "EngineError" && error.reason === "spawn") {
        // The resolved binary no longer runs: forget it and search again. What the search says is what there is to fix.
        yield* updateSettings({ cachedPath: null });
        yield* refreshBinary();
        if (state.binary._tag === "Unavailable") yield* publish({ ...state, error: { message: state.binary.message, fix: "mpv" } });
      }
    });

    // ---- Worker ----

    const runRequest = Effect.fn("Player.command")(function* (operation: Operation): Effect.fn.Return<void, CommandFailed> {
      const tag = operation._tag;
      yield* Effect.annotateCurrentSpan({ command: tag });
      const exit = yield* handleCommand(operation).pipe(Effect.annotateLogs({ command: tag }), Effect.exit);
      if (Exit.isSuccess(exit)) return yield* Effect.logInfo("Player command completed").pipe(Effect.annotateLogs({ command: tag, revision: state.stamp.revision }));
      const failure = Cause.findError(exit.cause);
      if (Result.isSuccess(failure)) {
        yield* report(failure.success, tag);
        return yield* new CommandFailed({ message: describeFailure(failure.success).message });
      }
      yield* Effect.logError("Player defect", { operation: tag, cause: safeCause(exit.cause) });
      const defect = new InternalError({ operation: tag, message: "An unexpected player error occurred." });
      applying = false;
      yield* failPlayback(defect);
      return yield* new CommandFailed({ message: defect.message });
    });
    const handleMessage = (message: Message): Effect.Effect<void> => {
      switch (message._tag) {
        case "Request":
          return runRequest(message.request.operation).pipe(
            Effect.exit,
            Effect.flatMap((exit) => Deferred.done(message.request.reply, exit)),
            Effect.ensuring(Effect.sync(() => replies.delete(message.request.reply))),
          );
        case "SessionEvent":
          return handleEvent(message).pipe(Effect.catch((error) => report(error, "event")));
        case "ReadPosition":
          return heldPosition().pipe(
            // mpv going away is reported as such; the position is only not known.
            Effect.orElseSucceed(() => null),
            Effect.flatMap((position) => Deferred.succeed(message.reply, position)),
            Effect.ensuring(Effect.sync(() => positionReplies.delete(message.reply))),
          );
        case "EngineFailed":
          return engine?.session.generation === message.generation ? report(message.error, "engine") : Effect.void;
        case "LoadTimeout":
          return message.token === loadToken && state.playback._tag === "Loading" ? failPlayback(new PlaybackFailed({ operation: "load", message: "The track did not finish loading." })) : Effect.void;
        case "SettingsWriteFailed":
          return publish({ ...state, error: { message: "Playback preferences could not be saved.", fix: null } });
      }
    };
    const failPendingReplies = (message: string) =>
      Effect.gen(function* () {
        for (const reply of replies) yield* Deferred.fail(reply, new CommandFailed({ message }));
        replies.clear();
        for (const reply of positionReplies) yield* Deferred.succeed(reply, null);
        positionReplies.clear();
      });

    const initialize = Effect.fn("Player.initialize")(function* () {
      settings = yield* store.load.pipe(
        Effect.catch(() => publish({ ...state, error: { message: "Stored preferences could not be read; defaults are in use.", fix: null } }).pipe(Effect.as(defaultSettings))),
      );
      yield* publish({ ...state, volumePercent: settings.volumePercent, muted: settings.muted });
      yield* refreshBinary();
    });
    const worker = yield* initialize().pipe(
      Effect.andThen(Effect.forever(Queue.take(mailbox).pipe(Effect.flatMap(handleMessage)))),
      Effect.catchCause((cause) =>
        Effect.gen(function* () {
          yield* Effect.logError("Player worker failed", { cause: safeCause(cause) });
          yield* failPlayback(new InternalError({ operation: "worker", message: "The player stopped unexpectedly. Restart the application." }));
          closing = true;
          yield* failPendingReplies("The player is unavailable.");
        }),
      ),
      Effect.forkScoped,
    );

    // ---- Public API ----

    /**
     * Opening a terminal changes nothing of the player's, so it does not wait behind playback, which it
     * could hold up for seconds, nor become the player's error: the one who asked is told what went wrong.
     */
    const openInstallTerminal = (method: MpvInstallMethod) => binaries.openTerminal(method).pipe(Effect.mapError((error) => new CommandFailed({ message: error.message })));
    const submit = Effect.fn("Player.submit")(function* (operation: Operation) {
      if (closing) return yield* new CommandFailed({ message: "The player is unavailable." });
      const reply = yield* Deferred.make<void, CommandFailed>();
      replies.add(reply);
      yield* Queue.offer(mailbox, { _tag: "Request", request: { operation, reply } });
      return yield* Deferred.await(reply);
    });
    /** Where the state says the held track has got to, worked out from when it was last read. */
    const estimatedPosition = Effect.map(Clock.currentTimeMillis, (now): PlayerPosition | null => {
      const media = currentMedia(state);
      return media ? { key: media.item.key, positionSeconds: positionAt(playerPositionRow(state), now) } : null;
    });
    const position = Effect.gen(function* () {
      if (closing) return null;
      const reply = yield* Deferred.make<PlayerPosition | null>();
      positionReplies.add(reply);
      yield* Queue.offer(mailbox, { _tag: "ReadPosition", reply });
      return yield* Deferred.await(reply);
    }).pipe(
      // Quitting waits for it, so an mpv slow to answer, or work ahead of the read, does not hold it up:
      // the position the state gives stands in, which is off by no more than mpv has drifted from the clock.
      Effect.timeoutOrElse({ duration: POSITION_READ_TIMEOUT, orElse: () => estimatedPosition }),
    );
    const shutdown = Effect.gen(function* () {
      if (shutdownStarted) return;
      shutdownStarted = true;
      closing = true;
      yield* Fiber.interrupt(worker);
      yield* failPendingReplies("The player is shutting down.");
      yield* closeEngine();
      yield* settingsWriter.flush;
      yield* publish({ ...state, playback: { _tag: "Idle" } });
    }).pipe(Effect.withSpan("Player.shutdown"));
    yield* Effect.addFinalizer(() => shutdown);

    return {
      execute: (command) => (command._tag === "OpenInstallTerminal" ? openInstallTerminal(command.method) : submit(command)),
      setCredentials: (next) => submit({ _tag: "Credentials", credentials: next }),
      position,
      snapshot: SubscriptionRef.get(published),
      changes: SubscriptionRef.changes(published),
      shutdown,
    } satisfies PlayerService;
  }),
);
