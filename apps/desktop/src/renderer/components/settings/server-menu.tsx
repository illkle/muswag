import {
  ArrowsClockwiseIcon,
  BooksIcon,
  CaretUpDownIcon,
  HardDrivesIcon,
  PackageIcon,
  SignOutIcon,
  SpinnerGapIcon,
  WarningIcon,
  WaveformIcon,
  XIcon,
} from "@phosphor-icons/react";
import { useCallback, useMemo, useState, type ReactNode } from "react";
import { useMutation } from "@tanstack/react-query";

import { usePlayerError, usePlayerMpvState } from "#/components/player-provider";
import { AppUpdateDialog } from "#/components/settings/app-update-dialog";
import { MpvInfoDialog, mpvStatusLabels } from "#/components/settings/mpv-info-dialog";
import { SyncDialog } from "#/components/settings/sync-dialog";
import { ThemeMenuControl } from "#/components/settings/theme-switcher";
import { Menu, MenuContent, MenuItem, MenuSeparator, MenuTrigger } from "#/components/ui/menu";
import { SidebarMenuButton } from "#/components/ui/sidebar";
import { getAppUpdateStatus, hasAppUpdate, useAppUpdate } from "#/hooks/use-app-update";
import { useSyncControls } from "#/hooks/use-sync-controls";
import { useUser } from "#/lib/queries";
import { SyncManager } from "#/lib/sync-manager";
import { getSyncProgressPercent, getSyncSummaryLine } from "#/lib/sync-status";
import { cn } from "#/lib/utils";

type SettingsDialog = "sync" | "mpv" | "update";

/** Progress along the bottom edge of the button; indeterminate until a step reports countable work. */
function SyncLine({ percent }: { percent: number | null }) {
  return (
    <span aria-hidden className="absolute inset-x-0 bottom-0 h-0.5 overflow-hidden bg-sidebar-border" data-slot="sync-progress">
      {percent === null ? (
        <span className="block h-full w-1/3 animate-[sync-line_1.4s_ease-in-out_infinite] rounded-full bg-primary motion-reduce:w-full motion-reduce:animate-none" />
      ) : (
        <span className="block h-full rounded-full bg-primary transition-[width] duration-300" style={{ width: `${percent}%` }} />
      )}
    </span>
  );
}

function StatusPill({ children, tone }: { children: ReactNode; tone: "primary" | "destructive" }) {
  return (
    <span
      className={cn(
        "shrink-0 rounded-full px-1.5 py-0.5 text-[11px] leading-none font-medium",
        tone === "primary" ? "bg-primary/15 text-primary" : "bg-destructive/15 text-destructive",
      )}
    >
      {children}
    </span>
  );
}

export function ServerMenu() {
  const userStateQuery = useUser();
  const syncControls = useSyncControls();
  const mpvState = usePlayerMpvState();
  const playerError = usePlayerError();
  const appUpdate = useAppUpdate();

  const [dialog, setDialog] = useState<SettingsDialog | null>(null);

  const logoutMutation = useMutation({
    mutationFn: () => SyncManager.logout(),
  });

  const closeDialog = useCallback(() => setDialog(null), []);
  const setMpvDialogOpen = useCallback((open: boolean) => setDialog(open ? "mpv" : null), []);

  const hostName = useMemo(() => {
    if (!userStateQuery.data) {
      return "";
    }

    return new URL(userStateQuery.data.url).hostname;
  }, [userStateQuery.data]);

  const { latestSync, running: syncRunning } = syncControls;
  const syncPercent = syncRunning ? getSyncProgressPercent(latestSync?.progress) : null;
  const syncSummary = getSyncSummaryLine(latestSync);
  const syncFailed = latestSync?.lastStatus === "failed";

  // `checking` is the startup state, so it must not paint the button red before mpv is actually missing.
  const playbackBroken = mpvState.status === "missing" || mpvState.status === "invalid" || Boolean(playerError);

  const updateStatus = getAppUpdateStatus(appUpdate);
  const updateWaiting = hasAppUpdate(updateStatus);

  // The button's colour and spinner carry state, so the accessible name has to carry it too.
  const triggerLabel = [
    hostName,
    "server and app settings",
    syncRunning ? "syncing" : null,
    playbackBroken ? "playback engine unavailable" : null,
  ]
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
              {syncRunning ? (
                <SpinnerGapIcon className="animate-spin" />
              ) : playbackBroken ? (
                <WarningIcon />
              ) : (
                <HardDrivesIcon className="opacity-70" />
              )}
              <span className="flex-1 truncate text-left font-medium">{hostName}</span>
              {playbackBroken && syncRunning ? <WarningIcon /> : null}
              <CaretUpDownIcon className={playbackBroken ? "opacity-70" : "text-muted-foreground"} />
              {syncRunning ? <SyncLine percent={syncPercent} /> : null}
            </SidebarMenuButton>
          }
        />

        <MenuContent align="start" className="w-64 p-1.5" side="top" sideOffset={8}>
          <div className="px-2 pt-1 pb-2.5">
            <div className="truncate font-medium">{hostName}</div>
            <div className="truncate text-xs text-muted-foreground">{userStateQuery.data.username}</div>
          </div>

          <MenuSeparator />

          <div className="flex items-center gap-1">
            <MenuItem className="min-w-0 flex-1" onClick={() => setDialog("sync")}>
              {syncRunning ? (
                <SpinnerGapIcon className="size-4 shrink-0 animate-spin" />
              ) : syncFailed ? (
                <WarningIcon className="size-4 shrink-0 text-destructive" />
              ) : (
                <BooksIcon className="size-4 shrink-0 text-muted-foreground" />
              )}
              <span className="min-w-0 flex-1 truncate">{syncSummary}</span>
            </MenuItem>
            <MenuItem
              aria-label={syncRunning ? "Cancel sync" : "Sync now"}
              className="shrink-0 px-2 text-muted-foreground"
              closeOnClick={false}
              disabled={syncRunning && syncControls.cancelling}
              onClick={() => (syncRunning ? syncControls.cancelSync() : syncControls.startSync("quick"))}
            >
              {syncRunning ? <XIcon className="size-4" /> : <ArrowsClockwiseIcon className="size-4" />}
            </MenuItem>
          </div>

          <MenuItem
            className={cn(
              playbackBroken && "bg-destructive/10 text-destructive data-highlighted:bg-destructive/20 data-highlighted:text-destructive",
            )}
            onClick={() => setDialog("mpv")}
          >
            {playbackBroken ? <WarningIcon className="size-4" /> : <WaveformIcon className="size-4 text-muted-foreground" />}
            <span className="flex-1 truncate">Playback engine</span>
            {playbackBroken ? (
              <StatusPill tone="destructive">{playerError ? "Error" : mpvStatusLabels[mpvState.status]}</StatusPill>
            ) : (
              <span className="shrink-0 text-xs text-muted-foreground">{mpvStatusLabels[mpvState.status]}</span>
            )}
          </MenuItem>

          <MenuItem onClick={() => setDialog("update")}>
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

          <MenuItem
            className="group data-highlighted:bg-destructive/10 data-highlighted:text-destructive"
            disabled={logoutMutation.isPending}
            onClick={() => logoutMutation.mutate()}
          >
            <SignOutIcon className="size-4 text-muted-foreground group-data-highlighted:text-destructive" />
            Log out
          </MenuItem>
        </MenuContent>
      </Menu>

      <SyncDialog controls={syncControls} onOpenChange={closeDialog} open={dialog === "sync"} serverName={hostName} />
      <MpvInfoDialog onOpenChange={setMpvDialogOpen} open={dialog === "mpv"} />
      <AppUpdateDialog onOpenChange={closeDialog} open={dialog === "update"} state={appUpdate} />
    </>
  );
}
