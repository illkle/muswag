import { useMainRead } from "#/data/main-read";
import { LibraryActions } from "#/library/actions";

/**
 * The artists the artists page lists, by name: those with albums of their own, and those only credited
 * on others' albums. Main finds them in the albums; they are read again once the albums and the artists
 * have stopped changing, which a sync does many times in a row.
 */
export const useArtistIndex = () => useMainRead({ queryKey: ["artist-index"], tables: ["albums", "artists"], read: () => LibraryActions.artistIndex(), quiet: true });
