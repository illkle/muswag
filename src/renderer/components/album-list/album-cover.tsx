import { cn } from "#/lib/utils";
import { CoverArt } from "#/lib/sync-manager";
import type { CoverTarget } from "#core";
import { startTransition, useEffect, useRef, useState } from "react";

export function AlbumCover({ coverArtPath, instantLoad = false, target, className }: { coverArtPath: string | undefined; instantLoad?: boolean; target?: CoverTarget; className?: string }) {
  const [imageFailed, setImageFailed] = useState(false);
  const [repairedPath, setRepairedPath] = useState<string | null>(null);
  const [retryRevision, setRetryRevision] = useState(0);
  const repairAttempts = useRef(0);
  const targetKey = target ? `${target.type}:${target.id}:${target.coverArtId ?? ""}` : "";
  const currentTargetKey = useRef(targetKey);
  currentTargetKey.current = targetKey;
  const effectiveCoverArtPath = repairedPath ?? coverArtPath;
  const coverSrc = effectiveCoverArtPath ? toCoverArtUrl(effectiveCoverArtPath, retryRevision) : null;

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

  useEffect(() => {
    if (!loadImage || effectiveCoverArtPath || !target?.coverArtId) return;
    const requestedTargetKey = targetKey;
    void CoverArt.ensure(target)
      .then((path) => {
        if (path && currentTargetKey.current === requestedTargetKey) setRepairedPath(path);
      })
      .catch((error: unknown) => {
        console.warn("On-demand cover fetch failed.", { target, error });
      });
  }, [effectiveCoverArtPath, loadImage, target, targetKey]);

  useEffect(() => {
    setImageFailed(false);
    setRepairedPath(null);
    setRetryRevision(0);
  }, [coverArtPath]);

  useEffect(() => {
    repairAttempts.current = 0;
  }, [targetKey]);

  return (
    <div className={cn("relative aspect-square overflow-hidden rounded", className)}>
      {!imageFailed && coverSrc && loadImage && (
        <img
          src={coverSrc}
          alt={`cover art`}
          className="relative z-10 size-full animate-in object-cover fade-in-0"
          decoding="async"
          loading="lazy"
          onLoad={() => {
            repairAttempts.current = 0;
          }}
          onError={() => {
            setImageFailed(true);
            if (!target || !effectiveCoverArtPath || repairAttempts.current >= 1) return;

            repairAttempts.current += 1;
            const requestedTargetKey = targetKey;
            void CoverArt.repair(target, effectiveCoverArtPath)
              .then((path) => {
                if (!path || currentTargetKey.current !== requestedTargetKey) return;
                setRepairedPath(path);
                setRetryRevision((revision) => revision + 1);
                setImageFailed(false);
              })
              .catch((error: unknown) => {
                console.warn("Cover repair failed.", { target, path: effectiveCoverArtPath, error });
              });
          }}
        />
      )}
      <div className="absolute top-0 size-full border border-border bg-muted"> </div>
    </div>
  );
}

function toCoverArtUrl(coverArtPath: string, revision: number): string {
  return `muswag-cover://local?path=${encodeURIComponent(coverArtPath)}&revision=${revision}`;
}
