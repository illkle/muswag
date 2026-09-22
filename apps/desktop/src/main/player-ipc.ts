import { dialog, type WebContents } from "electron";
import type { IpcEmitter, IpcListener } from "@electron-toolkit/typed-ipc/main";
import { Effect, ManagedRuntime, Schema, Stream } from "effect";
import type { MuswagMainIpc, MuswagRendererIpc } from "#shared/ipc";
import { PlayerCommand, PlayerCredentials, type CommandAck, type CommandResult, type PlayerSnapshot } from "#shared/player-contract";
import { makePlayerLayer, Player } from "./player";
import { CommandFailed, InvalidCommand, toIssue } from "./player/errors";

/** A window receives at most one unacknowledged snapshot; newer ones replace `latest` until it acks. */
type Subscriber = { readonly id: string; readonly contents: WebContents; awaitingAck: boolean; latest: PlayerSnapshot | null };

const invalid = (operation: string, message: string) => new CommandFailed({ issue: toIssue(new InvalidCommand({ operation, message })) });
const decodeCommand = (input: unknown) => Schema.decodeUnknownEffect(PlayerCommand)(input).pipe(Effect.mapError(() => invalid("decode", "Invalid player command.")));
const decodeCredentials = (input: unknown) => Schema.decodeUnknownEffect(Schema.NullOr(PlayerCredentials))(input).pipe(Effect.mapError(() => invalid("credentials", "Invalid credentials.")));

export function registerPlayerIpc(main: IpcListener<MuswagMainIpc>, renderer: IpcEmitter<MuswagRendererIpc>, options: Parameters<typeof makePlayerLayer>[0]) {
  const runtime = ManagedRuntime.make(makePlayerLayer(options));
  const snapshot = () => runtime.runPromise(Player.use((player) => player.snapshot));
  /** Runs a player operation and pairs its outcome with the snapshot that reflects it. */
  const respond = (commandId: string, operation: Effect.Effect<CommandAck, CommandFailed, Player>): Promise<CommandResult> =>
    runtime.runPromise(
      operation.pipe(
        Effect.matchEffect({
          onSuccess: (ack) => Player.use((player) => player.snapshot).pipe(Effect.map((snapshot): CommandResult => ({ ok: true, ack, snapshot }))),
          onFailure: (error) => Player.use((player) => player.snapshot).pipe(Effect.map((snapshot): CommandResult => ({ ok: false, commandId, issue: error.issue, snapshot }))),
        }),
      ),
    );
  const execute = (commandId: string, input: unknown) => respond(commandId, decodeCommand(input).pipe(Effect.flatMap((command) => Player.use((player) => player.execute(commandId, command)))));

  const subscribers = new Map<number, Subscriber>();
  const deliver = (subscriber: Subscriber) => {
    if (subscriber.awaitingAck || !subscriber.latest || subscriber.contents.isDestroyed()) return;
    const snapshot = subscriber.latest;
    subscriber.latest = null;
    subscriber.awaitingAck = true;
    renderer.send(subscriber.contents, "player:snapshot", { subscriptionId: subscriber.id, snapshot });
  };
  // One runtime-owned feed, interrupted by runtime disposal.
  runtime.runFork(
    Player.use((player) =>
      Stream.runForEach(player.changes, (snapshot) =>
        Effect.sync(() => {
          for (const [key, subscriber] of subscribers) {
            if (subscriber.contents.isDestroyed()) {
              subscribers.delete(key);
              continue;
            }
            subscriber.latest = snapshot;
            deliver(subscriber);
          }
        }),
      ),
    ),
  );

  main.handle("player:subscribe", async ({ sender }, subscriptionId) => {
    if (!subscribers.has(sender.id)) sender.once("destroyed", () => subscribers.delete(sender.id));
    subscribers.set(sender.id, { id: subscriptionId, contents: sender, awaitingAck: false, latest: null });
    return snapshot();
  });
  main.handle("player:unsubscribe", ({ sender }, subscriptionId) => {
    if (subscribers.get(sender.id)?.id === subscriptionId) subscribers.delete(sender.id);
  });
  main.handle("player:ackSnapshot", ({ sender }, subscriptionId) => {
    const subscriber = subscribers.get(sender.id);
    if (subscriber?.id !== subscriptionId) return;
    subscriber.awaitingAck = false;
    deliver(subscriber);
  });
  main.handle("player:getSnapshot", snapshot);
  main.handle("player:command", (_event, commandId, command) => execute(commandId, command));
  main.handle("player:setCredentials", (_event, input) =>
    respond("credentials", decodeCredentials(input).pipe(Effect.flatMap((credentials) => Player.use((player) => player.setCredentials(credentials))))),
  );
  main.handle("player:locate", async () => {
    const result = await dialog.showOpenDialog({ title: "Locate mpv", buttonLabel: "Use this binary", properties: ["openFile", "showHiddenFiles", "treatPackageAsDirectory"] });
    const path = result.canceled ? undefined : result.filePaths[0];
    return path ? execute(crypto.randomUUID(), { _tag: "SetBinaryPath", path }) : null;
  });

  return {
    shutdown: async () => {
      await runtime.runPromise(Player.use((player) => player.shutdown));
      subscribers.clear();
      await runtime.dispose();
    },
  };
}
