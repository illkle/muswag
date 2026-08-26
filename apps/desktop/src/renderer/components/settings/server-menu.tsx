import { ArrowsClockwiseIcon, CaretUpDownIcon, HardDrivesIcon, PackageIcon, SignOutIcon, SpinnerGapIcon, WarningIcon, WaveformIcon } from "@phosphor-icons/react";
import { useCallback, useMemo, useState, type ReactNode } from "react";
import { useMutation } from "@tanstack/react-query";

import { usePlayerError, usePlayerMpvState } from "#/components/player-provider";
import { AppUpdateDialog } from "#/components/settings/app-update-dialog";
import { MpvInfoDialog, mpvStatusLabels } from "#/components/settings/mpv-info-dialog";
import { ThemeMenuControl } from "#/components/settings/theme-switcher";
import { Menu, MenuContent, MenuItem, MenuSeparator, MenuTrigger } from "#/components/ui/menu";
import { SidebarMenuButton } from "#/components/ui/sidebar";
import { getAppUpdateStatus, hasAppUpdate, useAppUpdate } from "#/hooks/use-app-update";
import { useUser } from "#/lib/queries";
import { AppClient } from "#/core/client";
import { cn } from "#/lib/utils";

type SettingsDialog = "mpv" | "update";

function StatusPill({ children, tone }: { children: ReactNode; tone: "primary" | "destructive" }) {
  return (
    <span className={cn("shrink-0 rounded-full px-1.5 py-0.5 text-[11px] leading-none font-medium", tone === "primary" ? "bg-primary/15 text-primary" : "bg-destructive/15 text-destructive")}>
      {children}
    </span>
  );
}

export function ServerMenu() {
  const userStateQuery = useUser();
  const mpvState = usePlayerMpvState();
  const playerError = usePlayerError();
  const appUpdate = useAppUpdate();

  const [dialog, setDialog] = useState<SettingsDialog | null>(null);

  const logoutMutation = useMutation({
    mutationFn: () => AppClient.logout(),
  });
  const syncMutation = useMutation({
    mutationFn: () => AppClient.sync("quick"),
  });

  const closeDialog = useCallback(() => setDialog(null), []);
  const setMpvDialogOpen = useCallback((open: boolean) => setDialog(open ? "mpv" : null), []);

  const hostName = useMemo(() => {
    if (!userStateQuery.data) {
      return "";
    }

    return new URL(userStateQuery.data.url).hostname;
  }, [userStateQuery.data]);

  const syncRunning = syncMutation.isPending;

  // `checking` is the startup state, so it must not paint the button red before mpv is actually missing.
  const playbackBroken = mpvState.status === "missing" || mpvState.status === "invalid" || Boolean(playerError);

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

          <MenuItem disabled={syncRunning} onClick={() => syncMutation.mutate()}>
            {syncRunning ? <SpinnerGapIcon className="size-4 animate-spin" /> : <ArrowsClockwiseIcon className="size-4 text-muted-foreground" />}
            {syncRunning ? "Syncing library…" : "Sync library"}
          </MenuItem>

          <MenuItem className={cn(playbackBroken && "bg-destructive/10 text-destructive data-highlighted:bg-destructive/20 data-highlighted:text-destructive")} onClick={() => setDialog("mpv")}>
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

          <MenuItem className="group data-highlighted:bg-destructive/10 data-highlighted:text-destructive" disabled={logoutMutation.isPending} onClick={() => logoutMutation.mutate()}>
            <SignOutIcon className="size-4 text-muted-foreground group-data-highlighted:text-destructive" />
            Log out
          </MenuItem>
        </MenuContent>
      </Menu>

      <MpvInfoDialog onOpenChange={setMpvDialogOpen} open={dialog === "mpv"} />
      <AppUpdateDialog onOpenChange={closeDialog} open={dialog === "update"} state={appUpdate} />
    </>
  );
}
