import { createStore } from "@tanstack/react-store";
import { Schema } from "effect";

import { mainIpc } from "#/data/ipc";
import { playerState } from "#/data/state";
import { CommandResult, type MpvInstallMethod, type PlayerCommand, type PlayerIssue } from "#shared/commands/player";

/** How long a command waits for its outcome to show up in the state before it returns anyway. */
const SETTLE_TIMEOUT_MS = 5_000;

/** Main rejected a command; `issue` says why. */
export class CommandFailed extends Error {
  constructor(readonly issue: PlayerIssue) {
    super(issue.message);
    this.name = "CommandFailed";
  }
}

/**
 * The last rejected command's issue, until a command succeeds or it is dismissed. Main records most
 * rejections among the player's issues too, but not those that never reached the player, such as Busy.
 */
export const commandIssue = createStore<PlayerIssue | null>(null);
let failedCommand: { command: PlayerCommand; issueId: string } | null = null;

const decodeResult = Schema.decodeUnknownSync(CommandResult);

/** Waits until a command's outcome is visible in the state, then reports whether it was rejected. */
async function settle(reply: unknown, command: PlayerCommand | null): Promise<void> {
  const result = decodeResult(reply);
  // The state catches up regardless; waiting only keeps the reply from arriving ahead of it.
  await playerState.player.utils.awaitPosition(result.position, SETTLE_TIMEOUT_MS).catch(() => undefined);
  commandIssue.setState(() => (result.ok ? null : result.issue));
  if (result.ok) return;
  failedCommand = command ? { command, issueId: result.issue.id } : null;
  throw new CommandFailed(result.issue);
}

const execute = async (command: PlayerCommand) => settle(await mainIpc.invoke("player:command", crypto.randomUUID(), command), command);

export const MpvIPC = {
  cancelInstall: async () => {
    const install = playerState.player.get("player")?.install;
    if (install && install._tag !== "Idle") await execute({ _tag: "CancelInstall", jobId: install.jobId });
  },
  clearManualPath: () => execute({ _tag: "SetBinaryPath", path: null }),
  install: (method: MpvInstallMethod) => execute({ _tag: "StartInstall", method }),
  /** Lets the user pick an mpv binary; does nothing when they cancel. */
  locate: async () => {
    const reply = await mainIpc.invoke("player:locate");
    if (reply !== null) await settle(reply, null);
  },
  recheck: () => execute({ _tag: "RefreshBinary" }),
};

/** Transport controls. The queue itself is main's; see `QueueActions`. */
export const PlayerIPC = {
  pause: () => execute({ _tag: "Pause" }),
  play: () => execute({ _tag: "Play" }),
  seek: (seconds: number) => execute({ _tag: "Seek", seconds }),
  setVolume: (percent: number) => execute({ _tag: "SetVolume", percent }),
  setMuted: (muted: boolean) => execute({ _tag: "SetMuted", muted }),
  /** Resends the command behind `issueId` if it was the latest failure, otherwise just plays. */
  retryIssue: (issueId: string) => execute(failedCommand?.issueId === issueId ? failedCommand.command : { _tag: "Play" }),
  dismissIssue: async (issueId: string) => {
    if (commandIssue.state?.id === issueId) commandIssue.setState(() => null);
    await execute({ _tag: "DismissIssue", issueId });
  },
};
