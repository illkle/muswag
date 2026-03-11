import { Alert, AlertTitle, AlertDescription } from "#/components/ui/alert";
import { PlayerPanel } from "#/components/player-panel";
import { Button } from "#/components/ui/button";
import {
  SidebarProvider,
  SidebarHeader,
  SidebarContent,
  SidebarInset,
  Sidebar,
} from "#/components/ui/sidebar";
import { userStateQueryOptions } from "#/lib/app-state";
import { SM } from "#/lib/db";
import { getErrorMessage } from "#/lib/err";
import { cn } from "#/lib/utils";
import { useMutation, useQuery } from "@tanstack/react-query";
import { Navigate, Outlet, createFileRoute } from "@tanstack/react-router";
import { ChevronDown, LibraryBig, LogOut, RefreshCcw } from "lucide-react";
import { useEffect, useEffectEvent, useRef, useState } from "react";

export const Route = createFileRoute("/app")({
  component: RouteComponent,
});

const AppSidebarWrapper = ({
  children,
  url,
  lastSyncedAt,
}: {
  children: React.ReactNode;
  url: string;
  lastSyncedAt: string | null;
}) => {
  const syncMutation = useMutation({
    mutationFn: () => SM.sync(),
  });
  const logoutMutation = useMutation({
    mutationFn: () => SM.logout(),
  });

  return (
    <SidebarProvider>
      <Sidebar>
        <SidebarHeader>
          <div className="space-y-1">
            <div className="flex items-center gap-2">
              <div className="flex size-9 items-center justify-center rounded-xl bg-sidebar-primary text-sidebar-primary-foreground">
                <LibraryBig className="size-4" />
              </div>
              <div>
                <p className="text-sm font-semibold">Muswag</p>
                <p className="text-xs text-sidebar-foreground/70">Local library workspace</p>
              </div>
            </div>
          </div>
        </SidebarHeader>

        <SidebarContent>
          <SidebarServerMenu
            lastSyncedAt={lastSyncedAt}
            onLogout={() => logoutMutation.mutate()}
            onSync={() => syncMutation.mutate()}
            syncError={
              syncMutation.isError
                ? getErrorMessage(syncMutation.error, "The library could not be synced.")
                : null
            }
            syncSummary={
              syncMutation.data
                ? `${syncMutation.data.fetched} fetched, ${syncMutation.data.inserted} new, ${syncMutation.data.updated} updated`
                : null
            }
            syncing={syncMutation.isPending}
            url={url}
            loggingOut={logoutMutation.isPending}
          />
        </SidebarContent>
      </Sidebar>

      <SidebarInset className="grid h-(--main-height) grid-rows-[minmax(0,1fr)_auto]">
        <div className="min-h-0 overflow-y-auto">{children}</div>
      </SidebarInset>
    </SidebarProvider>
  );
};

function SidebarServerMenu({
  url,
  lastSyncedAt,
  syncing,
  loggingOut,
  syncSummary,
  syncError,
  onSync,
  onLogout,
}: {
  url: string;
  lastSyncedAt: string | null;
  syncing: boolean;
  loggingOut: boolean;
  syncSummary: string | null;
  syncError: string | null;
  onSync: () => void;
  onLogout: () => void;
}) {
  const [isOpen, setIsOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const isBusy = syncing || loggingOut;

  const closeMenu = useEffectEvent(() => {
    setIsOpen(false);
  });

  const handlePointerDown = useEffectEvent((event: PointerEvent) => {
    if (!containerRef.current?.contains(event.target as Node)) {
      closeMenu();
    }
  });

  const handleKeyDown = useEffectEvent((event: KeyboardEvent) => {
    if (event.key === "Escape") {
      closeMenu();
    }
  });

  useEffect(() => {
    if (!isOpen) {
      return;
    }

    document.addEventListener("pointerdown", handlePointerDown);
    document.addEventListener("keydown", handleKeyDown);

    return () => {
      document.removeEventListener("pointerdown", handlePointerDown);
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [handleKeyDown, handlePointerDown, isOpen]);

  return (
    <div className="relative" ref={containerRef}>
      <Button
        variant="ghost"
        className="h-auto w-full justify-between rounded-2xl border border-sidebar-border/70 bg-sidebar-accent/45 px-4 py-3 text-left shadow-none hover:bg-sidebar-accent/75"
        aria-expanded={isOpen}
        aria-haspopup="dialog"
        onClick={() => {
          setIsOpen((open) => !open);
        }}
      >
        <div className="min-w-0">
          <p className="truncate text-sm font-medium text-sidebar-foreground">
            {formatSidebarUrl(url)}
          </p>
          <p className="text-xs text-sidebar-foreground/70">{formatLastSyncLabel(lastSyncedAt)}</p>
        </div>
        <ChevronDown
          className={cn(
            "size-4 text-sidebar-foreground/70 transition-transform",
            isOpen && "rotate-180",
          )}
        />
      </Button>

      {isOpen ? (
        <div className="absolute inset-x-0 top-full z-50 mt-2 rounded-2xl border border-sidebar-border/70 bg-popover p-2 shadow-2xl shadow-black/10">
          <div className="space-y-2">
            <Button className="w-full justify-center" onClick={onSync} disabled={isBusy}>
              <RefreshCcw className={syncing ? "animate-spin" : ""} />
              {syncing ? "Syncing..." : "Sync now"}
            </Button>

            <Button
              variant="ghost"
              className="w-full justify-center"
              onClick={onLogout}
              disabled={isBusy}
            >
              <LogOut />
              {loggingOut ? "Logging out..." : "Log out"}
            </Button>
          </div>

          {syncSummary ? (
            <div className="mt-2 rounded-xl border border-border/70 bg-muted/60 px-3 py-2 text-xs text-muted-foreground">
              {syncSummary}
            </div>
          ) : null}

          {syncError ? (
            <Alert variant="destructive" className="mt-2">
              <AlertTitle>Sync failed</AlertTitle>
              <AlertDescription>{syncError}</AlertDescription>
            </Alert>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

function formatSidebarUrl(url: string): string {
  return url.replace(/^https?:\/\//, "").replace(/\/$/, "");
}

function formatLastSyncLabel(lastSyncedAt: string | null): string {
  if (!lastSyncedAt) {
    return "last sync never";
  }

  const timestamp = Date.parse(lastSyncedAt);
  if (Number.isNaN(timestamp)) {
    return "last sync unknown";
  }

  const diffMs = Math.max(0, Date.now() - timestamp);

  if (diffMs < 60_000) {
    return "last sync just now";
  }

  if (diffMs < 3_600_000) {
    return `last sync ${Math.floor(diffMs / 60_000)}m ago`;
  }

  if (diffMs < 86_400_000) {
    return `last sync ${Math.floor(diffMs / 3_600_000)}h ago`;
  }

  if (diffMs < 604_800_000) {
    return `last sync ${Math.floor(diffMs / 86_400_000)}d ago`;
  }

  if (diffMs < 2_592_000_000) {
    return `last sync ${Math.floor(diffMs / 604_800_000)}w ago`;
  }

  if (diffMs < 31_536_000_000) {
    return `last sync ${Math.floor(diffMs / 2_592_000_000)}mo ago`;
  }

  return `last sync ${Math.floor(diffMs / 31_536_000_000)}y ago`;
}

function RouteComponent() {
  const userStateQuery = useQuery(userStateQueryOptions);

  if (userStateQuery.isLoading) {
    return null;
  }

  if (!userStateQuery.data) {
    return <Navigate to="/" />;
  }

  if (userStateQuery.data.status === "logged_out") {
    return <Navigate to="/" />;
  }

  return (
    <div>
      <AppSidebarWrapper
        url={userStateQuery.data.url}
        lastSyncedAt={userStateQuery.data.lastSyncedAt}
      >
        <Outlet />
      </AppSidebarWrapper>
      <PlayerPanel />
    </div>
  );
}
