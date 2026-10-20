import { defineConfig } from "vitest/config";

const conditions = ["source", "module", "node", "development|production"];

// Each file in a process of its own, one after another, with `gc` exposed so heap sizes can be read.
export default defineConfig({
  resolve: { conditions },
  ssr: { resolve: { conditions, externalConditions: ["source"] } },
  test: {
    server: { deps: { inline: [/@muswag\//] } },
    include: ["test/songs-benchmark/**/*.bench.test.ts"],
    environment: "node",
    pool: "forks",
    execArgv: ["--expose-gc", "--max-old-space-size=8192"],
    fileParallelism: false,
    testTimeout: 30 * 60_000,
    silent: false,
  },
});
