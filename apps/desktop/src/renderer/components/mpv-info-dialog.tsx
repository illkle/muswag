import { AlertCircle, CheckCircle2, CircleX, Info } from "lucide-react";
import { useState } from "react";

import { Badge } from "#/components/ui/badge";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "#/components/ui/dialog";
import { SidebarMenuButton } from "#/components/ui/sidebar";
import { usePlayerError, usePlayerMpvAvailable, usePlayerStatus } from "#/components/player-provider";
import type { PlayerStatus } from "#shared/player";

const playerStatusLabels: Record<PlayerStatus, string> = {
  idle: "Idle",
  loading: "Loading",
  playing: "Playing",
  paused: "Paused",
  ended: "Ended",
  error: "Error",
};

export function MpvInfoDialog() {
  const [open, setOpen] = useState(false);
  const mpvAvailable = usePlayerMpvAvailable();
  const playerError = usePlayerError();
  const playerStatus = usePlayerStatus();

  const hookStatus = !mpvAvailable ? "Unavailable" : playerError ? "Error" : "Available";
  const hookStatusVariant = !mpvAvailable || playerError ? "destructive" : "secondary";

  return (
    <>
      <SidebarMenuButton tooltip="MPV information" onClick={() => setOpen(true)}>
        {playerError || !mpvAvailable ? <AlertCircle /> : <Info />}
        MPV information
      </SidebarMenuButton>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>MPV information</DialogTitle>
            <DialogDescription>View the current status of the mpv playback hook.</DialogDescription>
          </DialogHeader>

          <div className="space-y-4">
            <div className="flex items-center justify-between gap-4 rounded-lg border p-3">
              <div className="flex items-center gap-2">
                {hookStatus === "Available" ? <CheckCircle2 className="size-4 text-emerald-500" /> : <CircleX className="size-4" />}
                <span className="font-medium">Hook status</span>
              </div>
              <Badge variant={hookStatusVariant}>{hookStatus}</Badge>
            </div>

            <div className="flex items-center justify-between gap-4 text-sm">
              <span className="text-muted-foreground">Playback status</span>
              <span className="font-medium">{playerStatusLabels[playerStatus]}</span>
            </div>

            {playerError ? (
              <div className="rounded-lg border border-destructive/30 bg-destructive/5 p-3 text-sm text-destructive">
                <div className="flex items-center gap-2 font-medium">
                  <AlertCircle className="size-4" />
                  Last error
                </div>
                <p className="mt-2 break-words text-destructive/90">{playerError}</p>
              </div>
            ) : (
              <div className="flex items-center gap-2 text-sm text-muted-foreground">
                <CheckCircle2 className="size-4 text-emerald-500" />
                No errors reported.
              </div>
            )}
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
}
