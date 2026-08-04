import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { runCommand } from "./exec";
import { createJsonFileStore } from "./json-file-store";
import { createLineSplitter } from "./line-splitter";
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

describe("createLineSplitter", () => {
  it("buffers chunks, strips CR, skips blank lines, and flushes once", () => {
    const lines: string[] = [];
    const splitter = createLineSplitter((line) => lines.push(line));
    splitter.push("one\r\ntw");
    splitter.push("o\n \nthree");
    expect(lines).toEqual(["one", "two"]);
    splitter.flush();
    splitter.flush();
    expect(lines).toEqual(["one", "two", "three"]);
  });
});

describe("createJsonFileStore", () => {
  it("falls back for missing/corrupt data and saves through missing directories", () => {
    const root = mkdtempSync(join(tmpdir(), "muswag-store-"));
    const path = join(root, "nested", "state.json");
    const store = createJsonFileStore(path, (raw) => (typeof raw === "object" && raw ? (raw as { value: number }) : { value: 0 }));
    expect(store.load()).toEqual({ value: 0 });
    store.save({ value: 4 });
    expect(store.load()).toEqual({ value: 4 });
  });
});

describe("runCommand", () => {
  it("captures stdout, stderr, exit codes, and spawn failures", async () => {
    await expect(runCommand(process.execPath, ["-e", "process.stdout.write('out'); process.stderr.write('err'); process.exit(2)"])).resolves.toEqual({
      code: 2,
      errorCode: null,
      stderr: "err",
      stdout: "out",
    });
    const missing = await runCommand(join(tmpdir(), "definitely-missing-muswag-command"), []);
    expect(missing).toMatchObject({ code: null, errorCode: "ENOENT" });
  });

  it("reports timeouts", async () => {
    const result = await runCommand(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { timeoutMs: 10 });
    expect(result).toMatchObject({ code: null, errorCode: "ETIMEDOUT" });
  });
});
