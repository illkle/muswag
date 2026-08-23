import { defineConfig } from "vitest/config";
import { resolve } from "node:path";

export default defineConfig({
  root: resolve(import.meta.dirname, "../.."),
  resolve: {
    alias: [
      { find: "better-sqlite3", replacement: "better-sqlite3-test" },
      { find: "@muswag/shared/sync-node", replacement: resolve(import.meta.dirname, "../shared/src/sync-node.ts") },
      { find: "@muswag/shared", replacement: resolve(import.meta.dirname, "../shared/src/index.ts") },
      { find: "@muswag/subsonic-api/effect", replacement: resolve(import.meta.dirname, "../subsonic-api/src/effect.ts") },
      { find: "@muswag/subsonic-api", replacement: resolve(import.meta.dirname, "../subsonic-api/src/index.ts") },
    ],
  },
  test: {
    include: ["packages/tests/test/unit/**/*.test.ts", "packages/shared/src/**/*.test.ts"],
    environment: "node",
    testTimeout: 30_000,
    coverage: {
      provider: "v8",
      reporter: ["text", "json", "html"],
      reportsDirectory: "packages/tests/coverage",
      include: ["packages/shared/src/**/*.ts", "packages/subsonic-api/src/**/*.ts"],
    },
  },
});
