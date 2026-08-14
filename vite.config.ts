import { resolve } from "node:path";

import { devtools } from "@tanstack/devtools-vite";
import tailwindcss from "@tailwindcss/vite";
import tanstackRouter from "@tanstack/router-plugin/vite";
import viteReact from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";
import electron from "vite-plugin-electron/simple";
import { notBundle } from "vite-plugin-electron/plugin";

const sourceAliases = [
  { find: /^#core\/(.*)$/, replacement: `${resolve(import.meta.dirname, "src/core")}/$1` },
  { find: "#core", replacement: resolve(import.meta.dirname, "src/core/index.ts") },
  { find: "#subsonic-api", replacement: resolve(import.meta.dirname, "src/subsonic-api/index.ts") },
];

export default defineConfig(({ mode }) => ({
  clearScreen: false,
  root: ".",
  server: {
    port: 5173,
    strictPort: true,
  },
  envPrefix: ["VITE_"],
  resolve: {
    alias: [...(mode === "test" ? [{ find: "better-sqlite3", replacement: "better-sqlite3-test" }] : []), ...sourceAliases],
    tsconfigPaths: true,
  },
  build: {
    outDir: "out/renderer",
    target: "chrome124",
  },
  test: {
    include: ["src/**/*.test.{ts,tsx}"],
    testTimeout: 30_000,
    coverage: {
      provider: "v8",
      reporter: ["text", "json", "html"],
      reportsDirectory: "coverage",
      include: ["src/**/*.{ts,tsx}"],
    },
  },
  plugins: [
    ...(mode === "test"
      ? []
      : [
          electron({
            main: {
              entry: "src/main/index.ts",
              vite: {
                build: {
                  outDir: "out/main",
                  rolldownOptions: {
                    output: {
                      entryFileNames: "index.js",
                    },
                  },
                },
                plugins: [notBundle()],
              },
            },
            preload: {
              input: "src/preload/index.ts",
              vite: {
                build: {
                  outDir: "out/preload",
                  rolldownOptions: {
                    output: {
                      entryFileNames: "index.mjs",
                    },
                  },
                },
                plugins: [notBundle()],
              },
            },
          }),
        ]),
    devtools(),
    tailwindcss(),
    tanstackRouter({
      target: "react",
      routesDirectory: "src/renderer/routes",
      generatedRouteTree: "src/renderer/routeTree.gen.ts",
      autoCodeSplitting: true,
    }),
    viteReact(),
  ],
}));
