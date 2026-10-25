import { Schema } from "effect";

/** The theme the user picks for the app: one of its own, or whichever the OS asks for. */
export const Theme = Schema.Literals(["dark", "light", "system"]);
export type Theme = typeof Theme.Type;
