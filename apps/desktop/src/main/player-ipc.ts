import { dialog, type WebContents } from "electron";
import type { IpcEmitter, IpcListener } from "@electron-toolkit/typed-ipc/main";
import { Effect, ManagedRuntime, Stream } from "effect";
import type { MuswagMainIpc, MuswagRendererIpc } from "#shared/ipc";
import type { CommandResult, PlayerSnapshot } from "#shared/player-contract";
import { makePlayerLayer, Player } from "./player";

export function registerPlayerIpc(main: IpcListener<MuswagMainIpc>, renderer: IpcEmitter<MuswagRendererIpc>, options: Parameters<typeof makePlayerLayer>[0]) {
  const runtime = ManagedRuntime.make(makePlayerLayer(options));
  const subscribers = new Map<number, { id: string; contents: WebContents; awaiting: boolean; latest: PlayerSnapshot | null }>();
  const sendLatest = (subscriber: { id: string; contents: WebContents; awaiting: boolean; latest: PlayerSnapshot | null }) => {
    if (subscriber.awaiting || !subscriber.latest || subscriber.contents.isDestroyed()) return;
    const snapshot = subscriber.latest;
    subscriber.latest = null;
    subscriber.awaiting = true;
    renderer.send(subscriber.contents, "player:snapshot", { subscriptionId: subscriber.id, snapshot });
  };
  const ready = runtime.runPromise(Player.use((player) => player.snapshot));
  // One runtime-owned feed, interrupted by runtime disposal.
  runtime.runFork(
    Effect.gen(function* () {
      const player = yield* Player;
      yield* Stream.runForEach(player.changes, (snapshot) =>
        Effect.sync(() => {
          for (const [key, subscriber] of subscribers) {
            if (subscriber.contents.isDestroyed()) subscribers.delete(key);
            else {
              subscriber.latest = snapshot;
              sendLatest(subscriber);
            }
          }
        }),
      );
    }),
  );
  const snapshot = () => runtime.runPromise(Player.use((player) => player.snapshot));
  const execute = (id: string, command: unknown): Promise<CommandResult> =>
    runtime.runPromise(
      Player.use((player) =>
        player.execute(id, command).pipe(
          Effect.matchEffect({
            onSuccess: (ack) => player.snapshot.pipe(Effect.map((snapshot): CommandResult => ({ ok: true, ack, snapshot }))),
            onFailure: (error) => player.snapshot.pipe(Effect.map((snapshot): CommandResult => ({ ok: false, commandId: id, issue: error.issue, snapshot }))),
          }),
        ),
      ),
    );
  main.handle("player:subscribe", async ({ sender }, subscriptionId) => {
    await ready;
    if (!subscribers.has(sender.id)) sender.once("destroyed", () => subscribers.delete(sender.id));
    subscribers.set(sender.id, { id: subscriptionId, contents: sender, awaiting: false, latest: null });
    return snapshot();
  });
  main.handle("player:unsubscribe", ({ sender }, subscriptionId) => {
    if (subscribers.get(sender.id)?.id === subscriptionId) subscribers.delete(sender.id);
  });
  main.handle("player:ackSnapshot", ({ sender }, subscriptionId) => {
    const subscriber = subscribers.get(sender.id);
    if (subscriber?.id === subscriptionId) {
      subscriber.awaiting = false;
      sendLatest(subscriber);
    }
  });
  main.handle("player:getSnapshot", snapshot);
  main.handle("player:command", (_event, id, command) => execute(id, command));
  main.handle("player:setCredentials", (_event, input) =>
    runtime.runPromise(
      Player.use((player) =>
        player.setCredentials(input).pipe(
          Effect.matchEffect({
            onSuccess: () => player.snapshot.pipe(Effect.map((snapshot): CommandResult => ({ ok: true, ack: { commandId: "credentials", stamp: snapshot.stamp, jobId: null }, snapshot }))),
            onFailure: (error) => player.snapshot.pipe(Effect.map((snapshot): CommandResult => ({ ok: false, commandId: "credentials", issue: error.issue, snapshot }))),
          }),
        ),
      ),
    ),
  );
  main.handle("player:locate", async () => {
    const result = await dialog.showOpenDialog({ title: "Locate mpv", buttonLabel: "Use this binary", properties: ["openFile", "showHiddenFiles", "treatPackageAsDirectory"] });
    return result.canceled || !result.filePaths[0] ? null : execute(crypto.randomUUID(), { _tag: "SetBinaryPath", path: result.filePaths[0] });
  });
  return {
    shutdown: async () => {
      await runtime.runPromise(Player.use((player) => player.shutdown));
      subscribers.clear();
      await runtime.dispose();
    },
  };
}
