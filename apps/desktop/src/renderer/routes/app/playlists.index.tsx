import { createFileRoute, Link, Navigate } from "@tanstack/react-router";
import { ArrowsClockwiseIcon, PlaylistIcon, PlusIcon, SpinnerGapIcon } from "@phosphor-icons/react";
import { useState } from "react";

import { PlaylistFormDialog } from "#/components/playlist/playlist-form-dialog";
import { Alert, AlertDescription, AlertTitle } from "#/components/ui/alert";
import { Badge } from "#/components/ui/badge";
import { Button } from "#/components/ui/button";
import { getErrorMessage } from "#/lib/err";
import { PlaylistActions } from "#/lib/playlist-actions";
import { usePlaylists } from "#/lib/playlist-queries";
import { usePlaylistSyncStatus, useUser } from "#/lib/queries";
import { useMutation } from "@tanstack/react-query";

export const Route = createFileRoute("/app/playlists/")({
  component: RouteComponent,
});

function PlaylistsScreen() {
  const { playlists, isLoading, isError } = usePlaylists();
  const syncStatus = usePlaylistSyncStatus();
  const [createOpen, setCreateOpen] = useState(false);

  const syncMutation = useMutation({
    mutationFn: () => PlaylistActions.syncNow(),
  });

  const syncing = syncStatus.state === "syncing" || syncMutation.isPending;

  return (
    <section className="flex h-full w-full flex-col">
      <header className="flex items-center justify-between gap-3 border-b border-border/70 bg-card/80 px-4 py-5 md:px-6">
        <div className="min-w-0">
          <h1 className="text-2xl font-semibold tracking-tight md:text-3xl">Playlists</h1>
          {/* The retry path reports "scheduled" while still holding the failure, so key off `error`. */}
          {syncStatus.error ? <p className="mt-1 text-xs text-destructive">Sync problem: {syncStatus.error}</p> : null}
        </div>

        <div className="flex shrink-0 gap-2">
          <Button variant="secondary" disabled={syncing} onClick={() => syncMutation.mutate()}>
            {syncing ? <SpinnerGapIcon className="size-4 animate-spin" /> : <ArrowsClockwiseIcon className="size-4" />}
            {syncing ? "Syncing" : "Sync"}
          </Button>
          <Button onClick={() => setCreateOpen(true)}>
            <PlusIcon className="size-4" />
            New playlist
          </Button>
        </div>
      </header>

      {isLoading ? (
        <div className="m-6 rounded-xl border border-dashed border-border px-6 py-10 text-sm text-muted-foreground">
          Loading playlists...
        </div>
      ) : null}

      {isError ? (
        <div className="m-6">
          <Alert variant="destructive">
            <AlertTitle>Playlists unavailable</AlertTitle>
            <AlertDescription>The local playlist list could not be read.</AlertDescription>
          </Alert>
        </div>
      ) : null}

      {!isLoading && !isError && playlists.length === 0 ? (
        <div className="m-6 flex flex-col items-center justify-center gap-3 rounded-2xl border border-dashed border-border bg-muted/40 px-6 py-14">
          <div className="flex size-12 items-center justify-center rounded-2xl bg-primary/10 text-primary">
            <PlaylistIcon className="size-5" />
          </div>
          <div className="space-y-1 text-center">
            <p className="font-medium">No playlists yet.</p>
            <p className="text-sm text-muted-foreground">Create one here, or add songs to a playlist from any album.</p>
          </div>
        </div>
      ) : null}

      {!isLoading && !isError && playlists.length > 0 ? (
        <div className="min-h-0 flex-1 overflow-y-auto p-4 md:p-6">
          <ul className="flex flex-col gap-1">
            {playlists.map((playlist) => (
              <li key={playlist.id}>
                <Link
                  to="/app/playlists/$playlistId"
                  params={{ playlistId: playlist.id }}
                  preload="intent"
                  className="flex items-center gap-3 rounded-lg px-3 py-2.5 transition-colors hover:bg-muted/40"
                >
                  <div className="flex size-10 shrink-0 items-center justify-center rounded-md bg-muted text-muted-foreground">
                    <PlaylistIcon className="size-4" />
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <span className="truncate font-medium">{playlist.name}</span>
                      {playlist.readonly ? <Badge variant="secondary">Read-only</Badge> : null}
                      {playlist.localOnly ? <Badge variant="secondary">Not synced</Badge> : null}
                    </div>
                    <div className="truncate text-xs text-muted-foreground">
                      {playlist.songCount} {playlist.songCount === 1 ? "song" : "songs"}
                      {playlist.comment ? ` • ${playlist.comment}` : ""}
                      {playlist.readonly && playlist.owner ? ` • by ${playlist.owner}` : ""}
                    </div>
                  </div>
                </Link>
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      {syncMutation.isError ? (
        <div className="px-6 pb-4 text-xs text-destructive">
          {getErrorMessage(syncMutation.error, "The playlists could not be synced.")}
        </div>
      ) : null}

      <PlaylistFormDialog
        open={createOpen}
        onOpenChange={setCreateOpen}
        title="New playlist"
        submitLabel="Create"
        onSubmit={async ({ name, comment, public: isPublic }) => {
          const created = await PlaylistActions.create({ name });
          if (comment) await PlaylistActions.setComment(created.id, comment);
          if (isPublic) await PlaylistActions.setVisibility(created.id, true);
        }}
      />
    </section>
  );
}

function RouteComponent() {
  const userStateQuery = useUser();

  if (!userStateQuery.data) {
    return <Navigate to="/" />;
  }

  return <PlaylistsScreen />;
}
