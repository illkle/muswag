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
const property = Schema.Struct({ event: Schema.Literal("property-change"), name: Schema.String, data: Schema.Unknown });
const protocolError = () => new EngineError({ reason: "protocol", operation: "decode", uncertain: true });
export const parseMessage = (line: string): Effect.Effect<Message, EngineError> =>
  Effect.try({
    try: () => {
      const value: unknown = JSON.parse(line);
      if (!value || typeof value !== "object") throw protocolError();
      const record = value as Record<string, unknown>;
      if ("request_id" in record || "error" in record) {
        const parsed = Schema.decodeUnknownSync(response)(record);
        return { kind: "response", requestId: parsed.request_id, error: parsed.error, data: parsed.data };
      }
      if (record.event === "start-file") return { kind: "event", event: { type: "start-file", entryId: Schema.decodeUnknownSync(start)(record).playlist_entry_id } };
      if (record.event === "end-file") {
        const parsed = Schema.decodeUnknownSync(end)(record);
        return { kind: "event", event: { type: "end-file", entryId: parsed.playlist_entry_id, reason: parsed.reason } };
      }
      if (record.event === "file-loaded") return { kind: "event", event: { type: "file-loaded" } };
      if (record.event === "property-change") {
        const parsed = Schema.decodeUnknownSync(property)(record);
        return { kind: "event", event: { type: "property", name: parsed.name, data: parsed.data } };
      }
      return { kind: "ignored" };
    },
    catch: protocolError,
  });
export interface MpvCommand<A> {
  readonly name: string;
  readonly args: readonly unknown[];
  readonly decode: (value: unknown) => Effect.Effect<A, EngineError>;
}
const decode =
  <A>(schema: Schema.Codec<A>) =>
  (value: unknown) =>
    Schema.decodeUnknownEffect(schema)(value).pipe(Effect.mapError(protocolError));
export const command = (name: string, ...args: readonly unknown[]): MpvCommand<void> => ({ name, args: [name, ...args], decode: () => Effect.void });
export const load = (url: string, mode: "replace" | "insert-at", index = -1): MpvCommand<{ readonly playlist_entry_id: number }> => ({
  name: "loadfile",
  args: ["loadfile", url, mode, index],
  decode: decode(Schema.Struct({ playlist_entry_id: id })),
});
export const playlist: MpvCommand<readonly { readonly id: number; readonly current?: boolean | undefined }[]> = {
  name: "playlist",
  args: ["get_property", "playlist"],
  decode: decode(Schema.Array(Schema.Struct({ id, current: Schema.optional(Schema.Boolean) }))),
};
export const booleanProperty = (name: string): MpvCommand<boolean> => ({ name, args: ["get_property", name], decode: decode(Schema.Boolean) });
export const numberProperty = (name: string): MpvCommand<number> => ({ name, args: ["get_property", name], decode: decode(Schema.Finite) });
