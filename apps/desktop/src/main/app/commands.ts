import { Db, LibraryQueries, PlaylistCommands, SessionManager } from "@muswag/backend";
import type { Song } from "@muswag/model";
import { Cause, Effect, Exit, Schema } from "effect";
import type { IpcMain } from "electron";

import { AppCommandArgs, type AppCommandName, type AppCommandReply, type AppCommandResults } from "#shared/commands/app";
import type { QueueManager } from "../queue/queue-manager";
import type { LibrarySearch } from "../search/library-search";

type Handlers = { [K in AppCommandName]: (...args: (typeof AppCommandArgs)[K]["Type"]) => Effect.Effect<AppCommandResults[K], unknown> };

/**
 * Answers `app:command` from renderers for as long as the scope lasts: decodes each command against
 * `AppCommandArgs`, runs it, and replies with its result or failure as data.
 */
export const serveAppCommands = (options: {
  readonly ipcMain: Pick<IpcMain, "handle" | "removeHandler">;
  readonly queue: QueueManager;
  readonly songsByIds: (ids: readonly string[]) => Promise<Song[]>;
  readonly search: LibrarySearch["search"];
}) =>
  Effect.gen(function* () {
    const session = yield* SessionManager;
    const commands = yield* PlaylistCommands;
    const db = yield* Db;
    const run = Effect.runPromiseWith(yield* Effect.context<never>());
    const { queue } = options;

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
      "library:refresh": (target) => session.use((active) => active.library.refresh(target)),
      "library:artistAppearances": (artistId) => LibraryQueries.artistAppearances(artistId).pipe(Effect.provideService(Db, db)),
      "library:songPage": (sort, request, withTotal) => LibraryQueries.songPage(sort, request, withTotal).pipe(Effect.provideService(Db, db)),
      "library:songIds": (sort, ranges) => LibraryQueries.songIds(sort, ranges).pipe(Effect.provideService(Db, db)),
      "library:songPosition": (sort, text) => LibraryQueries.songPosition(sort, text).pipe(Effect.provideService(Db, db)),
      "library:albumPage": (request, withTotal) => LibraryQueries.albumPage(request, withTotal).pipe(Effect.provideService(Db, db)),
      "library:artistsWithAlbums": () => LibraryQueries.artistsWithAlbums().pipe(Effect.provideService(Db, db)),
      "library:albumCoverArts": (ids) => LibraryQueries.albumCoverArts(ids).pipe(Effect.provideService(Db, db)),
      "library:albumSongIds": (ids) => LibraryQueries.albumSongIds(ids).pipe(Effect.provideService(Db, db)),
      "library:album": (id) => LibraryQueries.album(id).pipe(Effect.provideService(Db, db)),
      "library:artist": (id) => LibraryQueries.artist(id).pipe(Effect.provideService(Db, db)),
      "library:discography": (id) => LibraryQueries.discography(id).pipe(Effect.provideService(Db, db)),
      "library:albumsByIds": (ids) => LibraryQueries.albumsByIds(ids).pipe(Effect.provideService(Db, db)),
      "library:sourceName": (ref) => LibraryQueries.sourceName(ref).pipe(Effect.provideService(Db, db)),
      "playlists:list": () => LibraryQueries.playlists().pipe(Effect.provideService(Db, db)),
      "playlists:get": (id) => LibraryQueries.playlist(id).pipe(Effect.provideService(Db, db)),
      // The worker finds the rows, and their current contents are read here.
      "library:search": (query, limit) =>
        Effect.tryPromise(() => options.search(query, limit)).pipe(Effect.flatMap((hits) => (hits ? LibraryQueries.searchResults(hits).pipe(Effect.provideService(Db, db)) : Effect.succeed(null)))),
      "playlists:create": (input) => commands.create(input),
      "playlists:rename": (id, name) => commands.rename(id, name),
      "playlists:setComment": (id, comment) => commands.setComment(id, comment),
      "playlists:setVisibility": (id, isPublic) => commands.setVisibility(id, isPublic),
      "playlists:addEntries": (id, songIds, beforeEntryId) => commands.addEntries(id, songIds, beforeEntryId),
      "playlists:removeEntry": (id, entryId) => commands.removeEntry(id, entryId),
      "playlists:moveEntries": (id, entryIds, beforeEntryId) => commands.moveEntries(id, entryIds, beforeEntryId),
      "playlists:delete": (id) => commands.delete(id),
      "playlists:sync": () => session.use((active) => active.playlists.sync),
      "queue:playSource": (ref, key) => Effect.promise(() => queue.playSource({ ...ref }, key)),
      "queue:select": (key) => Effect.promise(() => queue.select(key)),
      "queue:play": () => Effect.promise(() => queue.play()),
      "queue:enqueue": (songIds, beforeKey) => Effect.promise(() => songsInOrder(songIds).then((tracks) => queue.enqueue(tracks, beforeKey))),
      "queue:moveQueued": (keys, beforeKey) => Effect.promise(() => queue.moveQueued(keys, beforeKey)),
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
