import { createStore } from "@tanstack/react-store";
import { initialSnapshot, type CommandResult, type PlayerCommand, type PlayerIssue, type PlayerSnapshot } from "#shared/player-contract";
import { acceptSnapshot, binaryView, runtimeView } from "#/player/snapshot";
import { IpcEmitter, IpcListener } from "@electron-toolkit/typed-ipc/renderer";

import type { AppUpdateState, MpvInstallOutput, MuswagMainIpc, MuswagRendererIpc } from "#shared/ipc";
import type { ApplyMpvQueueInput, MpvInstallMethod, PlayerRuntimeState } from "#shared/player";
import type { SessionCredentials } from "@muswag/shared";

const mainIpc = new IpcEmitter<MuswagMainIpc>();
const rendererIpc = new IpcListener<MuswagRendererIpc>();

export const AppUpdateIPC = {
  check: () => mainIpc.invoke("appUpdate:check"),
  getState: () => mainIpc.invoke("appUpdate:getState"),
  install: () => mainIpc.invoke("appUpdate:install"),
  subscribe: (listener: (state: AppUpdateState) => void) =>
    rendererIpc.on("appUpdate:state", (_event, state) => {
      listener(state);
    }),
};

export const PlayerConnectionStore = createStore({ snapshot: initialSnapshot("unconnected"), connected: false, issue: null as PlayerIssue | null });
const runtimeListeners = new Set<(state: PlayerRuntimeState) => void>();
let subscriptionId = "";
let establishedEpoch = "";
let buffered: PlayerSnapshot | null = null;
let heartbeat: ReturnType<typeof setTimeout> | undefined;
let stopped = false;
let failedCommand: { command: PlayerCommand; issueId: string } | null = null;
const update = (incoming: PlayerSnapshot) => {
  const previous = PlayerConnectionStore.state.snapshot;
  const snapshot = acceptSnapshot(previous, incoming, establishedEpoch);
  PlayerConnectionStore.setState((state) => ({ ...state, snapshot, connected: true }));
  if (snapshot !== previous) for (const listener of runtimeListeners) listener(runtimeView(snapshot));
};
const deadline = <A>(promise: Promise<A>, ms = 5000): Promise<A> =>
  new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("Playback connection timed out.")), ms);
    promise.then(resolve, reject).finally(() => clearTimeout(timer));
  });
const disconnect = () => PlayerConnectionStore.setState((state) => ({ ...state, connected: false }));

const connect = async () => {
  subscriptionId = crypto.randomUUID();
  establishedEpoch = "";
  buffered = null;
  const id = subscriptionId;
  try {
    const snapshot = await deadline(mainIpc.invoke("player:subscribe", id));
    if (id !== subscriptionId || stopped) return;
    establishedEpoch = snapshot.stamp.epoch;
    update(snapshot);
    if (buffered) update(buffered);
  } catch {
    disconnect();
  }
};
const poll = async () => {
  if (stopped) return;
  try {
    if (!PlayerConnectionStore.state.connected) await connect();
    else {
      const snapshot = await deadline(mainIpc.invoke("player:getSnapshot"));
      if (snapshot.stamp.epoch !== establishedEpoch) await connect();
      else update(snapshot);
    }
  } catch {
    disconnect();
  }
  if (!stopped)
    heartbeat = setTimeout(() => {
      void poll();
    }, 3000);
};
let started = false;
export function initializePlayerConnection() {
  if (started) return;
  started = true;
  rendererIpc.on("player:snapshot", (_event, message) => {
    if (message.subscriptionId !== subscriptionId) return;
    void mainIpc.invoke("player:ackSnapshot", subscriptionId).catch(disconnect);
    if (!establishedEpoch) {
      buffered = message.snapshot;
      return;
    }
    update(message.snapshot);
  });
  void poll();
  window.addEventListener("beforeunload", () => {
    stopped = true;
    clearTimeout(heartbeat);
    void mainIpc.invoke("player:unsubscribe", subscriptionId).catch(() => {});
  });
}

const acceptResult = (result: CommandResult) => {
  if (establishedEpoch) update(result.snapshot);
  if (!result.ok) {
    PlayerConnectionStore.setState((state) => ({ ...state, issue: result.issue }));
    throw Object.assign(new Error(result.issue.message), { issue: result.issue });
  }
  PlayerConnectionStore.setState((state) => ({ ...state, issue: null }));
  return result.snapshot;
};
async function dispatch(command: PlayerCommand) {
  if (!PlayerConnectionStore.state.connected) throw new Error("Playback is disconnected. Reconnecting…");
  try {
    const result = await deadline(mainIpc.invoke("player:command", crypto.randomUUID(), command), 45000);
    if (!result.ok) failedCommand = { command, issueId: result.issue.id };
    return acceptResult(result);
  } catch (error) {
    if (!(error instanceof Error && "issue" in error)) disconnect();
    throw error;
  }
}
const execute = async (command: PlayerCommand): Promise<void> => {
  await dispatch(command);
};
export const MpvIPC = {
  cancelInstall: async () => {
    const install = PlayerConnectionStore.state.snapshot.install;
    if (install._tag !== "Idle") await execute({ _tag: "CancelInstall", jobId: install.jobId });
  },
  clearManualPath: async () => binaryView(await dispatch({ _tag: "SetBinaryPath", path: null })),
  install: async (method: MpvInstallMethod) => binaryView(await dispatch({ _tag: "StartInstall", method })),
  locate: async () => {
    const result = await mainIpc.invoke("player:locate");
    return binaryView(result ? acceptResult(result) : PlayerConnectionStore.state.snapshot);
  },
  recheck: async () => binaryView(await dispatch({ _tag: "RefreshBinary" })),
  subscribeInstallOutput: (listener: (output: MpvInstallOutput) => void) => {
    let job = "";
    let sequence = 0;
    const notify = () => {
      for (const output of PlayerConnectionStore.state.snapshot.installOutput) {
        if (output.jobId !== job) {
          job = output.jobId;
          sequence = 0;
        }
        if (output.sequence > sequence) {
          sequence = output.sequence;
          listener(output);
        }
      }
    };
    const subscription = PlayerConnectionStore.subscribe(notify);
    notify();
    return () => subscription.unsubscribe();
  },
};
export const PlayerIPC = {
  applyQueue: (input: ApplyMpvQueueInput) =>
    execute({ _tag: "ApplyQueue", items: input.snapshot.items, select: input.select ? { ...input.select, positionSeconds: input.select.positionSeconds ?? 0 } : null }),
  getRuntimeState: async () => runtimeView(await deadline(mainIpc.invoke("player:getSnapshot"))),
  pause: () => execute({ _tag: "Pause" }),
  play: () => execute({ _tag: "Play" }),
  restartCurrent: () => execute({ _tag: "Restart" }),
  stop: () => execute({ _tag: "Stop" }),
  toggle: () => execute({ _tag: "Toggle" }),
  seek: (seconds: number) => execute({ _tag: "Seek", seconds }),
  setVolume: (percent: number) => execute({ _tag: "SetVolume", percent }),
  setMuted: (muted: boolean) => execute({ _tag: "SetMuted", muted }),
  setCredentials: async (credentials: SessionCredentials | null) => {
    initializePlayerConnection();
    acceptResult(await deadline(mainIpc.invoke("player:setCredentials", credentials), 45000));
  },
  retryIssue: (issueId: string) => execute(failedCommand?.issueId === issueId ? failedCommand.command : { _tag: "Play" }),
  dismissIssue: async (issueId: string) => {
    await execute({ _tag: "DismissIssue", issueId });
    PlayerConnectionStore.setState((state) => ({ ...state, issue: state.issue?.id === issueId ? null : state.issue }));
  },
  subscribeRuntime: (listener: (state: PlayerRuntimeState) => void) => {
    runtimeListeners.add(listener);
    return () => {
      runtimeListeners.delete(listener);
    };
  },
};

export const FilesystemIpc = {
  writeFile: (path: string, data: Uint8Array) => mainIpc.invoke("fs:write", path, data),
  remove: (path: string) => mainIpc.invoke("fs:delete", path),
};
