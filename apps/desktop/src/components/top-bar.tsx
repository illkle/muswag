import { Search } from "#/components/search";
import { Button } from "#/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "#/components/ui/popover";
import { getErrorMessage } from "#/lib/err";
import { useSyncs, useUser } from "#/lib/queries";
import { SyncManager } from "#/lib/sync-manager";
import { cn } from "#/lib/utils";
import { useMutation } from "@tanstack/react-query";
import { useCanGoBack, useRouter } from "@tanstack/react-router";
import { ChevronDown, ChevronLeft, ChevronRight } from "lucide-react";
import { useMemo } from "react";

const ServerInfo = () => {
  const userStateQuery = useUser();
  const syncsQuery = useSyncs();

  const syncMutation = useMutation({
    mutationFn: () => SyncManager.sync(),
  });
  const logoutMutation = useMutation({
    mutationFn: () => SyncManager.logout(),
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

  if (!userStateQuery.data) {
    console.warn("No user data in ServerInfo component");
    return null;
  }

  return (
    <Popover>
      <PopoverTrigger className={"flex gap-2 items-center text-xs"}>
        {hostName} <ChevronDown size={14} className="" />
      </PopoverTrigger>
      <PopoverContent>
        last sync: {latestSync ? `${latestSync.lastStatus} at ${latestSync.timeStarted}` : "never"}
        {syncMutation.isError ? getErrorMessage(syncMutation.error, "The library could not be synced.") : null}
        <Button onClick={() => syncMutation.mutate()}>Sync</Button>
        <Button onClick={() => logoutMutation.mutate()}>Log out</Button>
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

      <Search />
      <div className="app-drag-region  w-full h-full"></div>
      <ServerInfo />

      <div className="app-drag-region shrink-0 w-20 h-full"></div>
    </div>
  );
};
