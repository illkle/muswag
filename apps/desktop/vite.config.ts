import { defineConfig } from "vite";
import { devtools } from "@tanstack/devtools-vite";
import tsconfigPaths from "vite-tsconfig-paths";

import viteReact from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import tanstackRouter from "@tanstack/router-plugin/vite";

const host = process.env.TAURI_DEV_HOST;

const config = defineConfig({
  clearScreen: false,
  server: {
    // make sure this port matches the devUrl port in tauri.conf.json file
    port: 5173,
    // Tauri expects a fixed port, fail if that port is not available
    strictPort: true,
    // if the host Tauri is expecting is set, use it
    host: host || false,
    hmr: host
      ? {
          protocol: "ws",
          host,
          port: 1421,
        }
      : undefined,

    watch: {
      // tell vite to ignore watching `src-tauri`
      ignored: ["**/src-tauri/**"],
    },
  },
  envPrefix: ["VITE_", "TAURI_ENV_*"],
  build: {
    // Tauri uses Chromium on Windows and WebKit on macOS and Linux
    target: process.env.TAURI_ENV_PLATFORM == "windows" ? "chrome105" : "safari13",
    // don't minify for debug builds
    minify: !process.env.TAURI_ENV_DEBUG ? "esbuild" : false,
    // produce sourcemaps for debug builds
    sourcemap: !!process.env.TAURI_ENV_DEBUG,
  },

  plugins: [
    devtools(),
    tsconfigPaths({ projects: ["./tsconfig.json"] }),
    tailwindcss(),
    tanstackRouter({
      target: "react",
      autoCodeSplitting: true,
    }),
    viteReact(),
  ],
});

export default config;
