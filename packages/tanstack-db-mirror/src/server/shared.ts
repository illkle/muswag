import { Cause, Data, Effect, Scope } from "effect";

import {
  MIRROR_PROTOCOL_VERSION,
  type MirrorChangeBatch,
  type MirrorKey,
  type MirrorMutation,
  type MirrorRequest,
  type MirrorResponse,
  type MirrorResults,
  type MirrorServerTransport,
} from "../protocol.js";

/** A request the server refused: unknown table or column, missing row, malformed payload. */
export class MirrorRequestError extends Data.TaggedError("MirrorRequestError")<{ readonly message: string }> {}

export const readOnlyError = () => new MirrorRequestError({ message: "This mirror is read-only; change the data through the server instead" });

/** Change-batch listeners, isolated from each other: one that throws does not stop the rest. */
export function makeListeners() {
  const listeners = new Set<(batch: MirrorChangeBatch) => void>();
  return {
    subscribe: (listener: (batch: MirrorChangeBatch) => void) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    broadcast: (batch: MirrorChangeBatch) => {
      for (const listener of listeners) {
        try {
          listener(batch);
        } catch (cause) {
          console.error("[tanstack-db-mirror] change listener failed", cause);
        }
      }
    },
  };
}

/** Validates a request, runs it, and wraps the outcome in a response envelope. Never fails. */
export const handleRequest =
  <R>(dispatch: (request: MirrorRequest) => Effect.Effect<MirrorResults[keyof MirrorResults], unknown, R>) =>
  (raw: unknown): Effect.Effect<MirrorResponse, never, R> =>
    Effect.suspend(() => dispatch(parseRequest(raw))).pipe(
      Effect.map((result): MirrorResponse => ({ ok: true, result })),
      Effect.catchCause((cause) => Effect.succeed<MirrorResponse>({ ok: false, error: errorPayload(Cause.squash(cause)) })),
    );

/** Connects a transport to a server for the lifetime of the current scope. */
export const serveWith =
  (handle: (request: unknown) => Effect.Effect<MirrorResponse>, subscribe: (listener: (batch: MirrorChangeBatch) => void) => () => void) =>
  (transport: MirrorServerTransport): Effect.Effect<void, never, Scope.Scope> =>
    Effect.gen(function* () {
      const runPromise = Effect.runPromiseWith(yield* Effect.context<never>());
      const stopListening = transport.listen((request) => runPromise(handle(request)));
      const unsubscribe = subscribe((batch) => transport.broadcast(batch));
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => {
          stopListening();
          unsubscribe();
        }),
      );
    });

const MUTATION_TYPES = new Set(["insert", "update", "delete"]);

export function parseRequest(raw: unknown): MirrorRequest {
  const invalid = (message: string) => new MirrorRequestError({ message: `Invalid mirror request: ${message}` });
  if (!isRecord(raw)) throw invalid("expected an object");
  if (raw.v !== MIRROR_PROTOCOL_VERSION) throw invalid(`unsupported protocol version ${String(raw.v)}`);

  switch (raw.type) {
    case "hello":
      return { v: MIRROR_PROTOCOL_VERSION, type: "hello" };
    case "snapshot":
      if (typeof raw.table !== "string") throw invalid("snapshot.table must be a string");
      return { v: MIRROR_PROTOCOL_VERSION, type: "snapshot", table: raw.table };
    case "pull":
      if (typeof raw.fromSeq !== "number") throw invalid("pull.fromSeq must be a number");
      return { v: MIRROR_PROTOCOL_VERSION, type: "pull", fromSeq: raw.fromSeq };
    case "mutate": {
      if (!Array.isArray(raw.mutations)) throw invalid("mutate.mutations must be an array");
      for (const mutation of raw.mutations as Array<unknown>) {
        if (!isRecord(mutation) || typeof mutation.table !== "string" || !MUTATION_TYPES.has(mutation.type as string)) {
          throw invalid("malformed mutation");
        }
        if (mutation.type === "insert" ? !isRecord(mutation.value) : !isKey(mutation.key)) throw invalid("malformed mutation");
        if (mutation.type === "update" && !isRecord(mutation.changes)) throw invalid("malformed mutation");
      }
      return { v: MIRROR_PROTOCOL_VERSION, type: "mutate", mutations: raw.mutations as Array<MirrorMutation> };
    }
    default:
      throw invalid(`unknown request type ${String(raw.type)}`);
  }
}

export const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
export const isKey = (value: unknown): value is MirrorKey => typeof value === "string" || typeof value === "number";

export function errorPayload(error: unknown) {
  if (!(error instanceof Error)) return { name: "Error", message: String(error) };
  // SqlError's own message is generic ("Failed to execute statement"); the driver's message
  // ("FOREIGN KEY constraint failed") sits on its reason's cause.
  const details: Array<string> = [];
  let cause: unknown = (error as { reason?: { cause?: unknown } }).reason?.cause ?? error.cause;
  while (cause instanceof Error && details.length < 5) {
    if (cause.message && !details.includes(cause.message)) details.push(cause.message);
    cause = (cause as { reason?: { cause?: unknown } }).reason?.cause ?? cause.cause;
  }
  const message = [error.message, ...details.filter((detail) => detail !== error.message)].join(": ");
  return { name: (error as { _tag?: string })._tag ?? error.name, message };
}
