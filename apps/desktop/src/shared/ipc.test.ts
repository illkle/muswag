import { createElectronRendererTransport } from "@muswag/tanstack-db-mirror/electron/renderer";
import { MIRROR_PROTOCOL_VERSION } from "@muswag/tanstack-db-mirror/protocol";
import { describe, expect, it } from "vitest";

import { EVENT_CHANNELS, INVOKE_CHANNELS, STATE_MIRROR_CHANNEL } from "./ipc";

describe("the channels the preload lets through", () => {
  it("cover what both mirrors use", () => {
    const invoked: string[] = [];
    const listened: string[] = [];
    const ipcRenderer = {
      invoke: async (channel: string) => void invoked.push(channel),
      on: (channel: string) => {
        listened.push(channel);
        return () => {};
      },
    };

    for (const channel of [undefined, STATE_MIRROR_CHANNEL]) {
      const transport = createElectronRendererTransport({ ipcRenderer, channel });
      void transport.request({ v: MIRROR_PROTOCOL_VERSION, type: "hello" });
      transport.subscribe(() => {});
    }

    expect(invoked).toHaveLength(2);
    expect(listened).toHaveLength(2);
    expect(INVOKE_CHANNELS).toEqual(expect.arrayContaining(invoked));
    expect(EVENT_CHANNELS).toEqual(expect.arrayContaining(listened));
  });
});
