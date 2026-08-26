import { SessionManager, type AuthSnapshot, type CoverTarget, type PlaylistSyncStatus, type SessionCredentials, type SyncMode } from "@muswag/shared";
import { Effect } from "effect";

import { runtime } from "#/core/runtime";

const IDLE_PLAYLIST_STATUS: PlaylistSyncStatus = {
  state: "idle",
  error: null,
  lastSyncedAt: null,
};

let authSnapshot: AuthSnapshot = { _tag: "Initializing" };
let playlistStatus = IDLE_PLAYLIST_STATUS;
let unsubscribePlaylistManager: (() => void) | undefined;
let syncInFlight: { readonly mode: SyncMode; readonly controller: AbortController; readonly promise: Promise<void> } | undefined;

const authListeners = new Set<() => void>();
const playlistListeners = new Set<() => void>();

function publishAuth(next: AuthSnapshot): void {
  authSnapshot = next;
  for (const listener of authListeners) listener();
}

function publishPlaylistStatus(next: PlaylistSyncStatus): void {
  playlistStatus = next;
  for (const listener of playlistListeners) listener();
}

async function connectPlaylistStatus(): Promise<void> {
  unsubscribePlaylistManager?.();
  unsubscribePlaylistManager = undefined;

  if (authSnapshot._tag !== "LoggedIn") {
    publishPlaylistStatus(IDLE_PLAYLIST_STATUS);
    return;
  }

  const connection = await runtime.runPromise(
    Effect.gen(function* () {
      const manager = yield* SessionManager;
      return yield* manager.use(({ playlists }) =>
        Effect.gen(function* () {
          const status = yield* playlists.getStatus;
          const unsubscribe = yield* playlists.subscribe(publishPlaylistStatus);
          return { status, unsubscribe };
        }),
      );
    }),
  );

  publishPlaylistStatus(connection.status);
  unsubscribePlaylistManager = connection.unsubscribe;
}

async function restore(): Promise<void> {
  const snapshot = await runtime.runPromise(
    Effect.gen(function* () {
      const manager = yield* SessionManager;
      return yield* manager.restore;
    }),
  );
  publishAuth(snapshot);
  await connectPlaylistStatus();
}

let resolveAppReady!: () => void;
let rejectAppReady!: (cause: unknown) => void;
let startPromise: Promise<void> | undefined;

export const appReady = new Promise<void>((resolve, reject) => {
  resolveAppReady = resolve;
  rejectAppReady = reject;
});

export const AppClient = {
  start(): Promise<void> {
    startPromise ??= restore().then(resolveAppReady, (cause) => {
      rejectAppReady(cause);
      throw cause;
    });
    return startPromise;
  },

  getAuthSnapshot: (): AuthSnapshot => authSnapshot,
  subscribeAuth(listener: () => void): () => void {
    authListeners.add(listener);
    return () => authListeners.delete(listener);
  },

  async login(credentials: SessionCredentials): Promise<void> {
    const snapshot = await runtime.runPromise(
      Effect.gen(function* () {
        const manager = yield* SessionManager;
        return yield* manager.login(credentials);
      }),
    );
    publishAuth(snapshot);
    await connectPlaylistStatus();
  },

  async logout(): Promise<void> {
    syncInFlight?.controller.abort();
    unsubscribePlaylistManager?.();
    unsubscribePlaylistManager = undefined;

    try {
      const { queueManager } = await import("#/components/player-provider");
      await queueManager.clear();
      await runtime.runPromise(
        Effect.gen(function* () {
          const manager = yield* SessionManager;
          return yield* manager.logout;
        }),
      );
    } finally {
      const snapshot = await runtime.runPromise(
        Effect.gen(function* () {
          const manager = yield* SessionManager;
          return yield* manager.snapshot;
        }),
      );
      publishAuth(snapshot);
      await connectPlaylistStatus();
    }
  },

  sync(mode: SyncMode): Promise<void> {
    if (syncInFlight) {
      if (syncInFlight.mode === mode) return syncInFlight.promise;
      return Promise.reject(new Error(`A ${syncInFlight.mode} sync is already running`));
    }

    const controller = new AbortController();
    const promise = runtime
      .runPromise(
        Effect.gen(function* () {
          const manager = yield* SessionManager;
          yield* manager.use(({ sync }) => sync.sync({ mode: mode === "full" ? "no_shortcuts" : "default" }));
        }),
        { signal: controller.signal },
      )
      .then(() => undefined)
      .finally(() => {
        syncInFlight = undefined;
      });
    syncInFlight = { mode, controller, promise };
    return promise;
  },

  cancelSync(): Promise<void> {
    syncInFlight?.controller.abort();
    return Promise.resolve();
  },

  refreshStats(target: { readonly type: "album" | "playlist"; readonly id: string }): Promise<void> {
    return runtime
      .runPromise(
        Effect.gen(function* () {
          const manager = yield* SessionManager;
          yield* manager.use(({ sync }) => sync.refreshStats(target));
        }),
      )
      .then(() => undefined);
  },

  ensureCover(target: CoverTarget): Promise<string | null> {
    return runtime.runPromise(
      Effect.gen(function* () {
        const manager = yield* SessionManager;
        return yield* manager.use(({ covers }) => covers.ensure(target));
      }),
    );
  },

  repairCover(target: CoverTarget, failedPath: string): Promise<string | null> {
    return runtime.runPromise(
      Effect.gen(function* () {
        const manager = yield* SessionManager;
        return yield* manager.use(({ covers }) => covers.repair(target, failedPath));
      }),
    );
  },

  getPlaylistSyncStatus: (): PlaylistSyncStatus => playlistStatus,
  subscribePlaylistSync(listener: () => void): () => void {
    playlistListeners.add(listener);
    return () => playlistListeners.delete(listener);
  },
  syncPlaylists(): Promise<PlaylistSyncStatus> {
    return runtime.runPromise(
      Effect.gen(function* () {
        const manager = yield* SessionManager;
        return yield* manager.use(({ playlists }) => playlists.sync);
      }),
    );
  },
};

window.addEventListener(
  "beforeunload",
  () => {
    unsubscribePlaylistManager?.();
    void runtime.dispose();
  },
  { once: true },
);
