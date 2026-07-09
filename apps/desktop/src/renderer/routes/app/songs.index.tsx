import { useRef } from "react";

import { createFileRoute, Navigate, useElementScrollRestoration } from "@tanstack/react-router";
import { Disc3 } from "lucide-react";

import { Alert, AlertDescription, AlertTitle } from "#/components/ui/alert";

import { useVirtualizer } from "@tanstack/react-virtual";
import { useUser } from "#/lib/queries";
import { eq, useLiveQuery } from "@tanstack/react-db";
import { db } from "#/lib/db-renderer";
import type { Song } from "@muswag/shared";
import { AlbumCover } from "#/components/album-cover";

export const Route = createFileRoute("/app/songs/")({
  component: RouteComponent,
});

function SongLine({ song, index }: { song: Song; index: number }) {
  const cover = useLiveQuery((q) =>
    q
      .from({ album: db.albums })
      .where((a) => eq(a.album.id, song.albumId))
      .findOne()
      .select((v) => ({
        cover: v.album.coverArtPath,
      })),
  );

  return (
    <div className="grid px-4 grid-cols-[40px_64px_1fr_1fr_48px] gap-4 w-full h-12 items-center">
      <div className="text-muted-foreground text-xs font-mono text-center">{index + 1}</div>
      <div className="w-10 h-10">
        <AlbumCover coverArtPath={cover.data?.cover} />
      </div>
      <div className="flex flex-col overflow-hidden">
        <div className="truncate text-sm">{song.title}</div>
        <div className="truncate text-xs text-muted-foreground">{song.artist}</div>
      </div>
      <div className="text-sm text-muted-foreground">{song.album}</div>
      <div className="text-xs text-muted-foreground">{song.duration}</div>
    </div>
  );
}

function SongsList({ songs, scrollId }: { songs: Song[]; scrollId: string }) {
  const parentRef = useRef<HTMLDivElement>(null);

  const scrollRestorationId = "song-list-" + scrollId;
  const scrollEntry = useElementScrollRestoration({
    id: "album-list-" + scrollId,
  });

  const SIZE = 48;

  const rowVirtualizer = useVirtualizer({
    count: songs.length,
    getScrollElement: () => parentRef.current,
    estimateSize: () => SIZE,
    overscan: 10,
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
            className="absolute top-0 left-0 w-full flex z-5"
          >
            <SongLine index={virtualRow.index} song={songs[virtualRow.index]!} />
          </div>
        ))}
      </div>
    </div>
  );
}

function LibraryScreen() {
  const songsQuery = useLiveQuery((q) => q.from({ songs: db.songs }));

  return (
    <section className="flex h-full w-full flex-col">
      {songsQuery.isLoading ? (
        <div className="m-6 rounded-xl border border-dashed border-border px-6 py-10 text-sm text-muted-foreground">Loading albums...</div>
      ) : null}

      {songsQuery.isError ? (
        <div className="m-6">
          <Alert variant="destructive">
            <AlertTitle>Albums unavailable</AlertTitle>
            <AlertDescription>{"The local album list could not be read."}</AlertDescription>
          </Alert>
        </div>
      ) : null}

      {!songsQuery.isLoading && !songsQuery.isError && (songsQuery.data?.length ?? 0) === 0 ? (
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

      {!songsQuery.isLoading && !songsQuery.isError && (songsQuery.data?.length ?? 0) > 0 ? (
        <SongsList songs={songsQuery.data ?? []} scrollId="library-screen-songs" />
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
