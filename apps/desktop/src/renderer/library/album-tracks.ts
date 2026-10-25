import type { LibraryAlbum, LibrarySong } from "@muswag/model";

import type { TrackListItem } from "#/components/track-list/types";
import { getArtistCredits } from "#/components/utils/artist-links";

/** The artists something is credited to, as one comparable line. */
export const creditLine = (credited: Parameters<typeof getArtistCredits>[0]) =>
  getArtistCredits(credited)
    .map(({ name }) => name)
    .join(", ");

/**
 * The heading over `song` when it starts a disc of an album of more than one, or null. `previous` is the
 * song listed before it, which may be of another album where a list goes through several.
 */
export function discHeading(album: { id: string; discTitles?: LibraryAlbum["discTitles"] | undefined }, song: LibrarySong, previous: LibrarySong | undefined): TrackListItem | null {
  const disc = song.discNumber;
  if ((album.discTitles?.length ?? 0) <= 1 || !disc) return null;
  if (previous?.albumId === song.albumId && previous.discNumber === disc) return null;

  const title = album.discTitles?.find((entry) => entry.disc === disc)?.title;
  return { type: "heading", key: `disc:${album.id}:${disc}`, title: `Disc ${disc}`, ...(title ? { subtitle: title } : {}) };
}

/**
 * Whether every song is credited just as its album is. Naming the artist on every row of tracks listed
 * under their albums only says something when one is credited differently.
 */
export function creditedAsTheirAlbums(songs: readonly LibrarySong[], albums: readonly LibraryAlbum[]): boolean {
  const albumCredits = new Map(albums.map((album) => [album.id, creditLine(album)]));
  return songs.every((song) => creditLine(song) === albumCredits.get(song.albumId ?? ""));
}
