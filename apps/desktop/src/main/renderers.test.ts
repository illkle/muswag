import type { LibraryChange } from "@muswag/backend";
import { describe, expect, it } from "vitest";

import { AppStateHub } from "./app-state";
import { libraryChangedEvent, serveRenderers, type ConnectIpc, type WebContentsLike } from "./renderers";

/** A renderer that keeps what main sends it, and can be closed. */
function fakeRenderer(id: number) {
  const received: Array<[string, unknown]> = [];
  const destroyed: Array<() => void> = [];
  let alive = true;
  const contents: WebContentsLike = {
    id,
    send: (channel, payload) => void received.push([channel, payload]),
    isDestroyed: () => !alive,
    once: (_event, listener) => destroyed.push(listener),
  };
  return {
    contents,
    received,
    close: () => {
      alive = false;
      for (const listener of destroyed) listener();
    },
  };
}

function fakeIpc() {
  let handler: ((event: { readonly sender: WebContentsLike }) => unknown) | undefined;
  const ipc: ConnectIpc = { handle: (_channel, listener) => void (handler = listener), removeHandler: () => void (handler = undefined) };
  return { ipc, connect: (sender: WebContentsLike) => handler!({ sender }) };
}

describe("serveRenderers", () => {
  it("answers a connecting renderer with the state, and sends it every change after", () => {
    const state = new AppStateHub();
    state.set("unplayable", []);
    const { ipc, connect } = fakeIpc();
    const renderers = serveRenderers(ipc, state);
    const renderer = fakeRenderer(1);

    expect(connect(renderer.contents)).toEqual({ version: 1, values: { unplayable: [] } });
    state.set("unplayable", [{ id: "song", title: "Song", skipped: true, at: 1 }]);
    renderers.send("library:changed", { tables: { songs: ["song"] } });

    expect(renderer.received).toEqual([
      ["app:state", { version: 2, name: "unplayable", value: [{ id: "song", title: "Song", skipped: true, at: 1 }] }],
      ["library:changed", { tables: { songs: ["song"] } }],
    ]);
    renderers.dispose();
  });

  it("sends nothing to a renderer that has not connected or has closed", () => {
    const state = new AppStateHub();
    const { ipc, connect } = fakeIpc();
    const renderers = serveRenderers(ipc, state);
    const [stranger, closed] = [fakeRenderer(1), fakeRenderer(2)];
    connect(closed.contents);
    closed.close();

    state.set("unplayable", []);
    expect(stranger.received).toEqual([]);
    expect(closed.received).toEqual([]);
    renderers.dispose();
  });
});

describe("libraryChangedEvent", () => {
  const change = (table: string, key: string): LibraryChange => ({ table, type: "changed", key });

  it("lists the keys of each table, and only the table where there are too many", () => {
    const songs = Array.from({ length: 1_001 }, (_, index) => change("songs", `song-${index}`));
    expect(libraryChangedEvent([change("albums", "a"), ...songs, { table: "albums", type: "deleted", key: "b" }])).toEqual({ tables: { albums: ["a", "b"], songs: null } });
  });
});
