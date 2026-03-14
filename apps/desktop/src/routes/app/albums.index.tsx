import { useEffect, useMemo, useRef, useState } from "react";

import { useQuery } from "@tanstack/react-query";
import { createFileRoute, Navigate, useNavigate } from "@tanstack/react-router";
import { Disc3 } from "lucide-react";

import { Alert, AlertDescription, AlertTitle } from "#/components/ui/alert";
import { albumsQueryOptions, userStateQueryOptions } from "#/lib/app-state";
import { getErrorMessage } from "#/lib/err";
import type { AlbumRecord } from "@muswag/shared";
import { useVirtualizer } from "@tanstack/react-virtual";
import { chunk } from "lodash-es";

export const Route = createFileRoute("/app/albums/")({
  component: RouteComponent,
});

const AlbumItem = ({ album, onClick }: { album: AlbumRecord; onClick: () => void }) => {
  return (
    <button
      key={album.id}
      className="cursor-pointer h-64 text-left flex flex-col p-1 justify-start align-bottom hover:bg-accent rounded transition"
      tabIndex={0}
      onClick={onClick}
    >
      <AlbumCover albumId={album.id} coverArtPath={album.coverArtPath} title={album.name} />

      <p className="truncate text-xs mt-2 line-clamp-2">
        {album.artist ?? album.displayArtist ?? "Unknown artist"}
      </p>
      <h2 className="line-clamp-2 text-xs font-semibold">{album.name}</h2>
      <p className="text-xs text-muted-foreground">{album.year}</p>
    </button>
  );
};

function AlbumList({ albums }: { albums: AlbumRecord[] }) {
  const parentRef = useRef(null);
  const navigate = useNavigate();

  const chunked = useMemo(() => chunk(albums, 7), [albums]);

  const rowVirtualizer = useVirtualizer({
    count: chunked.length,
    getScrollElement: () => parentRef.current,
    estimateSize: () => 256,
    overscan: 2,
  });

  return (
    <div ref={parentRef} className="overflow-y-auto">
      <div
        style={{
          height: `${rowVirtualizer.getTotalSize()}px`,
          width: "100%",
          position: "relative",
        }}
      >
        {rowVirtualizer.getVirtualItems().map((virtualRow) => (
          <div
            key={virtualRow.index}
            style={{
              height: `${virtualRow.size}px`,
              transform: `translateY(${virtualRow.start}px)`,
            }}
            className="absolute top-0 left-0 w-full grid grid-cols-7"
          >
            {chunked[virtualRow.index]?.map((a) => {
              return (
                <AlbumItem
                  key={a.id}
                  album={a}
                  onClick={() => {
                    void navigate({
                      to: "/app/albums/$albumId",
                      params: { albumId: a.id },
                    });
                  }}
                />
              );
            })}
          </div>
        ))}
      </div>
    </div>
  );
}

function LibraryScreen() {
  const albumsQuery = useQuery(albumsQueryOptions);

  return (
    <section className="flex h-full w-full flex-col">
      {albumsQuery.isLoading ? (
        <div className="m-6 rounded-xl border border-dashed border-border px-6 py-10 text-sm text-muted-foreground">
          Loading albums...
        </div>
      ) : null}

      {albumsQuery.isError ? (
        <div className="m-6">
          <Alert variant="destructive">
            <AlertTitle>Albums unavailable</AlertTitle>
            <AlertDescription>
              {getErrorMessage(albumsQuery.error, "The local album list could not be read.")}
            </AlertDescription>
          </Alert>
        </div>
      ) : null}

      {!albumsQuery.isLoading && !albumsQuery.isError && (albumsQuery.data?.length ?? 0) === 0 ? (
        <div className="m-6 flex flex-col items-center justify-center gap-3 rounded-2xl border border-dashed border-border bg-muted/40 px-6 py-14">
          <div className="flex size-12 items-center justify-center rounded-2xl bg-primary/10 text-primary">
            <Disc3 className="size-5" />
          </div>
          <div className="space-y-1">
            <p className="font-medium">No albums in the local database yet.</p>
            <p className="text-sm text-muted-foreground">
              Use the server control in the sidebar to fetch your server library.
            </p>
          </div>
        </div>
      ) : null}

      {!albumsQuery.isLoading && !albumsQuery.isError && (albumsQuery.data?.length ?? 0) > 0 ? (
        <AlbumList albums={albumsQuery.data ?? []} />
      ) : null}
    </section>
  );
}

function AlbumCover({
  coverArtPath,
  title,
}: {
  albumId: string;
  coverArtPath: string | null;
  title: string;
}) {
  const [imageFailed, setImageFailed] = useState(false);
  const coverSrc = coverArtPath ? toCoverArtUrl(coverArtPath) : null;

  const [loadedSrc, setLoadedSrc] = useState<string | null>(null);

  useEffect(() => {
    if (!coverSrc) return;
    let cancelled = false;
    const img = new Image();
    img.src = coverSrc;
    img.onload = () => {
      if (!cancelled) setLoadedSrc(coverSrc);
    };

    return () => {
      cancelled = true;
    };
  }, [coverSrc]);

  return (
    <div className="relative aspect-square overflow-hidden rounded">
      {!imageFailed && loadedSrc ? (
        <img
          src={loadedSrc}
          alt={`${title} cover art`}
          className="size-full relative z-10 object-cover fade-in-0 animate-in"
          decoding="async"
          loading="lazy"
          onError={() => {
            setImageFailed(true);
          }}
        />
      ) : null}
      <div className="size-full absolute top-0 border border-border bg-muted "> </div>
    </div>
  );
}

function toCoverArtUrl(coverArtPath: string): string {
  return `muswag-cover://local?path=${encodeURIComponent(coverArtPath)}`;
}

function RouteComponent() {
  const userStateQuery = useQuery(userStateQueryOptions);

  if (!userStateQuery.data) {
    return <Navigate to="/" />;
  }

  return <LibraryScreen />;
}
