import { WarningCircleIcon } from "@phosphor-icons/react";
import { createStore, useSelector } from "@tanstack/react-store";

import { MpvInstall, MpvSearch } from "#/components/settings/mpv-setup";
import { Dialog, DialogContent, DialogTitle } from "#/components/ui/dialog";
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
  const open = useSelector(dialogOpen);
  const playerError = usePlayerError();
  const playerStatus = usePlayerStatus();

  return (
    <Dialog open={open} onOpenChange={setDialogOpen}>
      {/* Grid items are as wide as their content at least, so they are let shrink: nothing scrolls sideways. */}
      <DialogContent className="scrollbar scrollbar-flush max-h-[85vh] overflow-x-hidden overflow-y-auto *:min-w-0 sm:max-w-4xl">
        {/* Named for screen readers only: the sections say what the dialog is about. */}
        <DialogTitle className="sr-only">Playback engine</DialogTitle>
        <div className="grid gap-8 md:grid-cols-2 md:gap-10">
          <div className="min-w-0 space-y-8">
            <MpvSearch />
            <div className="space-y-2 border-t pt-4 text-sm">
              <div className="flex items-center justify-between gap-4">
                <span className="text-muted-foreground">Playback status</span>
                <span className="font-medium">{playerStatusLabels[playerStatus]}</span>
              </div>
              {/* An error asking for mpv says what Auto discovery already does. */}
              {playerError && playerError.fix !== "mpv" ? (
                <div className="flex gap-2 text-destructive" role="alert">
                  <WarningCircleIcon className="mt-0.5 size-4 shrink-0" weight="fill" />
                  <span className="[overflow-wrap:anywhere]">{playerError.message}</span>
                </div>
              ) : null}
            </div>
          </div>
          <MpvInstall />
        </div>
      </DialogContent>
    </Dialog>
  );
}
