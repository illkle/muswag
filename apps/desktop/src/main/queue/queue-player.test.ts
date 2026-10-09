import { songRow, type QueueSourceRef, type SourceCursor, type SourceItem } from "@muswag/model";
import { Effect, ManagedRuntime, Stream } from "effect";
import { describe, expect, it, vi } from "vitest";

import type { PlayerSnapshot } from "#shared/commands/player";
import type { PlayerHandle } from "../player/ipc";
import { Player } from "../player/player";
import { fixture, login } from "../player/test/player-harness";
import { createQueue } from "./index";
import type { SourceDb } from "./source";

const album: QueueSourceRef = { type: "album", albumId: "album" };

/** The queue as `createQueue` builds it, over the real player and its in-memory mpv, playing from one album. */
function start(keys: readonly string[]) {
  const mpv = fixture();
  const runtime = ManagedRuntime.make(mpv.layer);
  const listeners = new Set<(snapshot: PlayerSnapshot) => void>();
  runtime.runFork(
    Player.use((player) =>
      Stream.runForEach(player.changes, (snapshot) =>
        Effect.sync(() => {
          for (const listener of listeners) listener(snapshot);
        }),
      ),
    ),
  );
  const position = { epoch: 0, seq: 0 };
  const snapshot = () => runtime.runPromise(Player.use((player) => player.snapshot));
  const player: Pick<PlayerHandle, "execute" | "snapshot" | "subscribe"> = {
    execute: (command) =>
      runtime.runPromise(
        Player.use((player) => player.execute(command)).pipe(
          Effect.match({ onSuccess: () => ({ ok: true as const, position }), onFailure: ({ message }) => ({ ok: false as const, message, position }) }),
        ),
      ),
    snapshot,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },
  };
  const library: SourceDb = {
    sourceWindow: async (_ref, at) => {
      const items = keys.map((key, offset): SourceItem => ({ key, offset, track: songRow({ id: key, title: key }) }));
      const found = items.findIndex(({ key }) => key === at.key);
      if (found < 0 && at.offset === null) return null;
      const cursor: SourceCursor = found < 0 ? { type: "gap", offset: at.offset! } : { type: "item", key: at.key!, offset: found };
      return { cursor, previous: items.slice(0, cursor.offset), current: items[found] ?? null, next: items.slice(found < 0 ? cursor.offset : found + 1), hasMore: false };
    },
    subscribe: () => () => {},
  };
  const queue = createQueue({
    player: player as PlayerHandle,
    library,
    tables: { load: async () => ({ state: null, items: [], resumePositionSeconds: 0 }), write: async () => {}, clear: async () => {} },
  });
  return {
    mpv,
    queue,
    snapshot,
    login: () => runtime.runPromise(Player.use(login)),
    dispose: async () => {
      queue.dispose();
      await runtime.dispose();
    },
  };
}

describe("the queue on the real player", () => {
  it("is on a selection while it loads, follows mpv to the next track, and moves past one that cannot be played", async () => {
    const { mpv, queue, snapshot, login, dispose } = start(["a", "b", "c"]);
    await login();

    await queue.playSource(album, "a");
    expect((await snapshot()).playback._tag).toBe("Loading");
    expect(queue.store.state).toMatchObject({ nowPlaying: { key: "a", origin: "source" }, source: { window: { next: [{ key: "b" }, { key: "c" }] } } });
    const a = mpv.currentId;
    mpv.emit({ type: "file-loaded" });
    await vi.waitFor(async () => expect((await snapshot()).playback._tag).toBe("Playing"));

    // "a" ends and mpv starts "b", the entry loaded after it, by itself.
    const b = a + 1;
    mpv.emit({ type: "end-file", entryId: a, reason: "eof" }, a);
    mpv.emit({ type: "start-file", entryId: b }, b);
    await vi.waitFor(() => expect(queue.store.state).toMatchObject({ nowPlaying: { key: "b" }, source: { window: { cursor: { key: "b", offset: 1 }, previous: [{ key: "a" }] } } }));
    expect((await snapshot()).playback._tag).toBe("Loading");

    // "b" fails, is loaded again in a new mpv, and fails there too.
    mpv.emit({ type: "end-file", entryId: b, reason: "error" }, b);
    await vi.waitFor(() => expect(mpv.generation).toBe(2));
    await vi.waitFor(() => expect(mpv.currentId).toBeGreaterThan(b));
    const retried = mpv.currentId;
    mpv.emit({ type: "end-file", entryId: retried, reason: "error" }, retried);

    // The queue goes on to "c", which the player loads in another mpv, and the failure is gone once it plays.
    await vi.waitFor(() => expect(queue.store.state.nowPlaying?.key).toBe("c"));
    await vi.waitFor(() => expect(mpv.generation).toBe(3));
    await vi.waitFor(() => expect(mpv.currentId).toBeGreaterThan(retried));
    mpv.emit({ type: "file-loaded" });
    await vi.waitFor(async () => expect(await snapshot()).toMatchObject({ playback: { _tag: "Playing", media: { item: { key: "c" } } }, error: null }));
    expect(queue.store.state).toMatchObject({ nowPlaying: { key: "c", origin: "source" }, source: { window: { cursor: { key: "c", offset: 2 }, next: [] } } });

    // The last track fails twice as well: nothing follows it, so the failure stays for the user to see.
    const c = mpv.currentId;
    mpv.emit({ type: "end-file", entryId: c, reason: "error" }, c);
    await vi.waitFor(() => expect(mpv.generation).toBe(4));
    await vi.waitFor(() => expect(mpv.currentId).toBeGreaterThan(c));
    mpv.emit({ type: "end-file", entryId: mpv.currentId, reason: "error" }, mpv.currentId);
    await vi.waitFor(async () => expect(await snapshot()).toMatchObject({ playback: { _tag: "Failed", reason: "track", media: { item: { key: "c" } } }, error: { fix: "retry" } }));
    expect(queue.store.state.nowPlaying?.key).toBe("c");

    // Previous steps back from the failed track.
    await queue.previous();
    expect(queue.store.state.nowPlaying?.key).toBe("b");
    await dispose();
  });

  it("is on a track the player holds but could not start, and plays on from it once it can", async () => {
    const { mpv, queue, snapshot, dispose } = start(["a", "b"]);

    // Nobody is logged in, so the player has nothing to sign the stream with.
    await expect(queue.playSource(album, "a")).rejects.toThrow("Log in");
    expect(await snapshot()).toMatchObject({ playback: { _tag: "Failed", reason: "player", media: { item: { key: "a" } } } });
    expect(queue.store.state).toMatchObject({ nowPlaying: { key: "a" }, source: { ref: album, window: { next: [{ key: "b" }] } } });

    // The queue leaves a failure that is not the track's alone.
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(queue.store.state.nowPlaying?.key).toBe("a");
    expect(mpv.generation).toBe(0);
    await dispose();
  });
});
