import { describe, expect, it } from "vitest";

import { SerialQueue } from "./serial-queue";

describe("SerialQueue", () => {
  it("serializes operations, returns their results, and survives rejection", async () => {
    const queue = new SerialQueue();
    const markers: string[] = [];
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const first = queue.run(async () => {
      markers.push("first:start");
      await gate;
      markers.push("first:end");
      return 1;
    });
    const second = queue.run(async () => {
      markers.push("second");
      throw new Error("nope");
    });
    const third = queue.run(async () => {
      markers.push("third");
      return 3;
    });
    await Promise.resolve();
    expect(markers).toEqual(["first:start"]);
    release();
    await expect(first).resolves.toBe(1);
    await expect(second).rejects.toThrow("nope");
    await expect(third).resolves.toBe(3);
    expect(markers).toEqual(["first:start", "first:end", "second", "third"]);
  });
});
