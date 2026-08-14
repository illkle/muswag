import { defineConfig } from "vitest/config";
import { resolve } from "node:path";

export default defineConfig({
  root: resolve(import.meta.dirname, "../.."),
  resolve: {
    alias: [
      { find: "better-sqlite3", replacement: "better-sqlite3-test" },
      { find: "@muswag/shared", replacement: resolve(import.meta.dirname, "../shared/src/index.ts") },
      { find: "@muswag/subsonic-api", replacement: resolve(import.meta.dirname, "../subsonic-api/src/index.ts") },
    ],
  },
  test: {
    include: ["packages/tests/test/benchmark/**/*.test.ts"],
    environment: "node",
    testTimeout: 30_000,
  },
});
