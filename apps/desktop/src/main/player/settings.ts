import { Context, Effect, FiberHandle, Layer, Schema, Semaphore } from "effect";
import { FileSystem } from "effect/FileSystem";
import { Path } from "effect/Path";
import { SettingsError } from "./errors";

const SAVE_DELAY = "250 millis";
const FLUSH_TIMEOUT = "2 seconds";

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

/**
 * Coalesces frequent preference changes (volume drags) into one delayed write.
 * `save` writes immediately; `flush` writes whatever is still pending, bounded for shutdown.
 * Background write failures are reported through `onFailure`.
 */
export const makeSettingsWriter = Effect.fn("makeSettingsWriter")(function* (store: typeof SettingsStore.Service, onFailure: Effect.Effect<void>) {
  const timer = yield* FiberHandle.make<void>();
  let pending: Settings | null = null;
  const write = (settings: Settings) =>
    store.save(settings).pipe(
      Effect.tap(() =>
        Effect.sync(() => {
          if (pending === settings) pending = null;
        }),
      ),
    );
  return {
    schedule: (settings: Settings) =>
      Effect.suspend(() => {
        pending = settings;
        return FiberHandle.run(
          timer,
          Effect.sleep(SAVE_DELAY).pipe(
            Effect.andThen(write(settings)),
            Effect.catch(() => onFailure),
          ),
        );
      }).pipe(Effect.asVoid),
    save: (settings: Settings) => FiberHandle.clear(timer).pipe(Effect.andThen(write(settings))),
    flush: Effect.gen(function* () {
      yield* FiberHandle.clear(timer);
      if (!pending) return;
      yield* write(pending).pipe(
        Effect.timeoutOrElse({ duration: FLUSH_TIMEOUT, orElse: () => Effect.logWarning("Settings flush timed out") }),
        Effect.catch(() => Effect.logWarning("Settings flush failed")),
      );
    }),
  };
});
