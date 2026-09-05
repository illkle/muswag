import { Effect } from "effect";
import { describe, expect, it } from "vitest";
import { applyQueue, type Correlation } from "./queue";
import type { SessionHandle } from "./mpv/session";
import { EngineError } from "./errors";
import { tracks } from "./test/player";

const old: Correlation = { generation: 1, entries: tracks.slice(0, 2).map((item, index) => ({ ...item, entryId: index + 1 })), currentId: 1 };
const urls = new Map(tracks.map((item) => [item.key, "https://secret.test"]));
describe("queue commit", () => {
  it("does not commit an uncertain rebuild or accept an automatically moved anchor", async () => {
    let failed = false;
    const session: SessionHandle = {
      generation: 1,
      sequence: () => 0,
      execute: (input) => {
        if (input.name === "loadfile") {
          if (failed) return Effect.fail(new EngineError({ reason: "timeout", operation: "loadfile", uncertain: true }));
          failed = true;
          return input.decode({ playlist_entry_id: 3 });
        }
        if (input.name === "playlist") return input.decode([{ id: 1 }, { id: 2, current: true }]);
        return input.decode(undefined);
      },
    };
    expect((await Effect.runPromise(applyQueue(session, old, tracks, null, urls).pipe(Effect.result)))._tag).toBe("Failure");
    expect(old.entries.map((entry) => entry.entryId)).toEqual([1, 2]);
    expect((await Effect.runPromise(applyQueue(session, old, tracks.slice(0, 2), null, urls).pipe(Effect.result)))._tag).toBe("Failure");
  });
});
