import { createStore, type Store } from "@tanstack/react-store";

import { initialAppStates, type AppCommandArgs, type AppCommandName, type AppCommandReply, type AppCommandResults, type AppStateName, type AppStates } from "#shared/app-contract";
import { mainIpc, rendererIpc } from "./ipc";

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

const initial = initialAppStates();

/** Main's states, kept current by its pushes. */
export const appStates = Object.fromEntries(Object.entries(initial).map(([name, value]) => [name, createStore(value)])) as { [K in AppStateName]: Store<AppStates[K]> };

const pushed = new Set<AppStateName>();
let listening = false;

/**
 * Starts following main's states: listens for pushes, then fetches every state once. A state main
 * pushed in the meantime is newer than the fetched one.
 */
export async function loadAppStates(): Promise<void> {
  if (!listening) {
    listening = true;
    rendererIpc.on("app:state", (_event, { name, value }) => {
      if (!Object.hasOwn(appStates, name)) return;
      pushed.add(name as AppStateName);
      (appStates[name as AppStateName] as Store<unknown>).setState(() => value);
    });
  }
  await Promise.all(
    (Object.keys(appStates) as AppStateName[]).map(async (name) => {
      const value = await mainIpc.invoke("app:state", name);
      if (!pushed.has(name) && value !== null) (appStates[name] as Store<unknown>).setState(() => value);
    }),
  );
}
