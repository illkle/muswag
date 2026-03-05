import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const dbEntry = fileURLToPath(new URL("../db/src/index.ts", import.meta.url));

export default defineConfig({
  resolve: {
    alias: {
      "@muswag/db": dbEntry,
    },
  },
  test: {
    include: ["test/**/*integration.test.ts"],
    environment: "node",
    testTimeout: 180_000,
    hookTimeout: 180_000,
  },
});
