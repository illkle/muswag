import { ArrowsClockwiseIcon, PlaylistIcon, PlusIcon, SpinnerGapIcon } from "@phosphor-icons/react";
import { useMutation } from "@tanstack/react-query";
import { useMatchRoute, useNavigate } from "@tanstack/react-router";
import { useState } from "react";

import { PlaylistFormDialog } from "#/components/playlist/playlist-form-dialog";
import { Button } from "#/components/ui/button";
import {
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
} from "#/components/ui/sidebar";
import { getErrorMessage } from "#/lib/err";
import { PlaylistActions } from "#/lib/playlist-actions";
import { usePlaylists } from "#/lib/playlist-queries";
import { usePlaylistSyncStatus } from "#/lib/queries";

/** The library's playlists, as a scrollable list filling whatever height is left below the nav. */
export function SidebarPlaylists() {
  const matchRoute = useMatchRoute();
  const navigate = useNavigate();
  const { playlists, isLoading, isError } = usePlaylists();
  const syncStatus = usePlaylistSyncStatus();
  const [createOpen, setCreateOpen] = useState(false);

  const syncMutation = useMutation({
    mutationFn: () => PlaylistActions.syncNow(),
  });

  const syncing = syncStatus.state === "syncing" || syncMutation.isPending;
  // The retry path reports "scheduled" while still holding the failure, so key off `error`.
  const syncError =
    syncStatus.error ?? (syncMutation.isError ? getErrorMessage(syncMutation.error, "The playlists could not be synced.") : null);

  return (
    <SidebarGroup className="min-h-0 flex-1 gap-1 pt-0">
      <div className="flex items-center gap-0.5">
        <SidebarGroupLabel className="min-w-0 flex-1">Playlists</SidebarGroupLabel>
        <Button
          variant="ghost"
          size="icon-xs"
          aria-label={syncing ? "Syncing playlists" : "Sync playlists"}
          disabled={syncing}
          onClick={() => syncMutation.mutate()}
        >
          {syncing ? <SpinnerGapIcon className="animate-spin" /> : <ArrowsClockwiseIcon />}
        </Button>
        <Button variant="ghost" size="icon-xs" aria-label="New playlist" onClick={() => setCreateOpen(true)}>
          <PlusIcon />
        </Button>
      </div>

      {syncError ? <p className="px-2 pb-1 text-xs text-destructive">Sync problem: {syncError}</p> : null}

      <SidebarGroupContent className="scrollbar scrollbar-flush -mr-1 min-h-0 flex-1 overflow-y-auto pr-1">
        {isLoading ? <p className="px-2 py-1 text-xs text-sidebar-foreground/60">Loading...</p> : null}
        {isError ? <p className="px-2 py-1 text-xs text-destructive">The playlist list could not be read.</p> : null}
        {!isLoading && !isError && playlists.length === 0 ? (
          <p className="px-2 py-1 text-xs text-sidebar-foreground/60">No playlists yet.</p>
        ) : null}

        <SidebarMenu>
          {playlists.map((playlist) => (
            <SidebarMenuItem key={playlist.id}>
              <SidebarMenuButton
                isActive={Boolean(matchRoute({ to: "/app/playlists/$playlistId", params: { playlistId: playlist.id } }))}
                onClick={() => navigate({ to: "/app/playlists/$playlistId", params: { playlistId: playlist.id } })}
              >
                <PlaylistIcon />
                <span>{playlist.name}</span>
              </SidebarMenuButton>
            </SidebarMenuItem>
          ))}
        </SidebarMenu>
      </SidebarGroupContent>

      <PlaylistFormDialog
        open={createOpen}
        onOpenChange={setCreateOpen}
        title="New playlist"
        submitLabel="Create"
        onSubmit={async ({ name, comment, public: isPublic }) => {
          const created = await PlaylistActions.create({ name });
          if (comment) await PlaylistActions.setComment(created.id, comment);
          if (isPublic) await PlaylistActions.setVisibility(created.id, true);
          await navigate({ to: "/app/playlists/$playlistId", params: { playlistId: created.id } });
        }}
      />
    </SidebarGroup>
  );
}
