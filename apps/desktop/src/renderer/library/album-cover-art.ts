import { useCallback, useSyncExternalStore } from "react";

import { db } from "#/data/library";

/** What is showing each album's cover, by the album's id. */
const listeners = new Map<string, Set<() => void>>();
let following = false;

/**
 * Tells what shows an album's cover when that album changes. One subscription to the albums serves
 * every cover on screen: a list scrolling past rows only adds and removes listeners, where a live
 * query or a subscription for each row would be set up and taken down with the row.
 *
 * It stays subscribed once started, as the albums are mirrored for as long as the window is open.
 */
function subscribe(albumId: string, onChange: () => void): () => void {
  if (!following) {
    following = true;
    // Told of the albums already there as well, it would hear nothing when one of them goes.
    db.albums.subscribeChanges(
      (changes) => {
        for (const { key } of changes) listeners.get(String(key))?.forEach((listener) => listener());
      },
      { includeInitialState: false },
    );
  }

  let forAlbum = listeners.get(albumId);
  if (!forAlbum) listeners.set(albumId, (forAlbum = new Set()));
  forAlbum.add(onChange);

  return () => {
    forAlbum.delete(onChange);
    if (forAlbum.size === 0) listeners.delete(albumId);
  };
}

/**
 * The id the server gives the cover of the album, or null while the album has none or is not in the
 * library. Covers of songs are read through their album, so that a cover has one address however many
 * songs show it.
 */
export function useAlbumCoverArt(albumId: string | null | undefined): string | null {
  const subscribeToAlbum = useCallback((onChange: () => void) => (albumId ? subscribe(albumId, onChange) : () => undefined), [albumId]);
  return useSyncExternalStore(subscribeToAlbum, () => (albumId ? (db.albums.get(albumId)?.coverArt ?? null) : null));
}
