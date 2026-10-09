import { Toast } from "@base-ui/react/toast";

import { playerState } from "#/data/state";
import { getErrorMessage } from "#/lib/err";

/** The notices on screen. `Notices` draws them; anything in the renderer can add one. */
export const notices = Toast.createToastManager();

/**
 * Tells the user that something they asked for did not happen. For a failure with no place of its
 * own to show: a command sent by a double-click, or from a menu that has closed by the time it fails.
 * `cause` is what was thrown; its message is shown under `message`.
 */
export function notifyFailure(message: string, cause?: unknown): void {
  const reason = getErrorMessage(cause, "");
  // What the player could not do is above the player bar already, in its own words.
  if (reason && playerState.player.get("player")?.error?.message === reason) return;

  notices.add({
    // The same failure again, such as every double-click while the server is away, renews its notice instead of stacking another.
    id: message,
    title: message,
    ...(reason ? { description: reason } : {}),
    priority: "high",
    timeout: 8000,
  });
}

/** `notifyFailure` as the handler of a rejected promise: `command().catch(failureNotice("…"))`. */
export const failureNotice = (message: string) => (cause: unknown) => notifyFailure(message, cause);
