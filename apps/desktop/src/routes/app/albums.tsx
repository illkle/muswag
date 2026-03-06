import { createFileRoute, Navigate } from "@tanstack/react-router";

import { Alert, AlertDescription, AlertTitle } from "#/components/ui/alert";
import { Badge } from "#/components/ui/badge";
import { Button } from "#/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "#/components/ui/card";
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarHeader,
  SidebarInset,
  SidebarProvider,
} from "#/components/ui/sidebar";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "#/components/ui/table";
import { albumsQueryOptions, userStateQueryOptions } from "#/lib/app-state";
import { SM } from "#/lib/db";
import { useMutation, useQuery } from "@tanstack/react-query";
import { CloudDownload, Disc3, LibraryBig, LogOut, RefreshCcw } from "lucide-react";
import { getErrorMessage } from "#/lib/err";

export const Route = createFileRoute("/app/albums")({
  component: RouteComponent,
});

function LibraryScreen({ url, username }: { url: string; username: string }) {
  const albumsQuery = useQuery(albumsQueryOptions);

  return (
    <section className="mx-auto flex w-full max-w-6xl flex-col gap-6 px-5 py-6 md:px-8 md:py-8">
      <Card className="border-0 bg-card/85 shadow-xl shadow-primary/5 backdrop-blur">
        <CardHeader className="gap-3 md:flex-row md:items-center md:justify-between">
          <div>
            <CardTitle className="flex items-center gap-2">
              <CloudDownload className="size-5" />
              Album library
            </CardTitle>
            <CardDescription>
              Browse the albums currently stored in the local database.
            </CardDescription>
          </div>
          <div className="flex items-center gap-2">
            <Badge variant="outline">{albumsQuery.data?.length ?? 0} albums</Badge>
            <Badge variant="secondary">{username}</Badge>
          </div>
        </CardHeader>
        <CardContent>
          {albumsQuery.isLoading ? (
            <div className="rounded-xl border border-dashed border-border px-6 py-10 text-sm text-muted-foreground">
              Loading albums...
            </div>
          ) : null}

          {albumsQuery.isError ? (
            <Alert variant="destructive">
              <AlertTitle>Albums unavailable</AlertTitle>
              <AlertDescription>
                {getErrorMessage(albumsQuery.error, "The local album list could not be read.")}
              </AlertDescription>
            </Alert>
          ) : null}

          {!albumsQuery.isLoading &&
          !albumsQuery.isError &&
          (albumsQuery.data?.length ?? 0) === 0 ? (
            <div className="flex flex-col items-center justify-center gap-3 rounded-2xl border border-dashed border-border bg-muted/40 px-6 py-14 text-center">
              <div className="flex size-12 items-center justify-center rounded-2xl bg-primary/10 text-primary">
                <Disc3 className="size-5" />
              </div>
              <div className="space-y-1">
                <p className="font-medium">No albums in the local database yet.</p>
                <p className="text-sm text-muted-foreground">
                  Use the sync button in the sidebar to fetch your server library.
                </p>
              </div>
            </div>
          ) : null}

          {!albumsQuery.isLoading && !albumsQuery.isError && (albumsQuery.data?.length ?? 0) > 0 ? (
            <div className="overflow-hidden rounded-2xl border border-border/80 bg-background/80">
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
                    <TableRow key={album.id}>
                      <TableCell className="font-medium">
                        {album.artist ?? "Unknown artist"}
                      </TableCell>
                      <TableCell>{album.name}</TableCell>
                      <TableCell>{album.year ?? "-"}</TableCell>
                      <TableCell>{album.songCount}</TableCell>
                      <TableCell>{album.genre ?? "-"}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          ) : null}
        </CardContent>
      </Card>
    </section>
  );
}

function RouteComponent() {
  const userStateQuery = useQuery(userStateQueryOptions);

  if (!userStateQuery.data) {
    return <Navigate to="/" />;
  }

  return <LibraryScreen url={userStateQuery.data.url} username={userStateQuery.data.username} />;
}
