import { useMainRead } from "#/data/main-read";
import { LibraryActions } from "#/library/actions";

/**
 * The artists with albums of their own, the ones the artists page lists, by name. Main finds them in
 * the albums; they are read again once the albums and the artists have stopped changing, which a sync
 * does many times in a row.
 */
export const useArtistsWithAlbums = () => useMainRead({ queryKey: ["artists-with-albums"], tables: ["albums", "artists"], read: () => LibraryActions.artistsWithAlbums(), quiet: true });
