import { useState } from "react";

import { useQuery } from "@tanstack/react-query";
import { createFileRoute, Navigate, useNavigate } from "@tanstack/react-router";
import { Disc3 } from "lucide-react";

import { Alert, AlertDescription, AlertTitle } from "#/components/ui/alert";
import { albumsQueryOptions, userStateQueryOptions } from "#/lib/app-state";
import { getErrorMessage } from "#/lib/err";
import type { AlbumRecord } from "@muswag/db";

export const Route = createFileRoute("/app/albums/")({
  component: RouteComponent,
});

function AlbumList({ albums }: { albums: AlbumRecord[] }) {
  const navigate = useNavigate();
  return (
    <div className="grid grid-cols-6 gap-2 p-2 items-start justify-start ">
      {albums?.map((album) => (
        <button
          key={album.id}
          className="cursor-pointer text-left flex flex-col p-1 justify-start align-bottom hover:bg-accent rounded transition"
          tabIndex={0}
          onClick={() => {
            void navigate({
              to: "/app/albums/$albumId",
              params: { albumId: album.id },
            });
          }}
        >
          <AlbumCover
            albumId={album.id}
            artist={album.artist ?? album.displayArtist ?? "Unknown artist"}
            coverArtPath={album.coverArtPath}
            title={album.name}
          />

          <p className="truncate text-xs mt-2 line-clamp-2">
            {album.artist ?? album.displayArtist ?? "Unknown artist"}
          </p>
          <h2 className="line-clamp-2 text-xs font-semibold">{album.name}</h2>
          <p className="text-xs text-muted-foreground">{album.year}</p>
        </button>
      ))}
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
  albumId,
  artist,
  coverArtPath,
  title,
}: {
  albumId: string;
  artist: string;
  coverArtPath: string | null;
  title: string;
}) {
  const [imageFailed, setImageFailed] = useState(false);
  const coverSrc = coverArtPath ? toCoverArtUrl(coverArtPath) : null;

  return (
    <div className="relative aspect-square overflow-hidden rounded">
      {coverSrc && !imageFailed ? (
        <img
          src={coverSrc}
          alt={`${title} cover art`}
          className="size-full object-cover"
          loading="lazy"
          onError={() => {
            setImageFailed(true);
          }}
        />
      ) : null}

      {!coverSrc || imageFailed ? (
        <div
          className={`flex size-full flex-col justify-between p-5 text-white`}
          aria-hidden="true"
        >
          <Disc3 className="size-8 opacity-85" />
          <div>
            <p className="line-clamp-2 text-lg font-semibold">{title}</p>
            <p className="mt-1 text-sm text-white/80">{artist}</p>
          </div>
        </div>
      ) : null}
    </div>
  );
}

function hashValue(value: string): number {
  let hash = 0;

  for (const character of value) {
    hash = (hash << 5) - hash + character.charCodeAt(0);
    hash |= 0;
  }

  return hash;
}

function toCoverArtUrl(coverArtPath: string): string {
  return `muswag-cover://local?path=${encodeURIComponent(coverArtPath)}`;
}

function RouteComponent() {
  const userStateQuery = useQuery(userStateQueryOptions);

  if (!userStateQuery.data || userStateQuery.data.status === "logged_out") {
    return <Navigate to="/" />;
  }

  return <LibraryScreen />;
}
