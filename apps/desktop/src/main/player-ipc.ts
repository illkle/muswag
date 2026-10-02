import { dialog } from "electron";
import type { IpcListener } from "@electron-toolkit/typed-ipc/main";
import { Effect, ManagedRuntime, Schema, Stream } from "effect";
import type { MuswagMainIpc } from "#shared/ipc";
import { PlayerCommand, type CommandAck, type CommandResult, type PlayerCredentials, type PlayerSnapshot } from "#shared/player-contract";
import { makePlayerLayer, Player } from "./player";
import { CommandFailed, InvalidCommand, toIssue } from "./player/errors";

const invalid = (operation: string, message: string) => new CommandFailed({ issue: toIssue(new InvalidCommand({ operation, message })) });
const decodeCommand = (input: unknown) => Schema.decodeUnknownEffect(PlayerCommand)(input).pipe(Effect.mapError(() => invalid("decode", "Invalid player command.")));

/** Runs the player and its commands. Renderers see its state through `options.stateMirror`. */
export function registerPlayerIpc(main: IpcListener<MuswagMainIpc>, options: Parameters<typeof makePlayerLayer>[0]) {
  const runtime = ManagedRuntime.make(makePlayerLayer(options));
  const snapshot = () => runtime.runPromise(Player.use((player) => player.snapshot));
  /** Runs a player operation and pairs its outcome with the state-mirror position that reflects it. */
  const respond = (commandId: string, operation: Effect.Effect<CommandAck, CommandFailed, Player>): Promise<CommandResult> =>
    runtime.runPromise(
      operation.pipe(
        Effect.matchEffect({
          onSuccess: (ack) => options.stateMirror.position.pipe(Effect.map((position): CommandResult => ({ ok: true, ack, position }))),
          onFailure: (error) => options.stateMirror.position.pipe(Effect.map((position): CommandResult => ({ ok: false, commandId, issue: error.issue, position }))),
        }),
      ),
    );
  const execute = (commandId: string, input: unknown) => respond(commandId, decodeCommand(input).pipe(Effect.flatMap((command) => Player.use((player) => player.execute(commandId, command)))));

  main.handle("player:command", (_event, commandId, command) => execute(commandId, command));
  main.handle("player:locate", async () => {
    const result = await dialog.showOpenDialog({ title: "Locate mpv", buttonLabel: "Use this binary", properties: ["openFile", "showHiddenFiles", "treatPackageAsDirectory"] });
    const path = result.canceled ? undefined : result.filePaths[0];
    return path ? execute(crypto.randomUUID(), { _tag: "SetBinaryPath", path }) : null;
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
    /** Runs a command from main itself, such as the queue manager. */
    execute: (command: PlayerCommand) =>
      respond(
        crypto.randomUUID(),
        Player.use((player) => player.execute(crypto.randomUUID(), command)),
      ),
    /** Credentials sign stream URLs; `null` stops playback. */
    setCredentials: (credentials: PlayerCredentials | null) =>
      respond(
        "credentials",
        Player.use((player) => player.setCredentials(credentials)),
      ),
    snapshot,
    subscribe: (listener: (snapshot: PlayerSnapshot) => void) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    shutdown: async () => {
      await runtime.runPromise(Player.use((player) => player.shutdown));
      listeners.clear();
      await runtime.dispose();
    },
  };
}
