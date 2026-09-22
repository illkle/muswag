// @vitest-environment jsdom

import { it } from "@effect/vitest";
import { Effect } from "effect";
import { beforeEach, describe, expect, vi } from "vitest";
import { initialSnapshot, type PlayerSnapshot } from "#shared/player-contract";

/** A scripted main process: `replies` answers invokes; `push` delivers a player:snapshot event. */
const main = vi.hoisted(() => ({
  invoked: [] as { channel: string; args: unknown[] }[],
  replies: {} as Record<string, (...args: unknown[]) => unknown>,
  listener: null as ((event: unknown, message: { subscriptionId: string; snapshot: unknown }) => void) | null,
}));
vi.mock("#/lib/ipc", () => ({
  mainIpc: {
    invoke: async (channel: string, ...args: unknown[]) => {
      main.invoked.push({ channel, args });
      return main.replies[channel]?.(...args);
    },
  },
  rendererIpc: {
    on: (_channel: string, listener: typeof main.listener) => {
      main.listener = listener;
      return () => {
        main.listener = null;
      };
    },
  },
}));

import { CommandFailed, PlayerConnection, PlayerConnectionLive, PlayerConnectionStore } from "./connection";

const snapshot = (revision: number, epoch = "e1"): PlayerSnapshot => ({ ...initialSnapshot(epoch), stamp: { epoch, revision } });
const subscriptionId = () => main.invoked.find((call) => call.channel === "player:subscribe")!.args[0] as string;
const push = (value: unknown) => main.listener!(null, { subscriptionId: subscriptionId(), snapshot: value });
/** Lets the connection's fibers process what was just delivered. */
const settle = Effect.promise(() => new Promise((resolve) => setTimeout(resolve, 0)));

beforeEach(() => {
  main.invoked.length = 0;
  main.replies = { "player:subscribe": () => snapshot(1), "player:getSnapshot": () => snapshot(1) };
  PlayerConnectionStore.setState(() => ({ snapshot: initialSnapshot("unconnected"), connected: false, issue: null }));
});

describe("player connection", () => {
  it.live("subscribes, applies newer pushes, acknowledges each one and ignores stale ones", () =>
    Effect.gen(function* () {
      yield* PlayerConnection.use(() => Effect.void);
      yield* settle;
      expect(PlayerConnectionStore.state).toMatchObject({ connected: true, snapshot: { stamp: { epoch: "e1", revision: 1 } } });
      push(snapshot(5));
      yield* settle;
      push(snapshot(3));
      yield* settle;
      expect(PlayerConnectionStore.state.snapshot.stamp.revision).toBe(5);
      expect(main.invoked.filter((call) => call.channel === "player:ackSnapshot")).toHaveLength(2);
    }).pipe(Effect.provide(PlayerConnectionLive)),
  );

  it.live("treats an undecodable push as a lost connection", () =>
    Effect.gen(function* () {
      yield* PlayerConnection.use(() => Effect.void);
      yield* settle;
      push({ ...snapshot(2), playback: { _tag: "Playing" } });
      yield* settle;
      expect(PlayerConnectionStore.state.connected).toBe(false);
    }).pipe(Effect.provide(PlayerConnectionLive)),
  );

  it.live("surfaces a rejected command as CommandFailed and records its issue", () =>
    Effect.gen(function* () {
      const connection = yield* PlayerConnection;
      yield* settle;
      const issue = { id: "i1", code: "InvalidCommand", message: "Select a track first.", operation: "play", occurrenceKey: null, actions: ["dismiss"] } as const;
      main.replies["player:command"] = (commandId) => ({ ok: false, commandId, issue, snapshot: snapshot(2) });
      const error = yield* connection.dispatch({ _tag: "Play" }).pipe(Effect.flip);
      expect(error).toBeInstanceOf(CommandFailed);
      expect(PlayerConnectionStore.state).toMatchObject({ connected: true, issue: { id: "i1" }, snapshot: { stamp: { revision: 2 } } });
    }).pipe(Effect.provide(PlayerConnectionLive)),
  );
});
