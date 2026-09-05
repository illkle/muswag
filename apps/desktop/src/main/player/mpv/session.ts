import { Context, Deferred, Effect, Layer, Scope, Stream } from "effect";
import { EngineError } from "../errors";
import { MpvConnection } from "./connection";
import { command, parseMessage, type MpvCommand, type MpvEvent } from "./protocol";

export type SessionEvent = { readonly generation: number; readonly sequence: number; readonly entryId: number | null; readonly event: MpvEvent };
export interface SessionHandle {
  readonly generation: number;
  readonly sequence: () => number;
  readonly execute: <A>(command: MpvCommand<A>) => Effect.Effect<A, EngineError>;
}
export class MpvSession extends Context.Service<
  MpvSession,
  {
    readonly open: (binaryPath: string, deliver: (event: SessionEvent) => boolean, failed: (error: EngineError, generation: number) => void) => Effect.Effect<SessionHandle, EngineError, Scope.Scope>;
  }
>()("@muswag/player/MpvSession") {}

export const MpvSessionLive = (ipcPath: string) =>
  Layer.effect(
    MpvSession,
    Effect.gen(function* () {
      const connection = yield* MpvConnection;
      let generation = 0;
      return {
        open: (binaryPath, deliver, failed) =>
          Effect.gen(function* () {
            const currentGeneration = ++generation;
            const wire = yield* connection.open(binaryPath, `${ipcPath}-${currentGeneration}`);
            const pending = new Map<number, Deferred.Deferred<unknown, EngineError>>();
            let nextRequest = 0;
            let sequence = 0;
            let entryId: number | null = null;
            let terminal: EngineError | null = null;
            const terminate = (error: EngineError) => {
              if (terminal) return;
              terminal = error;
              for (const reply of pending.values()) Deferred.doneUnsafe(reply, Effect.fail(error));
              pending.clear();
              failed(error, currentGeneration);
            };
            yield* Effect.addFinalizer(() =>
              Effect.sync(() => {
                terminal ??= new EngineError({ reason: "closed", operation: "shutdown", uncertain: false });
                for (const reply of pending.values()) Deferred.doneUnsafe(reply, Effect.fail(terminal));
                pending.clear();
              }),
            );
            const read = Stream.runForEach(wire.lines, (line) =>
              Effect.gen(function* () {
                const message = yield* parseMessage(line);
                sequence++;
                if (message.kind === "response") {
                  const reply = pending.get(message.requestId);
                  if (reply)
                    yield* Deferred.completeWith(
                      reply,
                      message.error === "success" ? Effect.succeed(message.data) : Effect.fail(new EngineError({ reason: "rejected", operation: "command", uncertain: false })),
                    );
                } else if (message.kind === "event") {
                  const event = message.event;
                  if (event.type === "start-file") entryId = event.entryId;
                  const identity = event.type === "end-file" ? event.entryId : entryId;
                  if (!deliver({ generation: currentGeneration, sequence, entryId: identity, event }))
                    return yield* Effect.fail(new EngineError({ reason: "protocol", operation: "event-overflow", uncertain: true }));
                  if (event.type === "end-file" && entryId === event.entryId) entryId = null;
                }
              }),
            ).pipe(Effect.catch((error) => Effect.sync(() => terminate(error))));
            yield* Effect.forkScoped(read);
            const execute = <A>(input: MpvCommand<A>): Effect.Effect<A, EngineError> =>
              Effect.gen(function* () {
                if (terminal) return yield* Effect.fail(terminal);
                const requestId = ++nextRequest;
                const reply = yield* Deferred.make<unknown, EngineError>();
                pending.set(requestId, reply);
                return yield* wire.write(`${JSON.stringify({ command: input.args, request_id: requestId })}\n`).pipe(
                  Effect.andThen(Deferred.await(reply)),
                  Effect.flatMap(input.decode),
                  Effect.timeoutOrElse({ duration: "5 seconds", orElse: () => Effect.fail(new EngineError({ reason: "timeout", operation: input.name, uncertain: true })) }),
                  Effect.tapError((error) =>
                    Effect.sync(() => {
                      if (error.uncertain) terminate(error);
                    }),
                  ),
                  Effect.onInterrupt(() => Effect.sync(() => terminate(new EngineError({ reason: "closed", operation: input.name, uncertain: true })))),
                  Effect.ensuring(Effect.sync(() => pending.delete(requestId))),
                );
              });
            for (const [index, property] of ["pause", "time-pos", "duration", "volume", "mute"].entries()) yield* execute(command("observe_property", index + 1, property));
            return { generation: currentGeneration, sequence: () => sequence, execute };
          }),
      };
    }),
  );
