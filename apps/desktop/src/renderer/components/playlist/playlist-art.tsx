import { PlaylistIcon } from "@phosphor-icons/react";

import type { CoverSize } from "#shared/cover";

import { DetailHeaderPlaceholder } from "#/components/detail-header";
import { TrackCover } from "#/components/track-list/columns";

/**
 * Artwork for a playlist, which has none of its own: the covers of the first four albums in it,
 * or the first one alone when it has fewer.
 */
export function PlaylistArt({ albumIds, size = "thumbnail" }: { albumIds: readonly string[]; size?: CoverSize }) {
  if (albumIds.length === 0) return <DetailHeaderPlaceholder icon={<PlaylistIcon />} />;
  if (albumIds.length < 4) return <TrackCover albumId={albumIds[0]!} size={size} />;

  return (
    <div className="grid aspect-square w-full grid-cols-2 overflow-hidden rounded">
      {albumIds.slice(0, 4).map((albumId) => (
        <TrackCover key={albumId} albumId={albumId} className="rounded-none" size={size} />
      ))}
    </div>
  );
}
