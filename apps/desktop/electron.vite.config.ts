import { resolve } from "node:path";

import { defineConfig, externalizeDepsPlugin } from "electron-vite";
import { mergeConfig } from "vite";

import { rendererConfig } from "./vite.config";

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
  },
  renderer: mergeConfig(rendererConfig, {
    build: {
      rollupOptions: {
        input: resolve(__dirname, "index.html"),
      },
    },
  }),
});
