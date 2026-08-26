import { Fragment } from "react";

import { Link } from "@tanstack/react-router";

export function ArtistLink({ artistId, children, className }: { artistId: string | null | undefined; children: React.ReactNode; className?: string | undefined }) {
  if (!artistId) {
    return <span className={className}>{children}</span>;
  }

  return (
    <Link
      to="/app/artists/$artistId"
      params={{ artistId }}
      className={className}
      onClick={(event) => {
        event.stopPropagation();
      }}
      onDoubleClick={(event) => {
        event.stopPropagation();
      }}
    >
      {children}
    </Link>
  );
}

type Artist = {
  id: string;
  name: string;
};

type ArtistFields = {
  displayArtist?: string | undefined;
  artistId?: string | undefined;
  artists?: readonly Artist[] | undefined;
  artist?: string | undefined;
};

export type ArtistCredit = {
  id?: string;
  name: string;
};

export function getArtistCredits({ displayArtist, artistId, artists, artist }: ArtistFields): ArtistCredit[] {
  if (displayArtist) {
    /* This is super dumb but in navidrome artists is all artists on all album(so all featured) and the only way to get both artist for collab albums is to split "displayArtist" property */

    const m = new Map<string, string>();

    if (artists) {
      for (const a of artists) {
        m.set(a.name, a.id);
      }
    }

    const splitted = displayArtist.split(" • ");

    const mapped: ArtistCredit[] = [];
    let ok = true;

    for (const s of splitted) {
      const id = m.get(s);
      if (id) {
        mapped.push({ id, name: s });
      } else {
        ok = false;
        break;
      }
    }

    if (ok) {
      return mapped;
    }
  }

  if (artists?.length) {
    return artists.map(({ id, name }) => ({ id, name }));
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
  className?: string | undefined;
  linkClassName?: string | undefined;
}) {
  const credits = getArtistCredits({
    artist,
    artistId,
    artists,
    displayArtist,
  });

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
