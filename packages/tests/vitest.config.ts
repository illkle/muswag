import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      "better-sqlite3": "better-sqlite3-test",
    },
  },
  test: {
    include: ["test/unit/**/*.test.ts"],
    environment: "node",
    testTimeout: 30_000,
  },
});
