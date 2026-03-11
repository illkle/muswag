import { useState } from "react";

import { useQuery } from "@tanstack/react-query";
import { createFileRoute, Navigate, useNavigate } from "@tanstack/react-router";
import { Disc3, Sparkles } from "lucide-react";

import { Alert, AlertDescription, AlertTitle } from "#/components/ui/alert";
import { Badge } from "#/components/ui/badge";
import { Card, CardContent } from "#/components/ui/card";
import { albumsQueryOptions, userStateQueryOptions } from "#/lib/app-state";
import { getErrorMessage } from "#/lib/err";

export const Route = createFileRoute("/app/albums/")({
  component: RouteComponent,
});

const coverPlaceholderTones = [
  "bg-[linear-gradient(145deg,#22150f,#c7673c)]",
  "bg-[linear-gradient(145deg,#0f1a22,#3b8ea5)]",
  "bg-[linear-gradient(145deg,#1d1424,#9d5bd2)]",
  "bg-[linear-gradient(145deg,#162213,#78a94d)]",
] as const;

function LibraryScreen() {
  const albumsQuery = useQuery(albumsQueryOptions);
  const navigate = useNavigate();

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
        <div className="m-6 flex flex-col items-center justify-center gap-3 rounded-2xl border border-dashed border-border bg-muted/40 px-6 py-14 text-center">
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
        <div className="min-h-0 flex-1 overflow-auto bg-[radial-gradient(circle_at_top,rgba(199,103,60,0.14),transparent_34%),linear-gradient(180deg,rgba(255,255,255,0.96),rgba(246,241,235,0.92))] px-6 py-6 dark:bg-[radial-gradient(circle_at_top,rgba(199,103,60,0.2),transparent_34%),linear-gradient(180deg,rgba(25,21,18,0.98),rgba(18,16,14,0.98))]">
          <div className="mx-auto flex max-w-7xl flex-col gap-6">
            <div className="rounded-[28px] border border-border/60 bg-card/80 p-5 shadow-sm backdrop-blur">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div>
                  <p className="text-xs font-medium uppercase tracking-[0.24em] text-muted-foreground">
                    Synced library
                  </p>
                  <h1 className="mt-1 text-2xl font-semibold tracking-tight">Albums</h1>
                </div>
                <Badge className="rounded-full px-3 py-1 text-xs">
                  <Sparkles className="size-3.5" />
                  {albumsQuery.data?.length} releases
                </Badge>
              </div>
            </div>

            <div className="grid grid-cols-1 gap-5 sm:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-4">
              {albumsQuery.data?.map((album) => (
                <Card
                  key={album.id}
                  className="cursor-pointer gap-0 overflow-hidden rounded-[28px] border border-border/60 bg-card/85 py-0 shadow-sm transition duration-200 hover:-translate-y-1 hover:shadow-xl focus-within:ring-2 focus-within:ring-ring/50"
                  tabIndex={0}
                  onClick={() => {
                    void navigate({
                      to: "/app/albums/$albumId",
                      params: { albumId: album.id },
                    });
                  }}
                  onKeyDown={(event) => {
                    if (event.key === "Enter" || event.key === " ") {
                      event.preventDefault();
                      void navigate({
                        to: "/app/albums/$albumId",
                        params: { albumId: album.id },
                      });
                    }
                  }}
                >
                  <AlbumCover
                    albumId={album.id}
                    artist={album.artist ?? album.displayArtist ?? "Unknown artist"}
                    coverArtPath={album.coverArtPath}
                    title={album.name}
                  />

                  <CardContent className="space-y-4 p-5">
                    <div className="space-y-1">
                      <p className="truncate text-xs font-medium uppercase tracking-[0.22em] text-muted-foreground">
                        {album.artist ?? album.displayArtist ?? "Unknown artist"}
                      </p>
                      <h2 className="line-clamp-2 text-xl font-semibold tracking-tight text-foreground">
                        {album.name}
                      </h2>
                    </div>

                    <div className="flex flex-wrap gap-2">
                      <Badge variant="secondary" className="rounded-full px-2.5 py-1">
                        {album.songCount} track{album.songCount === 1 ? "" : "s"}
                      </Badge>
                      {album.year ? (
                        <Badge variant="secondary" className="rounded-full px-2.5 py-1">
                          {album.year}
                        </Badge>
                      ) : null}
                      {album.genre ? (
                        <Badge variant="outline" className="rounded-full px-2.5 py-1">
                          {album.genre}
                        </Badge>
                      ) : null}
                    </div>
                  </CardContent>
                </Card>
              ))}
            </div>
          </div>
        </div>
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
  const placeholderTone = coverPlaceholderTones[Math.abs(hashValue(albumId)) % coverPlaceholderTones.length];
  const coverSrc = coverArtPath ? toCoverArtUrl(coverArtPath) : null;

  return (
    <div className="relative aspect-square overflow-hidden">
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
          className={`flex size-full flex-col justify-between ${placeholderTone} p-5 text-white`}
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
    hash = ((hash << 5) - hash) + character.charCodeAt(0);
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
