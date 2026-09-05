import { Context, Effect, Layer, Schema, Semaphore } from "effect";
import { FileSystem } from "effect/FileSystem";
import { Path } from "effect/Path";
import { SettingsError } from "./errors";

const SettingsSchema = Schema.Struct({
  volumePercent: Schema.Finite.check(Schema.isBetween({ minimum: 0, maximum: 100 })),
  muted: Schema.Boolean,
  manualPath: Schema.NullOr(Schema.String),
  cachedPath: Schema.NullOr(Schema.String),
});
export type Settings = typeof SettingsSchema.Type;
export const defaultSettings: Settings = { volumePercent: 100, muted: false, manualPath: null, cachedPath: null };
export class SettingsStore extends Context.Service<
  SettingsStore,
  {
    readonly load: Effect.Effect<Settings, SettingsError>;
    readonly save: (settings: Settings) => Effect.Effect<void, SettingsError>;
  }
>()("@muswag/player/SettingsStore") {}
export const SettingsLive = (file: string) =>
  Layer.effect(
    SettingsStore,
    Effect.gen(function* () {
      const fs = yield* FileSystem;
      const path = yield* Path;
      const lock = yield* Semaphore.make(1);
      return {
        load: fs.readFileString(file).pipe(
          Effect.catch((error) => (error.reason._tag === "NotFound" ? Effect.succeed(JSON.stringify(defaultSettings)) : Effect.fail(new SettingsError({ operation: "load" })))),
          Effect.flatMap((value) => Schema.decodeEffect(Schema.fromJsonString(SettingsSchema))(value)),
          Effect.mapError(() => new SettingsError({ operation: "load" })),
        ),
        save: (settings) =>
          lock
            .withPermit(
              Effect.gen(function* () {
                const temp = `${file}.${crypto.randomUUID()}.tmp`;
                yield* fs.makeDirectory(path.dirname(file), { recursive: true });
                yield* fs.writeFileString(temp, `${JSON.stringify(settings)}\n`).pipe(Effect.andThen(fs.rename(temp, file)), Effect.ensuring(fs.remove(temp, { force: true }).pipe(Effect.ignore)));
              }),
            )
            .pipe(Effect.mapError(() => new SettingsError({ operation: "save" }))),
      };
    }),
  );
