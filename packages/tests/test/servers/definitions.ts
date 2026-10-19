import { gonic } from "./gonic.js";
import { lms } from "./lms.js";
import { navidrome } from "./navidrome.js";
import type { ServerDefinition } from "./server.js";

/** Every server muswag is tested against. */
export const definitions: ServerDefinition[] = [navidrome, gonic, lms];
