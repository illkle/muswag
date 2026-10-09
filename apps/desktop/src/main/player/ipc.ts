import { dialog } from "electron";
import type { IpcListener } from "@electron-toolkit/typed-ipc/main";
import { Effect, ManagedRuntime, Schema, Stream } from "effect";
import type { MuswagMainIpc } from "#shared/ipc";
import { RendererCommand, type CommandResult, type PlayerCommand, type PlayerCredentials, type PlayerSnapshot } from "#shared/commands/player";
import { CommandFailed } from "./errors";
import { makePlayerLayer } from "./layer";
import { Player } from "./player";

/** The player as the rest of main uses it. */
export interface PlayerHandle {
  /** Runs a command from main itself, such as the queue manager. */
  readonly execute: (command: PlayerCommand) => Promise<CommandResult>;
  /** Credentials sign stream URLs; `null` stops playback. */
  readonly setCredentials: (credentials: PlayerCredentials | null) => Promise<CommandResult>;
  readonly snapshot: () => Promise<PlayerSnapshot>;
  readonly subscribe: (listener: (snapshot: PlayerSnapshot) => void) => () => void;
  readonly shutdown: () => Promise<void>;
}

/** A renderer's command, which is all a renderer can make the player do: main's own commands do not decode. */
const decodeCommand = (input: unknown) => Schema.decodeUnknownEffect(RendererCommand)(input).pipe(Effect.mapError(() => new CommandFailed({ message: "Invalid player command." })));

/** Runs the player and its commands. Renderers see its state through `options.stateMirror`. */
export function registerPlayerIpc(main: IpcListener<MuswagMainIpc>, options: Parameters<typeof makePlayerLayer>[0]): PlayerHandle {
  const runtime = ManagedRuntime.make(makePlayerLayer(options));
  const snapshot = () => runtime.runPromise(Player.use((player) => player.snapshot));
  /** Runs a player operation and pairs its outcome with the state-mirror position that reflects it. */
  const respond = (operation: Effect.Effect<void, CommandFailed, Player>): Promise<CommandResult> =>
    runtime.runPromise(
      operation.pipe(
        Effect.matchEffect({
          onSuccess: () => options.stateMirror.position.pipe(Effect.map((position): CommandResult => ({ ok: true, position }))),
          onFailure: (error) => options.stateMirror.position.pipe(Effect.map((position): CommandResult => ({ ok: false, message: error.message, position }))),
        }),
      ),
    );
  const execute = (command: Effect.Effect<PlayerCommand, CommandFailed>) => respond(command.pipe(Effect.flatMap((command) => Player.use((player) => player.execute(command)))));

  main.handle("player:command", (_event, command) => execute(decodeCommand(command)));
  main.handle("player:locate", async () => {
    const result = await dialog.showOpenDialog({ title: "Locate mpv", buttonLabel: "Use this binary", properties: ["openFile", "showHiddenFiles", "treatPackageAsDirectory"] });
    const path = result.canceled ? undefined : result.filePaths[0];
    return path ? execute(Effect.succeed({ _tag: "SetBinaryPath", path })) : null;
  });

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
    execute: (command) => execute(Effect.succeed(command)),
    setCredentials: (credentials) => respond(Player.use((player) => player.setCredentials(credentials))),
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
