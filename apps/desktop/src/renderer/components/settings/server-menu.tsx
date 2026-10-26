import { ArrowsClockwiseIcon, CaretUpDownIcon, GearSixIcon, HardDrivesIcon, PackageIcon, SignOutIcon, SpinnerGapIcon, WarningIcon, WaveformIcon } from "@phosphor-icons/react";
import { useCallback, useMemo, useState, type ReactNode } from "react";
import { useMutation } from "@tanstack/react-query";

import { usePlayerError, usePlayerMpvBinary } from "#/player/hooks";
import { getAppUpdateStatus, hasAppUpdate, useAppUpdate } from "#/updates/app-update";
import { useUser, Session } from "#/session/session";
import { LibraryActions } from "#/library/actions";
import { syncPercent, useLibrarySyncStatus } from "#/library/queries";
import { AppUpdateDialog } from "#/components/settings/app-update-dialog";
import { mpvStatusLabels, openMpvDialog } from "#/components/settings/mpv-info-dialog";
import { SyncSettingsDialog } from "#/components/settings/sync-settings-dialog";
import { ThemeMenuControl } from "#/components/settings/theme-switcher";
import { Button } from "#/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "#/components/ui/dialog";
import { Menu, MenuContent, MenuItem, MenuSeparator, MenuTrigger } from "#/components/ui/menu";
import { SidebarMenuButton } from "#/components/ui/sidebar";
import { getErrorMessage } from "#/lib/err";
import { formatAgo } from "#/lib/format";
import { cn } from "#/lib/utils";

function StatusPill({ children, tone }: { children: ReactNode; tone: "primary" | "destructive" }) {
  return (
    <span className={cn("shrink-0 rounded-full px-1.5 py-0.5 text-[11px] leading-none font-medium", tone === "primary" ? "bg-primary/15 text-primary" : "bg-destructive/15 text-destructive")}>
      {children}
    </span>
  );
}

/** Asks before logging out, since main deletes the synced library with the session. */
function LogoutDialog({ open, onOpenChange, hostName }: { open: boolean; onOpenChange: (open: boolean) => void; hostName: string }) {
  // Once main has logged out the app leaves for the login page, so only a failure keeps this dialog up.
  const logoutMutation = useMutation({
    mutationFn: () => Session.logout(),
  });

  const setOpen = (nextOpen: boolean) => {
    if (logoutMutation.isPending) return;
    if (!nextOpen) logoutMutation.reset();
    onOpenChange(nextOpen);
  };

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogContent showCloseButton={!logoutMutation.isPending} className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Log out of {hostName}?</DialogTitle>
          <DialogDescription>The library and the queue will be removed from this computer. Logging in again syncs the library back from the server.</DialogDescription>
        </DialogHeader>

        {logoutMutation.isError ? <p className="text-xs text-destructive">{getErrorMessage(logoutMutation.error, "Could not log out.")}</p> : null}

        <DialogFooter>
          <Button type="button" variant="secondary" disabled={logoutMutation.isPending} onClick={() => setOpen(false)}>
            Cancel
          </Button>
          <Button type="button" variant="destructive" disabled={logoutMutation.isPending} onClick={() => logoutMutation.mutate()}>
            {logoutMutation.isPending ? "Logging out…" : "Log out"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export function ServerMenu() {
  const userStateQuery = useUser();
  const binary = usePlayerMpvBinary();
  const playerError = usePlayerError();
  const appUpdate = useAppUpdate();

  const [updateDialogOpen, setUpdateDialogOpen] = useState(false);
  const [logoutDialogOpen, setLogoutDialogOpen] = useState(false);
  const [syncDialogOpen, setSyncDialogOpen] = useState(false);

  const syncMutation = useMutation({
    // Every song is read again unless the server says it has not scanned its files since the last sync that did.
    mutationFn: () => LibraryActions.sync(),
  });

  const closeUpdateDialog = useCallback(() => setUpdateDialogOpen(false), []);

  const hostName = useMemo(() => {
    if (!userStateQuery.data) {
      return "";
    }

    return new URL(userStateQuery.data.url).hostname;
  }, [userStateQuery.data]);

  // The sync runs in main and outlives this menu, e.g. across a window reload, so follow main's status too.
  const librarySync = useLibrarySyncStatus();
  const syncRunning = syncMutation.isPending || librarySync.running;
  const percent = syncPercent(librarySync);
  const syncLabel = percent === null ? "Syncing library…" : `Syncing library… ${percent}%`;

  // `checking` is the startup state, so it must not paint the button red before mpv is actually missing.
  const playbackBroken = binary._tag === "Unavailable" || Boolean(playerError);

  const updateStatus = getAppUpdateStatus(appUpdate);
  const updateWaiting = hasAppUpdate(updateStatus);

  // The button's colour and spinner carry state, so the accessible name has to carry it too.
  const triggerLabel = [hostName, "server and app settings", syncRunning ? "syncing" : null, playbackBroken ? "playback engine unavailable" : null].filter(Boolean).join(", ");

  if (!userStateQuery.data) {
    console.warn("No user data in ServerMenu component");
    return null;
  }

  return (
    <>
      <Menu>
        <MenuTrigger
          render={
            <SidebarMenuButton
              aria-label={triggerLabel}
              className={cn(
                "relative h-10 gap-2.5",
                playbackBroken &&
                  "bg-destructive/10 text-destructive hover:bg-destructive/15 hover:text-destructive data-open:bg-destructive/15 data-open:hover:bg-destructive/15 data-open:hover:text-destructive",
              )}
            >
              {/* A sync is transient, so it takes the icon slot; the alert falls back to the right of the name. */}
              {syncRunning ? <SpinnerGapIcon className="animate-spin" /> : playbackBroken ? <WarningIcon /> : <HardDrivesIcon className="opacity-70" />}
              <span className="flex-1 truncate text-left font-medium">{hostName}</span>
              {playbackBroken && syncRunning ? <WarningIcon /> : null}
              <CaretUpDownIcon className={playbackBroken ? "opacity-70" : "text-muted-foreground"} />
            </SidebarMenuButton>
          }
        />

        <MenuContent align="start" className="w-64 p-1.5" side="top" sideOffset={8}>
          <div className="px-2 pt-1 pb-2.5">
            <div className="truncate font-medium">{hostName}</div>
            <div className="truncate text-xs text-muted-foreground">{userStateQuery.data.username}</div>
          </div>

          <MenuSeparator />

          <div className="flex items-center gap-0.5">
            <MenuItem className="min-w-0 flex-1" disabled={syncRunning} onClick={() => syncMutation.mutate()}>
              {syncRunning ? <SpinnerGapIcon className="size-4 animate-spin" /> : <ArrowsClockwiseIcon className="size-4 text-muted-foreground" />}
              <span className="flex-1 truncate">{syncRunning ? syncLabel : "Sync library"}</span>
              {!syncRunning && librarySync.lastSyncedAt ? <span className="shrink-0 text-xs text-muted-foreground">{formatAgo(librarySync.lastSyncedAt)}</span> : null}
            </MenuItem>
            <MenuItem aria-label="Sync settings" className="shrink-0 justify-center px-2" onClick={() => setSyncDialogOpen(true)}>
              <GearSixIcon className="size-4 text-muted-foreground" />
            </MenuItem>
          </div>
          {librarySync.error && !syncRunning ? (
            <p role="alert" title={librarySync.error} className="line-clamp-2 px-2 pb-1.5 text-xs text-destructive">
              Last sync: {librarySync.error}
            </p>
          ) : null}

          <MenuItem className={cn(playbackBroken && "bg-destructive/10 text-destructive data-highlighted:bg-destructive/20 data-highlighted:text-destructive")} onClick={openMpvDialog}>
            {playbackBroken ? <WarningIcon className="size-4" /> : <WaveformIcon className="size-4 text-muted-foreground" />}
            <span className="flex-1 truncate">Playback engine</span>
            {playbackBroken ? (
              <StatusPill tone="destructive">{playerError ? "Error" : mpvStatusLabels[binary._tag]}</StatusPill>
            ) : (
              <span className="shrink-0 text-xs text-muted-foreground">{mpvStatusLabels[binary._tag]}</span>
            )}
          </MenuItem>

          <MenuItem onClick={() => setUpdateDialogOpen(true)}>
            <PackageIcon className="size-4 text-muted-foreground" />
            <span className="flex-1 truncate">
              Muswag <span className="font-mono tabular-nums">v{appUpdate?.currentVersion ?? "…"}</span>
            </span>
            {updateWaiting ? <StatusPill tone="primary">{updateStatus === "ready" ? "Update ready" : "Downloading"}</StatusPill> : null}
          </MenuItem>

          <MenuSeparator />

          <div className="flex items-center gap-2 px-2 py-1">
            <span className="flex-1 text-muted-foreground">Theme</span>
            <ThemeMenuControl className="w-24" />
          </div>

          <MenuSeparator />

          <MenuItem className="group data-highlighted:bg-destructive/10 data-highlighted:text-destructive" onClick={() => setLogoutDialogOpen(true)}>
            <SignOutIcon className="size-4 text-muted-foreground group-data-highlighted:text-destructive" />
            Log out…
          </MenuItem>
        </MenuContent>
      </Menu>

      <AppUpdateDialog onOpenChange={closeUpdateDialog} open={updateDialogOpen} state={appUpdate} />
      <LogoutDialog open={logoutDialogOpen} onOpenChange={setLogoutDialogOpen} hostName={hostName} />
      <SyncSettingsDialog open={syncDialogOpen} onOpenChange={setSyncDialogOpen} />
    </>
  );
}
