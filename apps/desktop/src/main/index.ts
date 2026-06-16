import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

import { app, BrowserWindow, net, protocol, shell } from 'electron';
import { IpcEmitter, IpcListener } from '@electron-toolkit/typed-ipc/main';
import { electronApp, is, optimizer } from '@electron-toolkit/utils';
import { createCoverArtStore, getUserInfo, login, logout, sync } from '@muswag/shared';
import type { MuswagRendererIpc } from '../shared/ipc';
import {
  disposePlayer,
  getDefaultMpvIpcPath,
  initializePlayer,
  next,
  pause,
  play,
  playQueue,
  previous,
  seek,
  subscribe,
  toggle,
} from './player/mpv-controller';
import { getState } from './player/player-session';
import { db, dbReady, disposeDB } from './db';

let unsubscribePlayerEvents: (() => void) | undefined;
let syncInFlight: Promise<Awaited<ReturnType<typeof sync>>> | undefined;

protocol.registerSchemesAsPrivileged([
  {
    scheme: 'muswag-cover',
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: true,
      corsEnabled: true,
    },
  },
]);

const mainIpc = new IpcListener();
const rendererIpc = new IpcEmitter<MuswagRendererIpc>();

function broadcastPlayerEvent(
  event: MuswagRendererIpc['player:event'][0],
): void {
  console.log('broadcast:renderer', event);
  for (const window of BrowserWindow.getAllWindows()) {
    rendererIpc.send(window.webContents, 'player:event', event);
  }
}

function broadcastDbReloadAll(): void {
  for (const window of BrowserWindow.getAllWindows()) {
    rendererIpc.send(window.webContents, 'db:reloadAll');
  }
}

function initializeDesktopPlayer(): void {
  initializePlayer({
    getDb: () => db,
    ipcPath: getDefaultMpvIpcPath(app.getPath('temp')),
    mpvBinaryPath: process.env.MUSWAG_MPV_PATH ?? 'mpv',
  });

  if (!unsubscribePlayerEvents) {
    unsubscribePlayerEvents = subscribe((event) => {
      broadcastPlayerEvent(event);
    });
  }
}

function createWindow(): void {
  const mainWindow = new BrowserWindow({
    width: 1280,
    height: 720,
    minHeight: 600,
    minWidth: 800,
    show: false,
    autoHideMenuBar: true,
    ...(process.platform === 'darwin'
      ? {
          titleBarStyle: 'hiddenInset' as const,
          trafficLightPosition: { x: 14, y: 14 },
        }
      : {}),
    webPreferences: {
      preload: join(__dirname, '../preload/index.mjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  mainWindow.on('ready-to-show', () => {
    mainWindow.show();
  });

  mainWindow.webContents.setWindowOpenHandler((details) => {
    shell.openExternal(details.url);
    return { action: 'deny' };
  });

  if (is.dev && process.env.ELECTRON_RENDERER_URL) {
    mainWindow.loadURL(process.env.ELECTRON_RENDERER_URL);
    mainWindow.webContents.openDevTools({ mode: 'detach' });
    return;
  }

  mainWindow.loadFile(join(__dirname, '../renderer/index.html'));
}

app.whenReady().then(() => {
  electronApp.setAppUserModelId('com.muswag.desktop');

  app.on('browser-window-created', (_, window) => {
    optimizer.watchWindowShortcuts(window);
  });

  protocol.handle('muswag-cover', (request) => {
    const requestedPath = new URL(request.url).searchParams.get('path');
    if (!requestedPath) {
      return new Response('Missing path', { status: 400 });
    }

    return net.fetch(pathToFileURL(requestedPath).toString());
  });

  mainIpc.handle('player:getState', async () => {
    return getState();
  });
  mainIpc.handle('player:next', async () => {
    await next();
  });
  mainIpc.handle('player:pause', async () => {
    await pause();
  });
  mainIpc.handle('player:play', async () => {
    await play();
  });
  mainIpc.handle('player:playQueue', async (_, input) => {
    await playQueue(input);
  });
  mainIpc.handle('player:previous', async () => {
    await previous();
  });
  mainIpc.handle('player:seek', async (_, positionSeconds) => {
    await seek(positionSeconds);
  });
  mainIpc.handle('player:toggle', async () => {
    await toggle();
  });
  mainIpc.handle('sync:login', async (_, credentials) => {
    await dbReady;
    const user = await login(db, credentials);
    broadcastDbReloadAll();
    return user;
  });
  mainIpc.handle('sync:logout', async () => {
    await dbReady;
    const result = await logout(db);
    broadcastDbReloadAll();
    return result;
  });
  mainIpc.handle('sync:run', async () => {
    await dbReady;

    if (syncInFlight) {
      return syncInFlight;
    }

    const user = getUserInfo(db);
    if (!user) {
      throw new Error('You need to log in before syncing.');
    }

    syncInFlight = sync(
      db,
      createCoverArtStore({
        ...user,
        coverArtDir: join(app.getPath('userData'), 'cover-art'),
      }),
    )
      .then((record) => {
        broadcastDbReloadAll();
        return record;
      })
      .finally(() => {
        syncInFlight = undefined;
      });

    return syncInFlight;
  });

  initializeDesktopPlayer();
  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

app.on('window-all-closed', () => {
  app.quit();
});

app.on('before-quit', () => {
  mainIpc.dispose();
  unsubscribePlayerEvents?.();
  unsubscribePlayerEvents = undefined;
  disposePlayer();
  disposeDB();
});
