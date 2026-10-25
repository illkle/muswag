// oxlint-disable vitest/expect-expect -- a benchmark reports what it measures rather than asserting it
import { performance } from "node:perf_hooks";
import { serialize } from "node:v8";

import { describe, it } from "vitest";

import { openLibrary, recorder, SIZES } from "./harness.js";

/**
 * What announcing a change to many songs costs main: the write with its triggers, then reading the
 * keys back and handing them to main's listeners, which is done before `exec` resolves. A stats
 * refresh that changes every song stands for a first sync or a rescan, and one of a thousand songs
 * for an ordinary one. Renderers hear only which tables changed once there are more than a thousand.
 */
describe("change stream", () => {
  const { record, save } = recorder("change-stream");

  it.each(SIZES)("%i songs", async (size) => {
    const library = await openLibrary(size);
    let bytes = 0;
    const unsubscribe = library.changes.subscribe((changes) => {
      bytes += serialize(changes).byteLength;
    });

    let started = performance.now();
    await library.exec(`UPDATE songs SET playCount = coalesce(playCount, 0) + 1`);
    record(size, "every song changes", performance.now() - started);
    record(size, "  keys to main's listeners", bytes / 1024 / 1024, "MB");

    bytes = 0;
    started = performance.now();
    await library.exec(`UPDATE songs SET playCount = coalesce(playCount, 0) + 1 WHERE rowid IN (SELECT rowid FROM songs ORDER BY rowid LIMIT 1000)`);
    record(size, "1000 songs change", performance.now() - started);
    record(size, "  keys to main's listeners ", bytes / 1024, "KB");

    unsubscribe();
    await library.dispose();
  });

  it("saves", () => save());
});
