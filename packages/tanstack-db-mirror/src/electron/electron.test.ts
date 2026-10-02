import { createCollection } from "@tanstack/db";
import { Effect, Exit, Scope } from "effect";
import { afterEach, describe, expect, it } from "vitest";

import { createMirrorClient, mirrorCollectionOptions } from "../client/index.js";
import type { MirrorChangeBatch, MirrorResponse } from "../protocol.js";
import { MirrorServer } from "../server/index.js";
import { album, albums, createHarness, eventually, rowsOf, type Harness } from "../test/harness.js";
import { createElectronMainTransport, type IpcMainLike, type WebContentsLike } from "./main.js";
import { createElectronRendererTransport, type IpcRendererLike } from "./renderer.js";

type Listener = (event: unknown, ...args: Array<unknown>) => void;

/** A minimal stand-in for Electron's ipcMain, webContents and ipcRenderer. */
function createFakeElectron() {
  const handlers = new Map<string, (event: { sender: WebContentsLike }, request: unknown) => Promise<MirrorResponse>>();
  const ipcMain: IpcMainLike = {
    handle: (channel, listener) => {
      if (handlers.has(channel)) throw new Error(`Attempted to register a second handler for '${channel}'`);
      handlers.set(channel, listener);
    },
    removeHandler: (channel) => {
      handlers.delete(channel);
    },
  };

  let nextId = 1;
  const createRenderer = (style: "toolkit" | "raw") => {
    const listeners = new Map<string, Set<Listener>>();
    const destroyedListeners: Array<() => void> = [];
    let destroyed = false;
    const sent: Array<{ channel: string; args: Array<unknown> }> = [];

    const webContents: WebContentsLike = {
      id: nextId++,
      send: (channel, ...args) => {
        if (destroyed) throw new Error("Object has been destroyed");
        sent.push({ channel, args });
        const cloned = structuredClone(args);
        setTimeout(() => {
          for (const listener of listeners.get(channel) ?? []) listener({}, ...cloned);
        }, 0);
      },
      isDestroyed: () => destroyed,
      once: (_event, listener) => {
        destroyedListeners.push(listener);
      },
    };

    const ipcRenderer: IpcRendererLike = {
      invoke: async (channel, ...args) => {
        const handler = handlers.get(channel);
        if (!handler) throw new Error(`No handler registered for '${channel}'`);
        return structuredClone(await handler({ sender: webContents }, structuredClone(args[0])));
      },
      on: (channel, listener) => {
        const set = listeners.get(channel) ?? new Set();
        set.add(listener);
        listeners.set(channel, set);
        return style === "toolkit" ? () => set.delete(listener) : ipcRenderer;
      },
      removeListener: (channel, listener) => {
        listeners.get(channel)?.delete(listener);
        return ipcRenderer;
      },
    };

    return {
      webContents,
      ipcRenderer,
      sent,
      listenerCount: (channel: string) => listeners.get(channel)?.size ?? 0,
      destroy: () => {
        destroyed = true;
        for (const listener of destroyedListeners) listener();
      },
    };
  };

  return { ipcMain, handlers, createRenderer };
}

let harness: Harness;

afterEach(async () => {
  await harness?.dispose();
});

async function serveOverElectron(channel?: string) {
  harness = await createHarness();
  const electron = createFakeElectron();
  const scope = await harness.run(Scope.make());
  await harness.run(harness.server.serve(createElectronMainTransport({ ipcMain: electron.ipcMain, channel })).pipe(Scope.provide(scope)));
  return { electron, close: () => harness.run(Scope.close(scope, Exit.void)) };
}

describe("electron transports", () => {
  it.each(["toolkit", "raw"] as const)("mirrors a table end to end with %s ipcRenderer listeners", async (style) => {
    const { electron } = await serveOverElectron();
    await harness.insertAlbums([album("a1")]);
    const renderer = electron.createRenderer(style);
    const client = createMirrorClient({ transport: createElectronRendererTransport({ ipcRenderer: renderer.ipcRenderer }) });
    const collection = createCollection(mirrorCollectionOptions({ client, table: albums }));

    await collection.preload();
    await collection.insert(album("a2")).isPersisted.promise;
    await harness.insertAlbums([album("a3")]);

    await eventually(() => expect(rowsOf(collection)).toEqual([album("a1"), album("a2"), album("a3")]));
    expect(await harness.dbRows("albums")).toEqual(rowsOf(collection));

    await collection.cleanup();
    client.dispose();
    expect(renderer.listenerCount("tanstack-db-mirror:changes")).toBe(0);
  });

  it("only sends batches to renderers that have made a request", async () => {
    const { electron } = await serveOverElectron();
    const idle = electron.createRenderer("toolkit");
    const active = electron.createRenderer("toolkit");
    await active.ipcRenderer.invoke("tanstack-db-mirror:request", { v: 1, type: "hello" });

    await harness.insertAlbums([album("a1")]);

    expect(idle.sent).toEqual([]);
    expect(active.sent).toHaveLength(1);
    expect(active.sent[0]!.channel).toBe("tanstack-db-mirror:changes");
    expect((active.sent[0]!.args[0] as MirrorChangeBatch).changes).toHaveLength(1);
  });

  it("stops sending to destroyed renderers", async () => {
    const { electron } = await serveOverElectron();
    const closed = electron.createRenderer("toolkit");
    const open = electron.createRenderer("toolkit");
    await closed.ipcRenderer.invoke("tanstack-db-mirror:request", { v: 1, type: "hello" });
    await open.ipcRenderer.invoke("tanstack-db-mirror:request", { v: 1, type: "hello" });

    closed.destroy();
    await harness.insertAlbums([album("a1")]);

    expect(closed.sent).toEqual([]);
    expect(open.sent).toHaveLength(1);
  });

  it("keeps pushing to renderers after the server restarts with a new transport", async () => {
    const { electron, close } = await serveOverElectron();
    await harness.insertAlbums([album("a1")]);
    const renderer = electron.createRenderer("toolkit");
    const client = createMirrorClient({ transport: createElectronRendererTransport({ ipcRenderer: renderer.ipcRenderer }) });
    const collection = createCollection(mirrorCollectionOptions({ client, table: albums }));
    await collection.preload();

    await close();
    const scope = await harness.run(Scope.make());
    const restarted = await harness.run(
      Effect.gen(function* () {
        const server = yield* MirrorServer.make({ tables: [albums] });
        yield* server.serve(createElectronMainTransport({ ipcMain: electron.ipcMain }));
        return server;
      }).pipe(Scope.provide(scope)),
    );
    // The renderer stays idle: it only learns about the restart from pushed batches.
    await harness.run(restarted.write(harness.sql.unsafe(`INSERT INTO albums (id, name) VALUES ('a2', 'B')`)));

    await eventually(() => expect(rowsOf(collection)).toEqual([album("a1"), album("a2", { name: "B" })]));
    expect(client.epoch).toBe(restarted.epoch);

    await collection.cleanup();
    client.dispose();
    await harness.run(Scope.close(scope, Exit.void));
  });

  it("keeps sending to other renderers when one send fails", async () => {
    const { electron } = await serveOverElectron();
    const broken = electron.createRenderer("toolkit");
    const healthy = electron.createRenderer("toolkit");
    await broken.ipcRenderer.invoke("tanstack-db-mirror:request", { v: 1, type: "hello" });
    await healthy.ipcRenderer.invoke("tanstack-db-mirror:request", { v: 1, type: "hello" });
    broken.webContents.send = () => {
      throw new Error("Render frame was disposed");
    };
    const original = console.error;
    console.error = () => {};
    try {
      await harness.insertAlbums([album("a1")]);
    } finally {
      console.error = original;
    }

    expect(healthy.sent).toHaveLength(1);
  });

  it("uses a custom channel and removes its handler when the scope closes", async () => {
    const { electron, close } = await serveOverElectron("library");
    expect([...electron.handlers.keys()]).toEqual(["library:request"]);

    const renderer = electron.createRenderer("raw");
    const response = (await renderer.ipcRenderer.invoke("library:request", { v: 1, type: "hello" })) as MirrorResponse;
    expect(response.ok).toBe(true);

    await close();
    expect(electron.handlers.size).toBe(0);
  });
});
