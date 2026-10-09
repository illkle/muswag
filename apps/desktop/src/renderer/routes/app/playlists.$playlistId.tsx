import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useMutation } from "@tanstack/react-query";
import { PencilSimpleIcon, PlayIcon, PlaylistIcon, TrashIcon, WarningIcon } from "@phosphor-icons/react";
import { useMemo, useState } from "react";

import { DETAIL_BOTTOM_PADDING, DETAIL_TOP_PADDING, DetailHeader } from "#/components/detail-header";
import { PageState } from "#/components/page-state";
import { PlaylistArt } from "#/components/playlist/playlist-art";
import { PlaylistFormDialog } from "#/components/playlist/playlist-form-dialog";
import { PlaylistDeleteDialog } from "#/components/playlist/playlist-delete-dialog";
import { QueueActions, useQueueManagerState } from "#/queue/queue";
import { PlaylistActions } from "#/playlists/actions";
import { totalDuration } from "#/playlists/rows";
import { usePlaylist } from "#/playlists/queries";
import { usePlaylistSongStatsRefresh } from "#/library/stats-refresh";
import { libraryColumns } from "#/components/track-list/columns";
import { TrackList } from "#/components/track-list/track-list";
import { TrackMenuAddItems } from "#/components/track-list/track-menu";
import type { TrackListItem, TrackSelection } from "#/components/track-list/types";
import { Button } from "#/components/ui/button";
import { ContextMenuItem, ContextMenuSeparator } from "#/components/ui/context-menu";
import { getErrorMessage } from "#/lib/err";
import { formatDuration, formatMetaLine } from "#/lib/format";
import { songRow, playlistOccurrenceKey } from "@muswag/model";

export const Route = createFileRoute("/app/playlists/$playlistId")({
  component: RouteComponent,
});

function PlaylistScreen({ playlistId }: { playlistId: string }) {
  const navigate = useNavigate();
  const { record, state, rows, isLoading, isError } = usePlaylist(playlistId);
  usePlaylistSongStatsRefresh(record?.serverId ?? null);
  const queueState = useQueueManagerState();
  const [editOpen, setEditOpen] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);

  const firstPlayableEntryId = useMemo(() => rows.find(({ song }) => song)?.entryId ?? null, [rows]);
  /** The first four albums the playlist draws on, for its artwork. */
  const artAlbumIds = useMemo(() => [...new Set(rows.flatMap(({ song }) => (song?.albumId ? [song.albumId] : [])))].slice(0, 4), [rows]);

  const playingKey = queueState.source?.ref.type === "playlist" && queueState.source.ref.playlistId === playlistId && queueState.nowPlaying?.origin === "source" ? queueState.nowPlaying.key : null;

  const removeEntriesMutation = useMutation({
    mutationFn: async (entryIds: readonly string[]) => {
      for (const entryId of entryIds) await PlaylistActions.removeEntry(playlistId, entryId);
    },
  });
  const items = useMemo(
    (): TrackListItem[] =>
      rows.map(({ entryId, songId, song }) => ({
        type: "track",
        key: playlistOccurrenceKey(playlistId, entryId),
        // Unavailable entries still need a row, so stand in a minimal song carrying the raw id.
        song: song ?? songRow({ id: songId, title: songId }),
        unavailable: !song,
      })),
    [playlistId, rows],
  );

  if (isLoading) return <PageState tone="quiet" title="Loading playlist…" />;
  if (isError) return <PageState tone="error" icon={<WarningIcon />} title="Playlist unavailable" description="The playlist could not be read from the local database." />;
  if (!state) return <PageState icon={<PlaylistIcon />} title="Playlist not found" description="It may have been deleted on another device." />;

  const missingCount = rows.filter(({ song }) => !song).length;
  const canEdit = !state.readonly;
  const playlistMeta = formatMetaLine([
    `${rows.length} song${rows.length === 1 ? "" : "s"}`,
    formatDuration(totalDuration(rows)),
    state.readonly && state.owner ? `by ${state.owner}` : null,
    state.readonly ? "read-only" : null,
  ]);

  const playFrom = (entryId: string) => void QueueActions.playSource({ type: "playlist", playlistId }, playlistOccurrenceKey(playlistId, entryId));

  const removeSelected = (selection: TrackSelection) => {
    const keys = new Set(selection.items.map(({ key }) => key));
    removeEntriesMutation.mutate(rows.flatMap(({ entryId }) => (keys.has(playlistOccurrenceKey(playlistId, entryId)) ? [entryId] : [])));
  };

  return (
    <section className="flex h-full w-full flex-col">
      <div className="min-h-0 flex-1">
        <TrackList
          items={items}
          columns={libraryColumns}
          playingKey={playingKey}
          showHeader
          onActivate={(item) => {
            if (!item.unavailable) void QueueActions.playSource({ type: "playlist", playlistId }, item.key);
          }}
          menu={(selection) => (
            <>
              <TrackMenuAddItems selection={selection} />
              {canEdit ? (
                <>
                  <ContextMenuSeparator />
                  <ContextMenuItem variant="destructive" onClick={() => removeSelected(selection)}>
                    Remove from playlist
                  </ContextMenuItem>
                </>
              ) : null}
            </>
          )}
          scrollId={"playlist-" + playlistId}
          topPadding={DETAIL_TOP_PADDING}
          bottomPadding={DETAIL_BOTTOM_PADDING}
          topContent={
            <DetailHeader title={state.name} art={<PlaylistArt albumIds={artAlbumIds} />}>
              <p className="text-sm text-muted-foreground">{playlistMeta}</p>
              {state.comment ? <p className="line-clamp-2 text-sm text-muted-foreground">{state.comment}</p> : null}
              {rows.length === 0 ? <p className="text-sm text-muted-foreground">Add songs from any album or the songs list.</p> : null}
              {missingCount > 0 ? (
                <p className="text-xs text-muted-foreground">
                  {missingCount} {missingCount === 1 ? "song is" : "songs are"} not in your synced library and will be skipped.
                </p>
              ) : null}
              {removeEntriesMutation.isError ? <p className="text-xs text-destructive">{getErrorMessage(removeEntriesMutation.error, "The song could not be removed.")}</p> : null}

              <div className="mt-2 flex items-center gap-1">
                <Button className="h-10 w-32 gap-2 text-base" disabled={!firstPlayableEntryId} onClick={() => firstPlayableEntryId && playFrom(firstPlayableEntryId)}>
                  <PlayIcon weight="fill" className="size-5" />
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
