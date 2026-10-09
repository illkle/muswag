/**
 * Where the lists that ask for it were last scrolled to, by their scroll id. The router restores a
 * position only when going back to a page; this brings it back on any visit, for as long as the window is open.
 */
export const scrollMemory = new Map<string, number>();
