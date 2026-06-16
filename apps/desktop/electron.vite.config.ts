import { resolve } from 'node:path';

import { defineConfig } from 'electron-vite';
import { mergeConfig } from 'vite';

import { rendererConfig } from './vite.config';

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
  renderer: mergeConfig(rendererConfig, {
    build: {
      rollupOptions: {
        input: resolve(__dirname, 'index.html'),
      },
    },
  }),
});
