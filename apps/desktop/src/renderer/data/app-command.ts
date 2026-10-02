import type { AppCommandArgs, AppCommandName, AppCommandReply, AppCommandResults } from "#shared/commands/app";
import { mainIpc } from "./ipc";

/** A command main rejected; `message` is main's own description of the failure. */
export class AppCommandError extends Error {
  constructor(
    readonly tag: string,
    message: string,
  ) {
    super(message);
    this.name = tag;
  }
}

/** Runs a command in main and returns its result. */
export async function appCommand<K extends AppCommandName>(name: K, ...args: AppCommandArgs<K>): Promise<AppCommandResults[K]> {
  const reply = (await mainIpc.invoke("app:command", name, args)) as AppCommandReply<K>;
  if (!reply.ok) throw new AppCommandError(reply.error.tag, reply.error.message);
  return reply.value;
}
