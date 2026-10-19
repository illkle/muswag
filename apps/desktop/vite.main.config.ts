import { builtinModules } from "node:module";

import { defineConfig } from "vite";

const nodeBuiltins = new Set([...builtinModules, ...builtinModules.map((name) => `node:${name}`)]);
// Shipped in the app's node_modules rather than bundled. Everything else is bundled, so that only the
// parts of a package main uses are packaged and loaded.
const runtimePackages = ["electron-updater"];

function isExternal(id: string): boolean {
  if (id === "electron" || id.startsWith("electron/")) return true;
  if (nodeBuiltins.has(id)) return true;
  return runtimePackages.some((name) => id === name || id.startsWith(`${name}/`));
}

export default defineConfig(({ mode }) => ({
  resolve: {
    conditions: ["source", "module", "node", "development|production"],
  },
  build: {
    copyPublicDir: false,
    emptyOutDir: true,
    lib: {
      entry: "src/main/index.ts",
      fileName: () => "index.cjs",
      formats: ["cjs"],
    },
    // Comments and whitespace are most of an unminified bundle, and V8 keeps the source of every function it
    // loads. Development keeps its names and lines, for the stack traces in the terminal.
    minify: mode !== "development",
    outDir: "out/main",
    rollupOptions: {
      external: isExternal,
      output: {
        chunkFileNames: "chunks/[name]-[hash].cjs",
      },
    },
    sourcemap: true,
    target: "node24",
  },
}));
