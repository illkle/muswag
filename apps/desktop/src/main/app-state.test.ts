import { describe, expect, it } from "vitest";

import type { AppStateUpdate } from "#shared/state/app-state";
import { AppStateHub } from "./app-state";

const idle = { running: null, progress: null, error: null, lastSyncedAt: null };

describe("AppStateHub", () => {
  it("counts every change, tells its listeners, and leaves out what was never set", () => {
    const hub = new AppStateHub();
    const updates: AppStateUpdate[] = [];
    hub.subscribe((update) => updates.push(update));

    hub.set("auth", { _tag: "Initializing" });
    hub.set("librarySync", idle);
    hub.set("auth", { _tag: "LoggedIn", url: "https://music.test", username: "me" });

    expect(updates.map(({ version, name }) => `${version} ${name}`)).toEqual(["1 auth", "2 librarySync", "3 auth"]);
    expect(hub.snapshot()).toEqual({ version: 3, values: { auth: { _tag: "LoggedIn", url: "https://music.test", username: "me" }, librarySync: idle } });
    expect(hub.get("player")).toBeUndefined();
  });

  it("takes a value equal to the one it has for no change", () => {
    const hub = new AppStateHub();
    const updates: AppStateUpdate[] = [];
    hub.set("unplayable", []);
    hub.subscribe((update) => updates.push(update));

    hub.set("unplayable", []);
    expect(updates).toEqual([]);
    expect(hub.version).toBe(1);
  });

  it("keeps a snapshot it gave out as it was", () => {
    const hub = new AppStateHub();
    hub.set("librarySync", idle);
    const before = hub.snapshot();
    hub.set("librarySync", { ...idle, running: "full" });
    expect(before).toEqual({ version: 1, values: { librarySync: idle } });
  });
});
