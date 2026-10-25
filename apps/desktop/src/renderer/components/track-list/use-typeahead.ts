import { useRef, type KeyboardEvent } from "react";

/** How long typing a few letters to jump to them waits for the next one before it starts over. */
const TYPEAHEAD_MS = 1_000;

/**
 * Jumping to a track by typing the first letters of what a list is in order of: `findPosition` says
 * where the first track at or after what was typed is, and `goTo` is given it. What it gives back
 * takes a key pressed in the list, and says whether the key was taken for typing.
 */
export function useTypeahead(findPosition: ((text: string) => Promise<number | null>) | undefined, goTo: (position: number) => void) {
  // What has been typed to jump to, until a moment passes without another key.
  const typed = useRef({ text: "", at: 0, search: 0 });
  return (event: KeyboardEvent<HTMLDivElement>): boolean => {
    const { key } = event;
    if (!findPosition || key.length !== 1 || event.metaKey || event.ctrlKey || event.altKey) return false;
    const now = performance.now();
    const going = typed.current.text !== "" && now - typed.current.at < TYPEAHEAD_MS;
    // Space plays and pauses, unless it goes on what is being typed.
    if (key === " " && !going) return false;
    event.preventDefault();
    event.stopPropagation();
    const text = (going ? typed.current.text : "") + key;
    const search = typed.current.search + 1;
    typed.current = { text, at: now, search };
    findPosition(text).then(
      (position) => {
        // Only the latest of the searches goes anywhere.
        if (position === null || typed.current.search !== search) return;
        goTo(position);
      },
      // Not finding where to jump leaves the list where it is.
      (cause: unknown) => console.error("[track-list] could not find where the typed text starts", cause),
    );
    return true;
  };
}
