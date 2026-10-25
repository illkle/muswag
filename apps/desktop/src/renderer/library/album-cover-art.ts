import { useCallback, useSyncExternalStore } from "react";

import { onLibraryChange } from "#/data/library-changes";
import { LibraryActions } from "#/library/actions";

/** The cover id of each album asked about, `null` for one without a cover or not in the library. */
const coverArts = new Map<string, string | null>();
/** What is showing each album's cover, by the album's id. */
const listeners = new Map<string, Set<() => void>>();
/** Albums to ask main about, gathered so that the rows drawn together ask once. */
const wanted = new Set<string>();
/** Albums main has been asked about and has not answered for yet. */
const asking = new Set<string>();
/** Albums that changed while main was being asked about them: its answer may be from before. */
const changedWhileAsking = new Set<string>();
let following = false;
/** After asking failed, how long it waits before it asks again. */
const RETRY_MS = 5_000;

const notify = (albumId: string) => listeners.get(albumId)?.forEach((listener) => listener());

/** Asks main for the cover ids of the albums `want` named since the last ask, all at once. */
function ask() {
  const ids = [...wanted];
  wanted.clear();
  for (const id of ids) asking.add(id);
  const done = () => {
    for (const id of ids) asking.delete(id);
    // An album that changed meanwhile is asked about again, so the cover shown is not the one from before.
    for (const id of ids) if (changedWhileAsking.delete(id)) want(id);
  };
  LibraryActions.albumCoverArts(ids).then(
    (found) => {
      const byId = new Map(found.map(({ id, coverArt }) => [id, coverArt]));
      for (const id of ids) {
        const coverArt = byId.get(id) ?? null;
        if (coverArts.has(id) && coverArts.get(id) === coverArt) continue;
        coverArts.set(id, coverArt);
        notify(id);
      }
      done();
    },
    (cause: unknown) => {
      console.error("[covers] the albums' covers could not be read", cause);
      done();
      // What is known of them may be out of date, if they were asked about because they changed: those
      // shown are asked about again in a moment, the others when next shown.
      for (const id of ids) if (!listeners.has(id)) coverArts.delete(id);
      setTimeout(() => {
        for (const id of ids) if (listeners.has(id)) want(id);
      }, RETRY_MS);
    },
  );
}

function want(albumId: string) {
  if (asking.has(albumId)) return;
  if (wanted.size === 0) queueMicrotask(ask);
  wanted.add(albumId);
}

/** Asks again about the albums that changed, or about every album asked about when too many changed to list. */
function follow() {
  following = true;
  const changed = (albumId: string) => {
    if (asking.has(albumId)) changedWhileAsking.add(albumId);
    else if (coverArts.has(albumId)) want(albumId);
  };
  onLibraryChange((event) => {
    if (!("albums" in event.tables)) return;
    const keys = event.tables.albums;
    for (const albumId of keys ? keys.map(String) : [...coverArts.keys(), ...asking]) changed(albumId);
  });
}

/**
 * Tells what shows an album's cover when the album's cover id is known or changes. The renderer does
 * not hold the albums, so the ids are asked of main, for the albums of every row drawn at once, and
 * kept: a cover id is a few bytes, and the same albums come back as a list scrolls.
 */
function subscribe(albumId: string, onChange: () => void): () => void {
  if (!following) follow();
  let forAlbum = listeners.get(albumId);
  if (!forAlbum) listeners.set(albumId, (forAlbum = new Set()));
  forAlbum.add(onChange);
  if (!coverArts.has(albumId)) want(albumId);
  return () => {
    forAlbum.delete(onChange);
    if (forAlbum.size === 0) listeners.delete(albumId);
  };
}

/**
 * The id the server gives the cover of the album, or null while it is not known yet, the album has none
 * or is not in the library. Covers of songs are read through their album, so that a cover has one
 * address however many songs show it.
 */
export function useAlbumCoverArt(albumId: string | null | undefined): string | null {
  const subscribeToAlbum = useCallback((onChange: () => void) => (albumId ? subscribe(albumId, onChange) : () => undefined), [albumId]);
  return useSyncExternalStore(subscribeToAlbum, () => (albumId ? (coverArts.get(albumId) ?? null) : null));
}
