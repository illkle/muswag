import { Cause, Context, Deferred, Effect, Exit, Fiber, Layer, Queue, Schema, Scope, Stream, SubscriptionRef } from "effect";
import { clonePlaybackItem, type PlaybackItem, type SessionCredentials } from "@muswag/shared";
import { CredentialsSchema, initialSnapshot, PlayerCommandSchema, type CommandAck, type PlayerCommand, type PlayerIssue, type PlayerSnapshot, type Selection } from "#shared/player-contract";
import { Binaries } from "./binary/binaries";
import { Installer } from "./binary/installer";
import { EngineError, issue, PlayerError, playerError, safeCause, safeFailure } from "./errors";
import { currentMedia, isCurrentEvent, withPosition } from "./model";
import { applyQueue, validateQueue, type Correlation } from "./queue";
import { command, booleanProperty, numberProperty } from "./mpv/protocol";
import { MpvSession, type SessionEvent, type SessionHandle } from "./mpv/session";
import { defaultSettings, SettingsStore, type Settings } from "./settings";
import { resolveStreamUrls } from "./stream-source";

export interface PlayerService {
  readonly execute: (commandId: string, input: unknown) => Effect.Effect<CommandAck, PlayerError>;
  readonly setCredentials: (input: unknown) => Effect.Effect<void, PlayerError>;
  readonly snapshot: Effect.Effect<PlayerSnapshot>;
  readonly changes: Stream.Stream<PlayerSnapshot>;
  readonly shutdown: Effect.Effect<void>;
}
export class Player extends Context.Service<Player, PlayerService>()("@muswag/player/Player") {}
type Operation = PlayerCommand | { readonly _tag: "Credentials"; readonly value: SessionCredentials | null };
type Request = { readonly type: "request"; readonly id: string; readonly command: Operation; readonly epoch: number; readonly reply: Deferred.Deferred<CommandAck, PlayerError> };
type Message =
  | Request
  | { readonly type: "event"; readonly value: SessionEvent }
  | { readonly type: "tick" }
  | { readonly type: "install" }
  | { readonly type: "terminal"; readonly error: EngineError; readonly generation: number }
  | { readonly type: "loadTimeout"; readonly token: number }
  | { readonly type: "settingsError" };

export const PlayerLive = Layer.effect(
  Player,
  Effect.gen(function* () {
    const sessions = yield* MpvSession;
    const binaries = yield* Binaries;
    const installer = yield* Installer;
    const store = yield* SettingsStore;
    const owner = yield* Effect.scope;
    const published = yield* SubscriptionRef.make(initialSnapshot(crypto.randomUUID()));
    let state = yield* SubscriptionRef.get(published);
    yield* Effect.annotateLogsScoped({ component: "player", epoch: state.stamp.epoch });
    const mailbox = yield* Queue.bounded<Message>(512);
    const replies = new Set<Deferred.Deferred<CommandAck, PlayerError>>();
    let lifecycleCount = 0;
    let epoch = 0;
    let closing = false;
    let credentials: SessionCredentials | null = null;
    let settings: Settings = defaultSettings;
    let session: SessionHandle | null = null;
    let sessionScope: Scope.Closeable | null = null;
    let correlation: Correlation | null = null;
    let items: readonly PlaybackItem[] = [];
    let selected: Selection | null = null;
    let retried = false;
    let loadToken = 0;
    let loadTimer: Fiber.Fiber<void> | null = null;
    let cancelActive: Deferred.Deferred<never, PlayerError | EngineError> | null = null;
    let telemetry: SessionEvent | null = null;
    let propertyFence = 0;
    let tickPending = false;
    let installPending = false;
    let latestInstall: { state: PlayerSnapshot["install"]; output: PlayerSnapshot["installOutput"] } | null = null;
    let settingsFiber: Fiber.Fiber<void> | null = null;
    let dirty = false;

    const publish = (next: PlayerSnapshot) =>
      Effect.suspend(() => {
        state = { ...next, stamp: { ...state.stamp, revision: state.stamp.revision + 1 } };
        return SubscriptionRef.set(published, state);
      });
    const addIssue = (problem: PlayerIssue) =>
      publish({ ...state, issues: [...state.issues.filter((item) => item.operation !== problem.operation || item.occurrenceKey !== problem.occurrenceKey), problem].slice(-20) });
    const closeSession = Effect.gen(function* () {
      session = null;
      propertyFence = 0;
      correlation = null;
      telemetry = null;
      loadToken++;
      if (loadTimer) {
        yield* Fiber.interrupt(loadTimer);
        loadTimer = null;
      }
      const previous = sessionScope;
      sessionScope = null;
      if (previous) yield* Scope.close(previous, Exit.void);
    });
    const failPlayback = (problem: PlayerIssue) =>
      Effect.gen(function* () {
        const media = currentMedia(state);
        yield* closeSession;
        yield* publish({
          ...state,
          playback: { _tag: "Failed", media, issue: problem },
          queue: { ...state.queue, sync: "unknown" },
          audio: { ...state.audio, applied: false },
          issues: [...state.issues.filter((item) => item.id !== problem.id), problem].slice(-20),
        });
      });
    const stop = Effect.gen(function* () {
      yield* closeSession;
      items = [];
      selected = null;
      retried = false;
      yield* publish({ ...state, playback: { _tag: "Idle" }, queue: { revision: state.queue.revision + 1, keys: [], sync: "empty" }, audio: { ...state.audio, applied: false } });
    });
    const persist = Effect.gen(function* () {
      dirty = true;
      if (settingsFiber) yield* Fiber.interrupt(settingsFiber);
      settingsFiber = yield* Effect.sleep("250 millis").pipe(
        Effect.andThen(Effect.suspend(() => store.save(settings))),
        Effect.tap(() =>
          Effect.sync(() => {
            dirty = false;
          }),
        ),
        Effect.catch(() =>
          Effect.sync(() => {
            Queue.offerUnsafe(mailbox, { type: "settingsError" });
          }),
        ),
        Effect.forkIn(owner),
      );
    });
    const ensureSession = Effect.gen(function* () {
      if (session) return session;
      if (state.binary._tag !== "Ready") return yield* Effect.fail(playerError("BinaryUnavailable", "playback", "Install or configure mpv before playing."));
      sessionScope = yield* Scope.fork(owner, "sequential");
      session = yield* sessions
        .open(
          state.binary.path,
          (event) => {
            if (event.event.type === "property" && event.event.name === "time-pos") {
              telemetry = event;
              return true;
            }
            if (closing || lifecycleCount >= 256) return false;
            lifecycleCount++;
            return Queue.offerUnsafe(mailbox, { type: "event", value: event });
          },
          (error, generation) => {
            if (closing) return;
            if (cancelActive) Deferred.doneUnsafe(cancelActive, Effect.fail(error));
            Queue.offerUnsafe(mailbox, { type: "terminal", error, generation });
          },
        )
        .pipe(Scope.provide(sessionScope));
      yield* session.execute(command("set_property", "volume", settings.volumePercent));
      yield* session.execute(command("set_property", "mute", settings.muted));
      yield* publish({ ...state, audio: { ...state.audio, applied: true } });
      return session;
    });
    const armLoading = Effect.gen(function* () {
      const token = ++loadToken;
      if (loadTimer) yield* Fiber.interrupt(loadTimer);
      loadTimer = yield* Effect.sleep("20 seconds").pipe(
        Effect.andThen(
          Effect.sync(() => {
            Queue.offerUnsafe(mailbox, { type: "loadTimeout", token });
          }),
        ),
        Effect.forkIn(owner),
      );
    });
    const apply = (next: readonly PlaybackItem[], selection: Selection | null) =>
      Effect.gen(function* () {
        yield* validateQueue(next, selection);
        if (!next.length) {
          yield* stop;
          return;
        }
        if (!selection && !correlation) return yield* Effect.fail(playerError("InvalidCommand", "queue", "Select a track to start playback."));
        if (!credentials) return yield* Effect.fail(playerError("NotAuthenticated", "playback", "Log in before starting playback."));
        const anchor = correlation?.entries.find((entry) => entry.entryId === correlation?.currentId);
        if (!selection && (!anchor || !next.some((item) => item.key === anchor.key && item.track.id === anchor.track.id)))
          return yield* playerError("InvalidCommand", "queue", "Select a track when replacing the current occurrence.");
        const urls = yield* resolveStreamUrls(credentials, next);
        items = structuredClone(next);
        yield* publish({ ...state, queue: { ...state.queue, sync: "applying" } });
        if (selection) {
          selected = selection;
          const item = next.find((item) => item.key === selection.key)!;
          yield* publish({ ...state, playback: { _tag: "Loading", media: { item, positionSeconds: selection.positionSeconds, durationSeconds: null }, targetPaused: !selection.play } });
        }
        if (selection) yield* closeSession;
        const engine = yield* ensureSession;
        if (selection) yield* engine.execute(command("set_property", "pause", !selection.play));
        correlation = yield* applyQueue(engine, correlation, next, selection, urls).pipe(
          Effect.timeoutOrElse({ duration: "15 seconds", orElse: () => Effect.fail(new EngineError({ reason: "timeout", operation: "queue", uncertain: true })) }),
        );
        items = structuredClone(next);
        yield* publish({ ...state, queue: { revision: state.queue.revision + 1, keys: next.map((item) => item.key), sync: "synced" } });
        if (selection) yield* armLoading;
      });
    const refresh = Effect.gen(function* () {
      yield* publish({ ...state, binary: { _tag: "Checking" } });
      const result = yield* binaries.resolve(settings.manualPath, settings.cachedPath);
      settings = { ...settings, cachedPath: result._tag === "Ready" ? result.path : null };
      yield* publish({ ...state, binary: result });
      yield* persist;
    });
    const pause = (paused: boolean) =>
      Effect.gen(function* () {
        if (!session || !currentMedia(state)) return yield* Effect.fail(playerError("InvalidCommand", "pause", "Select a playable track first."));
        yield* session.execute(command("set_property", "pause", paused));
        const confirmed = yield* session.execute(booleanProperty("pause"));
        propertyFence = session.sequence();
        if (selected) selected = { ...selected, play: !confirmed };
        const media = currentMedia(state)!;
        if (state.playback._tag === "Loading") yield* publish({ ...state, playback: { ...state.playback, targetPaused: confirmed } });
        else yield* publish({ ...state, playback: { _tag: confirmed ? "Paused" : "Playing", media } });
      });
    const handleCommand = (input: Operation): Effect.Effect<string | null, PlayerError | EngineError> =>
      Effect.gen(function* () {
        switch (input._tag) {
          case "ApplyQueue":
            retried = false;
            yield* apply(structuredClone(input.items), input.select);
            break;
          case "Stop":
            yield* stop;
            break;
          case "Credentials": {
            if (JSON.stringify(credentials) === JSON.stringify(input.value)) break;
            const old = currentMedia(state);
            const window = items;
            const play = state.playback._tag === "Playing";
            credentials = input.value;
            yield* closeSession;
            if (!credentials) yield* stop;
            else if (old) yield* apply(window, { key: old.item.key, positionSeconds: old.positionSeconds, play });
            break;
          }
          case "Play":
          case "Toggle":
          case "Pause": {
            if (input._tag === "Pause") yield* pause(true);
            else if (state.playback._tag === "Ended" || state.playback._tag === "Failed") {
              const media = currentMedia(state);
              if (!media) return yield* Effect.fail(playerError("InvalidCommand", "play", "Select a track first."));
              retried = false;
              yield* closeSession;
              yield* apply(items, { key: media.item.key, positionSeconds: 0, play: true });
            } else yield* pause(input._tag === "Toggle" && state.playback._tag === "Playing");
            break;
          }
          case "Restart": {
            const media = currentMedia(state);
            if (!media) return yield* Effect.fail(playerError("InvalidCommand", "restart", "Select a track first."));
            retried = false;
            yield* apply(items, { key: media.item.key, positionSeconds: 0, play: state.playback._tag !== "Paused" });
            break;
          }
          case "Seek": {
            const media = currentMedia(state);
            if (!session || !media || !["Playing", "Paused"].includes(state.playback._tag)) return yield* Effect.fail(playerError("InvalidCommand", "seek", "Wait until the track has loaded."));
            yield* session.execute(command("seek", Math.min(input.seconds, media.durationSeconds ?? Infinity), "absolute+exact"));
            const position = yield* session.execute(numberProperty("time-pos"));
            propertyFence = session.sequence();
            yield* publish(withPosition(state, position));
            break;
          }
          case "SetVolume":
          case "SetMuted": {
            let volumePercent = input._tag === "SetVolume" ? input.percent : settings.volumePercent;
            let muted = input._tag === "SetMuted" ? input.muted : settings.muted;
            if (session) {
              yield* session.execute(command("set_property", input._tag === "SetVolume" ? "volume" : "mute", input._tag === "SetVolume" ? volumePercent : muted));
              if (input._tag === "SetVolume") volumePercent = yield* session.execute(numberProperty("volume"));
              else muted = yield* session.execute(booleanProperty("mute"));
              propertyFence = session.sequence();
            }
            settings = { ...settings, volumePercent, muted };
            yield* publish({ ...state, audio: { volumePercent, muted, applied: session !== null } });
            yield* persist;
            break;
          }
          case "RefreshBinary":
            yield* refresh;
            break;
          case "SetBinaryPath": {
            const next = { ...settings, manualPath: input.path, cachedPath: null };
            yield* store.save(next).pipe(Effect.mapError(() => playerError("SettingsFailed", "path", "Unable to save the mpv path.")));
            settings = next;
            const media = currentMedia(state);
            const play = state.playback._tag === "Playing";
            yield* closeSession;
            yield* refresh;
            if (media) yield* apply(items, { key: media.item.key, positionSeconds: media.positionSeconds, play });
            break;
          }
          case "StartInstall":
            return yield* installer.start(input.method);
          case "CancelInstall":
            yield* installer.cancel(input.jobId);
            break;
          case "DismissIssue":
            yield* publish({ ...state, issues: state.issues.filter((issue) => issue.id !== input.issueId) });
            break;
        }
        return null;
      });
    const handleEvent = (message: SessionEvent): Effect.Effect<void, EngineError | PlayerError> =>
      Effect.gen(function* () {
        if (message.generation !== session?.generation || !correlation) return;
        const event = message.event;
        if (event.type === "start-file") {
          const entry = correlation.entries.find((entry) => entry.entryId === event.entryId);
          if (!entry) return;
          if (state.playback._tag === "Recovering" && selected?.key !== entry.key) return;
          correlation = { ...correlation, currentId: entry.entryId };
          if (currentMedia(state)?.item.key !== entry.key) {
            retried = false;
            selected = { key: entry.key, play: state.playback._tag !== "Paused", positionSeconds: 0 };
          }
          yield* publish({
            ...state,
            playback: {
              _tag: "Loading",
              media: { item: clonePlaybackItem(entry), positionSeconds: selected?.key === entry.key ? selected.positionSeconds : 0, durationSeconds: null },
              targetPaused: !(selected?.play ?? true),
            },
          });
          yield* armLoading;
          return;
        }
        if (event.type === "property" && ["volume", "mute"].includes(event.name)) {
          if (message.sequence <= propertyFence) return;
          if (event.name === "volume" && typeof event.data === "number" && Number.isFinite(event.data) && event.data >= 0 && event.data <= 100) settings = { ...settings, volumePercent: event.data };
          else if (event.name === "mute" && typeof event.data === "boolean") settings = { ...settings, muted: event.data };
          else return;
          yield* publish({ ...state, audio: { volumePercent: settings.volumePercent, muted: settings.muted, applied: true } });
          yield* persist;
          return;
        }
        if (!isCurrentEvent(message, session?.generation, correlation.currentId)) return;
        if (event.type === "file-loaded" && state.playback._tag === "Loading") {
          if (selected && selected.positionSeconds > 0) yield* session!.execute(command("seek", selected.positionSeconds, "absolute+exact"));
          yield* session!.execute(command("set_property", "pause", state.playback.targetPaused));
          const paused = yield* session!.execute(booleanProperty("pause"));
          propertyFence = session!.sequence();
          loadToken++;
          if (loadTimer) {
            yield* Fiber.interrupt(loadTimer);
            loadTimer = null;
          }
          if (selected) selected = { ...selected, positionSeconds: 0 };
          yield* publish({
            ...state,
            playback: { _tag: paused ? "Paused" : "Playing", media: state.playback.media },
            issues: state.issues.filter((issue) => issue.occurrenceKey !== currentMedia(state)?.item.key),
          });
        } else if (event.type === "end-file") {
          if (event.reason === "eof") {
            if (correlation.entries.at(-1)?.entryId === event.entryId) {
              const media = currentMedia(state);
              if (media) yield* publish({ ...state, playback: { _tag: "Ended", media: { ...media, positionSeconds: media.durationSeconds ?? media.positionSeconds } } });
            }
          } else if (event.reason === "error") {
            const media = currentMedia(state);
            if (media && !retried) {
              retried = true;
              const play = selected?.play ?? true;
              yield* publish({ ...state, playback: { _tag: "Recovering", media, attempt: 1 } });
              yield* Effect.logWarning("Reloading failed media", { occurrenceKey: media.item.key, attempt: 1 });
              yield* closeSession;
              yield* apply(items, { key: media.item.key, positionSeconds: media.positionSeconds, play });
            } else yield* failPlayback(issue("PlaybackFailed", "playback", "The track could not be played after retrying.", media?.item.key));
          }
        } else if (event.type === "property") {
          const media = currentMedia(state);
          if (event.name === "duration" && media && typeof event.data === "number" && Number.isFinite(event.data) && event.data >= 0 && state.playback._tag !== "Idle")
            yield* publish({ ...state, playback: { ...state.playback, media: { ...media, durationSeconds: event.data } } });
          if (message.sequence > propertyFence && event.name === "pause" && typeof event.data === "boolean" && media && ["Playing", "Paused"].includes(state.playback._tag))
            yield* publish({ ...state, playback: { _tag: event.data ? "Paused" : "Playing", media } });
        }
      });
    const report = (error: EngineError | PlayerError, operation: string) =>
      Effect.gen(function* () {
        const problem =
          error instanceof PlayerError
            ? error.issue
            : issue(
                error.reason === "rejected" && !error.uncertain ? "CommandRejected" : "EngineUnavailable",
                operation,
                error.reason === "timeout" ? "The playback engine did not respond in time." : "The playback engine could not complete the operation.",
                currentMedia(state)?.item.key,
              );
        yield* Effect.logWarning("Player operation failed", safeFailure(error));
        if (
          (error instanceof EngineError && (error.uncertain || operation === "event")) ||
          state.queue.sync === "applying" ||
          ["Credentials", "SetBinaryPath"].includes(operation) ||
          problem.code === "QueueOutOfSync"
        )
          yield* failPlayback(problem);
        else yield* addIssue(problem);
        if (error instanceof EngineError && error.reason === "spawn") {
          settings = { ...settings, cachedPath: null };
          yield* refresh;
        }
        return new PlayerError({ issue: problem });
      });
    const processMessage = (message: Message) =>
      Effect.gen(function* () {
        if (message.type === "request") {
          if (message.epoch !== epoch && !["Stop", "Credentials"].includes(message.command._tag)) {
            yield* Deferred.fail(message.reply, playerError("CommandRejected", message.command._tag, "The command was cancelled by stop or logout."));
            replies.delete(message.reply);
            return;
          }
          yield* publish({ ...state, pending: { commandId: message.id, kind: message.command._tag } });
          cancelActive = yield* Deferred.make<never, PlayerError | EngineError>();
          const result = yield* handleCommand(message.command).pipe(
            Effect.withLogSpan("player.command"),
            Effect.annotateLogs({ component: "player", commandId: message.id, command: message.command._tag, epoch: state.stamp.epoch }),
            Effect.raceFirst(Deferred.await(cancelActive)),
            Effect.exit,
          );
          cancelActive = null;
          yield* publish({ ...state, pending: null });
          if (Exit.isSuccess(result)) {
            yield* Effect.logInfo("Player command completed").pipe(Effect.annotateLogs({ commandId: message.id, command: message.command._tag, revision: state.stamp.revision }));
            yield* Deferred.succeed(message.reply, { commandId: message.id, stamp: state.stamp, jobId: result.value });
          } else {
            const error = Cause.findError(result.cause);
            const problem = error._tag === "Success" ? yield* report(error.success, message.command._tag) : playerError("InternalError", message.command._tag, "An unexpected player error occurred.");
            if (error._tag !== "Success") {
              yield* Effect.logError("Player defect", { operation: message.command._tag, cause: safeCause(result.cause) });
              yield* failPlayback(problem.issue);
            }
            yield* Deferred.fail(message.reply, problem);
          }
          replies.delete(message.reply);
        } else if (message.type === "event") {
          lifecycleCount--;
          cancelActive = yield* Deferred.make<never, PlayerError | EngineError>();
          yield* handleEvent(message.value).pipe(
            Effect.raceFirst(Deferred.await(cancelActive)),
            Effect.catch((error) => report(error, "event")),
          );
          cancelActive = null;
        } else if (message.type === "terminal") {
          if (session?.generation === message.generation) yield* report(message.error, "engine");
        } else if (message.type === "loadTimeout") {
          if (message.token === loadToken && state.playback._tag === "Loading")
            yield* failPlayback(issue("PlaybackFailed", "load", "The track did not finish loading.", currentMedia(state)?.item.key));
        } else if (message.type === "tick") {
          tickPending = false;
          const latest = telemetry;
          telemetry = null;
          if (
            latest &&
            latest.sequence > propertyFence &&
            isCurrentEvent(latest, session?.generation, correlation?.currentId ?? null) &&
            latest.event.type === "property" &&
            typeof latest.event.data === "number" &&
            Number.isFinite(latest.event.data) &&
            ["Playing", "Paused"].includes(state.playback._tag)
          )
            yield* publish(withPosition(state, latest.event.data));
        } else if (message.type === "install") {
          installPending = false;
          if (latestInstall) {
            const was = state.install;
            yield* publish({ ...state, install: latestInstall.state, installOutput: latestInstall.output });
            if (latestInstall.state._tag === "Succeeded" && (was._tag !== "Succeeded" || was.jobId !== latestInstall.state.jobId)) yield* refresh;
          }
        } else yield* addIssue(issue("SettingsFailed", "settings", "Playback preferences could not be saved."));
      });
    const initialization = Effect.gen(function* () {
      settings = yield* store.load.pipe(
        Effect.catch(() => addIssue(issue("SettingsFailed", "settings", "Stored preferences could not be read; defaults are in use.")).pipe(Effect.as(defaultSettings))),
      );
      yield* publish({ ...state, audio: { volumePercent: settings.volumePercent, muted: settings.muted, applied: false } });
      yield* refresh;
    });
    const worker = yield* initialization.pipe(
      Effect.andThen(Effect.forever(Queue.take(mailbox).pipe(Effect.flatMap(processMessage)))),
      Effect.catchCause((cause) =>
        Effect.gen(function* () {
          yield* Effect.logError("Player worker failed", { cause: safeCause(cause) });
          yield* failPlayback(issue("InternalError", "worker", "The player stopped unexpectedly. Restart the application."));
          closing = true;
          for (const reply of replies) yield* Deferred.fail(reply, playerError("InternalError", "worker", "The player is unavailable."));
          replies.clear();
        }),
      ),
      Effect.forkScoped,
    );
    yield* Effect.forever(
      Effect.sleep("500 millis").pipe(
        Effect.andThen(
          Effect.sync(() => {
            if (!tickPending && telemetry) {
              tickPending = true;
              Queue.offerUnsafe(mailbox, { type: "tick" });
            }
          }),
        ),
      ),
    ).pipe(Effect.forkScoped);
    yield* Stream.runForEach(installer.changes, (update) =>
      Effect.sync(() => {
        latestInstall = update;
        if (!installPending) {
          installPending = true;
          Queue.offerUnsafe(mailbox, { type: "install" });
        }
      }),
    ).pipe(Effect.forkScoped);
    const submit = (id: string, input: Operation) =>
      Effect.gen(function* () {
        if (closing) return yield* Effect.fail(playerError("ShuttingDown", input._tag, "The player is shutting down."));
        if (replies.size >= (input._tag === "Stop" || input._tag === "Credentials" ? 34 : 32)) return yield* Effect.fail(playerError("Busy", input._tag, "The player is busy. Try again shortly."));
        if (input._tag === "Stop" || input._tag === "Credentials") {
          epoch++;
          if (cancelActive) yield* Deferred.fail(cancelActive, playerError("CommandRejected", "cancel", "Playback operation cancelled."));
        }
        const reply = yield* Deferred.make<CommandAck, PlayerError>();
        replies.add(reply);
        yield* Queue.offer(mailbox, { type: "request", id, command: input, epoch, reply });
        return yield* Deferred.await(reply);
      });
    const shutdown = Effect.gen(function* () {
      if (state.lifecycle === "closed") return;
      closing = true;
      yield* Fiber.interrupt(worker);
      yield* publish({ ...state, lifecycle: "closing", pending: null });
      for (const reply of replies) yield* Deferred.fail(reply, playerError("ShuttingDown", "shutdown", "The player is shutting down."));
      replies.clear();
      if (state.install._tag === "Running" || state.install._tag === "Cancelling") yield* installer.cancel(state.install.jobId);
      yield* closeSession;
      if (settingsFiber) yield* Fiber.interrupt(settingsFiber);
      if (dirty)
        yield* store.save(settings).pipe(
          Effect.timeoutOrElse({ duration: "2 seconds", orElse: () => Effect.logWarning("Settings flush timed out") }),
          Effect.catch(() => Effect.logWarning("Settings flush failed")),
        );
      yield* publish({ ...state, lifecycle: "closed", playback: { _tag: "Idle" }, audio: { ...state.audio, applied: false } });
    });
    yield* Effect.addFinalizer(() => shutdown);
    return {
      execute: (id, input) =>
        Schema.decodeUnknownEffect(PlayerCommandSchema)(input).pipe(
          Effect.mapError(() => playerError("InvalidCommand", "decode", "Invalid player command.")),
          Effect.flatMap((command) =>
            command._tag === "ApplyQueue" ? validateQueue(command.items as readonly PlaybackItem[], command.select).pipe(Effect.andThen(submit(id, command as PlayerCommand))) : submit(id, command),
          ),
        ),
      setCredentials: (input) =>
        Schema.decodeUnknownEffect(CredentialsSchema)(input).pipe(
          Effect.mapError(() => playerError("InvalidCommand", "credentials", "Invalid credentials.")),
          Effect.flatMap((value) => submit(crypto.randomUUID(), { _tag: "Credentials", value })),
          Effect.asVoid,
        ),
      snapshot: SubscriptionRef.get(published),
      changes: SubscriptionRef.changes(published),
      shutdown,
    } satisfies PlayerService;
  }),
);
