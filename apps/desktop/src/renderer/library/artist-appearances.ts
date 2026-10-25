import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect } from "react";

import { mirrorClient } from "#/data/library";
import { LibraryActions } from "#/library/actions";

/** The mirrored tables whose changes can add or take away an appearance. */
const CREDIT_TABLES = ["songs", "albums"];
/** How long those tables have to stay unchanged before the appearances are read again: a sync changes them many times in a row. */
const QUIET_MS = 1_000;

/**
 * Where an artist appears on other artists' albums. Main reads it from the credits of every song, which
 * the renderer does not hold, so it is asked again once the songs or albums have changed.
 */
export function useArtistAppearances(artistId: string) {
  const queryClient = useQueryClient();

  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    // The client hears every change main makes, whether or not the songs are loaded here.
    const unsubscribe = mirrorClient.onTableChange(CREDIT_TABLES, () => {
      clearTimeout(timer);
      timer = setTimeout(() => void queryClient.invalidateQueries({ queryKey: ["artist-appearances", artistId] }), QUIET_MS);
    });
    return () => {
      clearTimeout(timer);
      unsubscribe();
    };
  }, [artistId, queryClient]);

  return useQuery({ queryKey: ["artist-appearances", artistId], queryFn: () => LibraryActions.artistAppearances(artistId) });
}
