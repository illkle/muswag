import type { LoginCredentials } from "@muswag/model";
import { useSelector } from "@tanstack/react-store";

import { appCommand } from "#/data/app-command";
import { appState, connectToMain } from "#/data/app-state";

let startPromise: Promise<void> | undefined;

/** Whether main has restored the session, logged in or not. */
const initialized = () => {
  const auth = appState.auth.get();
  return auth !== undefined && auth._tag !== "Initializing";
};

const whenInitialized = () =>
  new Promise<void>((resolve) => {
    if (initialized()) return resolve();
    const subscription = appState.auth.subscribe(() => {
      if (!initialized()) return;
      subscription.unsubscribe();
      resolve();
    });
  });

/** The session, which main runs. Its state is in `appState.auth`. */
export const Session = {
  /** Connects to main, and resolves once main has restored the session, logged in or not. */
  start(): Promise<void> {
    startPromise ??= connectToMain().then(whenInitialized);
    return startPromise;
  },

  login: (credentials: LoginCredentials) => appCommand("session:login", credentials).then(() => undefined),
  /** Main stops playback, ends the session and deletes the local library. */
  logout: () => appCommand("session:logout").then(() => undefined),
};

export const useUser = () => {
  const session = useSelector(appState.auth, (auth) => auth);
  return {
    data: session?._tag === "LoggedIn" ? { url: session.url, username: session.username } : undefined,
    /** The account of a session main ended because the server no longer accepts its password. */
    expired: session?._tag === "LoggedOut" ? session.expired : undefined,
    isLoading: !session || session._tag === "Initializing",
  };
};
