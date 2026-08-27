import { defineConfig } from "electron-vite";

import { rendererConfig } from "./vite.config";

export default defineConfig({
  main: {
    build: {
      externalizeDeps: true,
    },
  },
  preload: {
    build: {
      externalizeDeps: true,
    },
  },
  renderer: rendererConfig,
});
