import type { LibraryChangedEvent } from "#shared/state/app-state";

const listeners = new Set<(event: LibraryChangedEvent) => void>();
let listening = false;

/**
 * Calls `listener` whenever a write in main changes rows of the library, with the tables it changed and
 * the keys of the rows where there were few enough to list. Main sends them once the window has
 * connected (`connectToMain`).
 */
export function onLibraryChange(listener: (event: LibraryChangedEvent) => void): () => void {
  if (!listening) {
    listening = true;
    window.electron.ipcRenderer.on("library:changed", (_event, payload) => {
      for (const listener of Array.from(listeners)) listener(payload as LibraryChangedEvent);
    });
  }
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Calls `listener` whenever rows of `table` change. */
export const onTableChange =
  (table: string) =>
  (listener: () => void): (() => void) =>
    onLibraryChange((event) => {
      if (table in event.tables) listener();
    });
