import { startTransition, useEffect, useState } from "react";

export function AlbumCover({
  coverArtPath,
  instantLoad = false,
}: {
  coverArtPath: string | null;
  instantLoad?: boolean;
}) {
  const [imageFailed, setImageFailed] = useState(false);
  const coverSrc = coverArtPath ? toCoverArtUrl(coverArtPath) : null;

  const [loadImage, setLoadImage] = useState(instantLoad);

  useEffect(() => {
    const t = setTimeout(() => {
      startTransition(() => {
        setLoadImage(true);
      });
    }, 50);

    return () => {
      clearTimeout(t);
    };
  }, []);

  return (
    <div className="relative aspect-square overflow-hidden rounded">
      {!imageFailed && coverSrc && loadImage && (
        <img
          src={coverSrc}
          alt={`cover art`}
          className="size-full relative z-10 object-cover fade-in-0 animate-in"
          decoding="async"
          loading="lazy"
          onError={() => {
            setImageFailed(true);
          }}
        />
      )}
      <div className="size-full absolute top-0 border border-border bg-muted "> </div>
    </div>
  );
}

function toCoverArtUrl(coverArtPath: string): string {
  return `muswag-cover://local?path=${encodeURIComponent(coverArtPath)}`;
}
