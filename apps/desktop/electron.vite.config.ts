import { resolve } from "node:path";

import { defineConfig } from "electron-vite";
import { mergeConfig } from "vite";

import { rendererConfig } from "./vite.config";

export default defineConfig({
  main: {
    build: {
      externalizeDeps: false,
      rollupOptions: {
        external: ["better-sqlite3", "electron-updater"],
      },
    },
  },
  preload: {
    build: {
      externalizeDeps: false,
    },
  },
  renderer: mergeConfig(rendererConfig, {
    build: {
      rollupOptions: {
        input: resolve(__dirname, "index.html"),
      },
    },
  }),
});
