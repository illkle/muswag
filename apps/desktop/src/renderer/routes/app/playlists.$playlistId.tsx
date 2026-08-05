import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useMutation } from "@tanstack/react-query";
import { PencilSimpleIcon, PlayIcon, PlaylistIcon, TrashIcon } from "@phosphor-icons/react";
import { useMemo, useState } from "react";

import { DETAIL_BOTTOM_PADDING, DETAIL_TOP_PADDING, DetailHeader, DetailHeaderPlaceholder } from "#/components/detail-header";
import { PlaylistFormDialog } from "#/components/playlist/playlist-form-dialog";
import { PlaylistDeleteDialog } from "#/components/playlist/playlist-delete-dialog";
import { usePlayerCurrentIndex, usePlayerQueueContext, usePlayerStatus } from "#/components/player-provider";
import { SongListRoot, SongRenderPlaylist } from "#/components/song-list";
import { Alert, AlertDescription, AlertTitle } from "#/components/ui/alert";
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

function formatMetaLine(parts: Array<string | null | undefined>): string {
  return parts.filter((part): part is string => Boolean(part)).join(" • ");
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
        <div className="m-6 rounded-2xl border border-dashed border-border bg-card/70 px-6 py-12 text-sm text-muted-foreground">Loading playlist...</div>
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
  const playlistMeta = formatMetaLine([
    `${rows.length} song${rows.length === 1 ? "" : "s"}`,
    formatDuration(totalDuration(rows)),
    state.readonly && state.owner ? `by ${state.owner}` : null,
    state.readonly ? "read-only" : null,
  ]);

  const playFrom = (startIndex: number) =>
    void PlayerIPC.playQueue({
      queue,
      startIndex,
      context: { type: "playlist", playlistId, entryIds: [...queueIndexByEntryId.keys()] },
    });

  const onPlay = (_song: Song, index: number) => {
    const entryId = rows[index]?.entryId;
    const queueIndex = entryId === undefined ? undefined : queueIndexByEntryId.get(entryId);
    if (queueIndex === undefined) return;

    playFrom(queueIndex);
  };

  return (
    <section className="flex h-full w-full flex-col">
      <div className="min-h-0 flex-1">
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
          topPadding={DETAIL_TOP_PADDING}
          bottomPadding={DETAIL_BOTTOM_PADDING}
          topContent={
            <DetailHeader title={state.name} art={<DetailHeaderPlaceholder icon={<PlaylistIcon />} />}>
              <p className="text-sm text-muted-foreground">{playlistMeta}</p>
              {state.comment ? <p className="line-clamp-2 text-sm text-muted-foreground">{state.comment}</p> : null}
              {rows.length === 0 ? <p className="text-sm text-muted-foreground">Add songs from any album or the songs list.</p> : null}
              {missingCount > 0 ? (
                <p className="text-xs text-muted-foreground">
                  {missingCount} {missingCount === 1 ? "song is" : "songs are"} not in your synced library and will be skipped.
                </p>
              ) : null}
              {removeEntryMutation.isError ? <p className="text-xs text-destructive">{getErrorMessage(removeEntryMutation.error, "The song could not be removed.")}</p> : null}

              <div className="mt-2 flex items-center gap-1">
                <Button size="sm" disabled={queue.length === 0} onClick={() => playFrom(0)}>
                  <PlayIcon />
                  Play
                </Button>
                {canEdit ? (
                  <>
                    <Button variant="ghost" size="icon-sm" aria-label="Edit playlist" onClick={() => setEditOpen(true)}>
                      <PencilSimpleIcon />
                    </Button>
                    <Button
                      variant="ghost"
                      size="icon-sm"
                      aria-label="Delete playlist"
                      className="text-muted-foreground hover:bg-destructive/10 hover:text-destructive"
                      onClick={() => setDeleteOpen(true)}
                    >
                      <TrashIcon />
                    </Button>
                  </>
                ) : null}
              </div>
            </DetailHeader>
          }
        />
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
        onDeleted={() => void navigate({ to: "/app/albums" })}
      />
    </section>
  );
}

function RouteComponent() {
  const { playlistId } = Route.useParams();
  return <PlaylistScreen playlistId={playlistId} />;
}
