// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { AppStateSnapshot, AppStateUpdate } from "#shared/state/app-state";

const loggedIn = { _tag: "LoggedIn", url: "https://music.test", username: "me" } as const;

/** A main that answers `app:connect` with `snapshot` once told to, and sends events when the test does. */
function fakeMain(snapshot: AppStateSnapshot) {
  const listeners = new Map<string, (event: unknown, payload: unknown) => void>();
  let answer: () => void = () => {};
  const connected = new Promise<void>((resolve) => (answer = resolve));
  window.electron = {
    ipcRenderer: {
      invoke: async (channel) => {
        expect(channel).toBe("app:connect");
        await connected;
        return snapshot;
      },
      on: (channel, listener) => {
        listeners.set(channel, listener);
        return () => listeners.delete(channel);
      },
    },
  };
  return { send: (update: AppStateUpdate) => listeners.get("app:state")!(null, update), answer };
}

beforeEach(() => vi.resetModules());
afterEach(() => Reflect.deleteProperty(window, "electron"));

describe("connectToMain", () => {
  it("takes the state as of connecting, keeps what changed meanwhile, and drops what comes late", async () => {
    const main = fakeMain({ version: 3, values: { auth: { _tag: "Initializing" }, unplayable: [] } });
    const { appState, connectToMain, untilAppStateVersion } = await import("./app-state");

    const connecting = connectToMain();
    // Sent after the state main answers with was read, and arrived before it.
    main.send({ version: 4, name: "auth", value: loggedIn });
    main.answer();
    await connecting;

    expect(appState.auth.get()).toEqual(loggedIn);
    expect(appState.unplayable.get()).toEqual([]);
    expect(appState.player.get()).toBeUndefined();

    main.send({ version: 2, name: "auth", value: { _tag: "Initializing" } });
    expect(appState.auth.get()).toEqual(loggedIn);

    const waiting = untilAppStateVersion(5, 1_000);
    let reached = false;
    void waiting.then(() => (reached = true));
    await Promise.resolve();
    expect(reached).toBe(false);
    main.send({ version: 5, name: "unplayable", value: [{ id: "song", title: "Song", skipped: true, at: 1 }] });
    await waiting;
    expect(appState.unplayable.get()).toHaveLength(1);
  });

  it("stops waiting for a version that does not come", async () => {
    vi.useFakeTimers();
    const main = fakeMain({ version: 1, values: {} });
    const { connectToMain, untilAppStateVersion } = await import("./app-state");
    main.answer();
    await connectToMain();

    let done = false;
    void untilAppStateVersion(9, 5_000).then(() => (done = true));
    await vi.advanceTimersByTimeAsync(4_999);
    expect(done).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(done).toBe(true);
    vi.useRealTimers();
  });
});
