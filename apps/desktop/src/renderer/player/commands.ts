import { Schema } from "effect";

import { untilAppStateVersion } from "#/data/app-state";
import { mainIpc } from "#/data/ipc";
import { CommandResult, type MpvInstallMethod, type RendererCommand } from "#shared/commands/player";

/** How long a command waits for its outcome to show up in the state before it returns anyway. */
const SETTLE_TIMEOUT_MS = 5_000;

const decodeResult = Schema.decodeUnknownSync(CommandResult);

/**
 * Waits until a command's outcome is visible in the state, then rejects if main turned it down. Why
 * it did is also the player's error, which the player panel shows, so callers need not show it again.
 */
async function settle(reply: unknown): Promise<void> {
  const result = decodeResult(reply);
  // The state catches up regardless; waiting only keeps the reply from arriving ahead of it.
  await untilAppStateVersion(result.version, SETTLE_TIMEOUT_MS);
  if (!result.ok) throw new Error(result.message);
}

const execute = async (command: RendererCommand) => settle(await mainIpc.invoke("player:command", command));

export const MpvIPC = {
  clearManualPath: () => execute({ _tag: "ClearBinaryPath" }),
  /** Opens a terminal that installs mpv with `method`. */
  openTerminal: (method: MpvInstallMethod) => execute({ _tag: "OpenInstallTerminal", method }),
  /** Lets the user pick an mpv binary; does nothing when they cancel. */
  locate: async () => {
    const reply = await mainIpc.invoke("player:locate");
    if (reply !== null) await settle(reply);
  },
  recheck: () => execute({ _tag: "RefreshBinary" }),
};

/** Transport controls. The queue itself is main's; see `QueueActions`. */
export const PlayerIPC = {
  pause: () => execute({ _tag: "Pause" }),
  /** Resumes, or loads the track again when it ended or failed. */
  play: () => execute({ _tag: "Play" }),
  seek: (seconds: number) => execute({ _tag: "Seek", seconds }),
  setVolume: (percent: number) => execute({ _tag: "SetVolume", percent }),
  setMuted: (muted: boolean) => execute({ _tag: "SetMuted", muted }),
  dismissError: () => execute({ _tag: "DismissError" }),
};
