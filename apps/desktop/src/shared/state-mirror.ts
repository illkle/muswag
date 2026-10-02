import { APP_TABLES } from "./app-state";
import { PLAYER_TABLES } from "./player-state";

/**
 * Main's in-memory state, mirrored to renderers apart from the library: the player (`player-state.ts`)
 * and the session and sync status (`app-state.ts`).
 */
export const STATE_MIRROR_CHANNEL = "muswag-state";

export const STATE_TABLES = [...PLAYER_TABLES, ...APP_TABLES] as const;
