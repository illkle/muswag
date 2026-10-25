import { CheckCircleIcon, WarningCircleIcon } from "@phosphor-icons/react";
import { createStore, useStore } from "@tanstack/react-store";

import { MpvSetup } from "#/components/settings/mpv-setup";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "#/components/ui/dialog";
import { usePlayerError, usePlayerStatus } from "#/player/hooks";
import type { BinaryState } from "#shared/commands/player";
import type { PlayerStatus } from "#shared/state/player";

const playerStatusLabels: Record<PlayerStatus, string> = {
  idle: "Idle",
  loading: "Loading",
  playing: "Playing",
  paused: "Paused",
  ended: "Ended",
  stopped: "Stopped",
  error: "Error",
};

export const mpvStatusLabels: Record<BinaryState["_tag"], string> = {
  Checking: "Checking",
  Ready: "Available",
  Unavailable: "Unavailable",
};

/** Whether the dialog is open. Anything that finds playback broken can open it: the server menu, the player's error. */
const dialogOpen = createStore(false);
export const openMpvDialog = () => dialogOpen.setState(() => true);
const setDialogOpen = (open: boolean) => dialogOpen.setState(() => open);

export function MpvInfoDialog() {
  const open = useStore(dialogOpen);
  const playerError = usePlayerError();
  const playerStatus = usePlayerStatus();

  return (
    <Dialog open={open} onOpenChange={setDialogOpen}>
      {/* Grid items are as wide as their content at least, so they are let shrink: nothing scrolls sideways. */}
      <DialogContent className="scrollbar scrollbar-flush max-h-[85vh] overflow-x-hidden overflow-y-auto *:min-w-0 sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>Playback engine</DialogTitle>
          <DialogDescription>Muswag plays your music through mpv, a free media player it runs in the background.</DialogDescription>
        </DialogHeader>

        <MpvSetup />

        <div className="space-y-3 border-t pt-4">
          <div className="flex items-center justify-between gap-4 text-sm">
            <span className="text-muted-foreground">Playback status</span>
            <span className="font-medium">{playerStatusLabels[playerStatus]}</span>
          </div>

          {/* An error asking for mpv says what the setup above already does. */}
          {playerError?.fix === "mpv" ? null : playerError ? (
            <div className="rounded-lg border border-destructive/30 bg-destructive/5 p-3 text-sm text-destructive">
              <div className="flex items-center gap-2 font-medium">
                <WarningCircleIcon className="size-4" />
                Last playback error
              </div>
              <p className="mt-2 [overflow-wrap:anywhere] text-destructive/90">{playerError.message}</p>
            </div>
          ) : (
            <div className="flex items-center gap-2 text-sm text-muted-foreground">
              <CheckCircleIcon className="size-4 text-brand" />
              No errors reported.
            </div>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
