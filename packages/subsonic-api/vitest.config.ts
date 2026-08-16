import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: [],
  },
  test: {
    include: ["src/**/*.test.ts"],

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
