import { createFileRoute, Navigate, useNavigate } from "@tanstack/react-router";

import { Alert, AlertDescription, AlertTitle } from "#/components/ui/alert";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "#/components/ui/table";
import { albumsQueryOptions, userStateQueryOptions } from "#/lib/app-state";
import { useQuery } from "@tanstack/react-query";
import { ChevronRight, Disc3 } from "lucide-react";
import { getErrorMessage } from "#/lib/err";

export const Route = createFileRoute("/app/albums/")({
  component: RouteComponent,
});

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
        <div className="min-h-0 flex-1 overflow-auto border-y border-border/80 bg-background/80">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Artist</TableHead>
                <TableHead>Album</TableHead>
                <TableHead>Year</TableHead>
                <TableHead>Songs</TableHead>
                <TableHead>Genre</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {albumsQuery.data?.map((album) => (
                <TableRow
                  key={album.id}
                  className="cursor-pointer"
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
                  <TableCell className="font-medium">{album.artist ?? "Unknown artist"}</TableCell>
                  <TableCell className="font-medium text-foreground">
                    <div className="flex items-center justify-between gap-3">
                      <span className="truncate">{album.name}</span>
                      <ChevronRight className="size-4 text-muted-foreground" />
                    </div>
                  </TableCell>
                  <TableCell>{album.year ?? "-"}</TableCell>
                  <TableCell>{album.songCount}</TableCell>
                  <TableCell>{album.genre ?? "-"}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      ) : null}
    </section>
  );
}

function RouteComponent() {
  const userStateQuery = useQuery(userStateQueryOptions);

  if (!userStateQuery.data || userStateQuery.data.status === "logged_out") {
    return <Navigate to="/" />;
  }

  return <LibraryScreen />;
}
