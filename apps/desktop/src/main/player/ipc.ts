import { join } from "node:path";
import { dialog } from "electron";
import { Effect, ManagedRuntime, Stream } from "effect";
import type { CommandResult, PlayerCommand, PlayerCredentials, PlayerSnapshot } from "#shared/commands/player";
import type { CommandFailed } from "./errors";
import { makePlayerLayer } from "./layer";
import { Player, type PlayerPosition } from "./player";

/** The player as the rest of main uses it. */
export interface PlayerHandle {
  /** Runs a command, from main itself or one a renderer sent. */
  readonly execute: (command: PlayerCommand) => Promise<CommandResult>;
  /** Lets the user pick an mpv binary in a native dialog and uses it; `null` when they cancel. */
  readonly locate: () => Promise<CommandResult | null>;
  /** Credentials sign stream URLs; `null` stops playback. */
  readonly setCredentials: (credentials: PlayerCredentials | null) => Promise<CommandResult>;
  /** Where the player is in the occurrence it holds, read from mpv: the state has where it was when it last moved otherwise than with time. */
  readonly position: () => Promise<PlayerPosition | null>;
  readonly snapshot: () => Promise<PlayerSnapshot>;
  readonly subscribe: (listener: (snapshot: PlayerSnapshot) => void) => () => void;
  readonly shutdown: () => Promise<void>;
}

/**
 * Runs the player. Renderers see its state through `options.appState`, and send it commands
 * through `app:command`, which lets through only the `RendererCommand`s.
 */
export function startPlayer(options: Parameters<typeof makePlayerLayer>[0]): PlayerHandle {
  const runtime = ManagedRuntime.make(makePlayerLayer(options));
  const snapshot = () => runtime.runPromise(Player.use((player) => player.snapshot));
  /** Runs a player operation and pairs its outcome with the version of the app state that reflects it. */
  const respond = (operation: Effect.Effect<void, CommandFailed, Player>): Promise<CommandResult> =>
    runtime.runPromise(
      operation.pipe(
        Effect.match({
          onSuccess: (): CommandResult => ({ ok: true, version: options.appState.version }),
          onFailure: (error): CommandResult => ({ ok: false, message: error.message, version: options.appState.version }),
        }),
      ),
    );
  const execute = (command: PlayerCommand) => respond(Player.use((player) => player.execute(command)));

  const listeners = new Set<(snapshot: PlayerSnapshot) => void>();
  runtime.runFork(
    Player.use((player) =>
      Stream.runForEach(player.changes, (snapshot) =>
        Effect.sync(() => {
          for (const listener of listeners) listener(snapshot);
        }),
      ),
    ),
  );

  return {
    execute,
    locate: async () => {
      // An app is chosen as a whole, as people know it, and its mpv is the program inside it.
      const result = await dialog.showOpenDialog({ title: "Choose mpv", buttonLabel: "Use this mpv", properties: ["openFile", "showHiddenFiles"] });
      const chosen = result.canceled ? undefined : result.filePaths[0];
      const path = chosen?.endsWith(".app") ? join(chosen, "Contents", "MacOS", "mpv") : chosen;
      return path ? execute({ _tag: "SetBinaryPath", path }) : null;
    },
    setCredentials: (credentials) => respond(Player.use((player) => player.setCredentials(credentials))),
    position: () => runtime.runPromise(Player.use((player) => player.position)),
    snapshot,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    shutdown: async () => {
      // First, so nobody takes the player going idle as it closes for playback having stopped.
      listeners.clear();
      await runtime.runPromise(Player.use((player) => player.shutdown));
      await runtime.dispose();
    },
  };
}
