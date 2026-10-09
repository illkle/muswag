import { defineConfig } from "vitest/config";

const conditions = ["source", "module", "node", "development|production"];

export default defineConfig({
  // Workspace packages are transformed from source rather than loaded from their builds.
  resolve: { conditions },
  ssr: { resolve: { conditions, externalConditions: ["source"] } },
  test: {
    server: { deps: { inline: [/@muswag\//] } },
    include: ["test/**/*integration.test.ts"],
    environment: "node",
    testTimeout: 180_000,
    hookTimeout: 180_000,
  },
});
