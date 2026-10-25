import { fileURLToPath } from "node:url";

import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // A cache of this package's own: the packages' tests run side by side, and a lockfile change has
    // each of them clear a shared one at once.
    fsModuleCachePath: fileURLToPath(new URL("node_modules/.vitest-cache", import.meta.url)),
    include: ["src/**/*.test.ts"],
    environment: "node",
    coverage: {
      provider: "v8",
      reporter: ["text", "json", "html"],
      reportsDirectory: "coverage",
      include: ["src/**/*.ts"],
    },
  },
});
