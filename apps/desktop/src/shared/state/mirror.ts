import { appUpdate } from "./app-update";
import { SESSION_TABLES } from "./session";
import { PLAYER_TABLES } from "./player";
import { unplayableTracks } from "./queue";

/**
 * Main's in-memory state, mirrored to renderers apart from the library, on `STATE_MIRROR_CHANNEL`:
 * the player (`player.ts`), the session and sync status (`session.ts`), the app's updates
 * (`app-update.ts`) and the tracks that could not be played (`queue.ts`).
 */
export const STATE_TABLES = [...PLAYER_TABLES, ...SESSION_TABLES, appUpdate, unplayableTracks] as const;
