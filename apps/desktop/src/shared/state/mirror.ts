import { SESSION_TABLES } from "./session";
import { PLAYER_TABLES } from "./player";

/**
 * Main's in-memory state, mirrored to renderers apart from the library: the player (`player.ts`)
 * and the session and sync status (`session.ts`).
 */
export const STATE_MIRROR_CHANNEL = "muswag-state";

export const STATE_TABLES = [...PLAYER_TABLES, ...SESSION_TABLES] as const;
