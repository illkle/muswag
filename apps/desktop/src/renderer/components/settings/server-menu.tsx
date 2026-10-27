import { ArrowsClockwiseIcon, CaretUpDownIcon, CircleHalfIcon, GearSixIcon, HardDrivesIcon, PackageIcon, SignOutIcon, SpinnerGapIcon, WarningCircleIcon, WaveformIcon } from "@phosphor-icons/react";
import { useCallback, useMemo, useRef, useState, type ReactNode } from "react";
import { useMutation } from "@tanstack/react-query";

import { usePlayerError, usePlayerMpvBinary } from "#/player/hooks";
import { getAppUpdateStatus, shortVersion, useAppUpdate } from "#/updates/app-update";
import { useUser, Session } from "#/session/session";
import { LibraryActions } from "#/library/actions";
import { syncPercent, useLibrarySyncStatus } from "#/library/queries";
import { AppUpdateDialog } from "#/components/settings/app-update-dialog";
import { mpvStatusLabels, openMpvDialog, readUnavailable } from "#/components/settings/mpv-info-dialog";
import { SyncSettingsDialog } from "#/components/settings/sync-settings-dialog";
import { ThemeMenuControl } from "#/components/settings/theme-switcher";
import { InlineError } from "#/components/ui-custom/inline-error";
import { Button } from "#/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "#/components/ui/dialog";
import { Menu, MenuContent, MenuItem, MenuSeparator, MenuTrigger } from "#/components/ui/menu";
import { SidebarMenuButton } from "#/components/ui/sidebar";
import { getErrorMessage } from "#/lib/err";
import { formatAgo, formatAgoShort } from "#/lib/format";
import { cn } from "#/lib/utils";

/** The one value in the menu that asks for attention: an update waiting to be installed. */
function ReadyPill({ children }: { children: ReactNode }) {
  return <span className="shrink-0 rounded-full bg-brand/15 px-1.5 py-0.5 text-[11px] leading-none font-medium text-lime-700 dark:text-lime-400">{children}</span>;
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

  const popupRef = useRef<HTMLDivElement>(null);

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      {/* Focus starts on the dialog itself: no button looks chosen, and Return does not log out. */}
      <DialogContent ref={popupRef} initialFocus={popupRef} placement="top" showCloseButton={false} className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="leading-snug [overflow-wrap:anywhere]">Log out of {hostName}?</DialogTitle>
          <DialogDescription className="text-pretty">
            Stops playback and clears the library and queue on this computer. Your music and playlists stay on the server and sync again when you log back in.
          </DialogDescription>
        </DialogHeader>

        {logoutMutation.isError ? <InlineError alert>{getErrorMessage(logoutMutation.error, "Could not log out")}</InlineError> : null}

        <DialogFooter>
          <Button type="button" size="sm" variant="outline" disabled={logoutMutation.isPending} onClick={() => setOpen(false)}>
            Cancel
          </Button>
          <Button type="button" size="sm" variant="destructive" disabled={logoutMutation.isPending} onClick={() => logoutMutation.mutate()}>
            {/* The icon's place takes the spinner, so the button keeps its width while it works. */}
            {logoutMutation.isPending ? <SpinnerGapIcon className="animate-spin" /> : <SignOutIcon />}
            {logoutMutation.isPending ? (
              <span role="status" className="sr-only">
                Logging out…
              </span>
            ) : null}
            Log out
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

  // `checking` is the startup state, so it must not paint the button red before mpv is actually missing.
  const playbackBroken = binary._tag === "Unavailable" || Boolean(playerError);

  const updateStatus = getAppUpdateStatus(appUpdate);

  // The button's colour and spinner carry state, so the accessible name has to carry it too.
  const updateReady = updateStatus === "ready";
  const triggerLabel = [hostName, "server and app settings", syncRunning ? "syncing" : null, playbackBroken ? "playback engine unavailable" : null, updateReady ? "update ready" : null]
    .filter(Boolean)
    .join(", ");

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
              {syncRunning ? <SpinnerGapIcon className="animate-spin" /> : playbackBroken ? <WarningCircleIcon weight="fill" /> : <HardDrivesIcon className="opacity-70" />}
              <span className="flex-1 truncate text-left font-medium">{hostName}</span>
              {/* Only an update waiting to be installed asks for attention; a download in the background does not. */}
              {updateReady ? <span aria-hidden className="size-1.5 shrink-0 rounded-full bg-brand" /> : null}
              {playbackBroken && syncRunning ? <WarningCircleIcon weight="fill" /> : null}
              <CaretUpDownIcon className={playbackBroken ? "opacity-70" : "text-muted-foreground"} />
            </SidebarMenuButton>
          }
        />

        {/* As wide as the button it opens from, so the two share both edges. */}
        <MenuContent align="start" className="w-(--anchor-width) min-w-0 p-1.5" side="top" sideOffset={8}>
          {/* The button below already names the server, so the header names the account on it. */}
          <div className="px-2 pt-0.5 pb-1">
            <div className="text-xs text-muted-foreground">Signed in as</div>
            <div className="truncate">{userStateQuery.data.username}</div>
          </div>

          <MenuSeparator />

          <div className="flex items-center gap-0.5">
            {/* Unavailable while it runs, but its progress stays as readable as the other rows' values. */}
            <MenuItem className={cn("min-w-0 flex-1", syncRunning && "text-muted-foreground data-disabled:opacity-100")} disabled={syncRunning} onClick={() => syncMutation.mutate()}>
              {syncRunning ? <SpinnerGapIcon className="size-4 animate-spin" /> : <ArrowsClockwiseIcon className="size-4 text-muted-foreground" />}
              <span className="flex-1 truncate">{syncRunning ? "Syncing…" : "Sync library"}</span>
              {syncRunning ? (
                percent === null ? null : (
                  <span className="shrink-0 text-xs tabular-nums">{percent}%</span>
                )
              ) : librarySync.lastSyncedAt ? (
                <span title={`Last synced ${formatAgo(librarySync.lastSyncedAt)}`} className="shrink-0 text-xs text-muted-foreground">
                  {formatAgoShort(librarySync.lastSyncedAt)}
                </span>
              ) : null}
            </MenuItem>
            {/* Splits the row into the sync and its settings, which is why its value stops short of the others'. */}
            <div aria-hidden className="h-4 w-px shrink-0 bg-border" />
            <MenuItem aria-label="Library sync settings" title="Library sync settings" className="size-8 shrink-0 justify-center p-0" onClick={() => setSyncDialogOpen(true)}>
              <GearSixIcon className="size-4 text-muted-foreground" />
            </MenuItem>
          </div>
          {librarySync.error && !syncRunning ? (
            <p role="alert" title={librarySync.error} className="flex gap-1.5 pr-2 pb-1.5 pl-2 text-xs text-destructive">
              <WarningCircleIcon aria-hidden className="mt-px size-3.5 shrink-0" weight="fill" />
              <span className="line-clamp-2">Last sync failed: {librarySync.error}</span>
            </p>
          ) : null}

          <MenuSeparator />

          {/* The button that opens the menu is already red; inside, the icon and the value say it. */}
          <MenuItem onClick={openMpvDialog}>
            {playbackBroken ? <WarningCircleIcon className="size-4 text-destructive" weight="fill" /> : <WaveformIcon className="size-4 text-muted-foreground" />}
            <span className="flex-1 truncate">Playback engine</span>
            {playbackBroken ? (
              <span className="shrink-0 text-xs text-destructive">
                {binary._tag === "Unavailable" ? readUnavailable(binary.message).verdict : playerError ? "Failed" : mpvStatusLabels[binary._tag]}
              </span>
            ) : (
              <span className="shrink-0 text-xs text-muted-foreground tabular-nums">{binary._tag === "Ready" ? `mpv ${binary.version.split("-")[0]}` : mpvStatusLabels[binary._tag]}</span>
            )}
          </MenuItem>

          <MenuItem onClick={() => setUpdateDialogOpen(true)}>
            <PackageIcon className="size-4 text-muted-foreground" />
            <span className="flex-1 truncate">Updates</span>
            {/* Only a ready update asks for attention; a download or a failure is a value like the others. */}
            {updateReady ? (
              <ReadyPill>Ready</ReadyPill>
            ) : updateStatus === "downloading" ? (
              <span title="Downloading the update" className="shrink-0 text-xs text-muted-foreground tabular-nums">
                {appUpdate?.progressPercent === null || appUpdate?.progressPercent === undefined ? "Downloading" : `${Math.round(appUpdate.progressPercent)}%`}
              </span>
            ) : updateStatus === "error" ? (
              <span className="shrink-0 text-xs text-destructive">Failed</span>
            ) : (
              <span title={appUpdate ? `v${appUpdate.currentVersion}` : undefined} className="shrink-0 text-xs text-muted-foreground tabular-nums">
                {appUpdate ? shortVersion(appUpdate.currentVersion) : "v…"}
              </span>
            )}
          </MenuItem>

          {/* Not an item itself, but as tall as one and with its control ending where the values do. */}
          <div className="flex min-h-8 items-center gap-2 px-2 py-0.5">
            <CircleHalfIcon className="size-4 text-muted-foreground" />
            <span className="flex-1">Theme</span>
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
