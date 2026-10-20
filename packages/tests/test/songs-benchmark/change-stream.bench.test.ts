// oxlint-disable vitest/expect-expect -- a benchmark reports what it measures rather than asserting it
import { performance } from "node:perf_hooks";
import { serialize } from "node:v8";

import { describe, it } from "vitest";

import { openLibrary, recorder, SIZES } from "./harness.js";

/**
 * What a change to many songs costs main and the IPC to renderers: songs as a key-only table, which
 * the app has, against songs sent whole, which it had. A stats refresh that changes every song stands
 * for a first sync or a rescan, and one of a thousand songs for an ordinary one. The time is main's:
 * the write with its capture triggers, then reading the change log back and broadcasting it.
 */
describe("change stream", () => {
  const { record, save } = recorder("change-stream");

  it.each(SIZES)("%i songs", async (size) => {
    for (const fullRows of [false, true]) {
      const label = fullRows ? "whole rows" : "keys only";
      const library = await openLibrary(size, { fullRows });
      let bytes = 0;
      const unsubscribe = library.mirror.subscribe((batch) => {
        bytes += serialize(batch).byteLength;
      });

      // The flush after the commit broadcasts before `exec` resolves.
      let started = performance.now();
      await library.exec(`UPDATE songs SET playCount = coalesce(playCount, 0) + 1`);
      record(size, `every song changes, ${label}`, performance.now() - started);
      record(size, `  to renderers, ${label}`, bytes / 1024 / 1024, "MB");

      bytes = 0;
      started = performance.now();
      await library.exec(`UPDATE songs SET playCount = coalesce(playCount, 0) + 1 WHERE rowid IN (SELECT rowid FROM songs ORDER BY rowid LIMIT 1000)`);
      record(size, `1000 songs change, ${label}`, performance.now() - started);
      record(size, `  to renderers, ${label} `, bytes / 1024, "KB");

      unsubscribe();
      await library.dispose();
    }
  });

  it("saves", () => save());
});
