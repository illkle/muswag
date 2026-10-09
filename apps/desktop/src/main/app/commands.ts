import { PlaylistCommands, SessionManager } from "@muswag/backend";
import type { Song } from "@muswag/model";
import { SqliteMirror } from "@muswag/tanstack-db-mirror/server/sqlite";
import { Cause, Effect, Exit, Schema } from "effect";
import type { IpcMain } from "electron";

import { AppCommandArgs, type AppCommandName, type AppCommandReply, type AppCommandResults } from "#shared/commands/app";
import type { QueueManager } from "../queue/queue-manager";

type Handlers = { [K in AppCommandName]: (...args: (typeof AppCommandArgs)[K]["Type"]) => Effect.Effect<AppCommandResults[K], unknown> };

/**
 * Answers `app:command` from renderers for as long as the scope lasts: decodes each command against
 * `AppCommandArgs`, runs it, and replies with its result or failure as data.
 */
export const serveAppCommands = (options: {
  readonly ipcMain: Pick<IpcMain, "handle" | "removeHandler">;
  readonly queue: QueueManager;
  readonly songsByIds: (ids: readonly string[]) => Promise<Song[]>;
}) =>
  Effect.gen(function* () {
    const session = yield* SessionManager;
    const commands = yield* PlaylistCommands;
    const mirror = yield* SqliteMirror;
    const run = Effect.runPromiseWith(yield* Effect.context<never>());
    const { queue } = options;

    /** A library write, paired with the mirror position renderers can await to see it. */
    const written = <A, E>(effect: Effect.Effect<A, E>) => effect.pipe(Effect.flatMap((value) => mirror.position.pipe(Effect.map((position) => ({ value, position })))));

    /** Songs in the order of `ids`, skipping any that are gone. */
    const songsInOrder = async (ids: readonly string[]): Promise<Song[]> => {
      const byId = new Map((await options.songsByIds([...new Set(ids)])).map((song) => [song.id, song]));
      return ids.flatMap((id) => byId.get(id) ?? []);
    };

    // Ending a session must work even when playback cannot be stopped cleanly.
    const clearQueue = Effect.tryPromise(() => queue.clear()).pipe(Effect.catch((cause) => Effect.logWarning("Failed to stop playback and clear the queue", cause)));

    const handlers: Handlers = {
      // Logging in as someone else deletes what the database holds of the account before; the queue goes with it.
      "session:login": (credentials) => session.login(credentials, { beforeDataIsDeleted: clearQueue }),
      "session:logout": () => clearQueue.pipe(Effect.andThen(session.logout)),
      "library:sync": (mode) => session.use((active) => active.library.sync(mode)),
      "library:refreshStats": (target) => session.use((active) => active.library.refreshStats(target)),
      "playlists:create": (input) => written(commands.create(input)),
      "playlists:rename": (id, name) => written(commands.rename(id, name)),
      "playlists:setComment": (id, comment) => written(commands.setComment(id, comment)),
      "playlists:setVisibility": (id, isPublic) => written(commands.setVisibility(id, isPublic)),
      "playlists:addEntries": (id, songIds, beforeEntryId) => written(commands.addEntries(id, songIds, beforeEntryId)),
      "playlists:removeEntry": (id, entryId) => written(commands.removeEntry(id, entryId)),
      "playlists:delete": (id) => written(commands.delete(id)),
      "playlists:sync": () => session.use((active) => active.playlists.sync),
      "queue:playSource": (ref, key) => Effect.promise(() => queue.playSource({ ...ref }, key)),
      "queue:select": (key) => Effect.promise(() => queue.select(key)),
      "queue:play": () => Effect.promise(() => queue.play()),
      "queue:enqueue": (songIds) => Effect.promise(() => songsInOrder(songIds).then((tracks) => queue.enqueue(tracks))),
      "queue:removeQueued": (key) => Effect.promise(() => queue.removeQueued(key)),
      "queue:next": () => Effect.promise(() => queue.next()),
      "queue:previous": () => Effect.promise(() => queue.previous()),
    };

    const execute = <K extends AppCommandName>(name: K, input: unknown): Effect.Effect<AppCommandReply<K>> =>
      Schema.decodeUnknownEffect(AppCommandArgs[name])(input).pipe(
        Effect.mapError(() => ({ _tag: "InvalidCommand", message: `Invalid arguments for ${name}` })),
        Effect.flatMap((args) => (handlers[name] as (...args: ReadonlyArray<unknown>) => Effect.Effect<AppCommandResults[K], unknown>)(...(args as ReadonlyArray<unknown>))),
        Effect.exit,
        Effect.flatMap((exit) => {
          if (Exit.isSuccess(exit)) return Effect.succeed<AppCommandReply<K>>({ ok: true, value: exit.value });
          const error = Cause.squash(exit.cause) as { _tag?: unknown; message?: unknown };
          return Effect.logError(`Command ${name} failed`, exit.cause).pipe(
            Effect.as<AppCommandReply<K>>({
              ok: false,
              error: { tag: typeof error?._tag === "string" ? error._tag : "Error", message: typeof error?.message === "string" ? error.message : String(error) },
            }),
          );
        }),
      );

    yield* Effect.acquireRelease(
      Effect.sync(() => {
        options.ipcMain.handle("app:command", (_event, name: unknown, args: unknown) => {
          if (typeof name !== "string" || !Object.hasOwn(AppCommandArgs, name)) return { ok: false, error: { tag: "InvalidCommand", message: `Unknown command ${String(name)}` } };
          return run(execute(name as AppCommandName, args));
        });
      }),
      () =>
        Effect.sync(() => {
          options.ipcMain.removeHandler("app:command");
        }),
    );
  });
