import { Effect, Schema } from "effect";
import { EngineError } from "../errors";

export type MpvEvent =
  | { readonly type: "start-file"; readonly entryId: number }
  | { readonly type: "file-loaded" }
  | { readonly type: "end-file"; readonly entryId: number; readonly reason: string }
  | { readonly type: "property"; readonly name: string; readonly data: unknown };
export type Message = { kind: "response"; requestId: number; error: string; data: unknown } | { kind: "event"; event: MpvEvent } | { kind: "ignored" };
const id = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0));
const response = Schema.Struct({ request_id: id, error: Schema.String, data: Schema.optional(Schema.Unknown) });
const start = Schema.Struct({ event: Schema.Literal("start-file"), playlist_entry_id: id });
const end = Schema.Struct({ event: Schema.Literal("end-file"), playlist_entry_id: id, reason: Schema.String });
// mpv omits data for unavailable observations (e.g. duration before loading).
const property = Schema.Struct({ event: Schema.Literal("property-change"), name: Schema.String, data: Schema.optional(Schema.Unknown) });
const protocolError = (operation: string) => new EngineError({ reason: "protocol", operation, uncertain: true });
const decodeMessage = <A, I>(schema: Schema.Codec<A, I>, value: unknown, operation: string) => Schema.decodeUnknownEffect(schema)(value).pipe(Effect.mapError(() => protocolError(operation)));
export const parseMessage = (line: string): Effect.Effect<Message, EngineError> =>
  Effect.gen(function* () {
    const record = yield* decodeMessage(Schema.fromJsonString(Schema.Record(Schema.String, Schema.Unknown)), line, "decode:json-object");
    // Events can also carry an error field; only replies have request_id.
    if ("event" in record) {
      switch (record.event) {
        case "start-file": {
          const parsed = yield* decodeMessage(start, record, "decode:start-file");
          return { kind: "event", event: { type: "start-file", entryId: parsed.playlist_entry_id } };
        }
        case "end-file": {
          const parsed = yield* decodeMessage(end, record, "decode:end-file");
          return { kind: "event", event: { type: "end-file", entryId: parsed.playlist_entry_id, reason: parsed.reason } };
        }
        case "file-loaded":
          return { kind: "event", event: { type: "file-loaded" } };
        case "property-change": {
          const parsed = yield* decodeMessage(property, record, "decode:property-change");
          return { kind: "event", event: { type: "property", name: parsed.name, data: parsed.data } };
        }
        default:
          return { kind: "ignored" };
      }
    }
    if ("request_id" in record || "error" in record) {
      const parsed = yield* decodeMessage(response, record, "decode:response");
      return { kind: "response", requestId: parsed.request_id, error: parsed.error, data: parsed.data };
    }
    return { kind: "ignored" };
  });
export interface MpvCommand<A> {
  readonly name: string;
  readonly args: readonly unknown[];
  readonly decode: (value: unknown) => Effect.Effect<A, EngineError>;
}
const decode =
  <A>(schema: Schema.Codec<A>, operation: string) =>
  (value: unknown) =>
    Schema.decodeUnknownEffect(schema)(value).pipe(Effect.mapError(() => protocolError(`decode:${operation}`)));
export const command = (name: string, ...args: readonly unknown[]): MpvCommand<void> => ({ name, args: [name, ...args], decode: () => Effect.void });
export const load = (url: string, mode: "replace" | "insert-at", index = -1): MpvCommand<{ readonly playlist_entry_id: number }> => ({
  name: "loadfile",
  args: ["loadfile", url, mode, index],
  decode: decode(Schema.Struct({ playlist_entry_id: id }), "loadfile"),
});
export const playlist: MpvCommand<readonly { readonly id: number; readonly current?: boolean | undefined }[]> = {
  name: "playlist",
  args: ["get_property", "playlist"],
  decode: decode(Schema.Array(Schema.Struct({ id, current: Schema.optional(Schema.Boolean) })), "playlist"),
};
export const booleanProperty = (name: string): MpvCommand<boolean> => ({ name, args: ["get_property", name], decode: decode(Schema.Boolean, name) });
export const numberProperty = (name: string): MpvCommand<number> => ({ name, args: ["get_property", name], decode: decode(Schema.Finite, name) });
