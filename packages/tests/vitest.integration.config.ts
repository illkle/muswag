import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      "better-sqlite3": "better-sqlite3-test",
    },
  },
  test: {
    include: ["test/**/*integration.test.ts"],
    environment: "node",
    testTimeout: 180_000,
    hookTimeout: 180_000,
  },
});
