import { describe, expect, it } from "vitest";

import { EVENT_CHANNELS, INVOKE_CHANNELS } from "./ipc";

describe("the channels the preload lets through", () => {
  it("cover connecting, commands and the events main sends", () => {
    expect([...INVOKE_CHANNELS].sort()).toEqual(["app:command", "app:connect"]);
    expect([...EVENT_CHANNELS].sort()).toEqual(["app:state", "library:changed"]);
  });
});
