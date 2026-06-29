import { startTransition, useEffect, useMemo, useRef, useState } from "react";

import { createFileRoute, Navigate, useElementScrollRestoration, useNavigate } from "@tanstack/react-router";
import { Disc3 } from "lucide-react";

import { Alert, AlertDescription, AlertTitle } from "#/components/ui/alert";

import { useVirtualizer } from "@tanstack/react-virtual";
import { chunk } from "lodash-es";
import { useContentSize } from "#/components/app-content-size";
import { AlbumCover } from "#/components/album-cover";
import { useUser } from "#/lib/queries";
import { useLiveQuery } from "@tanstack/react-db";
import { db } from "#/lib/db-renderer";
import type { Album } from "@muswag/shared";

export const Route = createFileRoute("/app/albums/")({
  component: RouteComponent,
});

const AlbumItem = ({
  album,
  instantCovers,
  ...props
}: {
  album: Album;
  instantCovers: boolean;
} & React.ButtonHTMLAttributes<HTMLButtonElement>) => {
  return (
    <button
      key={album.id}
      className="cursor-pointer text-left flex w-full  flex-col p-1 justify-start align-bottom hover:bg-accent rounded transition"
      tabIndex={0}
      {...props}
    >
      <AlbumCover coverArtPath={album.coverArtPath} instantLoad={instantCovers} />

      <p className="truncate text-xs line-clamp-1 mt-2">{album.artist ?? album.displayArtist ?? "Unknown artist"}</p>
      <h2 className="line-clamp-2 text-xs font-semibold">{album.name}</h2>
      <p className="text-xs line-clamp-1 text-muted-foreground">{album.year}</p>
    </button>
  );
};

const calcSize = (totalSpace: number) => {
  const chunks = Math.floor(totalSpace / 150);

  const fullWidth = totalSpace / chunks;
  const paddings = 8;
  const coverSize = fullWidth - paddings;
  const textSize = 64;
  const fullHeight = textSize + 16 + coverSize + paddings;

  return { fullWidth, fullHeight, chunks };
};

function AlbumList({ albums, scrollId }: { albums: Album[]; scrollId: string }) {
  const parentRef = useRef<HTMLDivElement | null>(null);
  const navigate = useNavigate();

  const scrollRestorationId = "album-list-" + scrollId;
  const scrollEntry = useElementScrollRestoration({
    id: scrollRestorationId,
  });

  const s = useContentSize();

  const sizes = useMemo(() => calcSize(s.width ?? 600), [s.width]);

  const chunked = useMemo(() => chunk(albums, sizes.chunks), [albums, sizes.chunks]);

  const [instantCovers, setInstantCovers] = useState(true);

  useEffect(() => {
    startTransition(() => {
      setInstantCovers(false);
    });
  });

  const rowVirtualizer = useVirtualizer({
    count: chunked.length,
    getScrollElement: () => parentRef.current,
    estimateSize: () => sizes.fullHeight,
    overscan: 4,
    initialOffset: scrollEntry?.scrollY,
  });

  return (
    <div ref={parentRef} data-scroll-restoration-id={scrollRestorationId} className="overflow-y-auto">
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
            className="absolute top-0 left-0 w-full flex"
          >
            {chunked[virtualRow.index]?.map((a) => {
              return (
                <AlbumItem
                  key={a.id}
                  instantCovers={instantCovers}
                  album={a}
                  style={{
                    width: `${sizes.fullWidth}px`,
                    height: `${sizes.fullHeight}px`,
                  }}
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
  const albumsQuery = useLiveQuery((q) => q.from({ albums: db.albums }).orderBy((v) => v.albums.year, { direction: "desc" }));

  return (
    <section className="flex h-full w-full flex-col">
      {albumsQuery.isLoading ? (
        <div className="m-6 rounded-xl border border-dashed border-border px-6 py-10 text-sm text-muted-foreground">Loading albums...</div>
      ) : null}

      {albumsQuery.isError ? (
        <div className="m-6">
          <Alert variant="destructive">
            <AlertTitle>Albums unavailable</AlertTitle>
            <AlertDescription>{"The local album list could not be read."}</AlertDescription>
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
            <p className="text-sm text-muted-foreground">Use the server control in the sidebar to fetch your server library.</p>
          </div>
        </div>
      ) : null}

      {!albumsQuery.isLoading && !albumsQuery.isError && (albumsQuery.data?.length ?? 0) > 0 ? (
        <AlbumList albums={albumsQuery.data ?? []} scrollId="library-screen-albums" />
      ) : null}
    </section>
  );
}

function RouteComponent() {
  const userStateQuery = useUser();

  if (!userStateQuery.data) {
    return <Navigate to="/" />;
  }

  return <LibraryScreen />;
}
