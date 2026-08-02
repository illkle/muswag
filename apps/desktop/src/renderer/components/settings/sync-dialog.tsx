import { ArrowsClockwiseIcon, SpinnerGapIcon, XIcon } from "@phosphor-icons/react";

import { Badge } from "#/components/ui/badge";
import { Button } from "#/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "#/components/ui/dialog";
import type { SyncControls } from "#/hooks/use-sync-controls";
import { formatSyncTime, getSyncProgressPercent, getSyncStepLabel } from "#/lib/sync-status";
import { cn } from "#/lib/utils";
import type { SyncRecord } from "@muswag/shared";

const statCells: { key: keyof NonNullable<SyncRecord["progress"]>; label: string }[] = [
  { key: "artistsFetched", label: "Artists" },
  { key: "albumsFetched", label: "Albums read" },
  { key: "albumsInserted", label: "Added" },
  { key: "albumsUpdated", label: "Updated" },
  { key: "albumsDeleted", label: "Removed" },
  { key: "songsDeleted", label: "Songs cleaned" },
];

function SyncDetails({ syncRecord }: { syncRecord: SyncRecord }) {
  const progress = syncRecord.progress;
  const percent = getSyncProgressPercent(progress);
  const running = syncRecord.lastStatus === "running";

  return (
    <div className="space-y-4">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="font-medium">{getSyncStepLabel(syncRecord)}</div>
          <div className="text-xs text-muted-foreground">
            Started {formatSyncTime(syncRecord.timeStarted)}
            {syncRecord.timeEnded ? `, ended ${formatSyncTime(syncRecord.timeEnded)}` : null}
          </div>
        </div>
        <div className="flex shrink-0 gap-1">
          <Badge variant="secondary">{syncRecord.mode ?? "full"}</Badge>
          <Badge variant={syncRecord.lastStatus === "failed" ? "destructive" : "secondary"}>
            {syncRecord.currentStep === "skipped-unchanged" ? "unchanged" : syncRecord.lastStatus}
          </Badge>
        </div>
      </div>

      {percent !== null ? (
        <div className="space-y-1.5">
          <div className="flex justify-between text-xs text-muted-foreground">
            <span>{getSyncStepLabel(syncRecord)}</span>
            <span className="font-mono tabular-nums">{percent}%</span>
          </div>
          <div className="h-1.5 overflow-hidden rounded-full bg-muted">
            <div
              className={cn("h-full rounded-full bg-primary transition-[width]", running && "duration-300")}
              style={{ width: `${percent}%` }}
            />
          </div>
        </div>
      ) : null}

      {progress ? (
        <dl className="grid grid-cols-3 gap-x-4 gap-y-3 border-t pt-4 text-xs">
          {statCells.map(({ key, label }) => (
            <div key={key}>
              <dt className="text-muted-foreground">{label}</dt>
              <dd className="font-mono text-sm tabular-nums">{progress[key]}</dd>
            </div>
          ))}
          <div>
            <dt className="text-muted-foreground">Pages</dt>
            <dd className="font-mono text-sm tabular-nums">{progress.pagesFetched}</dd>
          </div>
          <div className="col-span-2">
            <dt className="text-muted-foreground">Cover art</dt>
            <dd className="font-mono text-sm tabular-nums">
              {progress.coverArtFetched}/{progress.coverArtTotal}
            </dd>
          </div>
        </dl>
      ) : null}

      {syncRecord.error ? (
        <p className="rounded-md bg-destructive/10 p-3 text-xs break-words text-destructive">{syncRecord.error}</p>
      ) : null}
    </div>
  );
}

export function SyncDialog({
  controls,
  onOpenChange,
  open,
  serverName,
}: {
  controls: SyncControls;
  onOpenChange: (open: boolean) => void;
  open: boolean;
  serverName: string;
}) {
  const { cancelSync, cancelling, error, latestSync, running, startSync } = controls;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Library sync</DialogTitle>
          <DialogDescription>Muswag keeps a local copy of the library on {serverName}.</DialogDescription>
        </DialogHeader>

        {latestSync ? <SyncDetails syncRecord={latestSync} /> : <p className="text-muted-foreground">Nothing synced yet.</p>}

        {error ? <p className="text-xs break-words text-destructive">{error}</p> : null}

        <DialogFooter className="sm:justify-start">
          <Button disabled={running} onClick={() => startSync("quick")}>
            {running ? <SpinnerGapIcon className="animate-spin" /> : <ArrowsClockwiseIcon />}
            {running ? "Syncing" : "Sync now"}
          </Button>
          {running ? (
            <Button disabled={cancelling} onClick={() => cancelSync()} variant="destructive">
              <XIcon />
              Cancel sync
            </Button>
          ) : (
            <Button onClick={() => startSync("full")} variant="secondary">
              Full sync
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
