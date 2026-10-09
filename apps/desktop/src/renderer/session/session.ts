import type { SessionCredentials } from "@muswag/model";
import { useLiveQuery } from "@tanstack/react-db";

import { appCommand } from "#/data/app-command";
import { appState } from "#/data/state";

let startPromise: Promise<void> | undefined;

/** Whether main has restored the session, logged in or not. */
const initialized = () => {
  const row = appState.auth.get("auth");
  return row !== undefined && row.value._tag !== "Initializing";
};

const whenInitialized = () =>
  new Promise<void>((resolve) => {
    if (initialized()) return resolve();
    const subscription = appState.auth.subscribeChanges(() => {
      if (!initialized()) return;
      subscription.unsubscribe();
      resolve();
    });
  });

/** The session, which main runs. Its state is in `appState.auth`. */
export const Session = {
  /** Resolves once main has restored the session, logged in or not. */
  start(): Promise<void> {
    startPromise ??= appState.auth.preload().then(whenInitialized);
    return startPromise;
  },

  login: (credentials: SessionCredentials) => appCommand("session:login", credentials).then(() => undefined),
  /** Main stops playback, ends the session and deletes the local library. */
  logout: () => appCommand("session:logout").then(() => undefined),
};

export const useUser = () => {
  const session = useLiveQuery((q) => q.from({ auth: appState.auth }).findOne()).data?.value;
  return {
    data: session?._tag === "LoggedIn" ? { url: session.url, username: session.username } : undefined,
    /** The account of a session main ended because the server no longer accepts its password. */
    expired: session?._tag === "LoggedOut" ? session.expired : undefined,
    isLoading: !session || session._tag === "Initializing",
  };
};
