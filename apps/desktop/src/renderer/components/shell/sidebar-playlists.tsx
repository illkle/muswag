import { ArrowsClockwiseIcon, PencilSimpleIcon, PlaylistIcon, PlusIcon, SpinnerGapIcon, TrashIcon } from "@phosphor-icons/react";
import { useMutation } from "@tanstack/react-query";
import { useMatchRoute, useNavigate } from "@tanstack/react-router";
import { useState, type MouseEvent } from "react";

import { openNewPlaylistDialog } from "#/components/playlist/new-playlist-dialog";
import { PlaylistDeleteDialog } from "#/components/playlist/playlist-delete-dialog";
import { PlaylistEditDialog } from "#/components/playlist/playlist-edit-dialog";
import { Button } from "#/components/ui/button";
import { ContextMenu, ContextMenuContent, ContextMenuItem, ContextMenuTrigger } from "#/components/ui/context-menu";
import { SidebarGroup, SidebarGroupContent, SidebarGroupLabel, SidebarMenu, SidebarMenuButton, SidebarMenuItem } from "#/components/ui/sidebar";
import { getErrorMessage } from "#/lib/err";
import { failureNotice } from "#/lib/notify";
import { dragDetail, startSongDrag, useSongDrop } from "#/lib/song-drag";
import { cn } from "#/lib/utils";
import { PlaylistActions } from "#/playlists/actions";
import { readPlaylist, usePlaylists, usePlaylistSyncStatus, type PlaylistSummary } from "#/playlists/queries";

/** A playlist of the sidebar: it opens the playlist, takes songs dropped on it unless it is read-only, and drags its songs. */
function SidebarPlaylist({ playlist }: { playlist: PlaylistSummary }) {
  const matchRoute = useMatchRoute();
  const navigate = useNavigate();
  const active = Boolean(matchRoute({ to: "/app/playlists/$playlistId", params: { playlistId: playlist.id } }));
  const drop = useSongDrop(
    (drag) =>
      void drag
        .songIds()
        .then((songIds) => PlaylistActions.addSongs(playlist.id, songIds))
        .catch(failureNotice(`The songs could not be added to “${playlist.name}”.`)),
    // A whole playlist goes into another only on that playlist's page, where it lands where it is dropped.
    { disabled: playlist.readonly, accepts: (drag) => drag.playlistId === undefined },
  );

  return (
    <SidebarMenuItem data-playlist-id={playlist.id}>
      <SidebarMenuButton
        isActive={active}
        onClick={() => navigate({ to: "/app/playlists/$playlistId", params: { playlistId: playlist.id } })}
        draggable={playlist.songCount > 0}
        onDragStart={(event) =>
          startSongDrag(event, {
            label: playlist.name,
            detail: dragDetail.playlist(playlist.songCount),
            playlistId: playlist.id,
            // The entries as they are when the songs are dropped.
            songIds: () => readPlaylist(playlist.id).then((record) => record?.local?.entries.map(({ songId }) => songId) ?? []),
          })
        }
        className={cn(drop.over && "bg-sidebar-accent ring-2 ring-brand ring-inset")}
        {...drop.props}
      >
        <PlaylistIcon weight={active ? "fill" : "regular"} />
        <span>{playlist.name}</span>
      </SidebarMenuButton>
    </SidebarMenuItem>
  );
}

/**
 * The library's playlists, as a scrollable list filling whatever height is left below the nav. A
 * right-click on a playlist offers to edit or delete it, and anywhere else in the list to make one.
 */
export function SidebarPlaylists() {
  const { playlists, isLoading, isError } = usePlaylists();
  const syncStatus = usePlaylistSyncStatus();
  const matchRoute = useMatchRoute();
  const navigate = useNavigate();

  /** What the menu is for: the playlist right-clicked, or `null` for the list around them. */
  const [menuFor, setMenuFor] = useState<PlaylistSummary | null>(null);
  const [editing, setEditing] = useState<PlaylistSummary | null>(null);
  const [deleting, setDeleting] = useState<PlaylistSummary | null>(null);

  const onContextMenu = (event: MouseEvent<HTMLElement> & { preventBaseUIHandler?: () => void }) => {
    const id = (event.target as Element).closest<HTMLElement>("[data-playlist-id]")?.dataset.playlistId;
    const playlist = id === undefined ? null : (playlists.find((playlist) => playlist.id === id) ?? null);
    // A playlist that cannot be changed has nothing to offer.
    if (playlist?.readonly) return event.preventBaseUIHandler?.();
    setMenuFor(playlist);
  };

  const syncMutation = useMutation({
    mutationFn: () => PlaylistActions.syncNow(),
  });

  const syncing = syncStatus.state === "syncing" || syncMutation.isPending;
  // The retry path reports "scheduled" while still holding the failure, so key off `error`.
  const syncError = syncStatus.error ?? (syncMutation.isError ? getErrorMessage(syncMutation.error, "The playlists could not be synced.") : null);

  return (
    <SidebarGroup className="min-h-0 flex-1 gap-1 pt-0">
      <div className="flex items-center gap-0.5">
        <SidebarGroupLabel className="min-w-0 flex-1">Playlists</SidebarGroupLabel>
        <Button variant="ghost" size="icon-sm" aria-label={syncing ? "Syncing playlists" : "Sync playlists"} disabled={syncing} onClick={() => syncMutation.mutate()}>
          {syncing ? <SpinnerGapIcon className="animate-spin" /> : <ArrowsClockwiseIcon />}
        </Button>
        <Button variant="ghost" size="icon-sm" aria-label="New playlist" onClick={() => openNewPlaylistDialog()}>
          <PlusIcon />
        </Button>
      </div>

      {syncError ? <p className="px-2 pb-1 text-xs text-destructive">Sync problem: {syncError}</p> : null}

      <ContextMenu>
        <ContextMenuTrigger render={<SidebarGroupContent />} className="scrollbar scrollbar-slim scrollbar-flush -mr-1 min-h-0 flex-1 overflow-y-auto pr-1" onContextMenu={onContextMenu}>
          {isLoading ? <p className="px-2 py-1 text-xs text-sidebar-foreground/60">Loading...</p> : null}
          {isError ? <p className="px-2 py-1 text-xs text-destructive">The playlist list could not be read.</p> : null}
          {!isLoading && !isError && playlists.length === 0 ? <p className="px-2 py-1 text-xs text-sidebar-foreground/60">No playlists yet.</p> : null}

          <SidebarMenu>
            {playlists.map((playlist) => (
              <SidebarPlaylist key={playlist.id} playlist={playlist} />
            ))}
          </SidebarMenu>
        </ContextMenuTrigger>
        <ContextMenuContent>
          {menuFor ? (
            <>
              <ContextMenuItem onClick={() => setEditing(menuFor)}>
                <PencilSimpleIcon />
                Edit details
              </ContextMenuItem>
              <ContextMenuItem variant="destructive" onClick={() => setDeleting(menuFor)}>
                <TrashIcon />
                Delete
              </ContextMenuItem>
            </>
          ) : (
            <ContextMenuItem onClick={() => openNewPlaylistDialog()}>
              <PlusIcon />
              New playlist
            </ContextMenuItem>
          )}
        </ContextMenuContent>
      </ContextMenu>

      {editing ? <PlaylistEditDialog key={editing.id} playlistId={editing.id} details={editing} open onOpenChange={(open) => !open && setEditing(null)} /> : null}
      {deleting ? (
        <PlaylistDeleteDialog
          open
          onOpenChange={(open) => !open && setDeleting(null)}
          playlistName={deleting.name}
          onConfirm={() => PlaylistActions.remove(deleting.id)}
          // The page of a playlist that has gone is left, and going back does not return to it.
          onDeleted={() => {
            if (matchRoute({ to: "/app/playlists/$playlistId", params: { playlistId: deleting.id } })) void navigate({ to: "/app/albums", replace: true });
          }}
        />
      ) : null}
    </SidebarGroup>
  );
}
