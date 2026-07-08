import { MiniSearch } from "#/components/search";
import { Badge } from "#/components/ui/badge";
import { Button } from "#/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "#/components/ui/popover";
import { getErrorMessage } from "#/lib/err";
import { useSyncs, useUser } from "#/lib/queries";
import { SyncManager } from "#/lib/sync-manager";
import { cn } from "#/lib/utils";
import type { SyncProgress, SyncRecord, SyncStep } from "@muswag/shared";
import { useMutation } from "@tanstack/react-query";
import { useCanGoBack, useRouter } from "@tanstack/react-router";
import { ChevronDown, ChevronLeft, ChevronRight, LoaderCircle, RefreshCw, X } from "lucide-react";
import { useMemo } from "react";

const syncStepLabels: Record<SyncStep, string> = {
  starting: "Starting sync",
  "fetching-album-list": "Fetching album page",
  "fetching-album-details": "Fetching album details",
  "saving-albums": "Saving albums",
  "removing-missing-albums": "Removing missing albums",
  "removing-dangling-songs": "Removing dangling songs",
  "removing-cover-art": "Removing cover art",
  completed: "Completed",
  failed: "Failed",
  aborted: "Aborted",
};

function getSyncStepLabel(syncRecord: SyncRecord): string {
  return syncRecord.currentStep ? syncStepLabels[syncRecord.currentStep] : syncRecord.lastStatus;
}

function getDetailProgressPercent(progress: SyncProgress | undefined): number | null {
  if (!progress || progress.currentPageAlbumDetailsTotal <= 0) {
    return null;
  }

  return Math.min(100, Math.round((progress.currentPageAlbumDetailsFetched / progress.currentPageAlbumDetailsTotal) * 100));
}

function formatSyncTime(value: string): string {
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(value));
}

const SyncProgressSummary = ({ syncRecord }: { syncRecord: SyncRecord | null }) => {
  if (!syncRecord) {
    return <div className="text-sm text-muted-foreground">No syncs yet.</div>;
  }

  const progress = syncRecord.progress;
  const detailProgressPercent = getDetailProgressPercent(progress);
  const isRunning = syncRecord.lastStatus === "running";

  return (
    <div className="space-y-3">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="text-sm font-medium">{getSyncStepLabel(syncRecord)}</div>
          <div className="text-xs text-muted-foreground">
            Started {formatSyncTime(syncRecord.timeStarted)}
            {syncRecord.timeEnded ? `, ended ${formatSyncTime(syncRecord.timeEnded)}` : null}
          </div>
        </div>
        <Badge variant={syncRecord.lastStatus === "failed" ? "destructive" : "secondary"}>{syncRecord.lastStatus}</Badge>
      </div>

      {progress ? (
        <>
          {detailProgressPercent !== null ? (
            <div className="space-y-1.5">
              <div className="flex justify-between text-xs text-muted-foreground">
                <span>Page {progress.currentPage} details</span>
                <span>
                  {progress.currentPageAlbumDetailsFetched}/{progress.currentPageAlbumDetailsTotal}
                </span>
              </div>
              <div className="h-1.5 overflow-hidden rounded-full bg-muted">
                <div
                  className={cn("h-full rounded-full bg-primary transition-[width]", isRunning && "duration-300")}
                  style={{ width: `${detailProgressPercent}%` }}
                />
              </div>
            </div>
          ) : null}

          <div className="grid grid-cols-3 gap-2 text-xs">
            <div>
              <div className="text-muted-foreground">Fetched</div>
              <div className="font-medium">{progress.albumsFetched}</div>
            </div>
            <div>
              <div className="text-muted-foreground">Inserted</div>
              <div className="font-medium">{progress.albumsInserted}</div>
            </div>
            <div>
              <div className="text-muted-foreground">Updated</div>
              <div className="font-medium">{progress.albumsUpdated}</div>
            </div>
            <div>
              <div className="text-muted-foreground">Deleted</div>
              <div className="font-medium">{progress.albumsDeleted}</div>
            </div>
            <div>
              <div className="text-muted-foreground">Songs cleaned</div>
              <div className="font-medium">{progress.songsDeleted}</div>
            </div>
            <div>
              <div className="text-muted-foreground">Pages</div>
              <div className="font-medium">{progress.pagesFetched}</div>
            </div>
          </div>
        </>
      ) : null}

      {syncRecord.error ? <div className="text-xs text-destructive">{syncRecord.error}</div> : null}
    </div>
  );
};

const ServerInfo = () => {
  const userStateQuery = useUser();
  const syncsQuery = useSyncs();

  const syncMutation = useMutation({
    mutationFn: () => SyncManager.sync(),
  });
  const logoutMutation = useMutation({
    mutationFn: () => SyncManager.logout(),
  });
  const cancelSyncMutation = useMutation({
    mutationFn: () => SyncManager.cancelSync(),
  });

  const hostName = useMemo(() => {
    if (!userStateQuery.data) {
      return "";
    }

    const url = new URL(userStateQuery.data.url);

    return url.hostname;
  }, [userStateQuery.data]);

  const latestSync = useMemo(() => {
    return (syncsQuery.data ?? []).reduce<(typeof syncsQuery.data)[number] | null>((latest, syncRecord) => {
      if (!latest || syncRecord.timeStarted > latest.timeStarted) {
        return syncRecord;
      }
      return latest;
    }, null);
  }, [syncsQuery.data]);

  const syncRunning = latestSync?.lastStatus === "running";

  if (!userStateQuery.data) {
    console.warn("No user data in ServerInfo component");
    return null;
  }

  return (
    <Popover>
      <PopoverTrigger className={"flex gap-2 items-center text-xs"}>
        {syncRunning ? <LoaderCircle size={14} className="animate-spin" /> : null}
        {hostName} <ChevronDown size={14} className="" />
      </PopoverTrigger>
      <PopoverContent className="w-80 space-y-4" align="end">
        <SyncProgressSummary syncRecord={latestSync} />
        {syncMutation.isError ? (
          <div className="text-xs text-destructive">{getErrorMessage(syncMutation.error, "The library could not be synced.")}</div>
        ) : null}
        <div className="flex gap-2">
          <Button className="flex-1" disabled={syncRunning || syncMutation.isPending} onClick={() => syncMutation.mutate()}>
            {syncRunning || syncMutation.isPending ? <LoaderCircle className="size-4 animate-spin" /> : <RefreshCw className="size-4" />}
            {syncRunning || syncMutation.isPending ? "Syncing" : "Sync"}
          </Button>
          {syncRunning ? (
            <Button variant="destructive" disabled={cancelSyncMutation.isPending} onClick={() => cancelSyncMutation.mutate()}>
              <X className="size-4" />
              Cancel
            </Button>
          ) : null}
          <Button variant="secondary" onClick={() => logoutMutation.mutate()}>
            Log out
          </Button>
        </div>
      </PopoverContent>
    </Popover>
  );
};

const NavButtons = () => {
  const router = useRouter();
  const canGoBack = useCanGoBack();
  const canGoForward = router.history.location.state.__TSR_index < router.history.length - 1;

  return (
    <>
      <Button
        variant="ghost"
        size="icon-sm"
        aria-label="Go back"
        disabled={!canGoBack}
        onClick={() => {
          router.history.back();
        }}
      >
        <ChevronLeft className="size-4" />
      </Button>
      <Button
        variant="ghost"
        size="icon-sm"
        aria-label="Go forward"
        disabled={!canGoForward}
        onClick={() => {
          router.history.forward();
        }}
      >
        <ChevronRight className="size-4" />
      </Button>
    </>
  );
};

export const TopBar = () => {
  const isMac = navigator.userAgent.toUpperCase().includes("MAC");

  return (
    <div className={cn("h-(--top-height) relative w-full  bg-accent flex items-center border-b")}>
      <div className="app-drag-region shrink-0  h-full w-30"></div>
      <div className={cn("flex app-no-drag items-center w-fit relative z-10 h-full ", isMac && "")}>
        <NavButtons />
      </div>
      <div className="app-drag-region  w-full h-full"></div>

      <MiniSearch />
      <div className="app-drag-region  w-full h-full"></div>
      <ServerInfo />

      <div className="app-drag-region shrink-0 w-20 h-full"></div>
    </div>
  );
};
