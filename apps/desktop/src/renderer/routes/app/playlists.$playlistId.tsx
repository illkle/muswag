import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useMutation } from "@tanstack/react-query";
import { PencilSimpleIcon, PlaylistIcon, TrashIcon, XIcon } from "@phosphor-icons/react";
import { useMemo, useState } from "react";

import { PlaylistFormDialog } from "#/components/playlist/playlist-form-dialog";
import { PlaylistDeleteDialog } from "#/components/playlist/playlist-delete-dialog";
import { usePlayerCurrentIndex, usePlayerQueueContext, usePlayerStatus } from "#/components/player-provider";
import { SongListRoot, SongRenderPlaylist } from "#/components/song-list";
import { Alert, AlertDescription, AlertTitle } from "#/components/ui/alert";
import { Badge } from "#/components/ui/badge";
import { Button } from "#/components/ui/button";
import { getErrorMessage } from "#/lib/err";
import { PlayerIPC } from "#/lib/ipc";
import { PlaylistActions } from "#/lib/playlist-actions";
import { buildPlayQueue, currentPlaylistEntryId, totalDuration, usePlaylist } from "#/lib/playlist-queries";
import type { Song } from "@muswag/shared";
import { usePlaylistSongStatsRefresh } from "#/lib/stats-refresh";

export const Route = createFileRoute("/app/playlists/$playlistId")({
  component: RouteComponent,
});

function formatDuration(totalSeconds: number): string {
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;

  if (hours > 0) {
    return `${hours}:${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
  }
  return `${minutes}:${String(seconds).padStart(2, "0")}`;
}

function PlaylistScreen({ playlistId }: { playlistId: string }) {
  const navigate = useNavigate();
  const { record, state, rows, isLoading, isError } = usePlaylist(playlistId);
  usePlaylistSongStatsRefresh(record?.serverId ?? null);
  const playerStatus = usePlayerStatus();
  const playerQueueContext = usePlayerQueueContext();
  const playerIndex = usePlayerCurrentIndex();
  const [editOpen, setEditOpen] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);

  const { queue, queueIndexByEntryId } = useMemo(() => buildPlayQueue(rows), [rows]);

  const playingRowKey = currentPlaylistEntryId(playerQueueContext, playlistId, playerIndex);

  const removeEntryMutation = useMutation({
    mutationFn: (entryId: string) => PlaylistActions.removeEntry(playlistId, entryId),
  });
  const songs = useMemo(
    // Unavailable entries still need a row, so stand in a minimal song carrying the raw id.
    (): Song[] => rows.map(({ songId, song }) => song ?? { id: songId, title: songId, isDir: false }),
    [rows],
  );
  const rowKeys = useMemo(() => rows.map(({ entryId }) => entryId), [rows]);
  const unavailableRowKeys = useMemo(() => new Set(rows.flatMap(({ entryId, song }) => (song ? [] : [entryId]))), [rows]);

  if (isLoading) {
    return (
      <section className="flex h-full w-full flex-col">
        <div className="m-6 rounded-2xl border border-dashed border-border bg-card/70 px-6 py-12 text-sm text-muted-foreground">
          Loading playlist...
        </div>
      </section>
    );
  }

  if (isError) {
    return (
      <section className="flex h-full w-full flex-col">
        <div className="m-6">
          <Alert variant="destructive">
            <AlertTitle>Playlist unavailable</AlertTitle>
            <AlertDescription>The playlist could not be read from the local database.</AlertDescription>
          </Alert>
        </div>
      </section>
    );
  }

  if (!state) {
    return (
      <section className="flex h-full w-full flex-col">
        <div className="m-6 flex flex-col items-center justify-center gap-3 rounded-2xl border border-border/70 bg-card/85 px-6 py-14 text-center">
          <div className="flex size-12 items-center justify-center rounded-2xl bg-primary/10 text-primary">
            <PlaylistIcon className="size-5" />
          </div>
          <div className="space-y-1">
            <p className="font-medium">Playlist not found.</p>
            <p className="text-sm text-muted-foreground">It may have been deleted on another device.</p>
          </div>
        </div>
      </section>
    );
  }

  const missingCount = rows.length - queue.length;
  const canEdit = !state.readonly;

  const onPlay = (_song: Song, index: number) => {
    const entryId = rows[index]?.entryId;
    const queueIndex = entryId === undefined ? undefined : queueIndexByEntryId.get(entryId);
    if (queueIndex === undefined) return;

    void PlayerIPC.playQueue({
      queue,
      startIndex: queueIndex,
      context: { type: "playlist", playlistId, entryIds: [...queueIndexByEntryId.keys()] },
    });
  };

  return (
    <section className="flex h-full w-full flex-col">
      <header className="border-b border-border/70 bg-card/80 px-4 py-5 md:px-6">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <p className="text-sm text-muted-foreground">Playlist</p>
              {state.readonly ? <Badge variant="secondary">Read-only</Badge> : null}
            </div>
            <h1 className="mt-1 truncate text-2xl font-semibold tracking-tight md:text-3xl">{state.name}</h1>
            <p className="mt-2 text-sm text-muted-foreground">
              {rows.length} {rows.length === 1 ? "song" : "songs"} • {formatDuration(totalDuration(rows))}
              {state.readonly && state.owner ? ` • by ${state.owner}` : ""}
            </p>
            {state.comment ? <p className="mt-1 text-sm text-muted-foreground">{state.comment}</p> : null}
          </div>

          <div className="flex shrink-0 gap-2">
            <Button
              disabled={queue.length === 0}
              onClick={() =>
                void PlayerIPC.playQueue({
                  queue,
                  startIndex: 0,
                  context: { type: "playlist", playlistId, entryIds: [...queueIndexByEntryId.keys()] },
                })
              }
            >
              Play
            </Button>
            {canEdit ? (
              <>
                <Button variant="secondary" size="icon" aria-label="Edit playlist" onClick={() => setEditOpen(true)}>
                  <PencilSimpleIcon className="size-4" />
                </Button>
                <Button variant="destructive" size="icon" aria-label="Delete playlist" onClick={() => setDeleteOpen(true)}>
                  <TrashIcon className="size-4" />
                </Button>
              </>
            ) : null}
          </div>
        </div>

        {missingCount > 0 ? (
          <p className="mt-3 text-xs text-muted-foreground">
            {missingCount} {missingCount === 1 ? "song is" : "songs are"} not in your synced library and will be skipped during playback.
          </p>
        ) : null}

        {removeEntryMutation.isError ? (
          <p className="mt-2 text-xs text-destructive">{getErrorMessage(removeEntryMutation.error, "The song could not be removed.")}</p>
        ) : null}
      </header>

      <div className="min-h-0 flex-1">
        {rows.length === 0 ? (
          <div className="m-6 rounded-2xl border border-dashed border-border bg-muted/40 px-6 py-14 text-center text-sm text-muted-foreground">
            This playlist is empty. Add songs from any album or the songs list.
          </div>
        ) : (
          <SongListRoot
            songs={songs}
            rowKeys={rowKeys}
            unavailableRowKeys={unavailableRowKeys}
            playingRowKey={playingRowKey}
            onSongPlay={onPlay}
            currentTrackID={null}
            playerStatus={playerStatus}
            SongComponent={SongRenderPlaylist}
            scrollId={"playlist-" + playlistId}
            rowActions={(_song, index) => {
              const entryId = rows[index]?.entryId;
              if (!canEdit || entryId === undefined) return null;

              return (
                <button
                  type="button"
                  aria-label="Remove from playlist"
                  className="inline-flex size-6 items-center justify-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground"
                  onClick={(event) => {
                    event.stopPropagation();
                    removeEntryMutation.mutate(entryId);
                  }}
                >
                  <XIcon className="size-3.5" />
                </button>
              );
            }}
          />
        )}
      </div>

      <PlaylistFormDialog
        open={editOpen}
        onOpenChange={setEditOpen}
        title="Playlist details"
        submitLabel="Save"
        initialValues={{ name: state.name, comment: state.comment, public: state.public }}
        onSubmit={async ({ name, comment, public: isPublic }) => {
          if (name.trim() !== state.name) await PlaylistActions.rename(playlistId, name);
          if (comment !== state.comment) await PlaylistActions.setComment(playlistId, comment);
          if (isPublic !== state.public) await PlaylistActions.setVisibility(playlistId, isPublic);
        }}
      />

      <PlaylistDeleteDialog
        open={deleteOpen}
        onOpenChange={setDeleteOpen}
        playlistName={state.name}
        onConfirm={() => PlaylistActions.remove(playlistId)}
        onDeleted={() => void navigate({ to: "/app/playlists" })}
      />
    </section>
  );
}

function RouteComponent() {
  const { playlistId } = Route.useParams();
  return <PlaylistScreen playlistId={playlistId} />;
}
