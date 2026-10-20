import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect } from "react";

import { LibraryActions } from "#/library/actions";
import { onTableChange } from "#/library/use-paged-window";

/** How long the albums have to stay unchanged before main is asked again: a sync changes them many times in a row. */
const QUIET_MS = 1_000;
/** How long changes that keep coming can put that off. */
const LONGEST_WAIT_MS = 5_000;
const QUERY_KEY = ["artists-with-albums"];

/**
 * The ids of the artists with albums of their own, the ones the artists page lists. Main finds them in
 * the albums, which the renderer does not hold, so they are asked again once the albums have changed.
 */
export function useArtistsWithAlbums() {
  const queryClient = useQueryClient();

  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    let firstChange: number | undefined;
    const ask = () => {
      timer = undefined;
      firstChange = undefined;
      void queryClient.invalidateQueries({ queryKey: QUERY_KEY });
    };
    const unsubscribe = onTableChange("albums")(() => {
      const now = performance.now();
      firstChange ??= now;
      clearTimeout(timer);
      timer = setTimeout(ask, Math.max(0, Math.min(QUIET_MS, firstChange + LONGEST_WAIT_MS - now)));
    });
    return () => {
      clearTimeout(timer);
      unsubscribe();
    };
  }, [queryClient]);

  return useQuery({ queryKey: QUERY_KEY, queryFn: () => LibraryActions.artistsWithAlbums() });
}
