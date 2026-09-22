import { Context, Deferred, Effect, Layer, Queue, Redacted, Scope, Stream } from "effect";
import { EngineError } from "../errors";
import { MpvConnection } from "./connection";
import { command, parseMessage, type MpvCommand, type MpvEvent } from "./protocol";

const OBSERVED_PROPERTIES = ["pause", "time-pos", "duration", "volume", "mute"] as const;
const REQUEST_TIMEOUT = "5 seconds";

/**
 * An mpv event stamped at read time. `sequence` orders it against command replies (see `SessionHandle.sequence`);
 * `entryId` is the playlist entry that was current when it arrived (or the ended entry, for end-file).
 */
export type SessionEvent = {
  readonly _tag: "SessionEvent";
  readonly generation: number;
  readonly sequence: number;
  readonly entryId: number | null;
  readonly event: MpvEvent;
};
export const isPositionEvent = (event: SessionEvent) => event.event.type === "property" && event.event.name === "time-pos";

/** Where a session delivers what it reads. Offers never wait: a full `events` queue ends the session. */
export interface SessionSinks {
  /** Lifecycle and property events, in wire order. */
  readonly events: Queue.Enqueue<SessionEvent>;
  /** High-frequency time-pos observations; typically a sliding queue that keeps only the latest. */
  readonly positions: Queue.Enqueue<SessionEvent>;
}
export interface SessionHandle {
  /** Distinguishes this process from earlier ones, whose late events must be ignored. */
  readonly generation: number;
  /** Number of messages read so far; an event with a lower sequence arrived before the latest reply. */
  readonly sequence: () => number;
  readonly execute: <A>(command: MpvCommand<A>) => Effect.Effect<A, EngineError>;
  /** Fails with the error that ended the session; never completes while the session is healthy. */
  readonly failure: Effect.Effect<never, EngineError>;
}
export class MpvSession extends Context.Service<MpvSession, { readonly open: (binaryPath: string, sinks: SessionSinks) => Effect.Effect<SessionHandle, EngineError, Scope.Scope> }>()(
  "@muswag/player/MpvSession",
) {}

const reveal = (arg: unknown) => (Redacted.isRedacted(arg) ? Redacted.value(arg) : arg);

export const MpvSessionLive = (ipcPath: string) =>
  Layer.effect(
    MpvSession,
    Effect.gen(function* () {
      const connection = yield* MpvConnection;
      let generation = 0;
      const open = Effect.fn("MpvSession.open")(function* (binaryPath: string, sinks: SessionSinks) {
        const currentGeneration = ++generation;
        yield* Effect.annotateCurrentSpan({ generation: currentGeneration });
        const wire = yield* connection.open(binaryPath, `${ipcPath}-${currentGeneration}`);
        const pending = new Map<number, Deferred.Deferred<unknown, EngineError>>();
        const failed = yield* Deferred.make<never, EngineError>();
        let nextRequest = 0;
        let sequence = 0;
        let entryId: number | null = null;
        let terminal: EngineError | null = null;

        const failPending = (error: EngineError) => {
          for (const reply of pending.values()) Deferred.doneUnsafe(reply, Effect.fail(error));
          pending.clear();
        };
        const terminate = (error: EngineError) => {
          if (terminal) return;
          terminal = error;
          failPending(error);
          Deferred.doneUnsafe(failed, Effect.fail(error));
        };
        yield* Effect.addFinalizer(() =>
          Effect.sync(() => {
            terminal ??= new EngineError({ reason: "closed", operation: "shutdown", uncertain: false });
            failPending(terminal);
          }),
        );

        const deliver = (event: MpvEvent) => {
          if (event.type === "start-file") entryId = event.entryId;
          const stamped: SessionEvent = { _tag: "SessionEvent", generation: currentGeneration, sequence, entryId: event.type === "end-file" ? event.entryId : entryId, event };
          if (event.type === "end-file" && entryId === event.entryId) entryId = null;
          return Queue.offerUnsafe(isPositionEvent(stamped) ? sinks.positions : sinks.events, stamped);
        };
        const handleLine = Effect.fnUntraced(function* (line: string) {
          const message = yield* parseMessage(line);
          sequence++;
          if (message.kind === "response") {
            const reply = pending.get(message.requestId);
            if (reply)
              yield* Deferred.completeWith(
                reply,
                message.error === "success" ? Effect.succeed(message.data) : Effect.fail(new EngineError({ reason: "rejected", operation: "command", uncertain: false })),
              );
          } else if (message.kind === "event" && !deliver(message.event)) {
            return yield* new EngineError({ reason: "protocol", operation: "event-overflow", uncertain: true });
          }
        });
        yield* Stream.runForEach(wire.lines, handleLine).pipe(
          Effect.catch((error) => Effect.sync(() => terminate(error))),
          Effect.forkScoped,
        );

        const execute = Effect.fn("MpvSession.execute")(function* <A>(input: MpvCommand<A>): Effect.fn.Return<A, EngineError> {
          if (terminal) return yield* terminal;
          const requestId = ++nextRequest;
          const reply = yield* Deferred.make<unknown, EngineError>();
          pending.set(requestId, reply);
          return yield* wire.write(`${JSON.stringify({ command: input.args.map(reveal), request_id: requestId })}\n`).pipe(
            Effect.andThen(Deferred.await(reply)),
            Effect.flatMap(input.decode),
            Effect.timeoutOrElse({ duration: REQUEST_TIMEOUT, orElse: () => Effect.fail(new EngineError({ reason: "timeout", operation: input.name, uncertain: true })) }),
            Effect.tapError((error) =>
              Effect.sync(() => {
                if (error.uncertain) terminate(error);
              }),
            ),
            Effect.onInterrupt(() => Effect.sync(() => terminate(new EngineError({ reason: "closed", operation: input.name, uncertain: true })))),
            Effect.ensuring(Effect.sync(() => pending.delete(requestId))),
          );
        });
        for (const [index, property] of OBSERVED_PROPERTIES.entries()) yield* execute(command("observe_property", index + 1, property));
        return { generation: currentGeneration, sequence: () => sequence, execute, failure: Deferred.await(failed) } satisfies SessionHandle;
      });
      return { open };
    }),
  );
