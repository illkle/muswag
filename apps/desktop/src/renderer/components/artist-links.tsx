import { Fragment } from "react";

import { ArtistLink } from "#/components/artist-link";

type Artist = {
  id: string;
  name: string;
};

type ArtistFields = {
  displayArtist?: string;
  artistId?: string;
  artists?: Artist[];
  artist?: string;
};

export type ArtistCredit = {
  id?: string;
  name: string;
};

export function getArtistCredits({ displayArtist, artistId, artists, artist }: ArtistFields): ArtistCredit[] {
  if (artists?.length) {
    return artists.map(({ id, name }) => ({ id, name }));
  }

  if (displayArtist) {
    return [{ id: artistId, name: displayArtist }];
  }

  if (artist && artistId) {
    return [{ id: artistId, name: artist }];
  }

  if (artist) {
    return [{ name: artist }];
  }

  return [{ name: "Unknown artist" }];
}

export function ArtistLinks({
  artist,
  artistId,
  artists,
  displayArtist,
  className,
  linkClassName,
}: ArtistFields & {
  className?: string;
  linkClassName?: string;
}) {
  const credits = getArtistCredits({ artist, artistId, artists, displayArtist });

  return (
    <span className={className}>
      {credits.map((credit, index) => (
        <Fragment key={credit.id ?? `${credit.name}-${index}`}>
          {index > 0 ? ", " : null}
          <ArtistLink artistId={credit.id} className={linkClassName}>
            {credit.name}
          </ArtistLink>
        </Fragment>
      ))}
    </span>
  );
}
