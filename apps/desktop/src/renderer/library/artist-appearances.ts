import { useMainRead } from "#/data/main-read";
import { LibraryActions } from "#/library/actions";

/**
 * Where an artist appears on other artists' albums. Main reads it from the credits of every song, so it
 * is read again only once the songs and albums have stopped changing.
 */
export const useArtistAppearances = (artistId: string) =>
  useMainRead({ queryKey: ["artist-appearances", artistId], tables: ["songs", "albums"], read: () => LibraryActions.artistAppearances(artistId), quiet: true });
